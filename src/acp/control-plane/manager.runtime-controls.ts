import { logVerbose } from "../../globals.js";
import { isRecord } from "../../utils.js";
import {
  describeAcpRpcError,
  extractAcpRpcError,
  withAcpRuntimeErrorBoundary,
} from "../runtime/errors.js";
import type { AcpRuntime, AcpRuntimeCapabilities, AcpRuntimeHandle } from "../runtime/types.js";
import type { SessionAcpMeta } from "./manager.types.js";
import { createUnsupportedControlError } from "./manager.utils.js";
import type { CachedRuntimeState } from "./runtime-cache.js";
import {
  buildRuntimeConfigOptionPairs,
  buildRuntimeControlSignature,
  normalizeText,
  resolveRuntimeOptionsFromMeta,
} from "./runtime-options.js";

// Apply-path policy. Returns true ONLY for the unsupported-control class:
//   -32601 Method not found              → always (control not implemented).
//   -32602 Invalid params, -32603 Internal error
//     → only when message + data.details match the unsupported-config /
//       unsupported-control hint regex below.
// A bare "-32602 Invalid params" with NO details is NOT swallowed —
// for setMode that means "bad mode value" (user error), not an unsupported control.
const UNSUPPORTED_HINT_RE =
  /unknown\s+config\s+option|unsupported\s+config\s+option|config\s+option[^.]{0,20}not\s+(?:supported|recognized|implemented)|method\s+(?:is\s+)?not\s+(?:supported|implemented)|not\s+supported\s+by\s+(?:this\s+)?(?:adapter|harness|backend)/i;

function isUnsupportedSessionControlError(err: unknown): boolean {
  const acp = extractAcpRpcError(err);
  if (!acp) {
    return false;
  }
  if (acp.code === -32601) {
    return true;
  }
  if (acp.code !== -32602 && acp.code !== -32603) {
    return false;
  }
  const details =
    isRecord(acp.data) && typeof acp.data.details === "string" ? acp.data.details : "";
  const haystack = `${acp.message ?? ""} ${details}`;
  return UNSUPPORTED_HINT_RE.test(haystack);
}

export async function resolveManagerRuntimeCapabilities(params: {
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
}): Promise<AcpRuntimeCapabilities> {
  let reported: AcpRuntimeCapabilities | undefined;
  if (params.runtime.getCapabilities) {
    reported = await withAcpRuntimeErrorBoundary({
      run: async () => await params.runtime.getCapabilities!({ handle: params.handle }),
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "Could not read ACP runtime capabilities.",
    });
  }
  const controls = new Set<AcpRuntimeCapabilities["controls"][number]>(reported?.controls ?? []);
  if (params.runtime.setMode) {
    controls.add("session/set_mode");
  }
  if (params.runtime.setConfigOption) {
    controls.add("session/set_config_option");
  }
  if (params.runtime.getStatus) {
    controls.add("session/status");
  }
  const normalizedKeys = (reported?.configOptionKeys ?? [])
    .map((entry) => normalizeText(entry))
    .filter(Boolean) as string[];
  return {
    controls: [...controls].toSorted(),
    ...(normalizedKeys.length > 0 ? { configOptionKeys: normalizedKeys } : {}),
  };
}

export async function applyManagerRuntimeControls(params: {
  sessionKey: string;
  runtime: AcpRuntime;
  handle: AcpRuntimeHandle;
  meta: SessionAcpMeta;
  getCachedRuntimeState: (sessionKey: string) => CachedRuntimeState | null;
}): Promise<void> {
  const options = resolveRuntimeOptionsFromMeta(params.meta);
  const signature = buildRuntimeControlSignature(options);
  const cached = params.getCachedRuntimeState(params.sessionKey);
  if (cached?.appliedControlSignature === signature) {
    return;
  }

  const capabilities = await resolveManagerRuntimeCapabilities({
    runtime: params.runtime,
    handle: params.handle,
  });
  const backend = params.handle.backend || params.meta.backend;
  const runtimeMode = normalizeText(options.runtimeMode);
  const configOptions = buildRuntimeConfigOptionPairs(options);
  const advertisedKeys = new Set(
    (capabilities.configOptionKeys ?? [])
      .map((entry) => normalizeText(entry))
      .filter(Boolean) as string[],
  );

  await withAcpRuntimeErrorBoundary({
    run: async () => {
      if (runtimeMode) {
        if (!capabilities.controls.includes("session/set_mode") || !params.runtime.setMode) {
          throw createUnsupportedControlError({
            backend,
            control: "session/set_mode",
          });
        }
        try {
          await params.runtime.setMode({
            handle: params.handle,
            mode: runtimeMode,
          });
        } catch (err) {
          if (isUnsupportedSessionControlError(err)) {
            logVerbose(
              `acp-manager: backend "${backend}" rejected session/set_mode(mode=${runtimeMode}): ${describeAcpRpcError(err)} — skipping`,
            );
          } else {
            throw err;
          }
        }
      }

      if (configOptions.length > 0) {
        if (
          !capabilities.controls.includes("session/set_config_option") ||
          !params.runtime.setConfigOption
        ) {
          throw createUnsupportedControlError({
            backend,
            control: "session/set_config_option",
          });
        }
        for (const [key, value] of configOptions) {
          if (advertisedKeys.size > 0 && !advertisedKeys.has(key)) {
            logVerbose(
              `acp-manager: backend "${backend}" does not advertise config key "${key}" — skipping`,
            );
            continue;
          }
          try {
            await params.runtime.setConfigOption({
              handle: params.handle,
              key,
              value,
            });
          } catch (err) {
            if (isUnsupportedSessionControlError(err)) {
              logVerbose(
                `acp-manager: backend "${backend}" rejected session/set_config_option(key=${key},value=${value}): ${describeAcpRpcError(err)} — skipping`,
              );
            } else {
              throw err;
            }
          }
        }
      }
    },
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not apply ACP runtime options before turn execution.",
  });

  if (cached) {
    cached.appliedControlSignature = signature;
  }
}
