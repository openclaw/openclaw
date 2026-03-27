/**
 * Stream Provider Registry
 *
 * A global singleton that allows plugins to register custom StreamFn factories
 * for any non-standard API type — including custom transports, proprietary
 * protocols, and browser-session endpoints.
 *
 * The registry is queried in `pi-embedded-runner/run/attempt.ts` during the
 * streamFn selection phase. If a registered factory matches `model.api`, it
 * replaces the default `streamSimple` path — allowing plugins to ship any
 * custom transport (HTTP, WebSocket, browser-session, etc.) without forking OpenClaw.
 *
 * Lifecycle:
 *   - Plugins call `registerPluginStreamProvider()` inside their `register()`
 *     callback, which runs at Gateway startup (plugin load phase).
 *   - `resolvePluginStreamFn()` is called once per agent run attempt, after the
 *     model is resolved and before the session is created.
 *
 * Thread-safety: Node.js is single-threaded; no locking is needed.
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AuthStorage } from "@mariozechner/pi-coding-agent";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("stream-provider-registry");

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Context passed to the factory when a stream function is being resolved for
 * an agent run.  Mirrors the information available in `attempt.ts` at the
 * point where `activeSession.agent.streamFn` is set.
 */
export type StreamProviderResolveContext = {
  /** The `model.api` string from the resolved model (e.g. `"my-web-provider"`). */
  api: string;
  /** The provider id (e.g. `"my-web-provider"`). */
  provider: string;
  /** The model id (e.g. `"my-model-id"`). */
  modelId: string;
  /** AuthStorage instance — used to retrieve stored credentials. */
  authStorage: AuthStorage;
  /** Current session id. */
  sessionId: string;
  /** Abort signal for the run. Always set by the runtime; may be omitted in tests. */
  signal?: AbortSignal;
};

/**
 * A factory function that accepts the resolve context and returns a StreamFn
 * (or null/undefined to skip and fall back to the next provider or streamSimple).
 *
 * The factory *may* be async — the caller awaits it.
 */
export type StreamFnFactory = (
  ctx: StreamProviderResolveContext,
) => StreamFn | null | undefined | Promise<StreamFn | null | undefined>;

/** Internal registration record. */
type StreamProviderRegistration = {
  pluginId: string;
  apiId: string;
  factory: StreamFnFactory;
};

// ── Global singleton via Symbol ────────────────────────────────────────────

const REGISTRY_KEY = Symbol.for("openclaw.agents.stream-provider-registry");

type RegistryState = {
  providers: StreamProviderRegistration[];
};

function getState(): RegistryState {
  const g = globalThis as typeof globalThis & {
    [REGISTRY_KEY]?: RegistryState;
  };
  return (g[REGISTRY_KEY] ??= { providers: [] });
}

// ── Public API (called by plugin registry infrastructure) ──────────────────

/**
 * Register a StreamFn factory for a given API identifier.
 * Called from `PluginRegistry.registerStreamProvider()` during plugin load.
 *
 * Same-plugin re-registrations refresh the factory silently (e.g. on gateway
 * reload or multiple resolvePluginProviders calls within one session).
 * Cross-plugin duplicate registrations are rejected with a warning
 * (first-writer wins, same policy as provider/channel registration).
 */

/**
 * Remove all stream provider registrations belonging to a plugin.
 *
 * Call this before re-registering a plugin's providers so that stale
 * factories from a previous load cycle do not block new registrations.
 */
export function unregisterPluginStreamProviders(pluginId: string): void {
  const state = getState();
  state.providers = state.providers.filter((p) => p.pluginId !== pluginId);
}

export function registerPluginStreamProvider(
  pluginId: string,
  apiId: string,
  factory: StreamFnFactory,
): boolean {
  const state = getState();
  const existing = state.providers.find((p) => p.apiId === apiId);
  if (existing) {
    if (existing.pluginId === pluginId) {
      // Same plugin re-registering (e.g. gateway reload or multiple resolvePluginProviders
      // calls within one session). Refresh the factory silently — no warning needed.
      existing.factory = factory;
      return true;
    }
    log.warn(
      `[stream-provider-registry] apiId "${apiId}" already registered by plugin` +
        ` "${existing.pluginId}" — ignoring duplicate from "${pluginId}"`,
    );
    return false;
  }
  state.providers.push({ pluginId, apiId, factory });
  log.info(
    `[stream-provider-registry] registered stream provider: apiId="${apiId}" plugin="${pluginId}"`,
  );
  return true;
}

/**
 * Resolve a StreamFn for the given resolve context.
 *
 * Returns the first matching StreamFn, or `null` if no plugin has registered
 * a factory for `ctx.api`.  The caller falls through to `streamSimple` on null.
 *
 * Called from `attempt.ts` in the streamFn selection block.
 */
export async function resolvePluginStreamFn(
  ctx: StreamProviderResolveContext,
): Promise<StreamFn | null> {
  const state = getState();
  const registration = state.providers.find((p) => p.apiId === ctx.api);
  if (!registration) {
    return null;
  }
  try {
    const result = await registration.factory(ctx);
    if (result == null) {
      log.info(
        `[stream-provider-registry] factory for "${ctx.api}" (plugin "${registration.pluginId}")` +
          ` returned null — falling back to streamSimple (credentials likely not set)`,
      );
      return null;
    }
    return result;
  } catch (err) {
    log.warn(
      `[stream-provider-registry] factory for "${ctx.api}" (plugin "${registration.pluginId}")` +
        ` threw: ${err instanceof Error ? err.message : String(err)} — falling back to streamSimple`,
    );
    return null;
  }
}

/**
 * Check whether any plugin has registered a factory for the given api id.
 * Cheap O(n) check used to decide whether to await resolvePluginStreamFn.
 */
export function hasPluginStreamProvider(apiId: string): boolean {
  return getState().providers.some((p) => p.apiId === apiId);
}

/**
 * Find the registration for a given api id without resolving the factory.
 * Avoids a double linear scan when existence check and resolution
 * are needed at the same call site.
 */
export function findPluginStreamProvider(api: string): StreamProviderRegistration | undefined {
  return getState().providers.find((p) => p.apiId === api);
}

/**
 * Reset the registry (test isolation only — not exported from plugin-sdk).
 *
 * @internal Test isolation only — not exported from plugin-sdk.
 *
 * @internal Test isolation only — not exported from plugin-sdk.
 *
 * Usage in vitest:
 * ```ts
 * import { resetPluginStreamProviderRegistry } from "../../agents/stream-provider-registry.js";
 * beforeEach(() => resetPluginStreamProviderRegistry());
 * ```
 */
export function resetPluginStreamProviderRegistry(): void {
  getState().providers = [];
}
