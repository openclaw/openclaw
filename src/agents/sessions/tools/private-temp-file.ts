/**
 * Private temporary file helper for tool output spillover.
 *
 * Creates owner-only log files without reusing predictable names.
 */
import { randomBytes } from "node:crypto";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { SandboxFsBridge } from "../../sandbox/fs-bridge.types.js";
import { getSandboxInputStager } from "../../sandbox/input-staging.js";

export type PrivateTempFileOptions = {
  sandbox?: { root?: string; bridge?: SandboxFsBridge };
  assertCurrent?: () => void;
  signal?: AbortSignal;
};

export async function writePrivateTempFile(
  prefix: string,
  content: string,
  options?: PrivateTempFileOptions,
): Promise<string> {
  options?.assertCurrent?.();
  if (options?.sandbox) {
    const { root, bridge } = options.sandbox;
    if (!root || !bridge) {
      throw new Error("Sandbox output context is unavailable");
    }
    const stageInput = getSandboxInputStager(bridge);
    if (!stageInput) {
      throw new Error("Sandbox does not support private output staging");
    }
    return stageInput({
      prefix,
      content,
      signal: options.signal,
      assertCurrent: () => options.assertCurrent?.(),
    });
  }
  const { capturePathRemovalGuard, removePathWithinRoot } =
    await import("../../../infra/fs-safe-remove.js");
  const filePath = createPrivateTempFilePath(prefix);
  const assertRoot = capturePathRemovalGuard(tmpdir());
  if (!assertRoot) {
    throw new Error("Private output directory is unavailable");
  }
  // An unsuccessful exclusive open never grants custody of an existing path.
  const file = await open(filePath, "wx", 0o600);
  let assertFile: (() => void) | undefined;
  const cleanup = async () => {
    if (!assertFile) {
      return;
    }
    await removePathWithinRoot({
      rootDir: tmpdir(),
      relativePath: basename(filePath),
      assertBeforeMutation: () => {
        assertRoot();
        assertFile?.();
      },
    });
  };
  try {
    assertFile = capturePathRemovalGuard(filePath);
    if (!assertFile) {
      throw new Error("Private output disappeared during creation");
    }
    await file.writeFile(content);
    await file.close();
  } catch (error) {
    // Preserve the operation's error even if best-effort removal also fails.
    await file.close().catch(() => undefined);
    await cleanup().catch(() => undefined);
    throw error;
  }
  options?.assertCurrent?.();
  return filePath;
}

function createPrivateTempFilePath(prefix: string): string {
  const id = randomBytes(8).toString("hex");
  return join(tmpdir(), `${prefix}-${id}.log`);
}
