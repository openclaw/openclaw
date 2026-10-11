import type { AcpRuntimeConfigOptionResult } from "@openclaw/acp-core/runtime/types";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { AcpRuntimeError, withAcpRuntimeErrorBoundary } from "../runtime/errors.js";
import {
  isRejectedThinkingConfigValue,
  resolveManagerRuntimeCapabilities,
} from "./manager.runtime-controls.js";
import type { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import type {
  AcpSessionRuntimeOptions,
  EnsureManagerRuntimeHandle,
  ResolveManagerSessionAsync,
  WriteManagerSessionMeta,
} from "./manager.types.js";
import {
  assertCurrentAcpActor,
  createUnsupportedControlError,
  requireReadySessionMeta,
} from "./manager.utils.js";
import {
  inferRuntimeOptionPatchFromConfigOption,
  mergeRuntimeOptions,
  reconcileAcceptedRuntimeOptions,
  resolveRuntimeConfigOptionKey,
  resolveRuntimeOptionsFromMeta,
} from "./runtime-options.js";

export type RuntimeOptionCommandServices = {
  runtimeHandles: ManagerRuntimeHandleCache;
  resolveSession: ResolveManagerSessionAsync;
  ensureRuntimeHandle: EnsureManagerRuntimeHandle;
  writeSessionMeta: WriteManagerSessionMeta;
  isCurrentActor: () => boolean;
};

type RuntimeOptionCommandContext = RuntimeOptionCommandServices & {
  assertActive?: () => void;
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId: string;
};

async function resolveRuntimeOptionSessionMeta(params: RuntimeOptionCommandContext) {
  const assertCurrent = () => {
    assertCurrentAcpActor(params.isCurrentActor(), params.sessionKey);
    params.assertActive?.();
  };
  assertCurrent();
  const resolution = await params.resolveSession({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    assertCurrent,
  });
  assertCurrent();
  return requireReadySessionMeta(resolution);
}

export async function runSetManagerSessionRuntimeMode(
  params: RuntimeOptionCommandContext & { runtimeMode: string },
): Promise<AcpSessionRuntimeOptions> {
  const resolvedMeta = await resolveRuntimeOptionSessionMeta(params);
  const { runtime, handle, meta } = await params.ensureRuntimeHandle({
    assertActive: params.assertActive,
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    meta: resolvedMeta,
    isCurrentActor: params.isCurrentActor,
  });
  params.assertActive?.();
  const capabilities = await resolveManagerRuntimeCapabilities({ runtime, handle });
  assertCurrentAcpActor(params.isCurrentActor(), params.sessionKey);
  if (!capabilities.controls.includes("session/set_mode") || !runtime.setMode) {
    throw createUnsupportedControlError({
      backend: handle.backend || meta.backend,
      control: "session/set_mode",
    });
  }

  await withAcpRuntimeErrorBoundary({
    run: async () => {
      assertCurrentAcpActor(params.isCurrentActor(), params.sessionKey);
      params.assertActive?.();
      await runtime.setMode!({
        handle,
        mode: params.runtimeMode,
      });
    },
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not update ACP runtime mode.",
  });
  assertCurrentAcpActor(params.isCurrentActor(), params.sessionKey);

  const nextOptions = mergeRuntimeOptions({
    current: resolveRuntimeOptionsFromMeta(meta),
    patch: { runtimeMode: params.runtimeMode },
  });
  await persistManagerRuntimeOptions({
    ...params,
    options: nextOptions,
  });
  return nextOptions;
}

export async function runSetManagerSessionConfigOption(
  params: RuntimeOptionCommandContext & {
    key: string;
    value: string;
    tolerateRejectedThinking?: boolean;
  },
): Promise<AcpSessionRuntimeOptions> {
  const resolvedMeta = await resolveRuntimeOptionSessionMeta(params);
  const { runtime, handle, meta } = await params.ensureRuntimeHandle({
    assertActive: params.assertActive,
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    meta: resolvedMeta,
    isCurrentActor: params.isCurrentActor,
  });
  params.assertActive?.();
  const inferredPatch = inferRuntimeOptionPatchFromConfigOption(params.key, params.value);
  const capabilities = await resolveManagerRuntimeCapabilities({
    runtime,
    handle,
    includeStatusConfigOptionKeys: true,
  });
  assertCurrentAcpActor(params.isCurrentActor(), params.sessionKey);
  if (!capabilities.controls.includes("session/set_config_option") || !runtime.setConfigOption) {
    throw createUnsupportedControlError({
      backend: handle.backend || meta.backend,
      control: "session/set_config_option",
    });
  }

  const advertisedKeys = new Set(
    (capabilities.configOptionKeys ?? [])
      .map((entry) => normalizeLowercaseStringOrEmpty(entry))
      .filter(Boolean),
  );
  const wireKey = resolveRuntimeConfigOptionKey(params.key, capabilities.configOptionKeys);
  if (advertisedKeys.size > 0 && !advertisedKeys.has(normalizeLowercaseStringOrEmpty(wireKey))) {
    throw new AcpRuntimeError(
      "ACP_BACKEND_UNSUPPORTED_CONTROL",
      `ACP backend "${handle.backend || meta.backend}" does not accept config key "${wireKey}".`,
    );
  }

  params.assertActive?.();
  let result: AcpRuntimeConfigOptionResult | void;
  try {
    result = await withAcpRuntimeErrorBoundary({
      run: async () =>
        await runtime.setConfigOption!({
          handle,
          key: wireKey,
          value: params.value,
        }),
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "Could not update ACP runtime config option.",
    });
  } catch (error) {
    // Automatic reconciliation replays an inherited thinking level the adapter may
    // not be able to name. Keep the accepted selection instead of failing the
    // caller; explicit operator commands still surface the rejection, and so does
    // an adapter that cannot take the control at all.
    if (params.tolerateRejectedThinking && isRejectedThinkingConfigValue(wireKey, error)) {
      return resolveRuntimeOptionsFromMeta(meta);
    }
    throw error;
  }
  assertCurrentAcpActor(params.isCurrentActor(), params.sessionKey);

  const nextOptions = reconcileAcceptedRuntimeOptions(
    mergeRuntimeOptions({ current: resolveRuntimeOptionsFromMeta(meta), patch: inferredPatch }),
    result,
  );
  await persistManagerRuntimeOptions({
    ...params,
    options: nextOptions,
  });
  return nextOptions;
}

export async function runUpdateManagerSessionRuntimeOptions(
  params: RuntimeOptionCommandContext & { patch: Partial<AcpSessionRuntimeOptions> },
): Promise<AcpSessionRuntimeOptions> {
  const resolvedMeta = await resolveRuntimeOptionSessionMeta(params);
  const nextOptions = mergeRuntimeOptions({
    current: resolveRuntimeOptionsFromMeta(resolvedMeta),
    patch: params.patch,
  });
  await persistManagerRuntimeOptions({
    ...params,
    assertCommitAllowed: params.assertActive,
    options: nextOptions,
  });
  return nextOptions;
}

export async function runResetManagerSessionRuntimeOptions(
  params: RuntimeOptionCommandContext,
): Promise<AcpSessionRuntimeOptions> {
  await resolveRuntimeOptionSessionMeta(params);
  const cached = params.runtimeHandles.get(params);
  if (cached) {
    await withAcpRuntimeErrorBoundary({
      run: async () => {
        assertCurrentAcpActor(params.isCurrentActor(), params.sessionKey);
        params.assertActive?.();
        await cached.runtime.close({
          handle: cached.handle,
          reason: "reset-runtime-options",
        });
      },
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "Could not reset ACP runtime options.",
    });
    assertCurrentAcpActor(params.isCurrentActor(), params.sessionKey);
    params.runtimeHandles.clearIfHandleMatches({ ...params, handle: cached.handle });
  }
  await persistManagerRuntimeOptions({
    ...params,
    // Closing an admitted handle owns its settlement; a metadata-only reset still needs authority.
    assertCommitAllowed: cached ? undefined : params.assertActive,
    options: {},
  });
  return {};
}

async function persistManagerRuntimeOptions(
  params: Pick<
    RuntimeOptionCommandContext,
    "cfg" | "sessionKey" | "agentId" | "runtimeHandles" | "writeSessionMeta" | "isCurrentActor"
  > & {
    assertCommitAllowed?: () => void;
    options: AcpSessionRuntimeOptions;
  },
): Promise<void> {
  const options = params.options;
  const hasOptions = Object.keys(options).length > 0;
  assertCurrentAcpActor(params.isCurrentActor(), params.sessionKey);
  await params.writeSessionMeta({
    assertCommitAllowed: params.assertCommitAllowed,
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    isCurrentActor: params.isCurrentActor,
    mutate: (current, entry) => {
      if (!entry || !current) {
        return null;
      }
      return {
        backend: current.backend,
        agent: current.agent,
        runtimeSessionName: current.runtimeSessionName,
        ...(current.identity ? { identity: current.identity } : {}),
        mode: current.mode,
        runtimeOptions: hasOptions ? options : undefined,
        cwd: options.cwd,
        state: current.state,
        lastActivityAt: Date.now(),
        ...(current.lastError ? { lastError: current.lastError } : {}),
      };
    },
    failOnError: true,
  });
  assertCurrentAcpActor(params.isCurrentActor(), params.sessionKey);

  const cached = params.runtimeHandles.get(params);
  if (!cached) {
    return;
  }
  // Persisting options does not guarantee this process pushed all controls to the runtime.
  // Force the next turn to reconcile runtime controls from persisted metadata.
  cached.appliedControlSignature = undefined;
}
