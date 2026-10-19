import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  updateSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { prepareConsumedSessionSendSource } from "../../gateway/session-send-recovery-source.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { acceptCompactionSuccessor } from "../embedded-agent-runner/compaction-successor.js";
import { markStartupOrphanedMainSessionsForRecovery } from "./main-session-restart-recovery-marking.js";
import { seedConsumedPeerRestartInput } from "./main-session-restart-recovery-peer-source.test-support.js";
import { recoverStore } from "./main-session-restart-recovery-store.js";

afterEach(() => {
  testing.resetSessionControllerForTest();
  resetGatewayWorkAdmission();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

it.each(["exact", "legacy"] as const)(
  "restores the %s peer source when the recovery run ID is also a legacy transcript key",
  async (selected) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
      const endpoint = (name: string) => ({
        agentId: "main",
        sessionKey: `agent:main:${name}`,
        sessionId: `${name}-session`,
        lifecycleRevision: `${name}-generation`,
        storePath,
      });
      const legacy = endpoint("legacy-source");
      const exact = endpoint("exact-source");
      const target = endpoint("collision-target");
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
        session: { store: storePath, communication: { send: "always", receive: "always" } },
        tools: { sessions: { visibility: "all" } },
      };
      setRuntimeConfigSnapshot(cfg);
      await seedConsumedPeerRestartInput({ cfg, source: legacy, target, runId: "foo" });
      if (selected === "exact") {
        await seedConsumedPeerRestartInput({ cfg, source: exact, target, runId: "foo:user" });
      }
      const recovered = expectDefined(
        await prepareConsumedSessionSendSource({
          config: cfg,
          target,
          sourceRunId: "foo:user",
          assertCurrent() {},
        }),
        "selected peer source",
      );
      try {
        if (selected === "exact") {
          await updateSessionEntry(legacy, () => ({ communication: { send: "never" } }));
          expect(() => recovered.source()).not.toThrow();
          await updateSessionEntry(legacy, () => ({ communication: { send: "always" } }));
        }
        await updateSessionEntry(selected === "exact" ? exact : legacy, () => ({
          communication: { send: "never" },
        }));
        expect(() => recovered.source()).toThrow();
        expect(
          await prepareConsumedSessionSendSource({
            config: cfg,
            target,
            sourceRunId: "foo:user",
            assertCurrent() {},
          }),
        ).toBeUndefined();
      } finally {
        recovered.release();
      }
    });
  },
);

it.each(["permission", "replacement"] as const)(
  "keeps consumed peer authority through committed compaction without bypassing %s revocation",
  async (revocation) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
      const source = {
        agentId: "main",
        sessionKey: "agent:main:compaction-source",
        sessionId: "compaction-source-session",
        lifecycleRevision: "compaction-source-generation",
        storePath,
      };
      const target = {
        ...source,
        sessionKey: "agent:main:compaction-target",
        sessionId: "compaction-target-session",
        lifecycleRevision: "compaction-target-generation",
      };
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
        session: { store: storePath, communication: { send: "always", receive: "always" } },
        tools: { sessions: { visibility: "all" } },
      };
      setRuntimeConfigSnapshot(cfg);
      await seedConsumedPeerRestartInput({ cfg, source, target, runId: "compacting-peer-input" });
      const recovered = expectDefined(
        await prepareConsumedSessionSendSource({
          config: cfg,
          target,
          sourceRunId: "compacting-peer-input",
          assertCurrent() {},
        }),
        "consumed peer source",
      );
      try {
        const entry = expectDefined(loadSessionEntry(target), "compaction target");
        const compacted = await acceptCompactionSuccessor({
          currentTarget: target,
          expectedEntry: {
            sessionId: entry.sessionId,
            lifecycleRevision: entry.lifecycleRevision,
            activeWriterRunId: entry.activeWriterRunId,
          },
          assertActive: recovered.source,
          config: cfg,
          result: {
            ok: true,
            compacted: true,
            result: { tokensBefore: 100, tokensAfter: 50, sessionId: "compacted-peer-session" },
          },
        });
        expect(compacted.sessionId).toBe("compacted-peer-session");
        expect(() => recovered.source()).not.toThrow();
        if (revocation === "permission") {
          await updateSessionEntry(source, () => ({ communication: { send: "never" } }));
        } else {
          await updateSessionEntry(target, () => ({ sessionId: "replacement-peer-session" }));
        }
        expect(() => recovered.source()).toThrow();
      } finally {
        recovered.release();
      }
    });
  },
);

it.each(["reset", "archive", "deny"] as const)(
  "settles a consumed peer input once when its sender changes before recovery: %s",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
      const source = {
        agentId: "main",
        sessionKey: "agent:main:revoked-source",
        sessionId: "revoked-source-session",
        lifecycleRevision: "revoked-source-generation",
        storePath,
      };
      const target = {
        ...source,
        sessionKey: "agent:main:revoked-target",
        sessionId: "revoked-target-session",
        lifecycleRevision: "revoked-target-generation",
      };
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
        session: { store: storePath, communication: { send: "always", receive: "always" } },
        tools: { sessions: { visibility: "all" } },
      };
      setRuntimeConfigSnapshot(cfg);
      const { originalTranscript } = await seedConsumedPeerRestartInput({
        cfg,
        source,
        target,
        runId: "revoked-peer-input",
      });
      await cleanupSessionStateForTest({ stateDir: state.stateDir });
      rotateAgentEventLifecycleGeneration();
      await markStartupOrphanedMainSessionsForRecovery({ cfg, stateDir: state.stateDir });
      await updateSessionEntry(source, () =>
        change === "reset"
          ? { sessionId: "replacement-source-session", lifecycleRevision: "replacement-generation" }
          : change === "archive"
            ? { archivedAt: Date.now() }
            : { communication: { send: "never" } },
      );
      const runtime: GatewayRecoveryRuntime = {
        prepareRestartRecovery: () => undefined,
        dispatchSessionMethod: vi.fn(),
        waitForAgent: vi.fn(),
        sendRecoveryNotice: vi.fn(async () => ({ suppressed: false })),
        dispatchAgent: vi.fn(),
      };
      const recover = () =>
        recoverStore({
          storeAgentId: target.agentId,
          storePath,
          cfg,
          handledSessionKeys: new Set(),
          gatewayRuntime: runtime,
        });
      expect(await recover()).toEqual({ started: 0, settled: 1, failed: 0, skipped: 0 });
      expect(runtime.dispatchAgent).not.toHaveBeenCalled();
      const settledTranscript = await loadTranscriptEvents(target);
      expect(settledTranscript).toHaveLength(originalTranscript.length + 1);
      expect(JSON.stringify(settledTranscript.at(-1))).toContain(
        "This interrupted turn could not resume after the Gateway restarted",
      );
      expect(loadSessionEntry(target)).toMatchObject({ status: "interrupted" });
      expect(loadSessionEntry(target)?.mainRestartRecovery?.tombstone).toBeUndefined();
      expect(await recover()).toEqual({ started: 0, settled: 0, failed: 0, skipped: 0 });
      expect(await loadTranscriptEvents(target)).toEqual(settledTranscript);
    });
  },
);

it("leaves authenticated consumed inputs to their private requester recovery owner", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
      session: { store: storePath, communication: { send: "always", receive: "always" } },
      tools: { sessions: { visibility: "all" } },
    };
    setRuntimeConfigSnapshot(cfg);
    for (const kind of ["channel", "operator"] as const) {
      const source = {
        agentId: "main",
        sessionKey: `agent:main:authenticated-source-${kind}`,
        sessionId: `authenticated-source-${kind}`,
        lifecycleRevision: `source-generation-${kind}`,
        storePath,
      };
      const target = {
        agentId: "main",
        sessionKey: `agent:main:authenticated-target-${kind}`,
        sessionId: `authenticated-target-${kind}`,
        lifecycleRevision: `target-generation-${kind}`,
        storePath,
      };
      const runId = `authenticated-peer-${kind}`;
      const { receiver, originalTranscript } = await seedConsumedPeerRestartInput({
        cfg,
        source,
        target,
        runId,
        requesterOrigin: {
          sessionKey: source.sessionKey,
          ...(kind === "channel"
            ? { messageProvider: "telegram", senderId: "fixture-requester" }
            : { operatorProfileId: "fixture-operator" }),
        },
      });
      expect(
        await prepareConsumedSessionSendSource({
          config: cfg,
          target,
          sourceRunId: runId,
          assertCurrent() {},
        }),
      ).toBeUndefined();
      expect(receiver).toHaveBeenCalledOnce();
      expect(await loadTranscriptEvents(target)).toEqual(originalTranscript);
    }
  });
});

it("recovers a consumed peer input through two process losses without replaying the input", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
    const source = {
      agentId: "main",
      sessionKey: "agent:main:peer-source",
      sessionId: "peer-source-session",
      lifecycleRevision: "peer-source-generation",
    };
    const target = {
      agentId: "main",
      sessionKey: "agent:main:peer-target",
      sessionId: "peer-target-session",
      lifecycleRevision: "peer-target-generation",
      storePath,
    };
    const cfg: OpenClawConfig = {
      agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
      session: { store: storePath, communication: { send: "always", receive: "always" } },
      tools: { sessions: { visibility: "all" } },
    };
    setRuntimeConfigSnapshot(cfg);
    const { receiver, originalTranscript } = await seedConsumedPeerRestartInput({
      cfg,
      source: { ...source, storePath },
      target,
      runId: "accepted-peer-input",
    });

    const dispatchGate = createDeferred();
    const finalDispatchGate = createDeferred();
    const dispatches: string[] = [];
    const skipped: string[] = [];
    let current = true;
    const runtime: GatewayRecoveryRuntime = {
      prepareRestartRecovery: () => undefined,
      dispatchSessionMethod: vi.fn(),
      waitForAgent: vi.fn(),
      sendRecoveryNotice: vi.fn(async () => ({ suppressed: false })),
      dispatchAgent: async <T>(
        request: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[0],
        _timeout?: number,
        options?: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[2],
      ) => {
        await options?.prepareDispatchCurrent?.();
        options?.assertAdmissionCurrent?.();
        dispatches.push(request.message);
        options?.onStartOwner?.({
          observe: () => ({ executionStarted: true }),
          abort: () => false,
        });
        options?.onAccepted?.({ runId: request.idempotencyKey, status: "accepted" });
        options?.onExecutionStarted?.();
        await (dispatches.length === 1 ? dispatchGate.promise : finalDispatchGate.promise);
        return { runId: request.idempotencyKey, status: "ok" } as T;
      },
    };
    const recover = () =>
      recoverStore({
        storeAgentId: target.agentId,
        storePath,
        cfg,
        handledSessionKeys: new Set(),
        gatewayRuntime: runtime,
        onSkipped: (reason) => skipped.push(reason),
        shouldContinue: () => current,
      });
    try {
      await cleanupSessionStateForTest({ stateDir: state.stateDir });
      rotateAgentEventLifecycleGeneration();
      await markStartupOrphanedMainSessionsForRecovery({ cfg, stateDir: state.stateDir });
      const firstRecovery = await recover();
      expect(skipped).toEqual([]);
      expect(firstRecovery).toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
      expect(loadSessionEntry(target)?.mainRestartRecovery?.tombstone).toBeUndefined();
      // The admitted continuation vanishes without a terminal owner receipt.
      current = false;
      dispatchGate.resolve();
      await cleanupSessionStateForTest({ stateDir: state.stateDir });
      testing.resetSessionControllerForTest();
      rotateAgentEventLifecycleGeneration();
      current = true;
      await markStartupOrphanedMainSessionsForRecovery({ cfg, stateDir: state.stateDir });
      expect(await recover()).toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
      expect(dispatches).toHaveLength(2);
      expect(
        dispatches.every((prompt) => prompt.includes("Your previous turn was interrupted")),
      ).toBe(true);
      expect(receiver).toHaveBeenCalledOnce();
      finalDispatchGate.resolve();
      await vi.waitFor(() => {
        expect(loadSessionEntry(target)).toMatchObject({ abortedLastRun: false });
      });
      expect(loadSessionEntry(target)?.mainRestartRecovery?.tombstone).toBeUndefined();
      expect(await loadTranscriptEvents(target)).toEqual(originalTranscript);
    } finally {
      current = false;
      dispatchGate.resolve();
      finalDispatchGate.resolve();
    }
  });
});
