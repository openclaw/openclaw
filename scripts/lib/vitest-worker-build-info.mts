import fs from "node:fs";
import path from "node:path";
import { asNullableRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { normalizeControlUiBuildInfo } from "../../ui/src/build-info-normalizers.ts";
import { normalizeBuildTimestamp, resolveBuildInfo, type BuildInfo } from "../write-build-info.ts";

export function resolveVitestWorkerBuildInfo(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): BuildInfo {
  let contents: string;
  try {
    contents = fs.readFileSync(path.join(rootDir, "dist/build-info.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return resolveBuildInfo({ rootDir, env });
    }
    throw error;
  }
  try {
    const value = asNullableRecord(JSON.parse(contents));
    const normalized = normalizeControlUiBuildInfo(value);
    if (
      !value ||
      !Object.hasOwn(value, "version") ||
      !Object.hasOwn(value, "commit") ||
      value.version !== normalized.version ||
      value.commit !== normalized.commit ||
      typeof value.builtAt !== "string" ||
      typeof value.buildId !== "string" ||
      !value.buildId ||
      value.buildId !== normalized.buildId
    ) {
      throw new Error("Invalid build metadata");
    }
    normalizeBuildTimestamp(value.builtAt);
    // Workers share the parent installation root. Minting a new identity here
    // makes its unchanged dist look like a replacement during maintenance.
    return {
      version: normalized.version,
      commit: normalized.commit,
      builtAt: value.builtAt,
      buildId: value.buildId,
    };
  } catch {
    throw new Error("Invalid host dist/build-info.json for compiled test workers");
  }
}
