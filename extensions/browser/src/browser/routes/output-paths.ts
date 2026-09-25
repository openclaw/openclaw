import { pathScope } from "openclaw/plugin-sdk/security-runtime";
/**
 * Browser route output-path helpers.
 *
 * Validates writable output paths against a route-specific root before any
 * screenshot, trace, or download route writes to disk.
 */
import { ensureOutputDirectory } from "../output-directories.js";
import type { BrowserResponse } from "./types.js";

/** Resolve a writable output path or send a 400 JSON response on scope errors. */
export async function resolveWritableOutputPathOrRespond(params: {
  res: BrowserResponse;
  rootDir: string;
  requestedPath: string;
  scopeLabel: string;
  defaultFileName?: string;
  ensureRootDir?: boolean;
}): Promise<string | null> {
  if (params.ensureRootDir) {
    await ensureOutputDirectory(params.rootDir);
  }
  const pathResult = await pathScope(params.rootDir, { label: params.scopeLabel }).writable(
    params.requestedPath,
    { defaultName: params.defaultFileName },
  );
  if (!pathResult.ok) {
    params.res.status(400).json({ error: pathResult.error });
    return null;
  }
  return pathResult.path;
}
