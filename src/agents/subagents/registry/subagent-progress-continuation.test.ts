import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AgentEventPayload } from "../../../infra/agent-events.js";
import type { MessageActionInput } from "../../../infra/outbound/message-action-contracts.js";
import { promoteSubagentProgressContinuation } from "./subagent-progress-context.js";
import {
  createSubagentProgressContinuation,
  withSubagentProgressContinuation,
} from "./subagent-progress-continuation.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const state = vi.hoisted(() => {
  const runs = new Map<string, SubagentRunRecord>();
  return {
    runs: Object.assign(runs, {
      runWithCompletionBatchAuthority: <T>(_entries: unknown, run: () => T) => run(),
    }),
    changes: new Set<(event: { runIds?: string[] }) => void>(),
    facts: new Set<(event: unknown) => void>(),
    events: new Map<string, (event: AgentEventPayload) => void>(),
    source: new AbortController(),
    gateway: new AbortController(),
    current: true,
    readSourceCurrent: true,
    sessionId: "requester-session",
    lifecycle: "gateway-generation",
    captureWait: undefined as Promise<void> | undefined,
    readWait: undefined as Promise<void> | undefined,
    deleteWait: undefined as Promise<void> | undefined,
    refuseEdit: false,
    effects: [] as Array<{ action: string; target: unknown; messageId: unknown }>,
    releases: 0,
    cfg: {
      channels: {
        telegram: {
          enabled: true,
          streaming: {
            mode: "progress",
            progress: { toolProgress: true },
          },
        },
      },
    },
  };
});
// mock-isolation: Use explicit per-test channel policy; never read the host configuration.
vi.mock("../../../config/config.js", () => ({ getRuntimeConfig: () => state.cfg }));
// mock-isolation: Use a deterministic action-capability fixture without loading host plugins.
vi.mock("../../../channels/plugins/index.js", () => ({
  getChannelPlugin: () => ({
    actions: { writeAuthorityActions: ["edit", "delete"] },
    config: { listAccountIds: () => ["default"] },
  }),
}));
// mock-isolation: Exclude global operator hooks from the presentation ownership fixture.
vi.mock("../../../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => undefined }));
// mock-isolation: The fixture uses canonical literal targets and does not load transport registries.
vi.mock("../../../infra/outbound/target-normalization.js", () => ({
  normalizeTargetForProvider: (_channel: string, target: string) => target,
}));
// mock-isolation: Bind only the fixture Gateway context rather than the host Gateway.
vi.mock("../../../plugins/runtime/gateway-request-scope.js", () => ({
  getSharedGatewayContextResolver: () => () => ({}),
  withPluginRuntimeGatewayContextResolver: <T>(_resolver: unknown, run: () => T) => run(),
}));
// mock-isolation: Control fixture drain revocation without the real process lifecycle owner.
vi.mock("../../../process/gateway-work-admission.js", () => ({
  getGatewayRestartDrainSignal: () => state.gateway.signal,
  runWithGatewayDetachedWorkContinuation: <T>(run: () => T) => run(),
}));
// mock-isolation: Keep worker currency in this fixture rather than entering host SQLite.
vi.mock("../../../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => ({}),
}));
// mock-isolation: Revoke an explicit fixture source without reading the persistent registry.
vi.mock("./subagent-registry-persistence.js", () => ({
  assertSubagentRegistryWriteSourceCurrent: () => {
    if (!state.current) {
      throw new Error("Source revoked");
    }
  },
}));
// mock-isolation: Own cohort rows per test without the process-global production registry.
vi.mock("./subagent-registry-memory.js", () => ({
  subagentRuns: state.runs,
  getSubagentRunsForChildSession: (key: string) =>
    [...state.runs.values()].filter((entry) => entry.childSessionKey === key),
}));
// mock-isolation: Own synchronous fixture publications without global registry subscribers.
vi.mock("./subagent-registry-publication.js", () => ({
  subscribeSubagentRunChanges: (
    _phase: string,
    listener: (event: { runIds?: string[] }) => void,
  ) => {
    state.changes.add(listener);
    return () => state.changes.delete(listener);
  },
}));
// mock-isolation: Own fixture session publications without entering host state.
vi.mock("../../../sessions/session-row-changes.js", () => ({
  sessionChanges: {
    subscribeFacts: (listener: (event: unknown) => void) => {
      state.facts.add(listener);
      return () => state.facts.delete(listener);
    },
  },
}));
// mock-isolation: Control lifecycle generation independently of the running host.
vi.mock("../../../infra/agent-run-registry.js", () => ({
  getAgentRunLifecycleGeneration: () => state.lifecycle,
}));
// mock-isolation: Own fixture event listeners without observing other agent runs.
vi.mock("../../../infra/agent-events.js", () => ({
  onAgentEventForRun: (id: string, listener: (event: AgentEventPayload) => void) => {
    state.events.set(id, listener);
    return () => state.events.delete(id);
  },
}));
// mock-isolation: No cron authority exists in this isolated presentation fixture.
vi.mock("../requester-cron-authority.js", () => ({
  withRequesterCronAuthority: <T>(_params: unknown, run: () => T) => run(),
}));
// mock-isolation: Hold a fixture authority-capture barrier instead of using the live Gateway.
vi.mock("../../../gateway/server-plugin-in-process-dispatch.js", () => ({
  captureOperatorToolGatewayContinuationContext: async () => {
    await state.captureWait;
    return {
      signal: state.source.signal,
      assertCurrent: () => {
        if (!state.current) {
          throw new Error("Source revoked");
        }
      },
      run: <T>(run: () => T) => run(),
      release: () => {
        state.releases++;
      },
    };
  },
}));
// mock-isolation: Exercise the presentation boundary against fixture incarnation facts, not host SQLite.
vi.mock("../../../config/sessions/session-entry-read-runtime.js", () => ({
  withSessionEntryReadOnlyInWorker: async (
    _params: unknown,
    assertCurrent: () => void,
    run: (read: unknown, owner: unknown) => Promise<void>,
  ) => {
    assertCurrent();
    await run({ ok: true, value: { sessionId: state.sessionId } }, {});
  },
}));
// mock-isolation: Hold a fixture worker-read barrier without reading live session state.
vi.mock("../../../config/sessions/session-entry-current-runtime.js", () => ({
  captureSessionEntryCurrentRead: () => ({
    kind: "native",
    assertSourceCurrent: () => {
      if (!state.current || !state.readSourceCurrent) {
        throw new Error("Source revoked");
      }
    },
    readCurrent: async () => {
      await state.readWait;
      return { sessionId: state.sessionId };
    },
  }),
}));
// mock-isolation: Record handoff effects without sending live messages from unit tests.
vi.mock("../../../infra/outbound/message-action-runner.js", () => ({
  runMessageAction: async (input: MessageActionInput) => {
    input.assertDirectAdapterHandoff?.();
    await input.onPlatformSendDispatch?.();
    state.effects.push({
      action: input.action,
      target: input.params.target,
      messageId: input.params.messageId,
    });
    if (input.action === "delete") {
      await state.deleteWait;
    }
    return {
      kind: "action",
      action: input.action,
      channel: "telegram",
      dryRun: false,
      payload: { ok: !(state.refuseEdit && input.action === "edit") },
    };
  },
}));

function child(id = "child"): SubagentRunRecord {
  return {
    runId: id,
    childSessionKey: "agent:main:subagent:" + id,
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterDisplayKey: "main",
    completionRequesterSessionId: "requester-session",
    task: "private task",
    taskName: "Delegated work",
    cleanup: "keep",
    createdAt: 1,
    execution: { status: "running" },
    expectsCompletionMessage: true,
    progressOrigin: { channel: "telegram", accountId: "default", to: "100", threadId: 42 },
    requesterSettleWake: {
      status: "pending",
      attemptCount: 0,
      requesterYieldBatch: true,
      rearmGeneration: 1,
      batchRunIds: [id],
    },
  };
}
function offer(entries = [child()]) {
  for (const entry of entries) {
    state.runs.set(entry.runId, entry);
  }
  for (const entry of entries) {
    entry.requesterSettleWake!.batchRunIds = entries.map((row) => row.runId);
  }
  return createSubagentProgressContinuation({
    requesterSessionKey: "agent:main:main",
    requesterAgentId: "main",
    requesterSessionId: "requester-session",
    requesterTurnRunId: "spawning-turn",
    assertCurrent: () => {},
    acceptedSessionSpawns: entries.map((entry) => ({
      runId: entry.runId,
      childSessionKey: entry.childSessionKey,
      expectsCompletionMessage: true,
    })),
  });
}
const receipt = {
  channel: "telegram",
  accountId: "default",
  to: "100",
  threadId: 42,
  messageId: "77",
  text: "Checking",
  snapshot: { lines: [], statusHeadline: "Checking" },
};
const final = { delivered: true, path: "direct", requesterVisibleFinalDelivered: true } as const;
function resume(entries: SubagentRunRecord[], run: () => Promise<typeof final>) {
  return withSubagentProgressContinuation(
    {
      entries,
      runId: "successor",
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      requesterSessionId: "requester-session",
      rearmGeneration: 1,
      isCurrent: () => true,
    },
    run,
  );
}
function publishChange(entries: SubagentRunRecord[]) {
  for (const listener of state.changes) {
    listener({ runIds: entries.map((entry) => entry.runId) });
  }
}
async function flush() {
  await vi.advanceTimersByTimeAsync(1_100);
}

beforeEach(() => {
  vi.useFakeTimers();
  state.runs.clear();
  state.effects = [];
  state.releases = 0;
  state.current = true;
  state.readSourceCurrent = true;
  state.sessionId = "requester-session";
  state.lifecycle = "gateway-generation";
  state.source = new AbortController();
  state.gateway = new AbortController();
  state.captureWait = state.readWait = state.deleteWait = undefined;
  state.refuseEdit = false;
  state.cfg.channels.telegram.enabled = true;
});
afterEach(async () => {
  state.source.abort();
  state.gateway.abort();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  state.events.clear();
  state.changes.clear();
  state.facts.clear();
});

describe("native subagent presentation custody", () => {
  it("refuses adoption after dispatch passed the unpresented boundary", async () => {
    const entry = child();
    const barrier = createDeferred();
    state.captureWait = barrier.promise;
    const adoption = offer([entry]).adopt(receipt);
    await resume([entry], async () => final);
    entry.requesterSettleWake!.status = "dispatching";
    barrier.resolve();
    expect(await adoption).toBe(false);
    await flush();
    expect(state.effects).toEqual([]);
    expect(state.releases).toBe(1);
  });
  it("does not make settlement await card deletion", async () => {
    const entry = child();
    expect(await offer([entry]).adopt(receipt)).toBe(true);
    const deletion = createDeferred();
    state.deleteWait = deletion.promise;
    expect(await resume([entry], async () => final)).toBe(final);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.effects).toContainEqual({ action: "delete", target: "100", messageId: "77" });
    deletion.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
  it("retains final cleanup after a definite edit refusal", async () => {
    const entry = child();
    state.refuseEdit = true;
    expect(await offer([entry]).adopt(receipt)).toBe(true);
    await flush();
    expect(state.effects.some((effect) => effect.action === "edit")).toBe(true);
    expect(await resume([entry], async () => final)).toBe(final);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.effects.at(-1)?.action).toBe("delete");
  });
  it("releases refused-edit custody when the cohort retires without a final", async () => {
    const entry = child();
    state.refuseEdit = true;
    expect(await offer([entry]).adopt(receipt)).toBe(true);
    await flush();
    state.runs.clear();
    publishChange([entry]);
    await flush();
    expect(state.releases).toBe(1);
    expect(state.changes.size).toBe(0);
    expect(state.facts.size).toBe(0);
    expect(state.events.size).toBe(0);
  });
  it("retires the suspended presenter when its cohort disappears", async () => {
    const entry = child();
    const entries = [entry];
    expect(await offer(entries).adopt(receipt)).toBe(true);
    await resume(entries, async () => {
      promoteSubagentProgressContinuation("successor", entries);
      state.runs.clear();
      publishChange(entries);
      expect(state.releases).toBe(1);
      expect(state.changes.size).toBe(0);
      return final;
    });
  });
  it("releases custody when a re-yield handoff rejects", async () => {
    const entries = [child()];
    expect(await offer(entries).adopt(receipt)).toBe(true);
    await expect(
      resume(entries, async () => {
        promoteSubagentProgressContinuation("successor", entries);
        throw new Error("handoff rejected");
      }),
    ).rejects.toThrow("handoff rejected");
    expect(state.releases).toBe(1);
    expect(state.changes.size).toBe(0);
    expect(state.facts.size).toBe(0);
    expect(state.events.size).toBe(0);
  });
  it("retains partial-cancellation cleanup during yield suspension", async () => {
    const first = child("first");
    const entries = [first, child("second")];
    expect(await offer(entries).adopt(receipt)).toBe(true);
    await resume(entries, async () => {
      promoteSubagentProgressContinuation("successor", entries);
      first.killIntent = { requestedAt: 2, reason: "cancelled" };
      publishChange(entries);
      for (const entry of entries) {
        entry.requesterSettleWake!.rearmGeneration = 2;
      }
      promoteSubagentProgressContinuation("successor", entries, 2);
      return final;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(state.effects.at(-1)?.action).toBe("delete");
  });
  it.each(["source", "read-source", "session", "gateway", "account"] as const)(
    "fences a queued mutation after %s revocation",
    async (kind) => {
      const entry = child();
      expect(await offer([entry]).adopt(receipt)).toBe(true);
      if (kind === "source") {
        state.current = false;
        state.source.abort();
      }
      if (kind === "read-source") {
        state.readSourceCurrent = false;
      }
      if (kind === "session") {
        state.sessionId = "replacement-session";
      }
      if (kind === "gateway") {
        state.lifecycle = "replacement-generation";
        state.gateway.abort();
      }
      if (kind === "account") {
        state.cfg.channels.telegram.enabled = false;
      }
      await flush();
      expect(state.effects).toEqual([]);
      expect(state.releases).toBe(1);
      expect(state.changes.size).toBe(0);
      expect(state.events.size).toBe(0);
    },
  );
  it.each([
    { ...receipt, accountId: "other" },
    { ...receipt, threadId: 43 },
    { ...receipt, to: "200" },
  ])("does not adopt a receipt from a different audience %#", async (other) => {
    expect(await offer().adopt(other)).toBe(false);
    await flush();
    expect(state.effects).toEqual([]);
  });
});
