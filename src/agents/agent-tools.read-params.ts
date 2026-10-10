import {
  classifyMediaReferenceSource,
  normalizeMediaReferenceSource,
  resolveMediaReferenceLocalPath,
} from "../media/media-reference.js";
import {
  REQUIRED_PARAM_GROUPS,
  assertRequiredParams,
  getToolParamsRecord,
  normalizeFileToolPathParamsFromKeys,
} from "./agent-tools.params.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

/** Prepare read aliases before root enforcement, without changing the display identity. */
export async function prepareReadToolParams(
  params: unknown,
  toolName: string,
  options?: { cwd?: string; bridge?: SandboxFsBridge },
) {
  const record = getToolParamsRecord(params);
  const normalizedRecord = record
    ? await normalizeFileToolPathParamsFromKeys(record, ["path"], options?.cwd, options?.bridge)
    : undefined;
  assertRequiredParams(normalizedRecord, REQUIRED_PARAM_GROUPS.read, toolName);
  const filePath = typeof normalizedRecord?.path === "string" ? normalizedRecord.path : "<unknown>";
  const mediaSource = normalizeMediaReferenceSource(filePath);
  // The guarded reader still decides access; a managed URI grants no root exception.
  const readArgs =
    !options?.bridge && classifyMediaReferenceSource(mediaSource).isMediaStoreUrl
      ? { ...normalizedRecord, path: await resolveMediaReferenceLocalPath(mediaSource) }
      : normalizedRecord;
  const dailyMemoryPath = process.platform === "win32" ? filePath.replace(/\\/g, "/") : filePath;
  // Daily journals may not exist yet; let the concrete reader own filesystem errors.
  const implicitlyOptional =
    normalizedRecord?.optional === undefined &&
    /^(?:\.\/)*memory\/\d{4}-\d{2}-\d{2}\.md$/u.test(dailyMemoryPath);
  return {
    filePath,
    args: implicitlyOptional ? { ...readArgs, optional: true } : (readArgs ?? {}),
  };
}
