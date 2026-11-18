/** Tests that a CLI turn's whole-turn usage reaches the persisted assistant transcript. */
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import { upsertSessionEntry } from "../plugin-sdk/session-store-runtime.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { runPreparedCliAgent } from "./cli-runner.js";
import { buildPreparedCliRunContext, requireRecord } from "./cli-runner.test-helpers.js";
import { persistCliTurnTranscript } from "./command/transcript-persistence.js";

const { executePreparedCliRunMock } = vi.hoisted(() => ({
  executePreparedCliRunMock: vi.fn(),
}));

// mock-isolation: The test supplies parsed CLI output; no backend process may be spawned.
vi.mock("./cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: executePreparedCliRunMock,
}));

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-cli-turn-usage-");

// The Claude stream parser keeps the latest model call apart from the terminal turn total.
const turnUsageOutput = {
  sessionId: "native-session",
  usage: { input: 2, output: 1, cacheRead: 27_376 },
  diagnosticUsage: { input: 6, output: 77, cacheRead: 54_631 },
};
// The whole turn is priced once at the Sonnet API rate ($2/$10/$0.10 per M), via priceAs.
const turnUsage = {
  input: 6,
  output: 77,
  cacheRead: 54_631,
  cacheWrite: 0,
  totalTokens: 54_714,
  cost: {
    input: 0.000012,
    output: 0.00077,
    cacheRead: 0.0054631,
    cacheWrite: 0,
    total: expect.closeTo(0.0062451, 12),
  },
  contextUsage: { state: "available", promptTokens: 27_378, totalTokens: 27_379 },
};

async function runTurn(name: string, output: object, params: object = {}) {
  const root = sessionDirs.make();
  const sessionTarget = {
    agentId: "main",
    sessionId: `cli-turn-usage-${name}`,
    sessionKey: `agent:main:cli-turn-usage-${name}`,
    storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...sessionTarget,
    entry: { sessionId: sessionTarget.sessionId, updatedAt: Date.now() },
  });
  executePreparedCliRunMock.mockResolvedValue({ ...turnUsageOutput, ...output });
  const context = buildPreparedCliRunContext({
    sessionTarget,
    workspaceDir: root,
    runId: `run-claude-turn-usage-${name}`,
  });
  Object.assign(context.params, {
    config: {},
    storePath: sessionTarget.storePath,
    persistAssistantTranscript: true,
    ...params,
  });
  const result = await runPreparedCliAgent(context);
  const messages = async () =>
    (await loadTranscriptEvents(sessionTarget)).flatMap((event) =>
      typeof event === "object" && event !== null && "message" in event ? [event.message] : [],
    );
  return { result, root, sessionTarget, messages };
}

it("persists the terminal Claude turn usage for a multi-call turn", async () => {
  const { result, messages } = await runTurn("visible", { text: "done", rawText: "done" });

  // Live context metadata stays on the latest model call.
  expect(result.meta.agentMeta?.lastCallUsage).toMatchObject({ output: 1, cacheRead: 27_376 });
  const persisted = await messages();
  expect(persisted).toHaveLength(1);
  // Transcript counters account for the whole turn; the context marker keeps the last call.
  expect(requireRecord(persisted[0], "assistant message").usage).toEqual(turnUsage);
  expect(result.meta.agentMeta?.costUsd).toBeCloseTo(0.0062451, 12);
});
const messageToolParams = {
  sourceReplyDeliveryMode: "message_tool_only",
  terminalReplyExpectation: "optional",
};
// The message tool mirrors the delivered text into the session.
const mirroredTurn = {
  text: "private terminal confirmation",
  didSendViaMessagingTool: true,
  didDeliverSourceReplyViaMessageTool: true,
  messagingToolSourceReplyPayloads: [{ text: "Progress update", sourceReplyFinal: false }],
};
// An external send leaves only a receipt; the final text is left for the command fallback.
const receiptTurn = {
  text: "Sent.",
  didSendViaMessagingTool: true,
  didDeliverSourceReplyViaMessageTool: true,
};

const usageOnlyRow = (kind: string) =>
  expect.objectContaining({
    role: "assistant",
    content: [],
    display: false,
    idempotencyKey: `cli-usage:run-claude-turn-usage-${kind}`,
    usage: turnUsage,
  });

it.each([
  {
    kind: "empty",
    output: { text: "", rawText: "" },
    params: { terminalReplyExpectation: "optional" },
  },
  {
    kind: "room-event",
    output: { text: "noted", rawText: "noted" },
    params: { currentInboundEventKind: "room_event" },
  },
  { kind: "message-tool", output: mirroredTurn, params: messageToolParams },
  { kind: "message-receipt", output: receiptTurn, params: messageToolParams },
  {
    // A native final answer with a held answer: neither belongs on the usage row.
    kind: "native-receipt",
    output: {
      ...receiptTurn,
      resumeCheckpointId: "native-final-1",
      interimNativeReplies: [
        { text: "Held answer", cliSessionId: "native-session", externalId: "native-held-1" },
      ],
    },
    params: messageToolParams,
  },
])("records $kind turn usage once without a CLI reply row", async ({ kind, output, params }) => {
  const { result, messages } = await runTurn(kind, output, params);

  const persisted = await messages();
  expect(persisted).toEqual([usageOnlyRow(kind)]);
  expect(persisted[0]).not.toHaveProperty("__openclaw.importedFrom");
  expect(result.meta.agentMeta).toMatchObject({ usageRecorded: true });
  expect(result.meta.agentMeta?.costUsd).toBeCloseTo(0.0062451, 12);
});

it("writes no usage row for a room event when the caller disables transcript writes", async () => {
  const { messages } = await runTurn(
    "room-event-off",
    { text: "noted", rawText: "noted" },
    { currentInboundEventKind: "room_event", persistAssistantTranscript: false },
  );

  expect(await messages()).toEqual([]);
});

it.each([
  { kind: "mirror-fallback", output: mirroredTurn, visible: [] },
  { kind: "receipt-fallback", output: receiptTurn, visible: ["Sent."] },
])("keeps one usage row when the command fallback persists the $kind turn", async (turn) => {
  const { result, root, sessionTarget, messages } = await runTurn(
    turn.kind,
    turn.output,
    messageToolParams,
  );

  await persistCliTurnTranscript({
    ...sessionTarget,
    body: "",
    result,
    sessionEntry: undefined,
    sessionAgentId: sessionTarget.agentId,
    sessionCwd: root,
    config: {},
    runId: `run-claude-turn-usage-${turn.kind}`,
    skipUserTurn: true,
  });
  const persisted = (await messages()).map((message) => requireRecord(message, "message"));
  expect(persisted.filter((message) => message.display === false)).toEqual([
    usageOnlyRow(turn.kind),
  ]);
  // Visible fallback text keeps the context marker but no counters.
  const visible = persisted.filter((message) => message.display !== false);
  expect(visible.map((message) => (message.content as Array<{ text: string }>)[0]?.text)).toEqual(
    turn.visible,
  );
  for (const message of visible) {
    expect(message.usage).toMatchObject({
      totalTokens: 0,
      contextUsage: { state: "available", promptTokens: 27_378 },
    });
  }
});
