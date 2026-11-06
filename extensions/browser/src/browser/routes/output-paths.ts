import { pathScope } from "openclaw/plugin-sdk/security-runtime";
import { readNonBlankString } from "openclaw/plugin-sdk/string-coerce-runtime";
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
  // defaultName preserves literal whitespace while sharing all writable checks.
  const result = await pathScope(params.rootDir, { label: params.scopeLabel }).writable("", {
    defaultName: readNonBlankString(params.requestedPath) ?? params.defaultFileName,
  });
  if (!result.ok) {
    params.res.status(400).json({ error: result.error });
    return null;
  }
  return result.path;
}
