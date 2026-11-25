import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

type SubsystemLogger = {
  isEnabled?(level: "debug" | "info" | "warn"): boolean;
  info(message: string): void;
  debug(message: string): void;
  debugLazy?(build: () => string): void;
};

type ModelTransportDebugEnv = NodeJS.ProcessEnv;

function isTruthyEnv(value: unknown): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  return (
    normalized.length > 0 &&
    normalized !== "0" &&
    normalized !== "false" &&
    normalized !== "off" &&
    normalized !== "no"
  );
}

/** Resolves model payload debug verbosity from `OPENCLAW_DEBUG_MODEL_PAYLOAD`. */
export function resolveModelPayloadDebugMode(
  env: ModelTransportDebugEnv = process.env,
): "off" | "summary" | "tools" | "full-redacted" {
  const normalized = normalizeLowercaseStringOrEmpty(env.OPENCLAW_DEBUG_MODEL_PAYLOAD);
  if (normalized === "tools" || normalized === "full-redacted" || normalized === "summary") {
    return normalized;
  }
  return "off";
}

/** Resolves SSE stream debug verbosity from `OPENCLAW_DEBUG_SSE`. */
export function resolveModelSseDebugMode(
  env: ModelTransportDebugEnv = process.env,
): "off" | "events" | "peek" {
  const normalized = normalizeLowercaseStringOrEmpty(env.OPENCLAW_DEBUG_SSE);
  if (normalized === "peek") {
    return "peek";
  }
  return isTruthyEnv(normalized) ? "events" : "off";
}

/** Emits transport diagnostics at debug, promoted to info by explicit debug flags. */
export function emitModelTransportDebug(
  log: SubsystemLogger,
  message: string | (() => string),
): void {
  const env = process.env;
  if (
    isTruthyEnv(env.OPENCLAW_DEBUG_MODEL_TRANSPORT) ||
    resolveModelPayloadDebugMode(env) !== "off" ||
    resolveModelSseDebugMode(env) !== "off" ||
    isTruthyEnv(env.OPENCLAW_DEBUG_CODE_MODE)
  ) {
    if (log.isEnabled?.("info") !== false) {
      log.info(typeof message === "function" ? message() : message);
    }
    return;
  }
  if (log.isEnabled?.("debug") === false) {
    return;
  }
  if (typeof message === "function" && log.debugLazy) {
    log.debugLazy(message);
  } else {
    log.debug(typeof message === "function" ? message() : message);
  }
}

/** The requesting layer owns AbortError classification; deadlines remain failures here. */
export function emitModelTransportError(
  log: SubsystemLogger & { warn(message: string): void },
  label: string,
  detail: string | (() => string),
  signal?: AbortSignal,
): void {
  const aborted =
    signal?.aborted === true &&
    signal.reason instanceof Error &&
    signal.reason.name === "AbortError";
  const message = () =>
    `[${label}] ${aborted ? "aborted" : "error"} ${typeof detail === "function" ? detail() : detail}`;
  if (aborted) {
    emitModelTransportDebug(log, message);
  } else if (log.isEnabled?.("warn") !== false) {
    log.warn(message());
  }
}
