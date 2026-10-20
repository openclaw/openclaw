import { mergeCodexThreadConfigs } from "./plugin-thread-config.js";
import type { CodexConfigReadResponse, JsonObject } from "./protocol.js";

const CODEX_NATIVE_PROJECT_DOC_MAX_BYTES = 128 * 1024;

export function buildCodexProjectDocThreadConfig(
  config?: JsonObject,
  effectiveNativeConfig?: CodexConfigReadResponse,
): JsonObject {
  const authoredMaxBytes = resolveCodexNativeProjectDocMaxBytes(effectiveNativeConfig);
  const defaults: JsonObject = {
    project_doc_max_bytes: authoredMaxBytes ?? CODEX_NATIVE_PROJECT_DOC_MAX_BYTES,
  };
  return mergeCodexThreadConfigs(defaults, config) ?? defaults;
}

function resolveCodexNativeProjectDocMaxBytes(
  effectiveNativeConfig?: CodexConfigReadResponse,
): number | undefined {
  // config/read materializes Codex's built-in 32 KiB default in `config`, but
  // deliberately omits packaged defaults from `origins`. Only an origin proves
  // that an operator or administrator actually authored this setting.
  if (effectiveNativeConfig?.origins?.project_doc_max_bytes === undefined) {
    return undefined;
  }
  const authoredMaxBytes = effectiveNativeConfig.config.project_doc_max_bytes;
  if (
    typeof authoredMaxBytes !== "number" ||
    !Number.isSafeInteger(authoredMaxBytes) ||
    authoredMaxBytes < 0
  ) {
    throw new Error("Codex config/read returned an invalid project_doc_max_bytes value");
  }
  return authoredMaxBytes;
}

export function mergeCodexNativeProjectDocThreadConfig(
  config: JsonObject | undefined,
  effectiveNativeConfig: CodexConfigReadResponse,
): JsonObject | undefined {
  const authoredMaxBytes = resolveCodexNativeProjectDocMaxBytes(effectiveNativeConfig);
  return authoredMaxBytes === undefined
    ? config
    : mergeCodexThreadConfigs({ project_doc_max_bytes: authoredMaxBytes }, config);
}
