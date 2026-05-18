import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { CONFIG_DIR } from "../utils.js";
import {
  resolveExistingPathsWithinRoot,
  resolveStrictExistingPathsWithinRoot,
} from "../sdk-security-runtime.js";
export {
  pathScope,
  resolvePathsWithinRoot,
  resolvePathWithinRoot,
  resolveWritablePathWithinRoot,
} from "../sdk-security-runtime.js";
export { resolveExistingPathsWithinRoot, resolveStrictExistingPathsWithinRoot };

const DEFAULT_FALLBACK_BROWSER_TMP_DIR = "/tmp/openclaw";

function canUseNodeFs(): boolean {
  const getBuiltinModule = (
    process as NodeJS.Process & {
      getBuiltinModule?: (id: string) => unknown;
    }
  ).getBuiltinModule;
  if (typeof getBuiltinModule !== "function") {
    return false;
  }
  try {
    return getBuiltinModule("fs") !== undefined;
  } catch {
    return false;
  }
}

const DEFAULT_BROWSER_TMP_DIR = canUseNodeFs()
  ? resolvePreferredOpenClawTmpDir()
  : DEFAULT_FALLBACK_BROWSER_TMP_DIR;
export const DEFAULT_TRACE_DIR = DEFAULT_BROWSER_TMP_DIR;
export const DEFAULT_DOWNLOAD_DIR = path.join(DEFAULT_BROWSER_TMP_DIR, "downloads");
export const DEFAULT_UPLOAD_DIR = path.join(DEFAULT_BROWSER_TMP_DIR, "uploads");
export const DEFAULT_INBOUND_MEDIA_DIR = path.join(CONFIG_DIR, "media", "inbound");

type ExistingPathsResult = Awaited<ReturnType<typeof resolveExistingPathsWithinRoot>>;
type StrictExistingPathsResult = Awaited<ReturnType<typeof resolveStrictExistingPathsWithinRoot>>;

type UploadPathResolutionOptions = {
  requestedPaths: string[];
  uploadDir?: string;
  inboundMediaDir?: string;
};

export async function resolveExistingUploadPaths({
  requestedPaths,
  uploadDir = DEFAULT_UPLOAD_DIR,
  inboundMediaDir = DEFAULT_INBOUND_MEDIA_DIR,
}: UploadPathResolutionOptions): Promise<ExistingPathsResult> {
  const uploadPathsResult = await resolveExistingPathsWithinRoot({
    rootDir: uploadDir,
    requestedPaths,
    scopeLabel: `uploads directory (${uploadDir})`,
  });
  if (uploadPathsResult.ok) {
    return uploadPathsResult;
  }
  return await resolveExistingPathsWithinRoot({
    rootDir: inboundMediaDir,
    requestedPaths,
    scopeLabel: `inbound media directory (${inboundMediaDir})`,
  });
}

export async function resolveStrictExistingUploadPaths({
  requestedPaths,
  uploadDir = DEFAULT_UPLOAD_DIR,
  inboundMediaDir = DEFAULT_INBOUND_MEDIA_DIR,
}: UploadPathResolutionOptions): Promise<StrictExistingPathsResult> {
  const uploadPathsResult = await resolveStrictExistingPathsWithinRoot({
    rootDir: uploadDir,
    requestedPaths,
    scopeLabel: `uploads directory (${uploadDir})`,
  });
  if (uploadPathsResult.ok) {
    return uploadPathsResult;
  }
  return await resolveStrictExistingPathsWithinRoot({
    rootDir: inboundMediaDir,
    requestedPaths,
    scopeLabel: `inbound media directory (${inboundMediaDir})`,
  });
}
