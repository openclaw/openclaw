import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { startAcpSpawnParentStreamRelay } from "./acp-spawn-parent-stream.js";

const { enqueueSessionEventMock } = vi.hoisted(() => ({
  enqueueSessionEventMock: vi.fn((_text: string, _options: Record<string, unknown>) => ({
    id: "occurrence",
    cancel: vi.fn(() => true),
    settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: true }),
  })),
}));
// mock-isolation: Capture parent relay events without starting reply turns or session lookups.
vi.mock("../../../auto-reply/reply/session-event-handoff.js", () => ({
  enqueueSessionEventForHost: enqueueSessionEventMock,
}));

let emitAgentEvent: typeof import("../../../infra/agent-events.js").emitAgentEvent;

const progressCommentaryDeliveryContext = {
  channel: "forum",
  to: "-1001234567890",
  accountId: "default",
  threadId: 1122,
};
const relays: Array<ReturnType<typeof startAcpSpawnParentStreamRelay>> = [];

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
  relays.push(relay);
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

function expectFragments(present: string[], absent: string[] = []): void {
  const text = collectedTexts().join("\n");
  for (const fragment of present) {
    expect(text).toContain(fragment);
  }
  for (const fragment of absent) {
    expect(text).not.toContain(fragment);
  }
}

describe("startAcpSpawnParentStreamRelay", () => {
  beforeAll(async () => {
    ({ emitAgentEvent } = await import("../../../infra/agent-events.js"));
  });

  beforeEach(() => {
    enqueueSessionEventMock.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T01:00:00.000Z"));
  });

  afterEach(async () => {
    await Promise.all(relays.splice(0).map((relay) => relay.dispose()));
    vi.useRealTimers();
  });

  it("relays assistant progress and completion to the parent session", () => {
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
    expect(enqueueSessionEventMock.mock.calls.map(([, options]) => options)).toEqual(
      ["start", "progress", "done"].map((phase) =>
        expect.objectContaining({
          contextKey: `acp-spawn:run-1:${phase}`,
          sessionKey: "agent:main:main",
          deliveryContext,
          agentId: "main",
          source: "task",
          expectedTarget: { sessionId: "parent-original", generation: "generation-original" },
        }),
      ),
    );
  });

  it("remaps cron-run parent session keys while relaying stream events", () => {
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
    expect(progressEvent?.[1]).toMatchObject({
      contextKey: "acp-spawn:run-cron:progress",
      agentId: "ops",
      sessionKey: "global",
    });
  });

  it("emits a pre-prompt stall notice and a resumed notice when output returns", () => {
    const relay = createRelay("run-2");

    vi.advanceTimersByTime(60_000);
    expectFragments(["no prompt submission was observed for 60s"]);

    relay.assistant("resumed output");
    vi.advanceTimersByTime(2_500);

    expectFragments(["resumed output.", "codex: resumed output"]);

    relay.emit("lifecycle", {
      phase: "error",
      error: "boom",
    });
    expectFragments(["run failed: boom"]);
  });

  it("classifies stalls after prompt submission but before the first runtime event", () => {
    const relay = createRelay("run-prompt-stall");

    relay.prompt(["HTTPS_PROXY"]);
    vi.advanceTimersByTime(60_000);

    expectFragments(
      ["prompt was submitted but no ACP runtime event arrived for 60s", "proxy env: HTTPS_PROXY"],
      ["waiting for interactive input"],
    );
  });

  it("classifies runtime activity without visible assistant output separately from input waits", () => {
    const relay = createRelay("run-runtime-stall");

    relay.prompt();
    vi.advanceTimersByTime(45_000);
    relay.status("connecting to upstream");
    vi.advanceTimersByTime(45_000);
    expectFragments([], ["has ACP runtime activity"]);

    vi.advanceTimersByTime(15_000);

    expectFragments(
      [
        "has ACP runtime activity but no visible assistant output for 60s",
        "Last ACP event: status",
      ],
      ["waiting for interactive input"],
    );
  });

  it("auto-disposes stale relays after max lifetime timeout", () => {
    const relay = createRelay("run-3");

    vi.advanceTimersByTime(6 * 60 * 60 * 1000);
    expectFragments(["stream relay timed out after 21600s"]);

    const before = enqueueSessionEventMock.mock.calls.length;
    relay.assistant("late output");
    vi.advanceTimersByTime(2_500);

    expect(enqueueSessionEventMock.mock.calls).toHaveLength(before);
  });

  it("relays the latest replaceable assistant snapshot instead of superseded drafts", () => {
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

    expectFragments(["codex: final answer"], ["coordination draft"]);
  });

  it.each(["final", "status"] as const)("flushes commentary before %s output", (boundary) => {
    const relay = progressRelay(
      `run-commentary-${boundary}`,
      boundary === "status" ? { stream: { tagVisibility: { plan: true } } } : undefined,
    );
    relay.assistant("checking files", "commentary");
    if (boundary === "final") {
      relay.assistant("ready");
      vi.advanceTimersByTime(2_500);
    } else {
      relay.status("plan: inspect the runtime handoff first", "plan");
    }
    expect(collectedTexts()).toEqual([
      "codex: checking files",
      boundary === "final" ? "codex: ready" : "codex: plan: inspect the runtime handoff first",
    ]);
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
  ])("$name", ({ name, first, second, flushFirst, expected }) => {
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
  });

  type Streaming = { mode?: "progress" | "off"; progress?: { commentary: boolean } };
  type CommentaryOptions = {
    channel?: string;
    streaming?: Streaming;
    accountStreaming?: { mode?: "off"; progress?: { commentary: boolean } };
    configuredAccount?: string;
    accountId?: string;
  };
  const progress: Streaming = { mode: "progress" };
  const on = { progress: { commentary: true } };
  const off = { progress: { commentary: false } };
  it.each<[string, CommentaryOptions, "assistant" | "item", boolean]>([
    ["Discord progress", { channel: "discord", streaming: progress }, "assistant", true],
    ["Discord unset", { channel: "discord" }, "item", false],
    ["commentary disabled", { streaming: { ...progress, ...off } }, "item", false],
    [
      "normalized account opt-out",
      {
        streaming: progress,
        accountStreaming: off,
        configuredAccount: "Carey Notifications",
        accountId: "carey-notifications",
      },
      "item",
      false,
    ],
    [
      "account mode opt-out",
      {
        streaming: { ...progress, ...on },
        accountStreaming: { mode: "off" },
      },
      "item",
      false,
    ],
    ["account inherits mode", { streaming: progress, accountStreaming: on }, "assistant", true],
    [
      "channel mode off",
      {
        channel: "discord",
        streaming: { mode: "off" },
        accountStreaming: on,
      },
      "assistant",
      false,
    ],
  ])("%s", (name, options, stream, visible) => {
    const {
      channel = "forum",
      streaming,
      accountStreaming,
      configuredAccount = "work",
      accountId = configuredAccount,
    } = options;
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
  });

  it("does not relay ACP status tags hidden by default when progress commentary is enabled", () => {
    const relay = progressRelay("run-status-commentary-default-hidden");

    relay.status("plan: inspect the runtime handoff first", "plan");
    vi.advanceTimersByTime(2_500);

    expectFragments([], ["inspect the runtime handoff"]);
  });

  it("classifies opted-in commentary as visible output for stall notices", () => {
    const relay = progressRelay("run-commentary-visible-stall");

    relay.prompt();
    relay.status("connecting to upstream");
    relay.assistant("checking active files before patching.", "commentary");
    vi.advanceTimersByTime(2_500);
    vi.advanceTimersByTime(60_000);

    expectFragments(
      ["codex: checking active files before patching.", "has produced no visible output for 60s"],
      ["has ACP runtime activity but no visible assistant output"],
    );
  });

  it("still relays final_answer assistant text after suppressed commentary", () => {
    const relay = createRelay("run-final");

    relay.assistant(
      "checking thread context; then post a tight progress reply here.",
      "commentary",
    );
    relay.assistant("final answer ready", "final_answer");
    vi.advanceTimersByTime(2_500);

    expectFragments(["codex: final answer ready"], ["checking thread context"]);
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
  ])("keeps $name on UTF-16 boundaries", ({ delta, expected }) => {
    const relay = createRelay("run-utf16-safe");

    relay.emit("assistant", { delta });

    expect(collectedTexts()).toEqual([`codex: ${expected}`]);
  });
});
