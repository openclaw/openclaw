import { embeddedAgentLog, type AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, expect, it, vi } from "vitest";
import { CodexHistoryRejection, type CodexHistoryRejectionReason } from "./history-rejection.js";
import { captureCodexSettledTurnFinalizationContext } from "./settled-turn-context.js";
import { attachCodexMirrorIdentity, attachUpstreamUserText } from "./upstream-prompt-provenance.js";

const mocks = vi.hoisted(() => ({
  readHistory: vi.fn(),
}));

vi.mock("../../session-history-worker-runtime.js", async () => {
  const { projectVerifiedSettledCodexMessages } = await import("./settled-turn-evidence.js");
  const { codexHistoryRejectionReason } = await import("./history-rejection.js");
  return {
    projectCodexSettledHistoryInWorker: async (
      params: Parameters<typeof projectVerifiedSettledCodexMessages>[1],
    ) => {
      try {
        const value = await mocks.readHistory(params, (messages: Iterable<AgentMessage>) =>
          projectVerifiedSettledCodexMessages(messages, params),
        );
        return { status: "ok", value };
      } catch (error) {
        return { status: "rejected", reason: codexHistoryRejectionReason(error) };
      }
    },
  };
});

function message(value: unknown, identity: string): AgentMessage {
  return attachCodexMirrorIdentity(value as AgentMessage, identity);
}

const user = (content: string, identity: string) => message({ role: "user", content }, identity);
const call = (id: string, identity: string, name = "message") =>
  message(
    { role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }] },
    identity,
  );
const result = (id: string, text: string, identity: string, toolName = "message") =>
  message(
    { role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text }] },
    identity,
  );

function settledTurn(): [AgentMessage, AgentMessage, AgentMessage] {
  return [
    user("Send it.", "turn-2:prompt"),
    call("call-2", "turn-2:tool:call-2:call"),
    result("call-2", "sent", "turn-2:tool:call-2:result"),
  ];
}

function capture(
  messages: AgentMessage[],
  overrides: Partial<Parameters<typeof captureCodexSettledTurnFinalizationContext>[0]> = {},
) {
  return captureCodexSettledTurnFinalizationContext({
    sessionFile: "/tmp/session.jsonl",
    sessionId: "session-1",
    turnId: "turn-2",
    model: "gpt-5.6-luna",
    mirroredMessages: messages,
    settledMessages: messages,
    ...overrides,
  });
}

async function captureContext(
  settledMessages: AgentMessage[],
  historyMessages = settledMessages,
  overrides: Parameters<typeof capture>[1] = {},
) {
  mocks.readHistory.mockImplementation(
    (_target, read: (messages: Iterable<AgentMessage>) => unknown) => read(historyMessages),
  );
  return capture(settledMessages, overrides);
}

async function expectRejected(
  capturing: () => Promise<unknown>,
  reason: CodexHistoryRejectionReason,
) {
  const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
  try {
    await expect(capturing()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("codex settled-turn finalization context capture failed", {
      reason,
    });
  } finally {
    warn.mockRestore();
  }
}

const userItem = (text: string) => ({
  type: "message",
  role: "user",
  content: [{ type: "input_text", text }],
});
const settledItems = () => [
  userItem("Send it."),
  { type: "function_call", call_id: "call-2", name: "message", arguments: "{}" },
  { type: "function_call_output", call_id: "call-2", output: "sent" },
];

beforeEach(() => {
  mocks.readHistory.mockReset();
});

it.each([
  { ending: "abort", rejected: false },
  { ending: "abort", rejected: true },
  { ending: "closure", rejected: false },
  { ending: "closure", rejected: true },
])(
  "keeps owner $ending ahead of capture diagnostics (rejected=$rejected)",
  async ({ ending, rejected }) => {
    const messages = settledTurn();
    const reading = createDeferred<void>();
    const finish = createDeferred<void>();
    const controller = new AbortController();
    let active = true;
    mocks.readHistory.mockImplementationOnce(async (_target, read) => {
      reading.resolve();
      await finish.promise;
      if (rejected) {
        throw new CodexHistoryRejection("field_limit");
      }
      return read(messages);
    });
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => {});
    const pending = capture(messages, {
      signal: controller.signal,
      assertActive: () => {
        if (!active) {
          throw new Error("synthetic owner closed");
        }
      },
    });
    await reading.promise;
    if (ending === "abort") {
      controller.abort(new Error("synthetic capture aborted"));
    } else {
      active = false;
    }
    finish.resolve();
    try {
      await expect(pending).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith("codex settled-turn finalization context capture failed", {
        reason: ending === "abort" ? "cancelled" : "history_read_failed",
      });
    } finally {
      warn.mockRestore();
    }
  },
);

it("captures source selection and the exact settled branch", async () => {
  const modelProvider = "openai";
  const prior = user("Alice is the recipient.", "turn-1:prompt");
  const settledMessages = settledTurn();
  const later = user("later message", "turn-3:prompt");
  const historyMessages = [prior, ...settledMessages, later];
  const selection = { model: "gpt-5.6-luna", modelProvider, authProfileId: "openai:captured" };

  const context = await captureContext(settledMessages, historyMessages, selection);

  Object.assign(prior, { content: "changed after capture" });
  Object.assign(selection, { model: "changed-model", authProfileId: "openai:changed" });
  expect(context?.data).toEqual([userItem("Alice is the recipient."), ...settledItems()]);
  expect(context?.selection).toEqual({
    model: "gpt-5.6-luna",
    modelProvider,
    authProfileId: "openai:captured",
  });
});

it("captures a turn whose internal prompt was never mirrored, anchored at its first tool call", async () => {
  // A stranded-reply retry suppresses its system prompt and carries no recorder, so the
  // transcript holds no `turn-2:prompt` row; the turn's evidence starts at its tool call.
  const prior = [
    user("Send the update to Alice.", "turn-1:prompt"),
    message(
      { role: "assistant", content: [{ type: "text", text: "Update: shipped." }] },
      "turn-1:final",
    ),
  ];
  const settledMessages = settledTurn().slice(1);
  const historyMessages = [...prior, ...settledMessages];

  const rejected = await captureContext(settledMessages, historyMessages);
  expect(rejected).toBeUndefined();

  const context = await captureContext(settledMessages, historyMessages, {
    promptSuppressed: true,
  });
  expect(context?.data).toEqual([
    userItem("Send the update to Alice."),
    {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Update: shipped." }],
    },
    ...settledItems().slice(1),
  ]);
});

it("still rejects a suppressed-prompt turn whose evidence carries a prompt row", async () => {
  const settledMessages = settledTurn();
  await expectRejected(
    () => captureContext(settledMessages, settledMessages, { promptSuppressed: true }),
    "provenance_unexpected_prompt",
  );
});

it("rejects a suppressed-prompt turn whose evidence starts on another turn", async () => {
  const settledMessages = [
    message(
      { role: "assistant", content: [{ type: "text", text: "Update: shipped." }] },
      "turn-1:final",
    ),
    ...settledTurn().slice(1),
  ];
  await expectRejected(
    () => captureContext(settledMessages, settledMessages, { promptSuppressed: true }),
    "provenance_foreign_anchor",
  );
});

it("captures a same-run continuation against the prompt the run persisted on an earlier turn", async () => {
  // A transient retry keeps its recorder: the prompt was persisted as `turn-1:prompt`,
  // and the continuation's tools settle on `turn-2`.
  const persistedPrompt = user("Send it.", "turn-1:prompt");
  const settledMessages = [persistedPrompt, ...settledTurn().slice(1)];
  const historyMessages = [user("Older context.", "older:prompt"), ...settledMessages];

  const rejected = await captureContext(settledMessages, historyMessages);
  expect(rejected).toBeUndefined();

  const context = await captureContext(settledMessages, historyMessages, {
    promptIdentity: "turn-1:prompt",
  });
  expect(context?.data).toEqual([userItem("Older context."), ...settledItems()]);
});

it("rejects a continuation whose persisted prompt is missing from history", async () => {
  const settledMessages = [user("Send it.", "turn-1:prompt"), ...settledTurn().slice(1)];
  await expectRejected(
    () =>
      captureContext(settledMessages, settledTurn().slice(1), { promptIdentity: "turn-1:prompt" }),
    "provenance_history_order",
  );
});

it.each([
  { budget: "items", overflow: 1 },
  { budget: "bytes", overflow: 0 },
  { budget: "bytes", overflow: 1 },
])(
  "preserves current evidence at the $budget limit (overflow=$overflow)",
  async ({ budget, overflow }) => {
    const settledMessages = settledTurn();
    const expected = settledItems();
    if (budget === "items") {
      for (let index = 0; index < 197 + overflow; index += 1) {
        settledMessages.splice(
          -1,
          0,
          message(
            { role: "assistant", content: [{ type: "text", text: "Working." }] },
            `turn-2:text-${index}`,
          ),
        );
        expected.splice(-1, 0, {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Working." }],
        });
      }
    } else {
      const bytes = expected.reduce(
        (sum, item) => sum + Buffer.byteLength(JSON.stringify(item)),
        0,
      );
      const prompt = "Send it." + "x".repeat(512 * 1024 - bytes + overflow);
      settledMessages[0] = attachUpstreamUserText(settledMessages[0], prompt);
      expected[0] = userItem(prompt);
    }
    const historyMessages = [user("Older context.", "older:prompt"), ...settledMessages];
    const before = structuredClone(historyMessages);
    const context = await captureContext(settledMessages, historyMessages);
    if (overflow > 0) {
      expect(context).toBeUndefined();
    } else {
      expect(context).toBeDefined();
      expect(context?.data).toEqual(expected);
    }
    expect(historyMessages).toEqual(before);
  },
);

it.each([false, true])(
  "keeps tool pairs atomic across steering (oversized=%s)",
  async (oversized) => {
    const prior = [
      user("Look up Alice.", "prior:prompt"),
      call("lookup", "prior:call", "lookup"),
      user(oversized ? "x".repeat(65537) : "Use the work address.", "steering:prompt"),
      result("lookup", "Alice verified.", "prior:result", "lookup"),
      user("Alice is the recipient.", "recent:prompt"),
    ];
    const settledMessages = settledTurn();
    const captured = await captureContext(settledMessages, [...prior, ...settledMessages]);
    expect(captured?.data).toBeDefined();
    expect(captured?.data).toContainEqual(userItem("Alice is the recipient."));
    const serialized = JSON.stringify(captured?.data);
    if (oversized) {
      expect(serialized).toContain("Earlier conversation was omitted");
      expect(serialized).not.toContain('"call_id":"lookup"');
    } else {
      expect(captured?.data).toHaveLength(8);
      expect(serialized).toContain('"call_id":"lookup"');
      expect(serialized).not.toContain("Earlier conversation was omitted");
    }
  },
);

it("still rejects duplicate identities in omitted history", async () => {
  const prior = Array.from({ length: 201 }, (_, index) => user("prior", `old-${index}:prompt`));
  const settledMessages = settledTurn();
  await expectRejected(
    () => captureContext(settledMessages, [...prior, prior[0]!, ...settledMessages]),
    "provenance_duplicate_identity",
  );
});

it("refuses a missing model without reading transcript evidence", async () => {
  const messages = settledTurn();
  await expect(capture(messages, { model: undefined })).resolves.toBeUndefined();
  expect(mocks.readHistory).not.toHaveBeenCalled();
});

it("refuses unannotated host prompts even with the same durable key and adjacent native messages", async () => {
  const settledMessages = settledTurn();
  settledMessages[0] = attachUpstreamUserText(
    message(
      { role: "user", content: "Send it.", idempotencyKey: "durable-user-turn" },
      "turn-2:prompt",
    ),
    "Decorated upstream prompt: Send it.",
  );
  const persistedPrompt = {
    role: "user",
    content: "Send it.",
    timestamp: 1,
    idempotencyKey: "durable-user-turn",
    __openclaw: { senderIsOwner: true, transport: { messageId: "transport-message" } },
  } as AgentMessage;
  const mirroredMessages = settledMessages.slice(1);
  const historyMessages = [persistedPrompt, ...mirroredMessages];
  const before = structuredClone(historyMessages);
  await expectRejected(
    () => captureContext(settledMessages, historyMessages, { mirroredMessages }),
    "provenance_mirror_prefix",
  );
  expect(historyMessages).toEqual(before);
});

it.each<{
  name: string;
  settled?: number[];
  history?: number[];
  mirrored?: number[];
  turnId?: string;
  drift?: boolean;
  reason: CodexHistoryRejectionReason;
}>([
  { name: "missing current prompt", settled: [1, 2], reason: "provenance_missing_prompt" },
  { name: "missing current tool call", history: [0, 2], reason: "provenance_history_order" },
  {
    name: "duplicate persisted identity",
    history: [0, 1, 2, 2],
    reason: "provenance_duplicate_identity",
  },
  {
    name: "duplicate prompt after the settled boundary",
    history: [0, 1, 2, 0],
    reason: "provenance_duplicate_identity",
  },
  { name: "foreign boundary turn", turnId: "turn-3", reason: "provenance_missing_boundary" },
  {
    name: "persisted payload drift under the same mirror identity",
    drift: true,
    reason: "provenance_fingerprint_drift",
  },
  {
    name: "reordered current mirrored messages",
    mirrored: [1, 0, 2],
    reason: "provenance_mirror_prefix",
  },
])(
  "fails closed for $name",
  async ({ settled, history, mirrored, turnId = "turn-2", drift, reason }) => {
    const current = settledTurn();
    const persisted = settledTurn();
    if (drift) {
      persisted[2] = result("call-2", "different result", "turn-2:tool:call-2:result");
    }
    const select = (messages: AgentMessage[], indices = [0, 1, 2]) =>
      indices.map((index) => messages[index]!);
    const settledMessages = select(current, settled);
    await expectRejected(
      () =>
        captureContext(settledMessages, select(persisted, history), {
          turnId,
          mirroredMessages: mirrored ? select(current, mirrored) : settledMessages,
        }),
      reason,
    );
  },
);

it("rejects a read failure after the complete prefix instead of accepting partial verification", async () => {
  const settledMessages = settledTurn();
  mocks.readHistory.mockImplementation(
    (_target, read: (messages: Iterable<AgentMessage>) => unknown) =>
      read(
        (function* () {
          yield* settledMessages;
          throw new Error("synthetic suffix read failure");
        })(),
      ),
  );
  await expect(capture(settledMessages)).resolves.toBeUndefined();
});
