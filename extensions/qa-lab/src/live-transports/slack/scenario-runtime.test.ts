import { afterEach, expect, it, vi } from "vitest";
import { runSlackScenario } from "./scenario-runtime.js";
import type { SlackMessage, SlackQaScenarioRun } from "./slack-live.contracts.js";
import {
  slackQaChartPresentationNativeScenario,
  slackQaMpimAppMentionDedupeScenario,
  slackQaTablePresentationNativeScenario,
} from "./slack-live.scenario-implementations.js";

const { runSlackApprovalScenario, runSlackCodexApprovalScenario } = vi.hoisted(() => ({
  runSlackApprovalScenario: vi.fn(),
  runSlackCodexApprovalScenario: vi.fn(),
}));

vi.mock("./slack-live.approvals.js", () => ({ runSlackApprovalScenario }));
vi.mock("./slack-live.codex-approval-runner.js", () => ({ runSlackCodexApprovalScenario }));

function fixture(run: SlackQaScenarioRun, channelId = "C_QA", reply?: SlackMessage) {
  const postMessage = vi.fn().mockResolvedValue({ channel: channelId, ts: "1.000000" });
  const history = vi.fn().mockResolvedValue({ messages: [reply] });
  const writes = vi.fn().mockResolvedValue([]);
  const environment = {
    channelId,
    configureScenario: vi.fn().mockResolvedValue({
      cfg: {},
      primaryModel: `${reply ? "mock-openai" : "openai"}/gpt-5.6-luna`,
      run,
    }),
    context: reply
      ? {
          driverClient: { chat: { postMessage } },
          sutReadClient: { conversations: { history } },
        }
      : {},
    getMessageWriteCursor: () => 0,
    observedMessages: [],
    readMessageWrites: writes,
    scenario: { id: "slack-runtime", title: "Slack runtime", timeoutMs: reply ? 1_000 : 30_000 },
    stopGateway: vi.fn(),
    sutAccountId: "sut",
    sutIdentity: { userId: "U_SUT", ...(reply ? { botId: "B_SUT" } : {}) },
  };
  return {
    env: environment as never,
    implementation: { buildRun: () => run },
    postMessage,
    history,
    writes,
  };
}

const sutMessage = (text: string, ts: string, thread_ts?: string): SlackMessage => ({
  bot_id: "B_SUT",
  user: "U_SUT",
  text,
  ts,
  thread_ts,
});

function createMpimRuntime() {
  const builtRun = slackQaMpimAppMentionDedupeScenario.buildRun("U_SUT");
  if (!("input" in builtRun)) {
    throw new Error("expected Slack MPIM message scenario");
  }
  const markerText = `${builtRun.matchText}_BOT_TESTNONCE`;
  const run = {
    ...builtRun,
    afterReply: undefined,
    beforeRun: undefined,
    cleanup: undefined,
    settleObservedMs: undefined,
  };
  return {
    ...fixture(run, "C_MPIM", sutMessage(markerText, "2.000000", "1.000000")),
    marker: markerText,
  };
}

const requestStartedAt = "2026-09-03T12:00:00.000Z";
function expectRttEvidence(
  result: unknown,
  rttMs: number,
  source: "approval-request-to-resolution" | "request-to-observed-message",
) {
  const responseObservedAt = new Date(Date.parse(requestStartedAt) + rttMs).toISOString();
  expect(result).toMatchObject({
    requestStartedAt,
    responseObservedAt,
    rttMs,
    rttMeasurement: {
      finalMatchedReplyRttMs: rttMs,
      requestStartedAt,
      responseObservedAt,
      source,
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

it.each([
  { kind: "chart", implementation: slackQaChartPresentationNativeScenario },
  { kind: "table", implementation: slackQaTablePresentationNativeScenario },
])(
  "captures the native $kind write before waiting for its final reply",
  async ({ kind, implementation }) => {
    const builtRun = implementation.buildRun("U_SUT");
    if (!("input" in builtRun)) {
      throw new Error(`expected Slack native ${kind} message scenario`);
    }
    const summaryText = builtRun.input.match(
      new RegExp(`SLACK_QA_${kind.toUpperCase()}_SUMMARY_[A-Z0-9]+`, "u"),
    )?.[0];
    if (!summaryText) {
      throw new Error(`missing Slack native ${kind} summary marker`);
    }
    const channelId = "C_NATIVE";
    const runtime = fixture(
      { ...builtRun, afterReply: undefined },
      channelId,
      sutMessage(builtRun.matchText, "3.000000"),
    );
    runtime.writes.mockResolvedValue([{ channelId, text: summaryText, ts: "2.000000" }]);

    await expect(runSlackScenario(runtime.env, implementation)).resolves.toMatchObject({
      details: expect.stringContaining("reply matched"),
    });
    expect(runtime.writes.mock.invocationCallOrder[0]).toBeLessThan(
      runtime.history.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  },
);

it("returns structured RTT evidence for a matched reply", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(requestStartedAt);
  const runtime = createMpimRuntime();
  runtime.postMessage.mockImplementationOnce(async () => {
    vi.advanceTimersByTime(1_750);
    return { channel: "C_MPIM", ts: "1.000000" };
  });

  expectRttEvidence(
    await runSlackScenario(runtime.env, slackQaMpimAppMentionDedupeScenario),
    1_750,
    "request-to-observed-message",
  );
});

it.each([
  ["native", "exec", "approval", "SLACK_QA_APPROVAL", "approval-1", 1_250],
  ["Codex", "plugin", "codex-approval", "SLACK_QA_CODEX_APPROVAL", "approval-2", 2_500],
] as const)(
  "returns structured RTT evidence for a %s approval",
  async (_label, approvalKind, kind, token, approvalId, rttMs) => {
    const base = { approvalKind, decision: "allow-once" as const, token };
    const runtime = fixture(
      kind === "codex-approval"
        ? {
            ...base,
            approvalKind: "plugin",
            kind,
            appServerMethod: "item/commandExecution/requestApproval",
          }
        : { ...base, kind },
    );
    const runner = kind === "approval" ? runSlackApprovalScenario : runSlackCodexApprovalScenario;
    runner.mockResolvedValueOnce({
      artifact: { approvalId },
      requestStartedAt: new Date(requestStartedAt),
      responseObservedAt: new Date(Date.parse(requestStartedAt) + rttMs),
      rttMs,
    });
    expectRttEvidence(
      await runSlackScenario(runtime.env, runtime.implementation),
      rttMs,
      "approval-request-to-resolution",
    );
  },
);

it.each([
  ["ignores off-channel captured commentary", "C_OTHER", "commentary", "1.500000", undefined],
  [
    "rejects a second same-channel non-marker response",
    "C_MPIM",
    "commentary",
    "2.500000",
    "1 marker match(es)",
  ],
  ["rejects two marker responses", "C_MPIM", "MARKER", "2.500000", "2 marker match(es)"],
  ["deduplicates the same Slack timestamp", "C_MPIM", "MARKER", "2.000000", undefined],
])("%s", async (_label, channelId, capturedText, ts, expectedMarkerCount) => {
  const runtime = createMpimRuntime();
  runtime.writes.mockResolvedValue([
    {
      channelId,
      text: capturedText === "MARKER" ? runtime.marker : capturedText,
      ts,
    },
  ]);
  const result = runSlackScenario(runtime.env, slackQaMpimAppMentionDedupeScenario);
  if (expectedMarkerCount) {
    await expect(result).rejects.toThrow(`got 2 response(s) and ${expectedMarkerCount}`);
    return;
  }
  await expect(result).resolves.toMatchObject({
    details: expect.stringContaining("one MPIM reply observed"),
  });
});
