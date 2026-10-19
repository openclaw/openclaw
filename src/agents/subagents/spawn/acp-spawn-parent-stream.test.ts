import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { SqliteWorkerError } from "../../../infra/sqlite-worker-contract.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { startAcpSpawnParentStreamRelay } from "./acp-spawn-parent-stream.js";

const { enqueueSessionEventMock, recordAcpParentStreamEventsMock } = vi.hoisted(() => ({
  enqueueSessionEventMock: vi.fn((_text: string, _options: Record<string, unknown>) => ({
    id: "occurrence",
    cancel: vi.fn(() => true),
    settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: true }),
  })),
  recordAcpParentStreamEventsMock: vi.fn(),
}));
// mock-isolation: Capture parent relay events without starting reply turns or session lookups.
vi.mock("../../../auto-reply/reply/session-event-handoff.js", () => ({
  enqueueSessionEventForHost: enqueueSessionEventMock,
}));

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

function progressRelay(runId: string, acp?: OpenClawConfig["acp"]) {
  return createRelay(runId, {
    cfg: {
      ...(acp ? { acp } : {}),
      channels: { forum: { streaming: { mode: "progress", progress: { commentary: true } } } },
    },
    deliveryContext: progressCommentaryDeliveryContext,
  });
}

function createRelay(
  runId: string,
  options: Partial<Omit<Parameters<typeof startAcpSpawnParentStreamRelay>[0], "runId">> = {},
) {
  const relay = startAcpSpawnParentStreamRelay({
    runId,
    requesterAgentId: "main",
    expectedTarget: { sessionId: "parent-original", generation: "generation-original" },
    parentSessionKey: "agent:main:main",
    childSessionKey: `agent:codex:acp:${runId}`,
    eventRouting: {},
    agentId: "codex",
    ...options,
  });
  const emit = (stream: string, data: Record<string, unknown>) =>
    emitAgentEvent({ runId, stream, data });
  return {
    ...relay,
    emit,
    assistant: (delta: string, phase?: string) =>
      emit("assistant", { delta, ...(phase ? { phase } : {}) }),
    prompt: (proxyEnvKeys: string[] = []) =>
      emit("acp", { phase: "prompt_submitted", at: Date.now(), proxyEnvKeys }),
    status: (text: string, tag?: string) =>
      emit("acp", { phase: "runtime_event", eventType: "status", text, ...(tag ? { tag } : {}) }),
  };
}

function collectedTexts() {
  return enqueueSessionEventMock.mock.calls.map(([text]) => text);
}

function expectTextWithFragment(texts: string[], fragment: string): void {
  expect(texts.join("\n")).toContain(fragment);
}

function expectNoTextWithFragment(texts: string[], fragment: string): void {
  expect(texts.join("\n")).not.toContain(fragment);
}

describe("startAcpSpawnParentStreamRelay", () => {
  beforeAll(async () => {
    ({ emitAgentEvent } = await import("../../../infra/agent-events.js"));
  });

  beforeEach(() => {
    enqueueSessionEventMock.mockClear();
    recordAcpParentStreamEventsMock.mockReset();
    recordAcpParentStreamEventsMock.mockResolvedValue({ ok: true, value: undefined });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T01:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("relays assistant progress and completion to the parent session", async () => {
    const deliveryContext = progressCommentaryDeliveryContext;
    const relay = createRelay("run-1", {
      childSessionKey: "agent:codex:acp:child-1",
      deliveryContext,
    });

    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    relay.notifyStarted();
    relay.assistant("hello");
    relay.assistant(" from child");
    vi.advanceTimersByTime(2_500);

    relay.emit("lifecycle", {
      phase: "end",
      startedAt: 1_000,
      endedAt: 3_100,
    });

    expect(collectedTexts()).toEqual([
      "Started codex session agent:codex:acp:child-1. Streaming progress updates to parent session.",
      "codex: hello from child",
      "codex run completed in 2s.",
    ]);
    expect(
      enqueueSessionEventMock.mock.calls.map(([, options]) => ({
        contextKey: options.contextKey,
        sessionKey: options.sessionKey,
        deliveryContext: options.deliveryContext,
      })),
    ).toEqual(
      ["start", "progress", "done"].map((phase) => ({
        contextKey: `acp-spawn:run-1:${phase}`,
        sessionKey: "agent:main:main",
        deliveryContext,
      })),
    );
    for (const [, options] of enqueueSessionEventMock.mock.calls) {
      expect(options).toMatchObject({
        agentId: "main",
        source: "task",
        expectedTarget: { sessionId: "parent-original", generation: "generation-original" },
      });
    }
    await relay.dispose();
  });

  it("backs off and caps confirmed rollback retries", async () => {
    const rollback = createDeferredCore<{ ok: false; error: Error }>();
    recordAcpParentStreamEventsMock
      .mockReturnValueOnce(rollback.promise)
      .mockResolvedValue({ ok: true, value: undefined });
    const relay = createRelay("run-diagnostic-retry", {
      childSessionId: "session-diagnostic-retry",
    });

    relay.assistant("first");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recordAcpParentStreamEventsMock).toHaveBeenCalledTimes(1);

    relay.assistant("arrived while the write was pending");
    rollback.resolve({ ok: false, error: new Error("database unavailable") });
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 300; index += 1) {
      relay.assistant(`event-${index}`);
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
      const relay = createRelay("outcome", {
        childSessionId: "child",
        agentId: "main",
      });
      relay.emit("acp", { phase: "runtime_event" });
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
    const relay = createRelay("settlement", {
      childSessionId: "child",
      agentId: "main",
    });
    const emitOrdinal = (ordinal: number) => relay.emit("acp", { ordinal });
    emitOrdinal(1);
    await vi.advanceTimersByTimeAsync(1_000);
    emitOrdinal(2);
    let disposed = false;
    const closing = relay.dispose().then(() => {
      disposed = true;
    });
    emitOrdinal(3);
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
    const relay = createRelay("run-cron", {
      requesterAgentId: "ops",
      parentSessionKey: "agent:ops:cron:nightly:run:run-1:subagent:worker",
      eventRouting: { mainKey: "primary", sessionScope: "global" },
    });

    relay.assistant("hello from child");
    vi.advanceTimersByTime(2_500);

    const progressEvent = enqueueSessionEventMock.mock.calls.find(
      ([text]) => typeof text === "string" && text.includes("codex: hello from child"),
    );
    expect(progressEvent?.[0]).toContain("codex: hello from child");
    const progressOptions = progressEvent?.[1] as
      | { contextKey?: unknown; sessionKey?: unknown }
      | undefined;
    expect(progressOptions?.contextKey).toBe("acp-spawn:run-cron:progress");
    expect(progressOptions?.sessionKey).toBe("global");
    expect(enqueueSessionEventMock.mock.calls[0]?.[1]).toMatchObject({
      agentId: "ops",
      sessionKey: "global",
    });
    await relay.dispose();
  });

  it("emits a pre-prompt stall notice and a resumed notice when output returns", async () => {
    const relay = createRelay("run-2");

    vi.advanceTimersByTime(60_000);
    expectTextWithFragment(collectedTexts(), "no prompt submission was observed for 60s");

    relay.assistant("resumed output");
    vi.advanceTimersByTime(2_500);

    const texts = collectedTexts();
    expectTextWithFragment(texts, "resumed output.");
    expectTextWithFragment(texts, "codex: resumed output");

    relay.emit("lifecycle", {
      phase: "error",
      error: "boom",
    });
    expectTextWithFragment(collectedTexts(), "run failed: boom");
    await relay.dispose();
  });

  it("classifies stalls after prompt submission but before the first runtime event", async () => {
    const relay = createRelay("run-prompt-stall");

    relay.prompt(["HTTPS_PROXY"]);
    vi.advanceTimersByTime(60_000);

    const texts = collectedTexts();
    expectTextWithFragment(texts, "prompt was submitted but no ACP runtime event arrived for 60s");
    expectTextWithFragment(texts, "proxy env: HTTPS_PROXY");
    expectNoTextWithFragment(texts, "waiting for interactive input");
    await relay.dispose();
  });

  it("classifies runtime activity without visible assistant output separately from input waits", async () => {
    const relay = createRelay("run-runtime-stall");

    relay.prompt();
    vi.advanceTimersByTime(45_000);
    relay.status("connecting to upstream");
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
    const relay = createRelay("run-3");

    vi.advanceTimersByTime(6 * 60 * 60 * 1000);
    expectTextWithFragment(collectedTexts(), "stream relay timed out after 21600s");

    const before = enqueueSessionEventMock.mock.calls.length;
    relay.assistant("late output");
    vi.advanceTimersByTime(2_500);

    expect(enqueueSessionEventMock.mock.calls).toHaveLength(before);
    await relay.dispose();
  });

  it("relays the latest replaceable assistant snapshot instead of superseded drafts", async () => {
    const relay = createRelay("run-replaceable-assistant");

    relay.emit("assistant", {
      text: "coordination draft",
      delta: "coordination draft",
      replaceable: true,
    });
    relay.emit("assistant", {
      text: "final answer",
      delta: "",
      replace: true,
      replaceable: true,
    });
    relay.emit("lifecycle", {
      phase: "end",
      startedAt: 1_000,
      endedAt: 2_000,
    });

    const texts = collectedTexts();
    expectNoTextWithFragment(texts, "coordination draft");
    expectTextWithFragment(texts, "codex: final answer");
    await relay.dispose();
  });

  it("flushes visible commentary before final answer text", async () => {
    const relay = progressRelay("run-commentary-final");

    relay.assistant("Note: Checking the requested response shape only.", "commentary");
    relay.assistant("ready");
    vi.advanceTimersByTime(2_500);

    expect(collectedTexts()).toEqual([
      "codex: Note: Checking the requested response shape only.",
      "codex: ready",
    ]);
    await relay.dispose();
  });

  it.each([
    {
      name: "replaces buffered preamble item progress when snapshots change text",
      first: "Checking config",
      second: "Reading files",
      flushFirst: false,
      expected: ["codex: Reading files"],
    },
    {
      name: "omits already flushed preamble item progress from later prefix snapshots",
      first: "Checking",
      second: "Checking the app-server stream",
      flushFirst: true,
      expected: ["codex: Checking", "codex: the app-server stream"],
    },
  ])("$name", async ({ name, first, second, flushFirst, expected }) => {
    const relay = progressRelay(name);

    const preamble = (progressText: string) =>
      relay.emit("item", { itemId: "preamble-1", kind: "preamble", progressText });
    preamble(first);
    if (flushFirst) {
      vi.advanceTimersByTime(2_500);
    }
    preamble(second);
    vi.advanceTimersByTime(2_500);

    expect(collectedTexts()).toEqual(expected);
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
      const relay = createRelay(name, {
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
      relay.emit(
        stream,
        stream === "assistant"
          ? { delta: "Checking progress.", phase: "commentary" }
          : { itemId: "preamble-1", kind: "preamble", progressText: "Checking progress." },
      );
      vi.advanceTimersByTime(2_500);
      expect(collectedTexts()).toEqual(visible ? ["codex: Checking progress."] : []);
      await relay.dispose();
    },
  );

  it("flushes buffered commentary before ACP status progress", async () => {
    const relay = progressRelay("run-commentary-status-boundary", {
      stream: { tagVisibility: { plan: true } },
    });

    relay.assistant("checking files", "commentary");
    relay.status("plan: inspect the runtime handoff first", "plan");

    expect(collectedTexts()).toEqual([
      "codex: checking files",
      "codex: plan: inspect the runtime handoff first",
    ]);
    await relay.dispose();
  });

  it("does not relay ACP status tags hidden by default when progress commentary is enabled", async () => {
    const relay = progressRelay("run-status-commentary-default-hidden");

    relay.status("plan: inspect the runtime handoff first", "plan");
    vi.advanceTimersByTime(2_500);

    expectNoTextWithFragment(collectedTexts(), "inspect the runtime handoff");
    await relay.dispose();
  });

  it("classifies opted-in commentary as visible output for stall notices", async () => {
    const relay = progressRelay("run-commentary-visible-stall");

    relay.prompt();
    relay.status("connecting to upstream");
    relay.assistant("checking active files before patching.", "commentary");
    vi.advanceTimersByTime(2_500);
    vi.advanceTimersByTime(60_000);

    const texts = collectedTexts();
    expectTextWithFragment(texts, "codex: checking active files before patching.");
    expectNoTextWithFragment(texts, "has ACP runtime activity but no visible assistant output");
    expectTextWithFragment(texts, "has produced no visible output for 60s");
    await relay.dispose();
  });

  it("still relays final_answer assistant text after suppressed commentary", async () => {
    const relay = createRelay("run-final");

    relay.assistant(
      "checking thread context; then post a tight progress reply here.",
      "commentary",
    );
    relay.assistant("final answer ready", "final_answer");
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
    const relay = createRelay("run-utf16-safe");

    relay.emit("assistant", { delta });

    expect(collectedTexts()).toEqual([`codex: ${expected}`]);
    await relay.dispose();
  });
});
