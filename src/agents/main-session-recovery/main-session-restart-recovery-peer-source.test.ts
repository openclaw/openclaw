import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as sessions from "../../config/sessions/session-accessor.js";
import * as transcript from "../../config/sessions/transcript.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { prepareConsumedSessionSendSource } from "../../gateway/session-send-recovery-source.js";
import { rotateAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { acceptCompactionSuccessor } from "../embedded-agent-runner/compaction-successor.js";
import { markStartupOrphanedMainSessionsForRecovery } from "./main-session-restart-recovery-marking.js";
import { seedConsumedPeerRestartInput } from "./main-session-restart-recovery-peer-source.test-support.js";
import { recoverStore } from "./main-session-restart-recovery-store.js";

type Dispatch = GatewayRecoveryRuntime["dispatchAgent"];
afterEach(() => {
  testing.resetSessionControllerForTest();
  resetGatewayWorkAdmission();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

function peerFixture(state: OpenClawTestState) {
  const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
    session: { store: storePath, communication: { send: "always", receive: "always" } },
    tools: { sessions: { visibility: "all" } },
  };
  setRuntimeConfigSnapshot(cfg);
  const endpoint = (name: string) => ({
    agentId: "main",
    sessionKey: `agent:main:${name}`,
    sessionId: `${name}-session`,
    lifecycleRevision: `${name}-generation`,
    storePath,
  });
  const prepare = (
    target: Parameters<typeof prepareConsumedSessionSendSource>[0]["target"],
    sourceRunId: string,
  ) => prepareConsumedSessionSendSource({ config: cfg, target, sourceRunId, assertCurrent() {} });
  const seed = async (
    runId: string,
    options: Partial<Omit<Parameters<typeof seedConsumedPeerRestartInput>[0], "cfg">> = {},
  ) => {
    const params = {
      cfg,
      source: endpoint("source"),
      target: endpoint("target"),
      runId,
      ...options,
    };
    return { ...params, ...(await seedConsumedPeerRestartInput(params)) };
  };
  const restart = async () => {
    await cleanupSessionStateForTest({ stateDir: state.stateDir });
    rotateAgentEventLifecycleGeneration();
    await markStartupOrphanedMainSessionsForRecovery({ cfg, stateDir: state.stateDir });
  };
  const recover = (
    gatewayRuntime: GatewayRecoveryRuntime,
    options?: Pick<Parameters<typeof recoverStore>[0], "onSkipped" | "shouldContinue">,
  ) =>
    recoverStore({
      storeAgentId: "main",
      storePath,
      cfg,
      handledSessionKeys: new Set(),
      gatewayRuntime,
      ...options,
    });
  return { cfg, stateDir: state.stateDir, endpoint, seed, prepare, restart, recover };
}

const withPeerState = (run: (fixture: ReturnType<typeof peerFixture>) => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal" }, (state) => run(peerFixture(state)));

function idleRuntime(): GatewayRecoveryRuntime {
  return {
    prepareFailedWorkerPlacement: async () => undefined,
    resumeChatInput: vi.fn(),
    prepareRestartRecovery: () => undefined,
    dispatchSessionMethod: vi.fn(),
    waitForAgent: vi.fn(),
    dispatchAgent: vi.fn(),
    sendRecoveryNotice: vi.fn(async () => ({ suppressed: false })),
  };
}

it.each(["exact", "legacy"] as const)(
  "restores the %s peer source when the recovery run ID is also a legacy transcript key",
  (selected) =>
    withPeerState(async ({ endpoint, seed, prepare }) => {
      const legacy = endpoint("legacy-source");
      const exact = endpoint("exact-source");
      const target = endpoint("collision-target");
      await seed("foo", { source: legacy, target });
      if (selected === "exact") {
        await seed("foo:user", { source: exact, target });
      }
      const recovered = expectDefined(await prepare(target, "foo:user"), "selected peer source");
      try {
        if (selected === "exact") {
          await sessions.updateSessionEntry(legacy, () => ({ communication: { send: "never" } }));
          expect(() => recovered.source()).not.toThrow();
          await sessions.updateSessionEntry(legacy, () => ({ communication: { send: "always" } }));
        }
        await sessions.updateSessionEntry(selected === "exact" ? exact : legacy, () => ({
          communication: { send: "never" },
        }));
        expect(() => recovered.source()).toThrow();
        expect(await prepare(target, "foo:user")).toBeUndefined();
      } finally {
        recovered.release();
      }
    }),
);

it.each(["permission", "replacement"] as const)(
  "keeps consumed peer authority through committed compaction without bypassing %s revocation",
  (revocation) =>
    withPeerState(async ({ seed, prepare }) => {
      const { cfg, source, target, runId } = await seed("compacting-peer-input");
      const recovered = expectDefined(await prepare(target, runId), "consumed peer source");
      try {
        const entry = expectDefined(sessions.loadSessionEntry(target), "compaction target");
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
          await sessions.updateSessionEntry(source, () => ({ communication: { send: "never" } }));
        } else {
          await sessions.updateSessionEntry(target, () => ({
            sessionId: "replacement-peer-session",
          }));
        }
        expect(() => recovered.source()).toThrow();
      } finally {
        recovered.release();
      }
    }),
);

it.each(["reset", "archive", "deny"] as const)(
  "settles a consumed peer input once when its sender changes before recovery: %s",
  (change) =>
    withPeerState(async ({ seed, restart, recover }) => {
      const { source, target, originalTranscript } = await seed("revoked-peer-input");
      await restart();
      await sessions.updateSessionEntry(source, () =>
        change === "reset"
          ? { sessionId: "replacement-source-session", lifecycleRevision: "replacement-generation" }
          : change === "archive"
            ? { archivedAt: Date.now() }
            : { communication: { send: "never" } },
      );
      const runtime = idleRuntime();
      expect(await recover(runtime)).toEqual({ started: 0, settled: 1, failed: 0, skipped: 0 });
      expect(runtime.dispatchAgent).not.toHaveBeenCalled();
      const settledTranscript = await sessions.loadTranscriptEvents(target);
      expect(settledTranscript).toHaveLength(originalTranscript.length + 1);
      expect(JSON.stringify(settledTranscript.at(-1))).toContain(
        "This interrupted turn could not resume after the Gateway restarted",
      );
      expect(sessions.loadSessionEntry(target)).toMatchObject({ status: "interrupted" });
      expect(sessions.loadSessionEntry(target)?.mainRestartRecovery?.tombstone).toBeUndefined();
      expect(await recover(runtime)).toEqual({ started: 0, settled: 0, failed: 0, skipped: 0 });
      expect(await sessions.loadTranscriptEvents(target)).toEqual(settledTranscript);
    }),
);

it("leaves authenticated consumed inputs to their private requester recovery owner", () =>
  withPeerState(async ({ endpoint, seed, prepare }) => {
    for (const kind of ["channel", "operator"] as const) {
      const source = endpoint(`authenticated-source-${kind}`);
      const target = endpoint(`authenticated-target-${kind}`);
      const runId = `authenticated-peer-${kind}`;
      const { receiver, originalTranscript } = await seed(runId, {
        source,
        target,
        requesterOrigin: {
          sessionKey: source.sessionKey,
          ...(kind === "channel"
            ? { messageProvider: "telegram", senderId: "fixture-requester" }
            : { operatorProfileId: "fixture-operator" }),
        },
      });
      expect(await prepare(target, runId)).toBeUndefined();
      expect(receiver).toHaveBeenCalledOnce();
      expect(await sessions.loadTranscriptEvents(target)).toEqual(originalTranscript);
    }
  }));

it.each(["peer", "requester-settle", "parent-notice-retry"] as const)(
  "keeps a denied %s child continuation resumable and records the action for its parent",
  (kind) =>
    withPeerState(async ({ endpoint, seed, restart, recover }) => {
      const { source, target } = await seed(
        kind === "requester-settle"
          ? "announce:requester-settle:main:child:missing-cohort"
          : "denied-child-input",
        {
          target: endpoint("subagent:child"),
        },
      );
      await sessions.updateSessionEntry(target, () => ({
        spawnedBy: source.sessionKey,
        spawnedBySessionId: source.sessionId,
        parentSessionLifecycleRevision: source.lifecycleRevision,
      }));
      await restart();
      await sessions.updateSessionEntry(source, () => ({ communication: { send: "never" } }));
      const runtime = idleRuntime();
      if (kind === "parent-notice-retry") {
        const parentBefore = await sessions.loadTranscriptEvents(source);
        const append = transcript.appendAssistantMessageToSessionTranscript;
        const failedWrite = vi
          .spyOn(transcript, "appendAssistantMessageToSessionTranscript")
          .mockImplementation(async (params) => {
            if (params.sessionKey === source.sessionKey) {
              throw new Error("Synthetic parent notice write failed");
            }
            return await append(params);
          });
        try {
          expect(await recover(runtime)).toEqual({ started: 0, settled: 0, failed: 1, skipped: 0 });
          expect(sessions.loadSessionEntry(target)).toMatchObject({ abortedLastRun: true });
          expect(sessions.loadSessionEntry(target)?.mainRestartRecovery?.tombstone).toBeUndefined();
          expect(await sessions.loadTranscriptEvents(source)).toEqual(parentBefore);
        } finally {
          failedWrite.mockRestore();
        }
      }
      expect(await recover(runtime)).toEqual({
        started: 0,
        settled: kind === "requester-settle" ? 1 : 0,
        failed: 0,
        skipped: kind === "requester-settle" ? 0 : 1,
      });
      expect(runtime.dispatchAgent).not.toHaveBeenCalled();
      expect(sessions.loadSessionEntry(target)?.mainRestartRecovery?.tombstone).toBeDefined();
      const parentTranscript = await sessions.loadTranscriptEvents(source);
      expect(JSON.stringify(parentTranscript.at(-1))).toContain("use Resume");
      expect(JSON.stringify(parentTranscript.at(-1))).toContain(target.sessionKey);
      await restart();
      expect(await recover(runtime)).toEqual({ started: 0, settled: 0, failed: 0, skipped: 0 });
      expect(runtime.dispatchAgent).not.toHaveBeenCalled();
      expect(sessions.loadSessionEntry(target)?.mainRestartRecovery?.tombstone).toBeDefined();
      expect(await sessions.loadTranscriptEvents(source)).toEqual(parentTranscript);
    }),
);

it("recovers a consumed peer input through two process losses without replaying the input", () =>
  withPeerState(async ({ cfg, stateDir, seed, restart, recover }) => {
    const { target, receiver, originalTranscript } = await seed("accepted-peer-input");

    const dispatchGate = createDeferred();
    const finalDispatchGate = createDeferred();
    const dispatches: string[] = [];
    const skipped: string[] = [];
    let current = true;
    const runtime: GatewayRecoveryRuntime = {
      ...idleRuntime(),
      dispatchAgent: async <T>(...[request, , options]: Parameters<Dispatch>) => {
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
    const recoverCurrent = () =>
      recover(runtime, {
        onSkipped: (reason) => skipped.push(reason),
        shouldContinue: () => current,
      });
    try {
      await restart();
      expect(await recoverCurrent()).toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
      expect(skipped).toEqual([]);
      expect(sessions.loadSessionEntry(target)?.mainRestartRecovery?.tombstone).toBeUndefined();
      // The admitted continuation vanishes without a terminal owner receipt.
      current = false;
      dispatchGate.resolve();
      await cleanupSessionStateForTest({ stateDir });
      testing.resetSessionControllerForTest();
      rotateAgentEventLifecycleGeneration();
      current = true;
      await markStartupOrphanedMainSessionsForRecovery({ cfg, stateDir });
      expect(await recoverCurrent()).toEqual({ started: 1, settled: 0, failed: 0, skipped: 0 });
      expect(dispatches).toHaveLength(2);
      expect(
        dispatches.every((prompt) => prompt.includes("Your previous turn was interrupted")),
      ).toBe(true);
      expect(receiver).toHaveBeenCalledOnce();
      finalDispatchGate.resolve();
      await vi.waitFor(() => {
        expect(sessions.loadSessionEntry(target)).toMatchObject({ abortedLastRun: false });
      });
      expect(sessions.loadSessionEntry(target)?.mainRestartRecovery?.tombstone).toBeUndefined();
      expect(await sessions.loadTranscriptEvents(target)).toEqual(originalTranscript);
    } finally {
      current = false;
      dispatchGate.resolve();
      finalDispatchGate.resolve();
    }
  }));
