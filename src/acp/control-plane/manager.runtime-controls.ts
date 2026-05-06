import { AcpRuntimeError, withAcpRuntimeErrorBoundary } from "../runtime/errors.js";
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
        await params.runtime.setMode({
          handle: params.handle,
          mode: runtimeMode,
        });
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
        // Only send options the backend explicitly advertised; if backend did not
        // advertise its supported keys, skip sending any to avoid sending unsupported
        // options to backends like Claude ACP that reject unknown keys.
        if (advertisedKeys.size > 0) {
          const filteredOptions = configOptions.filter(([key]) => advertisedKeys.has(key));
          for (const [key, value] of filteredOptions) {
            await params.runtime.setConfigOption({
              handle: params.handle,
              key,
              value,
            });
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
