/** Command handlers for changing ACP runtime mode and config options on live sessions. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { AcpRuntimeError, withAcpRuntimeErrorBoundary } from "../runtime/errors.js";
import { resolveManagerRuntimeCapabilities } from "./manager.runtime-controls.js";
import type { ManagerRuntimeHandleCache } from "./manager.runtime-handle-cache.js";
import { createSupersededActorError } from "./manager.runtime-handle-ensure.js";
import type {
  AcpSessionRuntimeOptions,
  EnsureManagerRuntimeHandle,
  ResolveManagerSession,
  WriteManagerSessionMeta,
} from "./manager.types.js";
import { createUnsupportedControlError, requireReadySessionMeta } from "./manager.utils.js";
import {
  inferRuntimeOptionPatchFromConfigOption,
  mergeRuntimeOptions,
  normalizeRuntimeOptions,
  reconcileAcceptedRuntimeOptions,
  resolveRuntimeConfigOptionKey,
  resolveRuntimeOptionsFromMeta,
} from "./runtime-options.js";

/** Manager services required by runtime-option command handlers. */
export type RuntimeOptionCommandServices = {
  runtimeHandles: ManagerRuntimeHandleCache;
  resolveSession: ResolveManagerSession;
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

function resolveRuntimeOptionSessionMeta(params: RuntimeOptionCommandContext) {
  if (!params.isCurrentActor()) {
    throw createSupersededActorError(params.sessionKey);
  }
  params.assertActive?.();
  return requireReadySessionMeta(
    params.resolveSession({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
    }),
  );
}

/** Applies a backend runtime mode control and persists the selected mode. */
export async function runSetManagerSessionRuntimeMode(
  params: RuntimeOptionCommandContext & { runtimeMode: string },
): Promise<AcpSessionRuntimeOptions> {
  const resolvedMeta = resolveRuntimeOptionSessionMeta(params);
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
  if (!params.isCurrentActor()) {
    throw createSupersededActorError(params.sessionKey);
  }
  if (!capabilities.controls.includes("session/set_mode") || !runtime.setMode) {
    throw createUnsupportedControlError({
      backend: handle.backend || meta.backend,
      control: "session/set_mode",
    });
  }

  await withAcpRuntimeErrorBoundary({
    run: async () => {
      if (!params.isCurrentActor()) {
        throw createSupersededActorError(params.sessionKey);
      }
      params.assertActive?.();
      await runtime.setMode!({
        handle,
        mode: params.runtimeMode,
      });
    },
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not update ACP runtime mode.",
  });
  if (!params.isCurrentActor()) {
    throw createSupersededActorError(params.sessionKey);
  }

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

/** Applies a backend config-option control and persists the inferred runtime option patch. */
export async function runSetManagerSessionConfigOption(
  params: RuntimeOptionCommandContext & { key: string; value: string },
): Promise<AcpSessionRuntimeOptions> {
  const resolvedMeta = resolveRuntimeOptionSessionMeta(params);
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
  if (!params.isCurrentActor()) {
    throw createSupersededActorError(params.sessionKey);
  }
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
  const result = await withAcpRuntimeErrorBoundary({
    run: async () =>
      await runtime.setConfigOption!({
        handle,
        key: wireKey,
        value: params.value,
      }),
    fallbackCode: "ACP_TURN_FAILED",
    fallbackMessage: "Could not update ACP runtime config option.",
  });
  if (!params.isCurrentActor()) {
    throw createSupersededActorError(params.sessionKey);
  }

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

/** Persists runtime option changes that do not need an immediate backend control call. */
export async function runUpdateManagerSessionRuntimeOptions(
  params: RuntimeOptionCommandContext & { patch: Partial<AcpSessionRuntimeOptions> },
): Promise<AcpSessionRuntimeOptions> {
  const resolvedMeta = resolveRuntimeOptionSessionMeta(params);
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

/** Closes the current runtime handle and clears persisted runtime options. */
export async function runResetManagerSessionRuntimeOptions(
  params: RuntimeOptionCommandContext,
): Promise<AcpSessionRuntimeOptions> {
  resolveRuntimeOptionSessionMeta(params);
  const cached = params.runtimeHandles.get(params);
  if (cached) {
    await withAcpRuntimeErrorBoundary({
      run: async () =>
        await cached.runtime.close({
          handle: cached.handle,
          reason: "reset-runtime-options",
        }),
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "Could not reset ACP runtime options.",
    });
    if (!params.isCurrentActor()) {
      throw createSupersededActorError(params.sessionKey);
    }
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
  const normalized = normalizeRuntimeOptions(params.options);
  const hasOptions = Object.keys(normalized).length > 0;
  if (!params.isCurrentActor()) {
    throw createSupersededActorError(params.sessionKey);
  }
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
        runtimeOptions: hasOptions ? normalized : undefined,
        cwd: normalized.cwd,
        state: current.state,
        lastActivityAt: Date.now(),
        ...(current.lastError ? { lastError: current.lastError } : {}),
      };
    },
    failOnError: true,
  });
  if (!params.isCurrentActor()) {
    throw createSupersededActorError(params.sessionKey);
  }

  const cached = params.runtimeHandles.get(params);
  if (!cached) {
    return;
  }
  // Persisting options does not guarantee this process pushed all controls to the runtime.
  // Force the next turn to reconcile runtime controls from persisted metadata.
  cached.appliedControlSignature = undefined;
}
