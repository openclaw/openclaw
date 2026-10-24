import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
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

const progressCommentaryDeliveryContext = {
  channel: "forum",
  to: "-1001234567890",
  accountId: "default",
  threadId: 1122,
};
const relays: Array<ReturnType<typeof startAcpSpawnParentStreamRelay>> = [];

function progressRelay(acp?: OpenClawConfig["acp"]) {
  return createRelay({
    cfg: {
      ...(acp ? { acp } : {}),
      channels: { forum: { streaming: { mode: "progress", progress: { commentary: true } } } },
    },
    deliveryContext: progressCommentaryDeliveryContext,
  });
}

function createRelay(
  options: Partial<Omit<Parameters<typeof startAcpSpawnParentStreamRelay>[0], "runId">> = {},
) {
  const runId = "run";
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
    preamble: (progressText: string) =>
      emit("item", { itemId: "preamble-1", kind: "preamble", progressText }),
    end: (endedAt = 2_000) => emit("lifecycle", { phase: "end", startedAt: 1_000, endedAt }),
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
    const relay = createRelay({
      childSessionKey: "agent:codex:acp:child-1",
      deliveryContext,
    });

    expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    relay.notifyStarted();
    relay.assistant("hello");
    relay.assistant(" from child");
    vi.advanceTimersByTime(2_500);

    relay.end(3_100);

    expect(collectedTexts()).toEqual([
      "Started codex session agent:codex:acp:child-1. Streaming progress updates to parent session.",
      "codex: hello from child",
      "codex run completed in 2s.",
    ]);
    expect(enqueueSessionEventMock.mock.calls.map(([, options]) => options)).toEqual(
      ["start", "progress", "done"].map((phase) =>
        expect.objectContaining({
          contextKey: `acp-spawn:run:${phase}`,
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
    const relay = createRelay({
      requesterAgentId: "ops",
      parentSessionKey: "agent:ops:cron:nightly:run:run-1:subagent:worker",
      eventRouting: { mainKey: "primary", sessionScope: "global" },
    });

    relay.assistant("hello from child");
    vi.advanceTimersByTime(2_500);

    expect(enqueueSessionEventMock.mock.calls).toEqual([
      [
        "codex: hello from child",
        expect.objectContaining({
          contextKey: "acp-spawn:run:progress",
          agentId: "ops",
          sessionKey: "global",
        }),
      ],
    ]);
  });

  it("emits a pre-prompt stall notice and a resumed notice when output returns", () => {
    const relay = createRelay();

    vi.advanceTimersByTime(60_000);
    expectFragments(["no prompt submission was observed for 60s"]);

    relay.assistant("resumed output");
    vi.advanceTimersByTime(2_500);

    expectFragments(["resumed output.", "codex: resumed output"]);

    relay.emit("lifecycle", { phase: "error", error: "boom" });
    expectFragments(["run failed: boom"]);
  });

  it("classifies stalls after prompt submission but before the first runtime event", () => {
    const relay = createRelay();

    relay.prompt(["HTTPS_PROXY"]);
    vi.advanceTimersByTime(60_000);

    expectFragments(
      ["prompt was submitted but no ACP runtime event arrived for 60s", "proxy env: HTTPS_PROXY"],
      ["waiting for interactive input"],
    );
  });

  it("classifies runtime activity without visible assistant output separately from input waits", () => {
    const relay = createRelay();

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
    const relay = createRelay();

    vi.advanceTimersByTime(6 * 60 * 60 * 1000);
    expectFragments(["stream relay timed out after 21600s"]);

    const before = enqueueSessionEventMock.mock.calls.length;
    relay.assistant("late output");
    vi.advanceTimersByTime(2_500);

    expect(enqueueSessionEventMock.mock.calls).toHaveLength(before);
  });

  it("relays the latest replaceable assistant snapshot instead of superseded drafts", () => {
    const relay = createRelay();

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
    relay.end();

    expectFragments(["codex: final answer"], ["coordination draft"]);
  });

  it.each(["final", "status"] as const)("flushes commentary before %s output", (boundary) => {
    const relay = progressRelay(
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
    ["replaces pending", "Checking", "Reading", false, ["codex: Reading"]],
    ["omits flushed prefix", "Check", "Check files", true, ["codex: Check", "codex: files"]],
  ] as const)("preamble %s", (_name, first, second, flushFirst, expected) => {
    const relay = progressRelay();
    relay.preamble(first);
    if (flushFirst) {
      vi.advanceTimersByTime(2_500);
    }
    relay.preamble(second);
    vi.advanceTimersByTime(2_500);

    expect(collectedTexts()).toEqual(expected);
  });

  type Streaming = { mode?: "progress" | "off"; progress?: { commentary: boolean } };
  const progress: Streaming = { mode: "progress" };
  const on = { progress: { commentary: true } };
  const off = { progress: { commentary: false } };
  it.each<
    [
      string,
      string,
      Streaming | undefined,
      { mode?: "off"; progress?: { commentary: boolean } } | undefined,
      "assistant" | "item",
      boolean,
      boolean?,
    ]
  >([
    ["Discord progress", "discord", progress, undefined, "assistant", true],
    ["Discord unset", "discord", undefined, undefined, "item", false],
    ["commentary disabled", "forum", { ...progress, ...off }, undefined, "item", false],
    ["normalized account opt-out", "forum", progress, off, "item", false, true],
    ["account mode opt-out", "forum", { ...progress, ...on }, { mode: "off" }, "item", false],
    ["account inherits mode", "forum", progress, on, "assistant", true],
    ["channel mode off", "discord", { mode: "off" }, on, "assistant", false],
  ])("%s", (_name, channel, streaming, accountStreaming, stream, visible, normalizeAccount) => {
    const configuredAccount = normalizeAccount ? "Carey Notifications" : "work";
    const accountId = normalizeAccount ? "carey-notifications" : configuredAccount;
    const relay = createRelay({
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
    if (stream === "assistant") {
      relay.assistant("Checking progress.", "commentary");
    } else {
      relay.preamble("Checking progress.");
    }
    vi.advanceTimersByTime(2_500);
    expect(collectedTexts()).toEqual(visible ? ["codex: Checking progress."] : []);
  });

  it("does not relay ACP status tags hidden by default when progress commentary is enabled", () => {
    const relay = progressRelay();

    relay.status("plan: inspect the runtime handoff first", "plan");
    vi.advanceTimersByTime(2_500);

    expectFragments([], ["inspect the runtime handoff"]);
  });

  it("classifies opted-in commentary as visible output for stall notices", () => {
    const relay = progressRelay();

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
    const relay = createRelay();
    relay.assistant("checking thread context", "commentary");
    relay.assistant("final answer ready", "final_answer");
    vi.advanceTimersByTime(2_500);

    expectFragments(["codex: final answer ready"], ["checking thread context"]);
  });

  it.each([
    ["preview cutoff", `${"a".repeat(218)}😀tail`, `${"a".repeat(218)}…`],
    ["retained buffer start", `😀${"b".repeat(3_999)}`, `${"b".repeat(219)}…`],
  ])("keeps %s on UTF-16 boundaries", (_name, delta, expected) => {
    const relay = createRelay();

    relay.emit("assistant", { delta });

    expect(collectedTexts()).toEqual([`codex: ${expected}`]);
  });
});
