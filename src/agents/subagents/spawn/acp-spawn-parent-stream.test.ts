import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { startAcpSpawnParentStreamRelay } from "./acp-spawn-parent-stream.js";

const { enqueueSystemEventMock, requestHeartbeatMock, recordAcpParentStreamEventsMock } =
  vi.hoisted(() => ({
    enqueueSystemEventMock: vi.fn(),
    requestHeartbeatMock: vi.fn(),
    recordAcpParentStreamEventsMock: vi.fn(),
  }));

vi.mock("../../../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

vi.mock("../../../infra/heartbeat-wake.js", async () => {
  const actual = await vi.importActual<typeof import("../../../infra/heartbeat-wake.js")>(
    "../../../infra/heartbeat-wake.js",
  );
  return {
    ...actual,
    requestHeartbeat: (...args: unknown[]) => requestHeartbeatMock(...args),
  } satisfies typeof actual;
});

vi.mock("./acp-parent-stream-store.sqlite.js", () => ({
  createAcpParentStreamRecorder: () => ({
    record: recordAcpParentStreamEventsMock,
    close: async () => {},
  }),
}));

let emitAgentEvent: typeof import("../../../infra/agent-events.js").emitAgentEvent;

const progressCommentaryDeliveryContext = {
  channel: "forum",
  to: "-1001234567890",
  accountId: "default",
  threadId: 1122,
};

function progressModeConfig(acp?: OpenClawConfig["acp"]): OpenClawConfig {
  return {
    ...(acp ? { acp } : {}),
    channels: {
      forum: {
        streaming: {
          mode: "progress",
          progress: {
            commentary: true,
          },
        },
      },
    },
  };
}

function collectedTexts() {
  return enqueueSystemEventMock.mock.calls.map((call) =>
    typeof call[0] === "string" ? call[0] : (JSON.stringify(call[0]) ?? ""),
  );
}

function expectTextWithFragment(texts: string[], fragment: string): void {
  expect(texts.join("\n")).toContain(fragment);
}

function expectNoTextWithFragment(texts: string[], fragment: string): void {
  expect(texts.join("\n")).not.toContain(fragment);
}

function firstMockCall(
  mock: { mock: { calls: Array<readonly unknown[]> } },
  label: string,
): readonly unknown[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

describe("startAcpSpawnParentStreamRelay", () => {
  beforeAll(async () => {
    ({ emitAgentEvent } = await import("../../../infra/agent-events.js"));
  });

  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    requestHeartbeatMock.mockClear();
    recordAcpParentStreamEventsMock.mockReset();
    recordAcpParentStreamEventsMock.mockResolvedValue({ ok: true, value: undefined });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T01:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("relays assistant progress and completion to the parent session", async () => {
    const deliveryContext = {
      channel: "forum",
      to: "-1001234567890",
      accountId: "default",
      threadId: 1122,
    };
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-1",
      parentSessionKey: "agent:main:main",
      eventRouting: {},
      childSessionKey: "agent:codex:acp:child-1",
      agentId: "codex",
      deliveryContext,
    });

    relay.notifyStarted();
    emitAgentEvent({ runId: "run-1", stream: "assistant", data: { delta: "hello" } });
    emitAgentEvent({ runId: "run-1", stream: "assistant", data: { delta: " from child" } });
    vi.advanceTimersByTime(2_500);

    emitAgentEvent({
      runId: "run-1",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: 1_000,
        endedAt: 3_100,
      },
    });

    expect(collectedTexts()).toEqual([
      "Started codex session agent:codex:acp:child-1. Streaming progress updates to parent session.",
      "codex: hello from child",
      "codex run completed in 2s.",
    ]);
    const systemEventCalls = enqueueSystemEventMock.mock.calls as Array<
      [
        string,
        {
          contextKey?: string;
          sessionKey?: string;
          deliveryContext?: unknown;
        },
      ]
    >;
    expect(
      systemEventCalls.map(([, options]) => ({
        contextKey: options.contextKey,
        sessionKey: options.sessionKey,
        deliveryContext: options.deliveryContext,
      })),
    ).toEqual([
      {
        contextKey: "acp-spawn:run-1:start",
        sessionKey: "agent:main:main",
        deliveryContext,
      },
      {
        contextKey: "acp-spawn:run-1:progress",
        sessionKey: "agent:main:main",
        deliveryContext,
      },
      {
        contextKey: "acp-spawn:run-1:done",
        sessionKey: "agent:main:main",
        deliveryContext,
      },
    ]);
    const heartbeatCalls = requestHeartbeatMock.mock.calls as Array<
      [{ source?: string; intent?: string; reason?: string; sessionKey?: string }]
    >;
    expect(heartbeatCalls.map(([options]) => options)).toEqual([
      {
        source: "acp-spawn",
        intent: "event",
        reason: "acp:spawn:stream",
        sessionKey: "agent:main:main",
      },
      {
        source: "acp-spawn",
        intent: "event",
        reason: "acp:spawn:stream",
        sessionKey: "agent:main:main",
      },
      {
        source: "acp-spawn",
        intent: "event",
        reason: "acp:spawn:stream",
        sessionKey: "agent:main:main",
      },
    ]);
    await relay.dispose();
  });

  it("backs off and caps confirmed rollback retries", async () => {
    const rollback = createDeferredCore<{ ok: false; error: Error }>();
    recordAcpParentStreamEventsMock
      .mockReturnValueOnce(rollback.promise)
      .mockResolvedValue({ ok: true, value: undefined });
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-diagnostic-retry",
      parentSessionKey: "agent:main:main",
      eventRouting: {},
      childSessionKey: "agent:codex:acp:diagnostic-retry",
      childSessionId: "session-diagnostic-retry",
      agentId: "codex",
    });

    emitAgentEvent({
      runId: "run-diagnostic-retry",
      stream: "assistant",
      data: { delta: "first" },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recordAcpParentStreamEventsMock).toHaveBeenCalledTimes(1);

    emitAgentEvent({
      runId: "run-diagnostic-retry",
      stream: "assistant",
      data: { delta: "arrived while the write was pending" },
    });
    rollback.resolve({ ok: false, error: new Error("database unavailable") });
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 300; index += 1) {
      emitAgentEvent({
        runId: "run-diagnostic-retry",
        stream: "assistant",
        data: { delta: `event-${index}` },
      });
    }
    expect(recordAcpParentStreamEventsMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(recordAcpParentStreamEventsMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(recordAcpParentStreamEventsMock).toHaveBeenCalledTimes(2);
    expect(recordAcpParentStreamEventsMock.mock.calls[1]?.[0]).toHaveLength(256);
    await relay.dispose();
  });

  it.each(["overloaded", "outcome-unknown"] as const)(
    "retries only proven pre-execution refusal (%s)",
    async (code) => {
      const failure = new SqliteWorkerError("controlled worker failure", code);
      recordAcpParentStreamEventsMock.mockRejectedValueOnce(failure);
      const relay = startAcpSpawnParentStreamRelay({
        runId: "outcome",
        parentSessionKey: "agent:main:main",
        eventRouting: {},
        childSessionKey: "agent:main:acp:child",
        childSessionId: "child",
        agentId: "main",
      });
      emitAgentEvent({ runId: "outcome", stream: "acp", data: { phase: "runtime_event" } });
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(2_000);
      await relay.dispose();
      expect(recordAcpParentStreamEventsMock).toHaveBeenCalledTimes(code === "overloaded" ? 2 : 1);
      await expect(recordAcpParentStreamEventsMock.mock.results[0]?.value).rejects.toBe(failure);
    },
  );

  it("joins an in-flight batch before the final buffer and seals event admission", async () => {
    const gate = createDeferredCore<{ ok: true; value: undefined }>();
    recordAcpParentStreamEventsMock.mockReturnValueOnce(gate.promise);
    const relay = startAcpSpawnParentStreamRelay({
      runId: "settlement",
      parentSessionKey: "agent:main:main",
      eventRouting: {},
      childSessionKey: "agent:main:acp:child",
      childSessionId: "child",
      agentId: "main",
    });
    const emit = (ordinal: number) =>
      emitAgentEvent({ runId: "settlement", stream: "acp", data: { ordinal } });
    emit(1);
    await vi.advanceTimersByTimeAsync(1_000);
    emit(2);
    let disposed = false;
    const closing = relay.dispose().then(() => {
      disposed = true;
    });
    emit(3);
    expect(disposed).toBe(false);
    expect(recordAcpParentStreamEventsMock).toHaveBeenCalledTimes(1);
    gate.resolve({ ok: true, value: undefined });
    await closing;
    expect(
      recordAcpParentStreamEventsMock.mock.calls.map(([events]) =>
        events.map((entry: { event: { data: { ordinal: number } } }) => entry.event.data.ordinal),
      ),
    ).toEqual([[1], [2]]);
  });

  it("remaps cron-run parent session keys while relaying stream events", async () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-cron",
      parentSessionKey: "agent:ops:cron:nightly:run:run-1:subagent:worker",
      eventRouting: { mainKey: "primary", sessionScope: "global" },
      childSessionKey: "agent:codex:acp:child-cron",
      agentId: "codex",
    });

    emitAgentEvent({
      runId: "run-cron",
      stream: "assistant",
      data: {
        delta: "hello from child",
      },
    });
    vi.advanceTimersByTime(2_500);

    const progressEvent = enqueueSystemEventMock.mock.calls.find(
      ([text]) => typeof text === "string" && text.includes("codex: hello from child"),
    );
    expect(progressEvent?.[0]).toContain("codex: hello from child");
    const progressOptions = progressEvent?.[1] as
      | { contextKey?: unknown; sessionKey?: unknown }
      | undefined;
    expect(progressOptions?.contextKey).toBe("acp-spawn:run-cron:progress");
    expect(progressOptions?.sessionKey).toBe("agent:ops:global");
    const heartbeatOptions = firstMockCall(requestHeartbeatMock, "heartbeat request")[0] as
      | { agentId?: string; reason?: string }
      | undefined;
    expect(heartbeatOptions?.agentId).toBe("ops");
    expect(heartbeatOptions?.reason).toBe("acp:spawn:stream");
    expect(heartbeatOptions).not.toHaveProperty("sessionKey");
    await relay.dispose();
  });

  it("emits a pre-prompt stall notice and a resumed notice when output returns", async () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-2",
      parentSessionKey: "agent:main:main",
      eventRouting: {},
      childSessionKey: "agent:codex:acp:child-2",
      agentId: "codex",
    });

    vi.advanceTimersByTime(60_000);
    expectTextWithFragment(collectedTexts(), "no prompt submission was observed for 60s");

    emitAgentEvent({
      runId: "run-2",
      stream: "assistant",
      data: {
        delta: "resumed output",
      },
    });
    vi.advanceTimersByTime(2_500);

    const texts = collectedTexts();
    expectTextWithFragment(texts, "resumed output.");
    expectTextWithFragment(texts, "codex: resumed output");

    emitAgentEvent({
      runId: "run-2",
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "boom",
      },
    });
    expectTextWithFragment(collectedTexts(), "run failed: boom");
    await relay.dispose();
  });

  it("classifies stalls after prompt submission but before the first runtime event", async () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-prompt-stall",
      parentSessionKey: "agent:main:main",
      eventRouting: {},
      childSessionKey: "agent:codex:acp:child-prompt-stall",
      agentId: "codex",
    });

    emitAgentEvent({
      runId: "run-prompt-stall",
      stream: "acp",
      data: {
        phase: "prompt_submitted",
        at: Date.now(),
        proxyEnvKeys: ["HTTPS_PROXY"],
      },
    });
    vi.advanceTimersByTime(60_000);

    const texts = collectedTexts();
    expectTextWithFragment(texts, "prompt was submitted but no ACP runtime event arrived for 60s");
    expectTextWithFragment(texts, "proxy env: HTTPS_PROXY");
    expectNoTextWithFragment(texts, "waiting for interactive input");
    await relay.dispose();
  });

  it("classifies runtime activity without visible assistant output separately from input waits", async () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-runtime-stall",
      parentSessionKey: "agent:main:main",
      eventRouting: {},
      childSessionKey: "agent:codex:acp:child-runtime-stall",
      agentId: "codex",
    });

    emitAgentEvent({
      runId: "run-runtime-stall",
      stream: "acp",
      data: {
        phase: "prompt_submitted",
        at: Date.now(),
        proxyEnvKeys: [],
      },
    });
    vi.advanceTimersByTime(45_000);
    emitAgentEvent({
      runId: "run-runtime-stall",
      stream: "acp",
      data: {
        phase: "runtime_event",
        eventType: "status",
        text: "connecting to upstream",
      },
    });
    vi.advanceTimersByTime(45_000);
    expectNoTextWithFragment(collectedTexts(), "has ACP runtime activity");

    vi.advanceTimersByTime(15_000);

    const texts = collectedTexts();
    expectTextWithFragment(
      texts,
      "has ACP runtime activity but no visible assistant output for 60s",
    );
    expectTextWithFragment(texts, "Last ACP event: status");
    expectNoTextWithFragment(texts, "waiting for interactive input");
    await relay.dispose();
  });

  it("auto-disposes stale relays after max lifetime timeout", async () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-3",
      parentSessionKey: "agent:main:main",
      eventRouting: {},
      childSessionKey: "agent:codex:acp:child-3",
      agentId: "codex",
    });

    vi.advanceTimersByTime(6 * 60 * 60 * 1000);
    expectTextWithFragment(collectedTexts(), "stream relay timed out after 21600s");

    const before = enqueueSystemEventMock.mock.calls.length;
    emitAgentEvent({
      runId: "run-3",
      stream: "assistant",
      data: {
        delta: "late output",
      },
    });
    vi.advanceTimersByTime(2_500);

    expect(enqueueSystemEventMock.mock.calls).toHaveLength(before);
    await relay.dispose();
  });

  it("emits a start notice only after explicit acceptance", async () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-4",
      parentSessionKey: "agent:main:main",
      eventRouting: {},
      childSessionKey: "agent:codex:acp:child-4",
      agentId: "codex",
    });

    expectNoTextWithFragment(collectedTexts(), "Started codex session");

    relay.notifyStarted();

    expectTextWithFragment(collectedTexts(), "Started codex session");
    await relay.dispose();
  });

  it("relays the latest replaceable assistant snapshot instead of superseded drafts", async () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-replaceable-assistant",
      parentSessionKey: "agent:main:main",
      eventRouting: {},
      childSessionKey: "agent:codex:acp:child-replaceable-assistant",
      agentId: "codex",
    });

    emitAgentEvent({
      runId: "run-replaceable-assistant",
      stream: "assistant",
      data: {
        text: "coordination draft",
        delta: "coordination draft",
        replaceable: true,
      },
    });
    emitAgentEvent({
      runId: "run-replaceable-assistant",
      stream: "assistant",
      data: {
        text: "final answer",
        delta: "",
        replace: true,
        replaceable: true,
      },
    });
    emitAgentEvent({
      runId: "run-replaceable-assistant",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: 1_000,
        endedAt: 2_000,
      },
    });

    const texts = collectedTexts();
    expectNoTextWithFragment(texts, "coordination draft");
    expectTextWithFragment(texts, "codex: final answer");
    await relay.dispose();
  });

  it("flushes visible commentary before final answer text", async () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-commentary-final",
      parentSessionKey: "agent:main:main",
      eventRouting: {},
      childSessionKey: "agent:codex:acp:child-commentary-final",
      agentId: "codex",
      cfg: progressModeConfig(),
      deliveryContext: progressCommentaryDeliveryContext,
    });

    emitAgentEvent({
      runId: "run-commentary-final",
      stream: "assistant",
      data: {
        delta: "Note: Checking the requested response shape only.",
        phase: "commentary",
      },
    });
    emitAgentEvent({
      runId: "run-commentary-final",
      stream: "assistant",
      data: {
        delta: "ready",
      },
    });
    vi.advanceTimersByTime(2_500);

    expect(collectedTexts()).toEqual([
      "codex: Note: Checking the requested response shape only.",
      "codex: ready",
    ]);
    await relay.dispose();
  });

  it("relays preamble item progress without duplicating snapshots", async () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-preamble-item",
      parentSessionKey: "agent:main:main",
      eventRouting: {},
      childSessionKey: "agent:codex:acp:child-preamble-item",
      agentId: "codex",
      cfg: progressModeConfig(),
      deliveryContext: progressCommentaryDeliveryContext,
    });

    emitAgentEvent({
      runId: "run-preamble-item",
      stream: "item",
      data: {
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking",
      },
    });
    emitAgentEvent({
      runId: "run-preamble-item",
      stream: "item",
      data: {
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking the app-server stream",
      },
    });
    vi.advanceTimersByTime(2_500);

    expect(collectedTexts()).toEqual(["codex: Checking the app-server stream"]);
    await relay.dispose();
  });

  it("replaces buffered preamble item progress when snapshots change text", async () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-preamble-item-replacement",
      parentSessionKey: "agent:main:main",
      eventRouting: {},
      childSessionKey: "agent:codex:acp:child-preamble-item-replacement",
      agentId: "codex",
      cfg: progressModeConfig(),
      deliveryContext: progressCommentaryDeliveryContext,
    });

    emitAgentEvent({
      runId: "run-preamble-item-replacement",
      stream: "item",
      data: {
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking config",
      },
    });
    emitAgentEvent({
      runId: "run-preamble-item-replacement",
      stream: "item",
      data: {
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Reading files",
      },
    });
    vi.advanceTimersByTime(2_500);

    expect(collectedTexts()).toEqual(["codex: Reading files"]);
    await relay.dispose();
  });

  it("omits already flushed preamble item progress from later prefix snapshots", async () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-preamble-item-after-flush",
      parentSessionKey: "agent:main:main",
      eventRouting: {},
      childSessionKey: "agent:codex:acp:child-preamble-item-after-flush",
      agentId: "codex",
      cfg: progressModeConfig(),
      deliveryContext: progressCommentaryDeliveryContext,
    });

    emitAgentEvent({
      runId: "run-preamble-item-after-flush",
      stream: "item",
      data: {
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking",
      },
    });
    vi.advanceTimersByTime(2_500);
    emitAgentEvent({
      runId: "run-preamble-item-after-flush",
      stream: "item",
      data: {
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking the app-server stream",
      },
    });
    vi.advanceTimersByTime(2_500);

    expect(collectedTexts()).toEqual(["codex: Checking", "codex: the app-server stream"]);
    await relay.dispose();
  });

  it.each<{
    name: string;
    channel?: string;
    streaming?: { mode?: "progress" | "off"; progress?: { commentary: boolean } };
    accountStreaming?: { mode?: "off"; progress?: { commentary: boolean } };
    configuredAccount?: string;
    accountId?: string;
    stream: "assistant" | "item";
    visible?: boolean;
  }>([
    {
      name: "defaults commentary on in explicit Discord progress mode",
      channel: "discord",
      streaming: { mode: "progress" },
      stream: "assistant",
      visible: true,
    },
    {
      name: "suppresses Discord commentary when streaming is unset",
      channel: "discord",
      stream: "item",
    },
    {
      name: "honors explicit Discord streaming off",
      channel: "discord",
      streaming: { mode: "off" },
      stream: "item",
    },
    {
      name: "suppresses assistant commentary when disabled",
      streaming: { mode: "progress", progress: { commentary: false } },
      stream: "assistant",
    },
    {
      name: "suppresses preamble progress when commentary is disabled",
      streaming: { mode: "progress", progress: { commentary: false } },
      stream: "item",
    },
    {
      name: "applies normalized account commentary opt-outs",
      streaming: { mode: "progress" },
      accountStreaming: { progress: { commentary: false } },
      configuredAccount: "Carey Notifications",
      accountId: "carey-notifications",
      stream: "item",
    },
    {
      name: "applies account streaming mode opt-outs",
      streaming: { mode: "progress", progress: { commentary: true } },
      accountStreaming: { mode: "off" },
      stream: "item",
    },
    {
      name: "inherits parent progress mode for account commentary overrides",
      streaming: { mode: "progress" },
      accountStreaming: { progress: { commentary: true } },
      stream: "assistant",
      visible: true,
    },
    {
      name: "preserves channel streaming off for account commentary overrides",
      channel: "discord",
      streaming: { mode: "off" },
      accountStreaming: { progress: { commentary: true } },
      stream: "assistant",
    },
  ])(
    "$name",
    async ({
      name,
      channel = "forum",
      streaming,
      accountStreaming,
      configuredAccount = "work",
      accountId = configuredAccount,
      stream,
      visible,
    }) => {
      const relay = startAcpSpawnParentStreamRelay({
        runId: name,
        parentSessionKey: "agent:main:main",
        eventRouting: {},
        childSessionKey: "agent:codex:acp:progress-config",
        agentId: "codex",
        cfg: {
          channels: {
            [channel]: {
              streaming,
              ...(accountStreaming
                ? { accounts: { [configuredAccount]: { streaming: accountStreaming } } }
                : {}),
            },
          },
        },
        deliveryContext: { ...progressCommentaryDeliveryContext, channel, accountId },
      });
      emitAgentEvent({
        runId: name,
        stream,
        data:
          stream === "assistant"
            ? { delta: "Checking progress.", phase: "commentary" }
            : { itemId: "preamble-1", kind: "preamble", progressText: "Checking progress." },
      });
      vi.advanceTimersByTime(2_500);
      expect(collectedTexts()).toEqual(visible ? ["codex: Checking progress."] : []);
      await relay.dispose();
    },
  );

  it("flushes buffered commentary before ACP status progress", async () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-commentary-status-boundary",
      parentSessionKey: "agent:main:main",
      eventRouting: {},
      childSessionKey: "agent:codex:acp:child-commentary-status-boundary",
      agentId: "codex",
      cfg: progressModeConfig({
        stream: {
          tagVisibility: {
            plan: true,
          },
        },
      }),
      deliveryContext: progressCommentaryDeliveryContext,
    });

    emitAgentEvent({
      runId: "run-commentary-status-boundary",
      stream: "assistant",
      data: {
        delta: "checking files",
        phase: "commentary",
      },
    });
    emitAgentEvent({
      runId: "run-commentary-status-boundary",
      stream: "acp",
      data: {
        phase: "runtime_event",
        eventType: "status",
        tag: "plan",
        text: "plan: inspect the runtime handoff first",
      },
    });

    expect(collectedTexts()).toEqual([
      "codex: checking files",
      "codex: plan: inspect the runtime handoff first",
    ]);
    await relay.dispose();
  });

  it("does not relay hidden ACP status tags when progress commentary is enabled", async () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-status-commentary-hidden",
      parentSessionKey: "agent:main:main",
      eventRouting: {},
      childSessionKey: "agent:codex:acp:child-status-commentary-hidden",
      agentId: "codex",
      cfg: progressModeConfig(),
      deliveryContext: progressCommentaryDeliveryContext,
    });

    emitAgentEvent({
      runId: "run-status-commentary-hidden",
      stream: "acp",
      data: {
        phase: "runtime_event",
        eventType: "status",
        tag: "usage_update",
        text: "usage updated: 10/100",
      },
    });
    emitAgentEvent({
      runId: "run-status-commentary-hidden",
      stream: "acp",
      data: {
        phase: "runtime_event",
        eventType: "status",
        tag: "available_commands_update",
        text: "available commands updated (7)",
      },
    });
    vi.advanceTimersByTime(2_500);

    const texts = collectedTexts();
    expectNoTextWithFragment(texts, "usage updated");
    expectNoTextWithFragment(texts, "available commands updated");
    await relay.dispose();
  });

  it("does not relay ACP status tags hidden by default when progress commentary is enabled", async () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-status-commentary-default-hidden",
      parentSessionKey: "agent:main:main",
      eventRouting: {},
      childSessionKey: "agent:codex:acp:child-status-commentary-default-hidden",
      agentId: "codex",
      cfg: progressModeConfig(),
      deliveryContext: progressCommentaryDeliveryContext,
    });

    emitAgentEvent({
      runId: "run-status-commentary-default-hidden",
      stream: "acp",
      data: {
        phase: "runtime_event",
        eventType: "status",
        tag: "plan",
        text: "plan: inspect the runtime handoff first",
      },
    });
    vi.advanceTimersByTime(2_500);

    expectNoTextWithFragment(collectedTexts(), "inspect the runtime handoff");
    await relay.dispose();
  });

  it("classifies opted-in commentary as visible output for stall notices", async () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-commentary-visible-stall",
      parentSessionKey: "agent:main:main",
      eventRouting: {},
      childSessionKey: "agent:codex:acp:child-commentary-visible-stall",
      agentId: "codex",
      cfg: progressModeConfig(),
      deliveryContext: progressCommentaryDeliveryContext,
    });

    emitAgentEvent({
      runId: "run-commentary-visible-stall",
      stream: "acp",
      data: {
        phase: "prompt_submitted",
        at: Date.now(),
        proxyEnvKeys: [],
      },
    });
    emitAgentEvent({
      runId: "run-commentary-visible-stall",
      stream: "acp",
      data: {
        phase: "runtime_event",
        eventType: "status",
        text: "connecting to upstream",
      },
    });
    emitAgentEvent({
      runId: "run-commentary-visible-stall",
      stream: "assistant",
      data: {
        delta: "checking active files before patching.",
        phase: "commentary",
      },
    });
    vi.advanceTimersByTime(2_500);
    vi.advanceTimersByTime(60_000);

    const texts = collectedTexts();
    expectTextWithFragment(texts, "codex: checking active files before patching.");
    expectNoTextWithFragment(texts, "has ACP runtime activity but no visible assistant output");
    expectTextWithFragment(texts, "has produced no visible output for 60s");
    await relay.dispose();
  });

  it("still relays final_answer assistant text after suppressed commentary", async () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-final",
      parentSessionKey: "agent:main:main",
      eventRouting: {},
      childSessionKey: "agent:codex:acp:child-final",
      agentId: "codex",
    });

    emitAgentEvent({
      runId: "run-final",
      stream: "assistant",
      data: {
        delta: "checking thread context; then post a tight progress reply here.",
        phase: "commentary",
      },
    });
    emitAgentEvent({
      runId: "run-final",
      stream: "assistant",
      data: {
        delta: "final answer ready",
        phase: "final_answer",
      },
    });
    vi.advanceTimersByTime(2_500);

    const texts = collectedTexts();
    expectNoTextWithFragment(texts, "checking thread context");
    expectTextWithFragment(texts, "codex: final answer ready");
    await relay.dispose();
  });

  it.each([
    {
      name: "preview cutoff",
      delta: `${"a".repeat(218)}😀tail`,
      expected: `${"a".repeat(218)}…`,
    },
    {
      name: "retained buffer start",
      delta: `😀${"b".repeat(3_999)}`,
      expected: `${"b".repeat(219)}…`,
    },
  ])("keeps $name on UTF-16 boundaries", async ({ delta, expected }) => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-utf16-safe",
      parentSessionKey: "agent:main:main",
      eventRouting: {},
      childSessionKey: "agent:codex:acp:utf16-safe",
      agentId: "codex",
    });

    emitAgentEvent({
      runId: "run-utf16-safe",
      stream: "assistant",
      data: { delta },
    });

    expect(collectedTexts()).toEqual([`codex: ${expected}`]);
    await relay.dispose();
  });
});
