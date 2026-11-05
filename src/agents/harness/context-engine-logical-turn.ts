import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  evaluateContextEngineHostSupport,
  supportsContextEngineDurableTurnAdvancement,
  type ContextEngineHostSupport,
} from "../../context-engine/host-compat.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import {
  hasSameContextEngineInstance,
  resolveLogicalTurnContextEngines,
} from "../../context-engine/registry.js";
import { disposeContextEngineSources } from "../../context-engine/registry.resources.js";
import type { ContextEngine, ContextEngineOperation } from "../../context-engine/types.js";
import { recordAgentCleanupFailure, runAgentCleanupStep } from "../run-cleanup-timeout.js";

type LogicalTurnSelectionState = "unselected" | "selected" | "started" | "handed-over" | "disposed";

type EffectiveContextEngineRef = Readonly<{
  engine: ContextEngine;
  registeredId: string;
  ownerPluginId?: string;
  mode: "configured" | "legacy-degraded";
  reason?: string;
}>;

export type ContextEngineLogicalTurnLease = {
  /** Compatibility getter for internal callers while the single context object is threaded. */
  readonly engine: ContextEngine;
  readonly effectiveEngine: ContextEngine;
  readonly effectiveEngineId: string;
  readonly effectiveEnginePluginId?: string;
  readonly degraded: boolean;
  readonly degradedReason?: string;
  readonly disposed: boolean;
  selectForHost: (params: {
    host: ContextEngineHostSupport;
    operation: ContextEngineOperation;
    requiresDurableCommit: boolean;
  }) => EffectiveContextEngineRef;
  degradeBeforeStart: (reason: string) => EffectiveContextEngineRef;
  begin: () => EffectiveContextEngineRef;
  /**
   * Hands a started turn to a reloaded plugin generation at a step boundary. It disposes
   * this generation's engines now, so the reload can drain them, and keeps the turn's
   * settlements for its end. `rebind()` then resolves the same engine id again.
   */
  handOver: () => Promise<void>;
  /** After `handOver()`, resolves the turn's engines from the current registry. */
  rebind: () => Promise<void>;
  onDispose: (key: string, settle: () => Promise<void>) => void;
  deferDisposalUntil: (promise: Promise<unknown>) => void;
  dispose: () => Promise<void>;
};

export async function createContextEngineLogicalTurnLease(params: {
  identity: { runId: string; sessionId: string };
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  awaitSessionDiffBaseline?: () => Promise<void>;
}): Promise<ContextEngineLogicalTurnLease> {
  const { runId, sessionId } = params.identity;
  const resolve = () =>
    resolveLogicalTurnContextEngines(params.config, {
      initialize: ensureContextEnginesInitialized,
      agentDir: params.agentDir,
      workspaceDir: params.workspaceDir,
      beforeCustomEngine: params.awaitSessionDiffBaseline,
      onCleanupFailure: recordAgentCleanupFailure,
    });
  let resolution = await resolve();
  let state: LogicalTurnSelectionState = "unselected";
  let effective = resolution.configured;
  let degradedReason = resolution.configuredFailure;
  let warned = false;
  const disposalHolds = new Set<Promise<unknown>>();
  const settlements = new Map<string, () => Promise<void>>();
  const isBaselineEngineSelection =
    resolution.configuredFailure === undefined &&
    resolution.configured.registeredId === resolution.fallback.registeredId;

  const asEffective = (): EffectiveContextEngineRef => ({
    ...effective,
    mode: degradedReason ? "legacy-degraded" : "configured",
    ...(degradedReason ? { reason: degradedReason } : {}),
  });

  const warnOnce = (reason: string) => {
    if (warned) {
      return;
    }
    warned = true;
    console.warn(
      `[context-engine] Context engine "${sanitizeForLog(resolution.configuredId)}" degraded to "${sanitizeForLog(resolution.fallback.registeredId)}" for this logical turn: ${sanitizeForLog(reason)}. ` +
        `The "${sanitizeForLog(resolution.fallback.registeredId)}" engine will handle only this turn; configuration is unchanged, and "${sanitizeForLog(resolution.configuredId)}" will be retried next turn.`,
    );
  };

  const degradeBeforeStart = (reason: string): EffectiveContextEngineRef => {
    if (state === "disposed") {
      throw new Error("context-engine logical turn selection is already pinned");
    }
    if (isBaselineEngineSelection) {
      if (state === "unselected") {
        state = "selected";
      }
      return asEffective();
    }
    if (state === "started") {
      throw new Error("context-engine logical turn selection is already pinned");
    }
    degradedReason ??= reason;
    effective = resolution.fallback;
    state = "selected";
    warnOnce(degradedReason);
    return asEffective();
  };

  const resolveSelectionIssue = (selection: {
    host: ContextEngineHostSupport;
    operation: ContextEngineOperation;
    requiresDurableCommit: boolean;
  }): string | undefined => {
    const support = evaluateContextEngineHostSupport({
      contextEngineInfo: effective.engine.info,
      operation: selection.operation,
      host: selection.host,
    });
    if (!support.ok) {
      return `host "${selection.host.id}" is missing ${support.missingCapabilities.join(", ")}`;
    }
    if (isBaselineEngineSelection) {
      // Legacy delegates durable transcript ownership to SessionManager, so only its
      // actual host requirements apply to repeated logical-turn selection.
      return undefined;
    }
    if (
      // A recorder-backed turn will be admitted during the run, so the declaration is required
      // whether or not the receipt exists yet at selection time. Gating this on the receipt alone
      // would let an engine that declares durable advancement but omits current-turn fencing run
      // on fresh turns, which the documented contract sends to legacy.
      selection.requiresDurableCommit &&
      effective.engine.info.transcriptSemantics?.currentTurnFence !== "before-current-turn-entry-v1"
    ) {
      return "current-turn transcript fencing is not declared";
    }
    if (
      selection.requiresDurableCommit &&
      !supportsContextEngineDurableTurnAdvancement(effective.engine)
    ) {
      return "atomic idempotent turn advancement is not declared";
    }
    return undefined;
  };

  if (resolution.configuredFailure) {
    degradeBeforeStart(resolution.configuredFailure);
  }

  // Dispose one resolution's distinct instances in parallel so their deadlines do not
  // stack. The shared helper records each failure before one-shot cleanup checks ownership.
  const disposeEngines = async (resolved: typeof resolution) => {
    const engines = [resolved.configured.engine, resolved.fallback.engine];
    const distinctEngines = engines.filter((engine, index) =>
      engines.slice(0, index).every((other) => !hasSameContextEngineInstance(engine, other)),
    );
    await Promise.allSettled(
      distinctEngines.map((engine) =>
        runAgentCleanupStep({
          runId,
          sessionId,
          step: "context-engine-dispose",
          log: { warn: console.warn },
          cleanup: async () => {
            const sources = new Set(
              engines
                .filter((other) => hasSameContextEngineInstance(engine, other))
                .flatMap((other) => resolved.sourceResources?.get(other) ?? []),
            );
            await disposeContextEngineSources(engine, [...sources]);
          },
        }),
      ),
    );
  };

  const lease: ContextEngineLogicalTurnLease = {
    get engine() {
      return effective.engine;
    },
    get effectiveEngine() {
      return effective.engine;
    },
    get effectiveEngineId() {
      return effective.registeredId;
    },
    get effectiveEnginePluginId() {
      return effective.ownerPluginId;
    },
    get degraded() {
      return degradedReason !== undefined;
    },
    get degradedReason() {
      return degradedReason;
    },
    get disposed() {
      return state === "disposed";
    },
    selectForHost(selection) {
      if (state === "disposed") {
        throw new Error("context-engine logical turn lease is already disposed");
      }
      if (degradedReason) {
        return asEffective();
      }
      const issue = resolveSelectionIssue(selection);
      if (issue) {
        if (state === "started") {
          throw new Error(
            `context-engine logical turn cannot change to incompatible ${selection.host.label}: ${issue}`,
          );
        }
        return degradeBeforeStart(issue);
      }
      if (state === "unselected") {
        state = "selected";
      }
      return asEffective();
    },
    degradeBeforeStart,
    begin() {
      if (state === "disposed") {
        throw new Error("context-engine logical turn lease is already disposed");
      }
      state = "started";
      return asEffective();
    },
    async handOver() {
      if (state !== "started") {
        return;
      }
      state = "handed-over";
      await disposeEngines(resolution);
    },
    async rebind() {
      if (state !== "handed-over") {
        return;
      }
      // Same config, so the same engine id; a rollback simply resolves the restored generation.
      const next = await resolve();
      if (!degradedReason && next.configuredFailure) {
        await disposeEngines(next);
        throw new Error(
          `context engine "${resolution.configuredId}" is unavailable after plugin reload: ${next.configuredFailure}`,
        );
      }
      resolution = next;
      effective = degradedReason ? next.fallback : next.configured;
      state = "started";
    },
    onDispose(key, settle) {
      if (state === "disposed") {
        throw new Error("context-engine logical turn lease is already disposed");
      }
      settlements.set(key, settle);
    },
    deferDisposalUntil(promise) {
      if (state === "disposed") {
        throw new Error("context-engine logical turn lease is already disposed");
      }
      disposalHolds.add(promise);
      void promise.finally(() => disposalHolds.delete(promise)).catch(() => {});
    },
    async dispose() {
      if (state === "disposed") {
        return;
      }
      // A turn that ends before rebinding released its engines when it was handed over.
      const ownsEngines = state !== "handed-over";
      state = "disposed";
      await Promise.all(
        [...settlements.values()].map((cleanup) =>
          runAgentCleanupStep({
            runId,
            sessionId,
            step: "context-engine-turn-settlement",
            log: { warn: console.warn },
            cleanup,
          }),
        ),
      );
      settlements.clear();
      if (!ownsEngines) {
        return;
      }
      if (disposalHolds.size > 0) {
        void Promise.allSettled(disposalHolds).then(() => disposeEngines(resolution));
        return;
      }
      await disposeEngines(resolution);
    },
  };
  return lease;
}
