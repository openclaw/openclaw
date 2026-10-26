import { afterEach, expect, it, vi } from "vitest";
import { runSlackScenario } from "./scenario-runtime.js";
import { writeSlackApprovalCheckpoint } from "./slack-live.approval-checkpoint.js";
import type {
  SlackMessage,
  SlackQaScenarioRun,
  SlackQaFetchFunction,
  SlackQaApprovalContext,
  SlackQaScenarioMetadata,
} from "./slack-live.contracts.js";
import { buildSlackApprovalCheckpointMessage } from "./slack-live.observations.js";
import {
  slackQaChartPresentationNativeScenario,
  slackQaMpimAppMentionDedupeScenario,
} from "./slack-live.scenario-implementations.js";
import { loadSlackQaRuntime } from "./slack-plugin.runtime.js";

vi.mock("./slack-live.approval-checkpoint.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./slack-live.approval-checkpoint.js")>()),
  writeSlackApprovalCheckpoint: vi.fn(),
}));

function fixture(run: SlackQaScenarioRun, channelId = "C_QA", reply?: SlackMessage) {
  const postMessage = vi.fn().mockResolvedValue({ channel: channelId, ts: "1.000000" });
  const history = vi.fn().mockResolvedValue({ messages: [reply] });
  const writes = vi.fn().mockResolvedValue([]);
  const environment = {
    channelId,
    configureScenario: async () => ({
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
    run: (
      overrides: {
        context?: SlackQaApprovalContext;
        scenario?: SlackQaScenarioMetadata;
        stopGateway?: (preserveDebugArtifacts: boolean) => Promise<void>;
      } = {},
    ) => runSlackScenario({ ...environment, ...overrides } as never, { buildRun: () => run }),
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
  const marker = `${builtRun.matchText}_BOT_TESTNONCE`;
  const run = { ...builtRun };
  for (const hook of ["afterReply", "beforeRun", "cleanup", "settleObservedMs"] as const) {
    delete run[hook];
  }
  return {
    ...fixture(run, "C_MPIM", sutMessage(marker, "2.000000", "1.000000")),
    marker,
  };
}

const requestStartedAt = "2026-09-03T12:00:00.000Z";
function expectRttEvidence(
  result: unknown,
  rttMs: number,
  source: "approval-request-to-resolution" | "request-to-observed-message",
) {
  const responseObservedAt = new Date(Date.parse(requestStartedAt) + rttMs).toISOString();
  const timing = { requestStartedAt, responseObservedAt };
  expect(result).toMatchObject({
    ...timing,
    rttMs,
    rttMeasurement: { ...timing, finalMatchedReplyRttMs: rttMs, source },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(writeSlackApprovalCheckpoint).mockReset();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("captures the native write before waiting for its final reply", async () => {
  const builtRun = slackQaChartPresentationNativeScenario.buildRun("U_SUT");
  if (!("input" in builtRun)) {
    throw new Error("expected Slack native chart message scenario");
  }
  const summaryText = builtRun.input.match(/SLACK_QA_CHART_SUMMARY_[A-Z0-9]+/u)?.[0];
  if (!summaryText) {
    throw new Error("missing Slack native chart summary marker");
  }
  const channelId = "C_NATIVE";
  const runtime = fixture(
    { ...builtRun, afterReply: undefined },
    channelId,
    sutMessage(builtRun.matchText, "3.000000"),
  );
  runtime.writes.mockResolvedValue([{ channelId, text: summaryText, ts: "2.000000" }]);

  await expect(runtime.run()).resolves.toMatchObject({
    details: expect.stringContaining("reply matched"),
  });
  expect(runtime.writes.mock.invocationCallOrder[0]).toBeLessThan(
    runtime.history.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
  );
});

it("returns structured RTT evidence for a matched reply", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(requestStartedAt);
  const runtime = createMpimRuntime();
  runtime.postMessage.mockImplementationOnce(async () => {
    vi.advanceTimersByTime(1_750);
    return { channel: "C_MPIM", ts: "1.000000" };
  });

  expectRttEvidence(await runtime.run(), 1_750, "request-to-observed-message");
});

it.each([
  ["ignores off-channel captured commentary", "C_OTHER", "commentary", "1.500000", undefined],
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
  const result = runtime.run();
  if (expectedMarkerCount) {
    await expect(result).rejects.toThrow(`got 2 response(s) and ${expectedMarkerCount}`);
    return;
  }
  await expect(result).resolves.toMatchObject({
    details: expect.stringContaining("one MPIM reply observed"),
  });
});

const actionValue =
  'openclaw:approval:v1:{"approvalId":"plugin:owned","approvalKind":"plugin","decision":"allow-once"}';
const buttons: NonNullable<SlackMessage["blocks"]> = [
  {
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Allow once" },
        action_id: "approval",
        value: actionValue,
      },
    ],
  },
];
const message = (overrides: Partial<SlackMessage> = {}): SlackMessage => ({
  user: "sut",
  ts: "100.1",
  text: "Plugin approval required marker",
  blocks: buttons,
  ...overrides,
});

function approvalHistory(pages: SlackMessage[][]) {
  return approvalClient(async (input) => {
    expect(new URL(String(input)).pathname).toBe("/api/conversations.history");
    const messages = pages.shift();
    expect(messages).toBeDefined();
    return Response.json({ ok: true, messages });
  });
}

function approvalClient(fetch: SlackQaFetchFunction) {
  return loadSlackQaRuntime().createSlackWebClient("xoxb-qa-approval-fixture", { fetch });
}

function runApproval(
  run: SlackQaScenarioRun,
  call: SlackQaApprovalContext["gateway"]["call"],
  client: SlackQaApprovalContext["sutReadClient"],
  stopGateway?: (preserveDebugArtifacts: boolean) => Promise<void>,
) {
  return fixture(run, "channel").run({
    context: { gateway: { call }, sutIdentity: { userId: "sut" }, sutReadClient: client },
    scenario: {
      id: "slack-approval",
      title: "Slack approval",
      timeoutMs: run.kind === "approval" ? 3_000 : 1_000,
    },
    ...(stopGateway ? { stopGateway } : {}),
  });
}

it("builds approval checkpoint message evidence from Slack blocks", () => {
  const text = "Plugin approval required";
  expect(
    buildSlackApprovalCheckpointMessage(
      message({
        text,
        blocks: [{ type: "section", text: { type: "mrkdwn", text } }, ...buttons],
      }),
    ),
  ).toEqual({
    actionLabels: ["Allow once"],
    blockText: [text, "Allow once"],
    hasNativeActions: true,
    text,
  });
});

it.each(["ok", "failed", "missing-command-result"] as const)(
  "records Codex approval RTT only after native verification (%s)",
  async (outcome) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(requestStartedAt);
    const phases: string[] = [];
    const marker = "SLACK_QA_CODEX_APPROVAL";
    const title = "Codex app-server command approval";
    let runId: unknown;
    let sessionKey: unknown;
    let resolved = false;
    const call = vi.fn(async (method: string, args?: unknown) => {
      phases.push(method);
      if (method === "agent") {
        const request = args as { idempotencyKey: string; sessionKey: string };
        runId = request.idempotencyKey;
        sessionKey = request.sessionKey;
      }
      if (method === "plugin.approval.resolve") {
        resolved = true;
        vi.setSystemTime(Date.parse(requestStartedAt) + 2_500);
      }
      const replies: Record<string, unknown> = {
        agent: { runId, status: "accepted" },
        "plugin.approval.list": [
          {
            id: "plugin:owned",
            request: {
              pluginId: "codex",
              title,
              toolName: "codex_command_approval",
              sessionKey,
              turnSourceChannel: "slack",
              turnSourceTo: "channel:channel",
              turnSourceAccountId: "sut",
            },
          },
        ],
        "plugin.approval.resolve": {},
        "agent.wait": { status: outcome === "failed" ? "failed" : "ok" },
        "chat.history": {
          messages: [
            {
              role: "toolResult",
              content: outcome === "missing-command-result" ? "unrelated" : marker,
            },
            { role: "assistant", content: marker },
          ],
        },
        "chat.abort": {},
      };
      if (!Object.hasOwn(replies, method)) {
        throw new Error(`unexpected Gateway method ${method}`);
      }
      return replies[method];
    });
    const fetch: SlackQaFetchFunction = async () => {
      phases.push(resolved ? "observe-resolved" : "observe-pending");
      return Response.json({
        ok: true,
        messages: [
          message({
            text: `Plugin approval${resolved ? ": Allowed once" : " required"} codex ${title}`,
            blocks: resolved ? [] : buttons,
          }),
        ],
      });
    };
    vi.mocked(writeSlackApprovalCheckpoint).mockImplementation(async ({ state }) => {
      await Promise.resolve();
      phases.push(`checkpoint-${state}`);
    });
    const stopGateway = vi.fn(async () => {
      phases.push("stop");
    });
    const result = runApproval(
      {
        kind: "codex-approval",
        approvalKind: "plugin",
        appServerMethod: "item/commandExecution/requestApproval",
        decision: "allow-once",
        token: marker,
      },
      call,
      approvalClient(fetch),
      stopGateway,
    );
    if (outcome === "ok") {
      expectRttEvidence(await result, 2_500, "approval-request-to-resolution");
    } else {
      await expect(result).rejects.toThrow(
        outcome === "failed"
          ? "finished with status failed"
          : "command result did not contain marker",
      );
    }
    expect(phases).toEqual([
      ..."agent observe-pending plugin.approval.list checkpoint-pending plugin.approval.resolve agent.wait".split(
        " ",
      ),
      ...(outcome === "failed" ? [] : ["chat.history"]),
      ...(outcome === "ok" ? ["observe-resolved", "checkpoint-resolved"] : []),
      "chat.abort",
      "agent.wait",
      "stop",
    ]);
    expect(stopGateway).toHaveBeenCalledWith(outcome !== "ok");
    expect(call).toHaveBeenCalledWith("chat.abort", { runId, sessionKey }, { timeoutMs: 10_000 });
  },
);

it("waits for native approval identity/actions and records RTT with the longer RPC deadline", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(requestStartedAt);
  const withoutActions = message({ blocks: [] });
  const resolvedText = "Plugin approval: Allowed once marker";
  const pages = [
    [message({ user: "other" }), withoutActions, message({ text: "unrelated approval" })],
    [withoutActions, message()],
    [message({ ts: "200.1", text: resolvedText, blocks: [] }), message({ text: resolvedText })],
    [message({ text: resolvedText, blocks: [] })],
  ];
  const call = vi.fn(async (method: string) => {
    if (method === "plugin.approval.resolve") {
      expect(pages).toHaveLength(2);
      vi.setSystemTime(Date.parse(requestStartedAt) + 1_250);
    }
    return method === "plugin.approval.request"
      ? { id: "plugin:owned", status: "accepted" }
      : { decision: "allow-once" };
  });
  vi.stubEnv("OPENCLAW_QA_SLACK_APPROVAL_CHECKPOINT_DIR", "");
  const result = runApproval(
    {
      kind: "approval",
      approvalKind: "plugin",
      decision: "allow-once",
      token: "marker",
    },
    call,
    approvalHistory(pages),
  );
  await vi.advanceTimersByTimeAsync(2_000);
  expectRttEvidence(await result, 2_250, "approval-request-to-resolution");
  expect(pages).toHaveLength(0);
  for (const [method, input, expectFinal] of [
    ["plugin.approval.resolve", { decision: "allow-once", id: "plugin:owned" }, false],
    ["plugin.approval.waitDecision", { id: "plugin:owned" }, true],
  ] as const) {
    expect(call).toHaveBeenCalledWith(method, input, { expectFinal, timeoutMs: 35_000 });
  }
});
