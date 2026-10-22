import { assert, expect, it } from "vitest";
import type { AssistantMessage } from "../../llm.js";
import type { SessionTreeEntry } from "../types.js";
import { generateBranchSummary, prepareBranchEntries } from "./branch-summarization.js";
import { createCompactionModel, createMessageEntry } from "./compaction.test-support.js";
import {
  bash,
  captureStream,
  compactionEntry,
  contains,
  custom,
  decoratedResponse,
  entries,
  excludes,
  modelReply,
  text,
  toolCall,
  toolResult,
  user,
  userEntry,
} from "./shard-fixtures.test-support.js";

type Options = Omit<
  Parameters<typeof generateBranchSummary>[1],
  "model" | "apiKey" | "signal" | "streamFn"
> & {
  contextWindow?: number;
  maxTokens?: number;
  response?: AssistantMessage["content"];
};
async function run(
  history: SessionTreeEntry[],
  {
    contextWindow = 128_000,
    maxTokens = 8000,
    response = [text("Branch summary")],
    ...options
  }: Options = {},
) {
  const model = createCompactionModel({
    id: "branch-summary-model",
    name: "Branch Summary Model",
    contextWindow,
    maxTokens,
  });
  const capture = captureStream(() => modelReply(model, response));
  const result = await generateBranchSummary(history, {
    model,
    apiKey: "test-key",
    signal: new AbortController().signal,
    streamFn: capture.streamFn,
    ...options,
  });
  return { result, ...capture.readCapture(), streamFn: capture.streamFn };
}
const longBranch = (count: number) =>
  Array.from({ length: count }, (_, i) => userEntry(`turn-${i} ${"x".repeat(3500)}`, i));

it("consumes the decorated branch stream before reading its result", async () => {
  const model = createCompactionModel({ contextWindow: 128_000 });
  const { streamFn, consumed } = decoratedResponse(modelReply(model, "Branch summary"));
  await generateBranchSummary(entries(user("summarize this branch")), {
    model,
    apiKey: "test-key",
    signal: new AbortController().signal,
    streamFn,
  });
  expect(consumed()).toBe(true);
});
it("rejects whitespace-only branch summaries", async () => {
  const { result } = await run(entries(user("summarize this branch")), {
    response: [text(" \n\t ")],
  });
  assert(!result.ok);
  expect(result.error).toMatchObject({
    name: "BranchSummaryError",
    code: "summarization_failed",
    message: "Branch summary failed: model returned no summary text",
  });
});
it("preserves summary whitespace and file metadata but excludes private context", async () => {
  const model = createCompactionModel();
  const history = [
    userEntry("inspect files", 0),
    {
      type: "custom_message" as const,
      id: "entry-1",
      parentId: "entry-0",
      timestamp: new Date(1).toISOString(),
      customType: "openclaw.runtime-context",
      content: "PRIVATE_RUNTIME_CONTEXT",
      display: false,
      details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
    },
    createMessageEntry(
      modelReply(model, [
        { type: "thinking", thinking: "PRIVATE_BRANCH_REASONING" },
        text("Visible branch answer"),
        toolCall("read", { path: "src/read.ts" }, "read-1"),
        toolCall("write", { path: "src/write.ts" }, "write-1"),
      ]),
      2,
    ),
  ];
  const { result, prompt } = await run(history, {
    response: [text("  Branch summary body  "), text("continues ")],
  });
  assert(result.ok);
  expect(result.value).toEqual({
    summary:
      "The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n  Branch summary body  \ncontinues \n\n<read-files>\nsrc/read.ts\n</read-files>\n\n<modified-files>\nsrc/write.ts\n</modified-files>",
    readFiles: ["src/read.ts"],
    modifiedFiles: ["src/write.ts"],
  });
  contains(
    prompt,
    "[Assistant]: Visible branch answer",
    '[Assistant tool calls]: read(path="src/read.ts"); write(path="src/write.ts")',
  );
  excludes(prompt, "PRIVATE_BRANCH_REASONING", "PRIVATE_RUNTIME_CONTEXT");
});
it("retains attribution when custom instructions replace the branch format", async () => {
  const { result, prompt, systemPrompt } = await run(
    entries(
      user("Alice owns this branch decision.", 1, {
        senderId: "alice-id",
        senderName: "Alice",
        senderUsername: "alice",
      }),
    ),
    { customInstructions: "Use this caller-owned branch format.", replaceInstructions: true },
  );
  expect(result.ok).toBe(true);
  contains(
    prompt,
    "Use this caller-owned branch format.",
    '[User sender={"id":"alice-id","name":"Alice","username":"alice"}]: Alice owns this branch decision.',
  );
  contains(systemPrompt, "Preserve attribution for material facts", "is unattributed");
});
it("charges sender metadata against the branch budget", () => {
  const prepared = prepareBranchEntries(
    entries(user("old", 1, { senderId: "alice-id", senderName: "A".repeat(256) }), user("new", 2)),
    4,
  );
  expect(prepared.messages).toMatchObject([{ role: "user", content: "new" }]);
  expect(prepared.totalTokens).toBeLessThanOrEqual(4);
});
it.each(["shell", "custom"] as const)(
  "excludes private %s activity without displacing earlier context",
  async (kind) => {
    const output = `private output marker ${"x".repeat(80_000)}`;
    const hidden =
      kind === "shell"
        ? bash(output, { timestamp: 2 })
        : custom(output, {
            customType: "openclaw.operator-activity",
            timestamp: 2,
            excludeFromContext: true,
          });
    const history = entries(user("important original request"), hidden, user("continue branch", 3));
    const prepared = prepareBranchEntries(history, 100);
    expect(prepared.messages).toMatchObject([
      { role: "user", content: "important original request" },
      { role: "user", content: "continue branch" },
    ]);
    expect(prepared.totalTokens).toBeLessThan(100);
    expect(
      prepareBranchEntries(
        entries(
          user("important original request"),
          { ...hidden, excludeFromContext: false },
          user("continue branch", 3),
        ),
        100,
      ).messages,
    ).toMatchObject([{ role: "user", content: "continue branch" }]);
    const { result, prompt } = await run(history, { contextWindow: 8192 });
    expect(result.ok).toBe(true);
    contains(prompt, "important original request", "continue branch");
    excludes(prompt, "private command", "private output marker");
    contains(JSON.stringify(history), "private output marker");
  },
);
it("preserves a final tool failure without sending private diagnostics", async () => {
  const history = entries(user("run deployment"), {
    ...toolResult(`${"deployment log line\n".repeat(2400)}ERROR: deployment timed out`, {
      toolCallId: "deploy-call",
      toolName: "deploy",
      isError: true,
      timestamp: 2,
    }),
    details: { privateDiagnostic: "never send internal metadata" },
  });
  const { result, prompt, streamFn, maxOutputTokens } = await run(history, { contextWindow: 8192 });
  expect(result.ok).toBe(true);
  expect(streamFn).toHaveBeenCalledOnce();
  contains(prompt, "run deployment", "ERROR: deployment timed out");
  excludes(prompt, "never send internal metadata");
  expect(maxOutputTokens).toBe(2048);
});
it.each([
  [
    "custom focus",
    8192,
    8000,
    12,
    "turn-0",
    2048,
    {
      reserveTokens: 2048,
      customInstructions: `Preserve release blockers. ${"Keep relevant decisions. ".repeat(200)}`,
    },
  ],
  ["large reservation", 8192, 8000, 12, "turn-9", 2048, { reserveTokens: 6144 }],
  ["narrow output", 4096, 512, 8, "turn-0", 512, {}],
] as const)(
  "bounds branch requests with %s",
  async (_name, contextWindow, maxTokens, count, absent, output, options) => {
    const { result, prompt, systemPrompt, maxOutputTokens } = await run(longBranch(count), {
      contextWindow,
      maxTokens,
      ...options,
    });
    expect(result.ok).toBe(true);
    expect(maxOutputTokens).toBe(output);
    excludes(prompt, absent);
    if (count === 12) {
      contains(prompt, "turn-11");
    }
    expect(
      Math.ceil((prompt.length + systemPrompt.length) / 4) + (maxOutputTokens ?? 0),
    ).toBeLessThanOrEqual(contextWindow);
  },
);
it("reports a previous summary that cannot fit without changing the history", async () => {
  const history = [
    compactionEntry(0, `Preserve this branch context. ${"x".repeat(15_000)}`, "earlier-entry", {
      tokensBefore: 20_000,
    }),
  ];
  const original = JSON.stringify(history);
  const { result, streamFn } = await run(history, { contextWindow: 4096 });
  assert(!result.ok);
  expect(result.error.code).toBe("summarization_failed");
  expect(streamFn).not.toHaveBeenCalled();
  expect(JSON.stringify(history)).toBe(original);
});
it.each([false, true])("skips provider work for excluded-only history: %s", async (excluded) => {
  const { result, streamFn } = await run(excluded ? entries(bash("private output")) : [], {
    contextWindow: 4096,
  });
  expect(result).toEqual({
    ok: true,
    value: { summary: "No content to summarize", readFiles: [], modifiedFiles: [] },
  });
  expect(streamFn).not.toHaveBeenCalled();
});
