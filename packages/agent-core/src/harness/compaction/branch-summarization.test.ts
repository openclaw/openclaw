import { assert, describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Model, StreamFn } from "../../llm.js";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";
import { generateBranchSummary, prepareBranchEntries } from "./branch-summarization.js";
import { createCompactionModel, createMessageEntry } from "./compaction.test-support.js";
import {
  assistant,
  bash,
  decoratedResponse,
  responseStream,
  text as textBlock,
  toolCall,
  toolResult,
  user,
} from "./shard-fixtures.test-support.js";

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
  content: AssistantMessage["content"] = [textBlock("Branch summary")],
): AssistantMessage {
  return assistant(content, { api: model.api, provider: model.provider, model: model.id });
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
    return responseStream(createResponse(model, responseContent));
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
  return createMessageEntry(user(content, index + 1), index);
}

function createLongBranchEntries(count: number): SessionTreeEntry[] {
  return Array.from({ length: count }, (_, index) =>
    userEntry(`turn-${index} ${"x".repeat(3500)}`, index),
  );
}

describe("branch summarization", () => {
  it("consumes the decorated stream before reading its result", async () => {
    const model = createModel(128_000);
    const { streamFn, consumed } = decoratedResponse(createResponse(model));

    await generateBranchSummary([userEntry("summarize this branch", 0)], {
      model,
      apiKey: "test-key",
      signal: new AbortController().signal,
      streamFn,
    });

    expect(consumed()).toBe(true);
  });

  it("rejects whitespace-only model output before creating a summary", async () => {
    const content: AssistantMessage["content"] = [{ type: "text", text: " \n\t " }];
    const model = createModel(128_000);
    const streamFn = vi.fn<StreamFn>(() => responseStream(createResponse(model, content)));
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
          toolCall("read", { path: "src/read.ts" }, "read-1"),
          toolCall("write", { path: "src/write.ts" }, "write-1"),
        ]),
        2,
      ),
    ];

    const result = await capture.summarize(entries);

    assert(result.ok);
    expect(result.value).toEqual({
      summary: `The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n${summaryText}\n\n<read-files>\nsrc/read.ts\n</read-files>\n\n<modified-files>\nsrc/write.ts\n</modified-files>`,
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
    const capture = createCapturingStream(createModel(128_000));
    const result = await capture.summarize(
      [
        createMessageEntry(
          user("Alice owns this branch decision.", 1, {
            senderId: "alice-id",
            senderName: "Alice",
            senderUsername: "alice",
          }),
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
    const attributed = user("old", 1, { senderId: "alice-id", senderName: "A".repeat(256) });
    const recent = user("new", 2);
    const entries = [createMessageEntry(attributed, 0), createMessageEntry(recent, 1)];

    const preparation = prepareBranchEntries(entries, 4);

    expect(preparation.messages).toMatchObject([{ role: "user", content: "new" }]);
    expect(preparation.totalTokens).toBeLessThanOrEqual(4);
  });

  it.each(["shell", "custom"] as const)(
    "preserves earlier branch context while excluding private %s activity",
    async (kind) => {
      const capture = createCapturingStream(createModel(8192));
      const excludedMessage: AgentMessage =
        kind === "shell"
          ? bash(`private output marker ${"x".repeat(80_000)}`, { timestamp: 2 })
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
    const capture = createCapturingStream(createModel(8192));
    const entries: SessionTreeEntry[] = [
      userEntry("run deployment", 0),
      createMessageEntry(
        {
          ...toolResult(`${"deployment log line\n".repeat(2400)}ERROR: deployment timed out`, {
            toolCallId: "deploy-call",
            toolName: "deploy",
            isError: true,
            timestamp: 2,
          }),
          details: { privateDiagnostic: "never send internal metadata" },
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

  it.each([
    {
      name: "custom focus",
      window: 8192,
      cap: 8000,
      count: 12,
      absent: "turn-0",
      output: 2048,
      options: {
        reserveTokens: 2048,
        customInstructions: `Preserve release blockers. ${"Keep relevant decisions. ".repeat(200)}`,
      },
    },
    {
      name: "large usable reservation",
      window: 8192,
      cap: 8000,
      count: 12,
      absent: "turn-9",
      output: 2048,
      options: { reserveTokens: 6144 },
    },
    {
      name: "narrow output cap",
      window: 4096,
      cap: 512,
      count: 8,
      absent: "turn-0",
      output: 512,
      options: {},
    },
  ])(
    "bounds branch requests with $name",
    async ({ window, cap, count, absent, output, options }) => {
      const capture = createCapturingStream(createModel(window, cap));
      expect((await capture.summarize(createLongBranchEntries(count), options)).ok).toBe(true);
      const { prompt, systemPrompt, maxOutputTokens } = capture.readCapture();
      expect(maxOutputTokens).toBe(output);
      expect(prompt).not.toContain(absent);
      if (count === 12) {
        expect(prompt).toContain("turn-11");
      }
      expect(
        Math.ceil((prompt.length + systemPrompt.length) / 4) + (maxOutputTokens ?? 0),
      ).toBeLessThanOrEqual(window);
    },
  );

  it("reports when the complete previous summary cannot fit instead of claiming there is no content", async () => {
    const capture = createCapturingStream(createModel(4096));
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
    const capture = createCapturingStream(createModel(4096));
    const excluded = createMessageEntry(bash("private output"), 0);

    for (const entries of [[], [excluded]]) {
      const result = await capture.summarize(entries);

      expect(result).toEqual({
        ok: true,
        value: { summary: "No content to summarize", readFiles: [], modifiedFiles: [] },
      });
    }
    expect(capture.streamFn).not.toHaveBeenCalled();
  });
});
