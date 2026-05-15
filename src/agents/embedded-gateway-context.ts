// Minimal GatewayRequestContext for embedded local agent runs (e.g.
// `openclaw agent --local`, gateway-timeout fallback, gateway-transport
// fallback). Installed as the fallback gateway context for the duration of
// the embedded run so that in-process gateway dispatch -- routed there by
// #81383 (subagent announce handoff) and similar handoffs -- has a context
// to read.
//
// Fixes #82140: regression where `--local` runs would fail subagent
// completion announce with "In-process gateway dispatch requires a gateway
// request scope (method: agent). No scope set and no fallback context
// available."
//
// Design notes:
//   - Embedded mode has no connected gateway clients, so broadcast / node-
//     subscribe / connId-tracking functions are no-ops.
//   - Mutable Maps are fresh per run (no cross-run sharing -- embedded runs
//     do not have concurrent peers in the same process scope).
//   - getRuntimeConfig is wired to the real config getter so dispatched
//     methods see the running config.
//   - SubsystemLogger and logHealth route through the embedded run's runtime
//     logger so messages still surface, just without WS broadcast.

import type { CliDeps } from "../cli/deps.types.js";
import { getRuntimeConfig } from "../config/config.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { setFallbackGatewayContext } from "../gateway/server-plugins.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { RuntimeEnv } from "../runtime.js";

/**
 * Build a minimal GatewayRequestContext suitable for embedded agent runs.
 *
 * The returned context satisfies the type-check on
 * `dispatchGatewayMethodInProcessRaw` and provides functional state Maps
 * plus no-op broadcast hooks. Fields that only matter when a real gateway
 * server is running (subscriber tracking, voice-wake broadcasts, channel
 * lifecycle, wizard runner) are stubbed as no-ops or harmless defaults.
 *
 * `deps` should be threaded through from the CLI command. The agent method
 * handler reads `context.deps` when dispatching follow-up agent runs (see
 * `server-methods/agent.ts: agentCommandFromIngress(..., params.context.deps)`).
 *
 * The following fields are intentionally undefined / empty for embedded mode
 * and should never be accessed by code paths that fire during embedded
 * runs: `cron`, `cronStorePath`, `nodeRegistry`. Subagent announce delivery
 * (the primary path #82140 covers) does not touch them.
 */
export function buildEmbeddedGatewayContext(params: {
  runtime: RuntimeEnv;
  deps?: CliDeps;
}): GatewayRequestContext {
  const logSubsystem = createSubsystemLogger("agent/embedded");
  const noop = () => {};
  const noopAsync = async () => {};
  const emptyReadonlySet: ReadonlySet<string> = new Set();

  return {
    deps: params.deps ?? ({} as unknown as GatewayRequestContext["deps"]),
    cron: undefined as unknown as GatewayRequestContext["cron"],
    cronStorePath: "",
    getRuntimeConfig,
    loadGatewayModelCatalog: async () => [],
    getHealthCache: () => null,
    refreshHealthSnapshot: async () =>
      ({}) as unknown as Awaited<ReturnType<GatewayRequestContext["refreshHealthSnapshot"]>>,
    logHealth: { error: (message: string) => logSubsystem.error(message) },
    logGateway: logSubsystem,
    incrementPresenceVersion: () => 0,
    getHealthVersion: () => 0,
    broadcast: noop as unknown as GatewayRequestContext["broadcast"],
    broadcastToConnIds: noop as unknown as GatewayRequestContext["broadcastToConnIds"],
    nodeSendToSession: noop,
    nodeSendToAllSubscribed: noop,
    nodeSubscribe: noop,
    nodeUnsubscribe: noop,
    nodeUnsubscribeAll: noop,
    hasConnectedTalkNode: () => false,
    nodeRegistry: {} as unknown as GatewayRequestContext["nodeRegistry"],
    agentRunSeq: new Map(),
    chatAbortControllers: new Map(),
    chatAbortedRuns: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    chatDeltaLastBroadcastLen: new Map(),
    chatDeltaLastBroadcastText: new Map(),
    agentDeltaSentAt: new Map(),
    bufferedAgentEvents: new Map(),
    addChatRun: noop,
    removeChatRun: () => undefined,
    subscribeSessionEvents: noop,
    unsubscribeSessionEvents: noop,
    subscribeSessionMessageEvents: noop,
    unsubscribeSessionMessageEvents: noop,
    unsubscribeAllSessionEvents: noop,
    getSessionEventSubscriberConnIds: () => emptyReadonlySet,
    registerToolEventRecipient: noop,
    dedupe: new Map(),
    wizardSessions: new Map(),
    findRunningWizard: () => null,
    purgeWizardSession: noop,
    getRuntimeSnapshot: () =>
      ({}) as unknown as ReturnType<GatewayRequestContext["getRuntimeSnapshot"]>,
    startChannel: noopAsync,
    stopChannel: noopAsync,
    markChannelLoggedOut: noop,
    wizardRunner: noopAsync,
    broadcastVoiceWakeChanged: noop,
    broadcastVoiceWakeRoutingChanged: noop,
  };
}

/**
 * Run `work` with an embedded gateway context installed as the fallback.
 * Cleans up the fallback after `work` resolves (success or failure).
 *
 * Useful for tests and scoped scenarios where the context must not outlive
 * the wrapped work. Not appropriate for CLI entry points: subagent
 * completion announce can fire AFTER the parent's `agentCommand` returns
 * from a `sessions_yield` turn, by which time the cleanup would have run.
 * Use `ensureEmbeddedGatewayContextInstalledForProcess` for CLI entry.
 */
export async function withEmbeddedGatewayContext<T>(
  params: { runtime: RuntimeEnv; deps?: CliDeps },
  work: () => Promise<T>,
): Promise<T> {
  const cleanup = setFallbackGatewayContext(buildEmbeddedGatewayContext(params));
  try {
    return await work();
  } finally {
    cleanup();
  }
}

/**
 * Install the embedded gateway context as a process-scoped fallback.
 *
 * Designed for CLI entry points where the process exits when the command
 * completes -- no cleanup necessary. This is the production wiring used
 * by `agentCliCommand` to ensure subagent completion announce delivery
 * has a context even when it fires asynchronously AFTER the parent's
 * `agentCommand` returns from a `sessions_yield` turn.
 *
 * Returns the cleanup function from `setFallbackGatewayContext` for tests
 * that need to revert state between cases. CLI callers can discard it.
 */
export function ensureEmbeddedGatewayContextInstalledForProcess(params: {
  runtime: RuntimeEnv;
  deps?: CliDeps;
}): () => void {
  return setFallbackGatewayContext(buildEmbeddedGatewayContext(params));
}
