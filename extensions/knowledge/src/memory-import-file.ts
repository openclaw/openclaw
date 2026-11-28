import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { openRootFile } from "openclaw/plugin-sdk/file-access-runtime";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";

export async function resolveMemoryImportFile(
  file: { path: string; sha256?: string },
  tool: OpenClawPluginToolContext,
  signal?: AbortSignal,
) {
  const workspace = tool.fsPolicy?.root ?? tool.workspaceDir;
  if (!workspace || tool.sandboxed || tool.sandbox) {
    return file;
  }
  const absolutePath = path.resolve(workspace, file.path);
  const opened = await openRootFile({
    rootPath: workspace,
    absolutePath,
    boundaryLabel: "Memory import workspace",
    rejectSymlinks: true,
    rejectHardlinks: true,
  });
  if (!opened.ok) {
    const error = "error" in opened ? opened.error : undefined;
    if (
      opened.reason === "path" &&
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    ) {
      return undefined;
    }
    throw new Error(`Could not read Memory import file: ${file.path}`);
  }
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(absolutePath, { fd: opened.fd, signal })) {
    hash.update(bytes);
  }
  return { path: file.path, sha256: hash.digest("hex") };
}
