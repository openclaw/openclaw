import { createHash } from "node:crypto";
import { closeSync, fstatSync } from "node:fs";
import path from "node:path";
import { readFileWindowFullySync } from "@openclaw/fs-safe/advanced";
import type { FeatureInvocationContext } from "openclaw/plugin-sdk/feature-plugin";
import { openRootFile } from "openclaw/plugin-sdk/file-access-runtime";
import {
  ATTACHMENT_CHUNK_BYTES,
  type AttachFileInput,
  type AttachInput,
  type AttachOutput,
} from "./attachment-contract.js";

/** Stream one host-workspace original through the existing durable upload owner. */
export async function attachWorkspaceFile(
  input: AttachFileInput,
  context: FeatureInvocationContext,
  assertCurrent: () => void,
  attach: (chunk: AttachInput) => Promise<AttachOutput>,
): Promise<AttachOutput> {
  // Remote or sandbox paths must never be interpreted as Gateway filesystem paths.
  if (context.source !== "tool") {
    throw new Error("Workspace file attachment is available only to agent tools.");
  }
  if (context.tool.sandboxed || context.tool.sandbox) {
    throw new Error(
      "Sandbox files require programmatic knowledge_attach byte transfer; host paths are not accepted.",
    );
  }
  const workspace = context.tool.fsPolicy?.root ?? context.tool.workspaceDir;
  if (!workspace) {
    throw new Error("Workspace file attachment requires a host-selected workspace.");
  }
  const current = () => {
    context.signal?.throwIfAborted();
    assertCurrent();
  };
  current();
  const opened = await openRootFile({
    rootPath: workspace,
    absolutePath: path.resolve(workspace, input.filePath),
    boundaryLabel: "Knowledge source workspace",
    rejectSymlinks: true,
    rejectHardlinks: true,
  });
  if (!opened.ok) {
    throw new Error(
      "Source file must be a readable regular file inside the authorized workspace without aliases.",
    );
  }
  try {
    // Pin one descriptor and use deterministic windows so exact retries replay chunks.
    const { filePath: _filePath, sha256, ...metadata } = input;
    const digest = createHash("sha256");
    let offset = 0;
    while (offset < opened.stat.size) {
      current();
      const bytes = Buffer.alloc(Math.min(ATTACHMENT_CHUNK_BYTES, opened.stat.size - offset));
      const read = readFileWindowFullySync(opened.fd, bytes, offset);
      if (read !== bytes.length) {
        throw new Error("Source file changed during attachment; no complete receipt was created.");
      }
      digest.update(bytes);
      current();
      await attach({ ...metadata, offset, data: bytes.toString("base64"), final: false });
      offset += bytes.length;
    }
    // Only finalize after the complete source matches the caller-observed hash.
    // A final empty chunk also makes empty files and completed retries identical.
    current();
    const after = fstatSync(opened.fd);
    if (
      after.size !== opened.stat.size ||
      after.mtimeMs !== opened.stat.mtimeMs ||
      after.ctimeMs !== opened.stat.ctimeMs ||
      digest.digest("hex") !== sha256
    ) {
      throw new Error(
        "Source file changed or SHA-256 does not match; no complete receipt was created.",
      );
    }
    current();
    return await attach({ ...metadata, offset, data: "", final: true });
  } finally {
    closeSync(opened.fd);
  }
}
