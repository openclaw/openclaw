import { assert, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../../llm.js";
import type { AssistantMessage, Model, StreamFn } from "../../llm.js";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";
import { generateBranchSummary, prepareBranchEntries } from "./branch-summarization.js";
import { createCompactionModel, createMessageEntry } from "./compaction.test-support.js";

function createModel(contextWindow: number, maxTokens = 8000): Model & { contextWindow: number } {
  return createCompactionModel({
    id: "branch-summary-model",
    name: "Branch Summary Model",
    contextWindow,
    maxTokens,
  });
}

function createResponse(
  model: Model,
  content: AssistantMessage["content"] = [{ type: "text", text: "Branch summary" }],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

function createResponseStream(model: Model, content?: AssistantMessage["content"]) {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "done", reason: "stop", message: createResponse(model, content) });
  stream.end();
  return stream;
}

function createCapturingStream(model: Model, responseContent?: AssistantMessage["content"]) {
  let prompt = "";
  let systemPrompt = "";
  let maxOutputTokens: number | undefined;
  const streamFn = vi.fn<StreamFn>((_model, context, options) => {
    const userMessage = context.messages[0];
    if (!userMessage || userMessage.role !== "user") {
      throw new Error("expected a user message containing the branch summary prompt");
    }
    prompt =
      typeof userMessage.content === "string"
        ? userMessage.content
        : userMessage.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    systemPrompt = context.systemPrompt ?? "";
    maxOutputTokens = options?.maxTokens;
    return createResponseStream(model, responseContent);
  });
  return {
    streamFn,
    readCapture: () => ({ prompt, systemPrompt, maxOutputTokens }),
    summarize: (
      entries: SessionTreeEntry[],
      options: Omit<
        Parameters<typeof generateBranchSummary>[1],
        "model" | "apiKey" | "signal" | "streamFn"
      > = {},
    ) =>
      generateBranchSummary(entries, {
        model,
        apiKey: "test-key",
        signal: new AbortController().signal,
        streamFn,
        ...options,
      }),
  };
}

function userEntry(content: string, index: number) {
  return createMessageEntry({ role: "user", content, timestamp: index + 1 }, index);
}

function createLongBranchEntries(count: number): SessionTreeEntry[] {
  return Array.from({ length: count }, (_, index) =>
    userEntry(`turn-${index} ${"x".repeat(3500)}`, index),
  );
}

describe("branch summarization", () => {
  it("consumes the decorated stream before reading its result", async () => {
    const model = createModel(128_000);
    let consumed = false;
    const streamFn = vi.fn<StreamFn>(() => ({
      [Symbol.asyncIterator]() {
        return {
          async next() {
            consumed = true;
            return { done: true as const, value: undefined };
          },
        };
      },
      async result() {
        if (!consumed) {
          throw new Error("stream result read before iteration");
        }
        return createResponse(model);
      },
    }));

    await generateBranchSummary([userEntry("summarize this branch", 0)], {
      model,
      apiKey: "test-key",
      signal: new AbortController().signal,
      streamFn,
    });

    expect(consumed).toBe(true);
  });

  it("rejects whitespace-only model output before creating a summary", async () => {
    const content: AssistantMessage["content"] = [{ type: "text", text: " \n\t " }];
    const model = createModel(128_000);
    const streamFn = vi.fn<StreamFn>(() => createResponseStream(model, content));
    const entries = [userEntry("summarize this branch", 0)];

    const result = await generateBranchSummary(entries, {
      model,
      apiKey: "test-key",
      signal: new AbortController().signal,
      streamFn,
    });

    assert(!result.ok);
    expect(result.error).toMatchObject({
      name: "BranchSummaryError",
      code: "summarization_failed",
      message: "Branch summary failed: model returned no summary text",
    });
  });

  it("preserves valid summary whitespace, preamble, and file metadata", async () => {
    const model = createModel(128_000);
    const summaryText = "  Branch summary body  \ncontinues ";
    const capture = createCapturingStream(model, [
      { type: "text", text: "  Branch summary body  " },
      { type: "text", text: "continues " },
    ]);
    const entries: SessionTreeEntry[] = [
      userEntry("inspect files", 0),
      {
        type: "custom_message",
        id: "entry-1",
        parentId: "entry-0",
        timestamp: new Date(1).toISOString(),
        customType: "openclaw.runtime-context",
        content: "PRIVATE_RUNTIME_CONTEXT",
        display: false,
        details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
      },
      createMessageEntry(
        createResponse(model, [
          { type: "thinking", thinking: "PRIVATE_BRANCH_REASONING" },
          { type: "text", text: "Visible branch answer" },
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/read.ts" } },
          {
            type: "toolCall",
            id: "write-1",
            name: "write",
            arguments: { path: "src/write.ts" },
          },
        ]),
        2,
      ),
    ];

    const result = await capture.summarize(entries);

    assert(result.ok);
    expect(result.value).toEqual({
      summary: `The user explored a different conversation branch before returning here.
Summary of that exploration:

${summaryText}

<read-files>
src/read.ts
</read-files>

<modified-files>
src/write.ts
</modified-files>`,
      readFiles: ["src/read.ts"],
      modifiedFiles: ["src/write.ts"],
    });
    expect(capture.readCapture().prompt).toContain("[Assistant]: Visible branch answer");
    expect(capture.readCapture().prompt).toContain(
      '[Assistant tool calls]: read(path="src/read.ts"); write(path="src/write.ts")',
    );
    expect(capture.readCapture().prompt).not.toContain("PRIVATE_BRANCH_REASONING");
    expect(capture.readCapture().prompt).not.toContain("PRIVATE_RUNTIME_CONTEXT");
  });

  it("applies attribution instructions when custom branch instructions replace the default", async () => {
    const model = createModel(128_000);
    const capture = createCapturingStream(model);
    const result = await capture.summarize(
      [
        createMessageEntry(
          {
            role: "user",
            content: "Alice owns this branch decision.",
            timestamp: 1,
            __openclaw: { senderId: "alice-id", senderName: "Alice", senderUsername: "alice" },
          } as AgentMessage,
          0,
        ),
      ],
      {
        customInstructions: "Use this caller-owned branch format.",
        replaceInstructions: true,
      },
    );

    expect(result.ok).toBe(true);
    expect(capture.readCapture().prompt).toContain("Use this caller-owned branch format.");
    expect(capture.readCapture().prompt).toContain(
      '[User sender={"id":"alice-id","name":"Alice","username":"alice"}]: Alice owns this branch decision.',
    );
    expect(capture.readCapture().systemPrompt).toContain("Preserve attribution for material facts");
    expect(capture.readCapture().systemPrompt).toContain("is unattributed");
  });

  it("charges sender-heavy entries before selecting a branch history budget", () => {
    const attributed = {
      role: "user",
      content: "old",
      timestamp: 1,
      __openclaw: { senderId: "alice-id", senderName: "A".repeat(256) },
    } as AgentMessage;
    const recent = { role: "user", content: "new", timestamp: 2 } as AgentMessage;
    const entries = [createMessageEntry(attributed, 0), createMessageEntry(recent, 1)];

    const preparation = prepareBranchEntries(entries, 4);

    expect(preparation.messages).toMatchObject([{ role: "user", content: "new" }]);
    expect(preparation.totalTokens).toBeLessThanOrEqual(4);
  });

  it.each(["shell", "custom"] as const)(
    "preserves earlier branch context while excluding private %s activity",
    async (kind) => {
      const model = createModel(8192);
      const capture = createCapturingStream(model);
      const excludedMessage: AgentMessage =
        kind === "shell"
          ? {
              role: "bashExecution",
              command: "private command",
              output: `private output marker ${"x".repeat(80_000)}`,
              exitCode: 0,
              cancelled: false,
              truncated: false,
              timestamp: 2,
              excludeFromContext: true,
            }
          : {
              role: "custom",
              customType: "openclaw.operator-activity",
              content: `private output marker ${"x".repeat(80_000)}`,
              display: true,
              timestamp: 2,
              excludeFromContext: true,
            };
      const entries: SessionTreeEntry[] = [
        userEntry("important original request", 0),
        createMessageEntry(excludedMessage, 1),
        userEntry("continue branch", 2),
      ];

      const preparation = prepareBranchEntries(entries, 100);
      expect(preparation.messages).toMatchObject([
        { role: "user", content: "important original request" },
        { role: "user", content: "continue branch" },
      ]);
      expect(preparation.totalTokens).toBeLessThan(100);

      const visibleEntries = entries.map((entry, index) =>
        index === 1
          ? createMessageEntry({ ...excludedMessage, excludeFromContext: false }, index)
          : entry,
      );
      expect(prepareBranchEntries(visibleEntries, 100).messages).toMatchObject([
        { role: "user", content: "continue branch" },
      ]);

      const result = await capture.summarize(entries);

      expect(result.ok).toBe(true);
      expect(capture.readCapture().prompt).toContain("important original request");
      expect(capture.readCapture().prompt).toContain("continue branch");
      expect(capture.readCapture().prompt).not.toContain("private command");
      expect(capture.readCapture().prompt).not.toContain("private output marker");
      expect(JSON.stringify(entries)).toContain("private output marker");
    },
  );

  it("summarizes a large final tool failure without losing the task or exposing private details", async () => {
    const model = createModel(8192);
    const capture = createCapturingStream(model);
    const entries: SessionTreeEntry[] = [
      userEntry("run deployment", 0),
      createMessageEntry(
        {
          role: "toolResult",
          toolCallId: "deploy-call",
          toolName: "deploy",
          content: [
            {
              type: "text",
              text: `${"deployment log line\n".repeat(2400)}ERROR: deployment timed out`,
            },
          ],
          details: { privateDiagnostic: "never send internal metadata" },
          isError: true,
          timestamp: 2,
        },
        1,
      ),
    ];

    const result = await capture.summarize(entries);

    expect(result.ok).toBe(true);
    expect(capture.streamFn).toHaveBeenCalledOnce();
    expect(capture.readCapture().prompt).toContain("run deployment");
    expect(capture.readCapture().prompt).toContain("ERROR: deployment timed out");
    expect(capture.readCapture().prompt).not.toContain("never send internal metadata");
    expect(capture.readCapture().maxOutputTokens).toBe(2048);
  });

  it("bounds the complete request with an output-sized reservation and custom focus", async () => {
    const model = createModel(8192);
    const capture = createCapturingStream(model);

    const result = await capture.summarize(createLongBranchEntries(12), {
      reserveTokens: 2048,
      customInstructions: `Preserve release blockers. ${"Keep relevant decisions. ".repeat(200)}`,
    });

    const { prompt, systemPrompt, maxOutputTokens } = capture.readCapture();
    expect(result.ok).toBe(true);
    expect(prompt).toContain("turn-11");
    expect(prompt).not.toContain("turn-0");
    expect(maxOutputTokens).toBe(2048);
    expect(
      Math.ceil((prompt.length + systemPrompt.length) / 4) + (maxOutputTokens ?? 0),
    ).toBeLessThanOrEqual(model.contextWindow);
  });

  it("reports when the complete previous summary cannot fit instead of claiming there is no content", async () => {
    const model = createModel(4096);
    const capture = createCapturingStream(model);
    const text = `Preserve this branch context. ${"x".repeat(15_000)}`;
    const entries: SessionTreeEntry[] = [
      {
        type: "compaction",
        id: "entry-0",
        parentId: null,
        timestamp: new Date(1).toISOString(),
        firstKeptEntryId: "earlier-entry",
        summary: text,
        tokensBefore: 20_000,
      },
    ];
    const original = JSON.stringify(entries);

    const result = await capture.summarize(entries);

    assert(!result.ok);
    expect(result.error.code).toBe("summarization_failed");
    expect(capture.streamFn).not.toHaveBeenCalled();
    expect(JSON.stringify(entries)).toBe(original);
  });

  it("skips provider work for empty or excluded-only branch history", async () => {
    const model = createModel(4096);
    const capture = createCapturingStream(model);
    const excluded = createMessageEntry(
      {
        role: "bashExecution",
        command: "private command",
        output: "private output",
        exitCode: 0,
        cancelled: false,
        truncated: false,
        timestamp: 1,
        excludeFromContext: true,
      },
      0,
    );

    for (const entries of [[], [excluded]]) {
      const result = await capture.summarize(entries);

      expect(result).toEqual({
        ok: true,
        value: { summary: "No content to summarize", readFiles: [], modifiedFiles: [] },
      });
    }
    expect(capture.streamFn).not.toHaveBeenCalled();
  });

  it("preserves usable caller reservations larger than half the context window", async () => {
    const model = createModel(8192);
    const capture = createCapturingStream(model);

    const result = await capture.summarize(createLongBranchEntries(12), { reserveTokens: 6144 });

    expect(result.ok).toBe(true);
    expect(capture.readCapture().prompt).toContain("turn-11");
    expect(capture.readCapture().prompt).not.toContain("turn-9");
    expect(capture.readCapture().maxOutputTokens).toBe(2048);
  });

  it("scales output headroom to narrow model contexts and model output caps", async () => {
    const model = createModel(4096, 512);
    const capture = createCapturingStream(model);

    const result = await capture.summarize(createLongBranchEntries(8));

    const { prompt, systemPrompt, maxOutputTokens } = capture.readCapture();
    expect(result.ok).toBe(true);
    expect(maxOutputTokens).toBe(512);
    expect(prompt).not.toContain("turn-0");
    expect(
      Math.ceil((prompt.length + systemPrompt.length) / 4) + (maxOutputTokens ?? 0),
    ).toBeLessThanOrEqual(model.contextWindow);
  });
});
