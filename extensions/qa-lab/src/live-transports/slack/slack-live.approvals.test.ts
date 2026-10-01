import { afterEach, expect, it, vi } from "vitest";
import { runSlackApprovalScenario, waitForSlackApprovalMessage } from "./slack-live.approvals.js";
import type {
  SlackMessage,
  SlackObservedMessage,
  SlackQaFetchFunction,
} from "./slack-live.contracts.js";
import { loadSlackQaRuntime } from "./slack-plugin.runtime.js";

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

function observation(pages: SlackMessage[][]) {
  const fetch: SlackQaFetchFunction = async (input) => {
    expect(new URL(String(input)).pathname).toBe("/api/conversations.history");
    const messages = pages.shift();
    expect(messages).toBeDefined();
    return Response.json({ ok: true, messages });
  };
  const client = loadSlackQaRuntime().createSlackWebClient("xoxb-qa-approval-fixture", { fetch });
  const observedMessages: SlackObservedMessage[] = [];
  return {
    approvalKind: "plugin" as const,
    channelId: "channel",
    client,
    decision: "allow-once" as const,
    observedMessages,
    oldestTs: "99.0",
    scenarioId: "approval",
    scenarioTitle: "Approval",
    sutIdentity: { userId: "sut" },
    timeoutMs: 3_000,
    token: "marker",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("retains prompt evidence while waiting for the requested native decision", async () => {
  vi.useFakeTimers();
  const withoutActions = message({ blocks: [] });
  const params = observation([
    [message({ user: "other" }), withoutActions, message({ text: "unrelated approval" })],
    [withoutActions, message()],
  ]);
  const pending = waitForSlackApprovalMessage({
    ...params,
    state: "pending",
    approvalId: "plugin:owned",
  });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await pending).toMatchObject({
    approvalId: "plugin:owned",
    actionValues: [actionValue],
    message: { ts: "100.1" },
  });
  expect(params.observedMessages).toEqual([
    {
      actionValues: [],
      blockText: [],
      botId: undefined,
      channelId: "channel",
      matchedScenario: true,
      scenarioId: "approval",
      scenarioTitle: "Approval",
      text: "Plugin approval required marker",
      threadTs: undefined,
      ts: "100.1",
      userId: "sut",
    },
    expect.objectContaining({ text: "unrelated approval", matchedScenario: false }),
    expect.objectContaining({ actionValues: [actionValue], matchedScenario: true }),
  ]);
});

it("waits for the original approval message to lose its native actions after resolution", async () => {
  vi.useFakeTimers();
  const resolvedText = "Plugin approval: Allowed once marker";
  const params = observation([
    [message({ ts: "200.1", text: resolvedText, blocks: [] }), message({ text: resolvedText })],
    [message({ text: resolvedText, blocks: [] })],
  ]);
  const pending = waitForSlackApprovalMessage({
    ...params,
    state: "resolved",
    messageTs: "100.1",
  });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await pending).toMatchObject({ actionValues: [], message: { ts: "100.1" } });
  expect(params.observedMessages).toMatchObject([
    { ts: "100.1", matchedScenario: false, actionValues: [actionValue] },
    { ts: "100.1", matchedScenario: true, actionValues: [] },
  ]);
});

it("allows live approval decision RPCs to take longer than the generic gateway probe timeout", async () => {
  const call = vi.fn(async (method: string) =>
    method === "plugin.approval.request"
      ? { id: "plugin:owned", status: "accepted" }
      : { decision: "allow-once" },
  );
  const params = observation([
    [message()],
    [message({ text: "Plugin approval: Allowed once marker", blocks: [] })],
  ]);
  vi.stubEnv("OPENCLAW_QA_SLACK_APPROVAL_CHECKPOINT_DIR", "");
  await runSlackApprovalScenario({
    channelId: params.channelId,
    context: {
      gateway: { call },
      sutIdentity: params.sutIdentity,
      sutReadClient: params.client,
    },
    observedMessages: params.observedMessages,
    run: { kind: "approval", approvalKind: "plugin", decision: "allow-once", token: "marker" },
    scenario: { id: "slack-approval", title: "Slack approval", timeoutMs: 1_000 },
    sutAccountId: "sut",
  });
  expect(call).toHaveBeenCalledWith(
    "plugin.approval.resolve",
    { decision: "allow-once", id: "plugin:owned" },
    { expectFinal: false, timeoutMs: 35_000 },
  );
  expect(call).toHaveBeenCalledWith(
    "plugin.approval.waitDecision",
    { id: "plugin:owned" },
    { expectFinal: true, timeoutMs: 35_000 },
  );
});
