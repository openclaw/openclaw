// Covers the compaction planning worker boundary and timeout behavior.
import { createAssistantMessageEventStream } from "@openclaw/llm-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { serializeConversation } from "openclaw/plugin-sdk/agent-core";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { estimateTokens } from "../../packages/agent-core/src/harness/compaction/compaction.js";
import { convertToLlm } from "../../packages/agent-core/src/harness/messages.js";
import { makeTextToolResult } from "../../test/helpers/text-tool-result.js";
import * as compactionPlanningWorkerRuntime from "./compaction-planning-worker-runtime.js";
import {
  CompactionPlanningWorkerError,
  runCompactionPlanningWorker,
} from "./compaction-planning-worker-runtime.js";
import {
  buildOversizedFallbackPlanWithWorker,
  buildSummarizationStagePlanWithWorker,
  buildSummaryChunksWithWorker,
  computeAdaptiveChunkRatioWithWorker,
} from "./compaction-planning-worker.js";
import {
  buildSummaryChunks,
  estimateMessagesTokens,
  projectCompactionInlineMediaForTransfer,
} from "./compaction-planning.js";
import {
  type CompactionPlanningWorkerInput,
  runCompactionPlanningWorkerInput,
} from "./compaction-planning.worker.js";
import { summarizeInStages } from "./compaction.js";
import type { AgentMessage } from "./runtime/index.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

function makeMessage(id: number, text = "x".repeat(4000)): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp: id,
  };
}

function createSyntheticWorkerUrl(source: string): URL {
  // Synthetic data URLs let timeout/error tests exercise Worker plumbing
  // without relying on a bundled build artifact.
  return new URL(`data:text/javascript,${encodeURIComponent(source)}`);
}

const TEST_MODEL = {
  id: "gpt-5.6-luna",
  name: "Synthetic context-limit model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://unused.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 8_192,
} satisfies Parameters<typeof summarizeInStages>[0]["model"];

const cancellablePlanningOperations = [
  {
    operation: "summary chunks",
    run: (messages: AgentMessage[], signal: AbortSignal) =>
      buildSummaryChunksWithWorker({ messages, maxChunkTokens: 1_200, signal }),
  },
  {
    operation: "oversized fallback",
    run: (messages: AgentMessage[], signal: AbortSignal) =>
      buildOversizedFallbackPlanWithWorker({ messages, contextWindow: 1_200, signal }),
  },
  {
    operation: "stage request budgeting",
    run: (messages: AgentMessage[], signal: AbortSignal) =>
      buildSummarizationStagePlanWithWorker({
        messages,
        maxChunkTokens: 1_200,
        contextWindow: TEST_MODEL.contextWindow,
        model: TEST_MODEL,
        reserveTokens: 4_096,
        signal,
      }),
  },
  {
    operation: "adaptive chunk sizing",
    run: (messages: AgentMessage[], signal: AbortSignal) =>
      computeAdaptiveChunkRatioWithWorker({ messages, contextWindow: 1_200, signal }),
  },
];

describe("compaction planning worker", () => {
  let packagedSummaryChunks: Awaited<ReturnType<typeof runCompactionPlanningWorker>>;

  beforeAll(async () => {
    packagedSummaryChunks = await runCompactionPlanningWorker({
      input: {
        kind: "summaryChunks",
        messages: [makeMessage(1), makeMessage(2), makeMessage(3)],
        maxChunkTokens: 1200,
      },
      timeoutMs: 30_000,
    });
  });

  it("rejects invalid and retired worker input", async () => {
    for (const input of [
      { kind: "summaryChunks" },
      {
        kind: "historyPrune",
        messagesToSummarize: [],
        turnPrefixMessages: [],
        tokensBefore: 0,
        contextWindowTokens: 1,
        maxHistoryShare: 0.5,
      },
    ]) {
      await expect(
        runCompactionPlanningWorker({
          // SAFETY: Exercise the worker's runtime validation with malformed protocol input.
          input: input as CompactionPlanningWorkerInput,
        }),
      ).rejects.toMatchObject({
        name: "CompactionPlanningWorkerError",
        code: "failed",
        message: "invalid compaction planning worker input",
      });
    }
  });

  it.each(
    cancellablePlanningOperations.flatMap(({ operation, run }) =>
      [63, 64].map((messageCount) => ({ operation, run, messageCount })),
    ),
  )(
    "honors cancellation for $operation with $messageCount messages",
    async ({ run, messageCount }) => {
      const reason = new Error("operator cancelled compaction");
      const signal = AbortSignal.abort(reason);
      const messages = Array.from({ length: messageCount }, (_, index) =>
        makeMessage(index + 1, "active user request"),
      );

      await expect(run(messages, signal)).rejects.toBe(reason);
    },
  );

  it("does not inspect large history after compaction is already cancelled", async () => {
    const reason = new Error("operator cancelled before planning");
    const unreadableMessages = new Proxy([] as AgentMessage[], {
      get() {
        throw new Error("history should remain unread");
      },
    });

    await expect(
      buildSummarizationStagePlanWithWorker({
        messages: unreadableMessages,
        maxChunkTokens: 1_200,
        contextWindow: TEST_MODEL.contextWindow,
        model: TEST_MODEL,
        reserveTokens: 4_096,
        signal: AbortSignal.abort(reason),
      }),
    ).rejects.toBe(reason);
  });

  it("does not resume cancelled compaction when its worker becomes unavailable", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled compaction");
    const worker = vi
      .spyOn(compactionPlanningWorkerRuntime, "runCompactionPlanningWorker")
      .mockImplementationOnce(async () => {
        controller.abort(reason);
        throw new CompactionPlanningWorkerError("worker disappeared", "unavailable");
      });

    try {
      await expect(
        buildSummaryChunksWithWorker({
          messages: Array.from({ length: 64 }, (_, index) => makeMessage(index + 1, "request")),
          maxChunkTokens: 1_200,
          signal: controller.signal,
        }),
      ).rejects.toBe(reason);
    } finally {
      worker.mockRestore();
    }
  });

  it("does not restore a worker plan after its compaction has been cancelled", async () => {
    const controller = new AbortController();
    const reason = new Error("operator cancelled compaction");
    const worker = vi
      .spyOn(compactionPlanningWorkerRuntime, "runCompactionPlanningWorker")
      .mockImplementationOnce(async () => {
        controller.abort(reason);
        return { kind: "summaryChunks", chunkIndexes: [[0]] };
      });

    try {
      await expect(
        buildSummaryChunksWithWorker({
          messages: Array.from({ length: 64 }, (_, index) => makeMessage(index + 1, "request")),
          maxChunkTokens: 1_200,
          signal: controller.signal,
        }),
      ).rejects.toBe(reason);
    } finally {
      worker.mockRestore();
    }
  });

  it("plans summary chunks in the packaged worker", () => {
    expect(packagedSummaryChunks.kind).toBe("summaryChunks");
    if (packagedSummaryChunks.kind !== "summaryChunks") {
      return;
    }
    expect(packagedSummaryChunks.chunkIndexes.flat()).toEqual([0, 1, 2]);
    expect(packagedSummaryChunks.chunkIndexes.length).toBeGreaterThan(1);
  }, 45_000);

  it("bounds image data in worker planning without changing returned summary input", async () => {
    const imageData = "a".repeat(1_000_000);
    const imageMessage = {
      role: "toolResult",
      toolCallId: "call_image",
      toolName: "browser",
      isError: false,
      content: [{ type: "image", data: imageData, mimeType: "image/png" }],
      timestamp: 1,
    } satisfies AgentMessage;
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "image" as const, data: imageData, mimeType: "image/png" }],
        timestamp: 0,
      },
      imageMessage,
      ...Array.from({ length: 62 }, (_, index) => makeMessage(index + 2)),
    ];

    const chunks = await buildSummaryChunksWithWorker({ messages, maxChunkTokens: 8_000 });
    const plannedMessages = chunks.flat();
    const plannedImageMessage = plannedMessages.find(
      (message) => message.role === "toolResult" && message.toolCallId === "call_image",
    );
    const plannedUserImageMessage = plannedMessages.find(
      (message) => message.role === "user" && message.timestamp === 0,
    );
    expect(plannedImageMessage?.role).toBe("toolResult");
    if (!plannedImageMessage || plannedImageMessage.role !== "toolResult") {
      throw new Error("expected planned tool result");
    }

    expect(plannedImageMessage.content[0]).toEqual({
      type: "image",
      data: imageData,
      mimeType: "image/png",
    });
    expect(plannedUserImageMessage?.role).toBe("user");
    if (!plannedUserImageMessage || plannedUserImageMessage.role !== "user") {
      throw new Error("expected planned user message");
    }
    expect(plannedUserImageMessage.content).toEqual([
      { type: "image", data: imageData, mimeType: "image/png" },
    ]);
    expect(estimateMessagesTokens([plannedImageMessage])).toBe(
      estimateMessagesTokens([imageMessage]),
    );
    expect(serializeConversation([plannedImageMessage])).toBe(
      serializeConversation([imageMessage]),
    );
  }, 45_000);

  it.each(
    [
      { script: "ASCII", glyph: "x" },
      { script: "common CJK", glyph: "漢" },
      { script: "rare BMP CJK", glyph: "㐀" },
      { script: "supplementary CJK", glyph: "𠀀" },
    ].flatMap(({ script, glyph }) =>
      ["text", "arguments"].map((source) => ({ script, glyph, source })),
    ),
  )(
    "preserves $script $source chunk budgets after restoring originals",
    async ({ glyph, source }) => {
      const hugeText = glyph.repeat(40_000);
      const messages: AgentMessage[] =
        source === "text"
          ? Array.from({ length: 64 }, (_, index) =>
              index === 0
                ? {
                    role: "toolResult",
                    toolCallId: "call_large",
                    toolName: "browser",
                    isError: false,
                    content: [{ type: "text", text: hugeText }],
                    timestamp: 0,
                  }
                : makeMessage(index, hugeText),
            )
          : Array.from({ length: 32 }, (_, index) => [
              makeAgentAssistantMessage({
                content: [
                  {
                    type: "toolCall",
                    id: `call_${index}`,
                    name: "write",
                    arguments: { [hugeText]: { nested: [hugeText] } },
                  },
                ],
                stopReason: "toolUse",
                timestamp: index * 2,
              }),
              {
                role: "toolResult" as const,
                toolCallId: `call_${index}`,
                toolName: "write",
                isError: false,
                content: [{ type: "text" as const, text: "ok" }],
                timestamp: index * 2 + 1,
              },
            ]).flat();
      const groupSize = source === "text" ? 1 : 2;
      const groupTokens = estimateMessagesTokens(messages.slice(0, groupSize));
      const maxChunkTokens = Math.ceil(groupTokens * 1.75);
      const chunks = await buildSummaryChunksWithWorker({ messages, maxChunkTokens });

      expect(chunks.map((chunk) => chunk.length)).toEqual(
        buildSummaryChunks({ messages, maxChunkTokens }).map((chunk) => chunk.length),
      );
      expect(chunks).toHaveLength(messages.length / groupSize);
      expect(Math.max(...chunks.map(estimateMessagesTokens))).toBeLessThanOrEqual(maxChunkTokens);
      chunks.flat().forEach((message, index) => expect(message).toBe(messages[index]));
      const fallback = await buildOversizedFallbackPlanWithWorker({
        messages,
        contextWindow: maxChunkTokens,
      });
      expect(fallback.smallMessages).toEqual([]);
      expect(fallback.oversizedNotes).toHaveLength(messages.length / groupSize);
    },
    45_000,
  );

  it("summarizes CJK history after ASCII exhausts the worker projection budget", async () => {
    const model = TEST_MODEL;
    const markers = Array.from(
      { length: 64 },
      (_, index) => `[history-${String(index).padStart(2, "0")}]`,
    );
    // The ASCII prefix fills the 256 KiB payload budget. Without weighted omitted
    // pressure, stage planning keeps all 64 messages and restores an overflowing chunk.
    const messages = markers.map((marker, index) =>
      makeMessage(
        index + 1,
        index < 32 ? "x".repeat(8_192 - marker.length) + marker : "漢".repeat(40_000) + marker,
      ),
    );
    const inputTokens: number[] = [];
    const outputAllowances: number[] = [];
    const seen = new Set<string>();
    let omissionNotes = false;
    const maxChunkTokens = 395_904;

    const summary = await summarizeInStages({
      messages,
      model,
      apiKey: "synthetic-no-credential", // pragma: allowlist secret
      signal: AbortSignal.timeout(45_000),
      reserveTokens: 4_096,
      maxChunkTokens,
      contextWindow: model.contextWindow,
      streamFn: (_model, context, options) => {
        const tokens = context.messages.reduce(
          (sum, message) => sum + estimateTokens(message),
          estimateTokens(makeMessage(0, context.systemPrompt ?? "")),
        );
        inputTokens.push(tokens);
        outputAllowances.push(options?.maxTokens ?? 0);
        const text = context.messages
          .map((message) =>
            typeof message.content === "string"
              ? message.content
              : message.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n"),
          )
          .join("\n");
        for (const marker of markers) {
          if (text.includes(marker)) {
            seen.add(marker);
          }
        }
        omissionNotes ||= /\[Large .*omitted from summary\]|\[Partial summary:/.test(text);
        if (tokens > model.contextWindow) {
          throw new Error(`context length exceeded: ${tokens} > ${model.contextWindow}`);
        }
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: "done",
          reason: "stop",
          message: makeAgentAssistantMessage({
            content: [{ type: "text", text: "Compact summary." }],
          }),
        });
        stream.end();
        return stream;
      },
    });

    expect(summary).toBe("Compact summary.");
    expect(inputTokens.length).toBeGreaterThan(0);
    expect(outputAllowances).toEqual(inputTokens.map(() => Math.floor(4_096 * 0.8)));
    expect(Math.max(...inputTokens) + Math.max(...outputAllowances)).toBeLessThanOrEqual(
      model.contextWindow,
    );
    expect([...seen].toSorted()).toEqual(markers.toSorted());
    expect(omissionNotes).toBe(false);
    expect(summary).not.toMatch(/\[Large .*omitted from summary\]|\[Partial summary:/);
  }, 45_000);

  it("plans summary chunks for worker input", () => {
    const value = runCompactionPlanningWorkerInput({
      kind: "summaryChunks",
      messages: [makeMessage(1), makeMessage(2), makeMessage(3)],
      maxChunkTokens: 1200,
    });

    expect(value.kind).toBe("summaryChunks");
    if (value.kind !== "summaryChunks") {
      return;
    }
    expect(value.chunkIndexes.flat()).toEqual([0, 1, 2]);
    expect(value.chunkIndexes.length).toBeGreaterThan(1);
  });

  it("budgets and plans a summarization stage for worker input", () => {
    const value = runCompactionPlanningWorkerInput({
      kind: "summarizationStagePlan",
      messages: Array.from({ length: 64 }, (_, index) => makeMessage(index + 1)),
      maxChunkTokens: 1_200,
      contextWindow: TEST_MODEL.contextWindow,
      model: TEST_MODEL,
      reserveTokens: 4_096,
    });

    expect(value).toMatchObject({ kind: "summarizationStagePlan" });
  });

  it.each([
    { kind: "oversizedFallback", messages: [makeMessage(1)], contextWindow: 1200 },
    { kind: "stageSplit", messages: [makeMessage(1)], maxChunkTokens: 1200 },
    { kind: "adaptiveChunkRatio", messages: [makeMessage(1)], contextWindow: 1200 },
  ])("plans $kind for worker input", (input) => {
    expect(runCompactionPlanningWorkerInput(input)).toMatchObject({
      kind: input.kind,
    });
  });

  it("preserves original user identity while worker fallback omits an oversized tool batch", async () => {
    const displacedUser = makeMessage(2, "keep the latest real user request");
    const messages: AgentMessage[] = [
      makeAgentAssistantMessage({
        content: [
          { type: "text", text: "x".repeat(12_000) },
          { type: "toolCall", id: "call_large", name: "read", arguments: {} },
        ],
        model: "gpt-5.6-luna",
        stopReason: "stop",
        timestamp: 1,
      }),
      displacedUser,
      makeTextToolResult("call_large", "read", "small result", false, 3),
      ...Array.from({ length: 61 }, (_, index) => makeMessage(index + 4, "keep")),
    ];

    const plan = await buildOversizedFallbackPlanWithWorker({ messages, contextWindow: 2_000 });

    expect(plan.smallMessages).toHaveLength(62);
    expect(plan.smallMessages[0]).toBe(displacedUser);
    expect(plan.smallMessages.every((message) => message.role === "user")).toBe(true);
    expect(plan.oversizedNotes).toEqual([expect.stringContaining("Large assistant")]);
  }, 45_000);

  it("clamps oversized worker timeouts before scheduling", async () => {
    const workerUrl = createSyntheticWorkerUrl(`
      import { parentPort } from "node:worker_threads";
      parentPort.on("message", () => parentPort.postMessage({
        status: "ok",
        value: {
          kind: "summaryChunks",
          chunkIndexes: [],
        },
      }));
    `);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      await runCompactionPlanningWorker({
        input: {
          kind: "summaryChunks",
          messages: [makeMessage(1), makeMessage(2), makeMessage(3)],
          maxChunkTokens: 1200,
        },
        timeoutMs: Number.MAX_SAFE_INTEGER,
        workerUrl,
      });
      // Node timers reject values above the signed 32-bit cap; clamping keeps
      // huge caller timeouts from firing immediately.
      expect(setTimeoutSpy.mock.calls).toContainEqual([expect.any(Function), MAX_TIMER_TIMEOUT_MS]);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("classifies missing worker runtime as unavailable", async () => {
    await expect(
      runCompactionPlanningWorker({
        input: {
          kind: "summaryChunks",
          messages: [makeMessage(1)],
          maxChunkTokens: 1200,
        },
        timeoutMs: 500,
        workerUrl: new URL("./missing-compaction-planning.worker.js", import.meta.url),
      }),
    ).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("dispatches exact request budgeting with stage planning", async () => {
    const workerKinds: string[] = [];
    const worker = vi
      .spyOn(compactionPlanningWorkerRuntime, "runCompactionPlanningWorker")
      .mockImplementation(async ({ input }) => {
        workerKinds.push(input.kind);
        if (input.kind === "summarizationStagePlan") {
          return { kind: input.kind, mode: "single", fitsWholeRequest: true };
        }
        if (input.kind === "summaryChunks") {
          return {
            kind: input.kind,
            chunkIndexes: [input.messages.map((_, index) => index)],
          };
        }
        throw new Error(`unexpected worker input: ${input.kind}`);
      });
    try {
      const summary = await summarizeInStages({
        messages: Array.from({ length: 64 }, (_, index) => makeMessage(index + 1)),
        model: TEST_MODEL,
        apiKey: "synthetic-no-credential", // pragma: allowlist secret
        reserveTokens: 4_096,
        maxChunkTokens: 1_200,
        contextWindow: TEST_MODEL.contextWindow,
        signal: AbortSignal.timeout(30_000),
        streamFn: () => {
          const stream = createAssistantMessageEventStream();
          stream.push({
            type: "done",
            reason: "stop",
            message: makeAgentAssistantMessage({
              content: [{ type: "text", text: "Compact summary." }],
            }),
          });
          stream.end();
          return stream;
        },
      });

      expect(summary).toBe("Compact summary.");
      expect(workerKinds[0]).toBe("summarizationStagePlan");
    } finally {
      worker.mockRestore();
    }
  });

  it("drops oversized inline media payloads before the worker transfer", async () => {
    // serializeConversation never emits media bytes, so the payload must not be
    // shipped across the structured-clone boundary. Budget inputs and the
    // restored split must stay identical to the unprojected history.
    const payload = "A".repeat(40_000);
    const messages: AgentMessage[] = Array.from({ length: 64 }, (_, index) => ({
      role: "user",
      content: [
        { type: "text", text: `turn ${index} ${"context ".repeat(200)}` },
        { type: "image", data: payload, mimeType: "image/png" },
      ],
      timestamp: index + 1,
    }));

    let transferredChars = 0;
    let transferredMediaPayloads = 0;
    const worker = vi
      .spyOn(compactionPlanningWorkerRuntime, "runCompactionPlanningWorker")
      .mockImplementation(async ({ input }) => {
        transferredChars = JSON.stringify(input.messages).length;
        for (const message of input.messages) {
          const content = (message as { content?: unknown }).content;
          if (!Array.isArray(content)) {
            continue;
          }
          for (const block of content) {
            const data = (block as { data?: unknown }).data;
            if (typeof data === "string" && data.length > 0) {
              transferredMediaPayloads++;
            }
          }
        }
        if (input.kind !== "summarizationStagePlan") {
          throw new Error(`unexpected worker input: ${input.kind}`);
        }
        return {
          kind: input.kind,
          mode: "split",
          chunkIndexes: [input.messages.map((_, index) => index)],
        };
      });
    try {
      const plan = await buildSummarizationStagePlanWithWorker({
        messages,
        maxChunkTokens: 8_000,
        contextWindow: TEST_MODEL.contextWindow,
        model: TEST_MODEL,
        reserveTokens: 4_096,
      });

      // No inline media payload crosses the boundary.
      expect(transferredMediaPayloads).toBe(0);
      // The transfer stays far below the raw payload size (64 x 40 KB ~ 2.5 MB).
      expect(transferredChars).toBeLessThan(500_000);
      // The restored chunk still carries the original messages with payloads,
      // so summarization input is unchanged by the transfer projection.
      expect(plan.mode).toBe("split");
      if (plan.mode !== "split") {
        throw new Error("expected split plan");
      }
      expect(plan.chunks[0]).toEqual(messages);
      const restoredBlock = (plan.chunks[0]![0] as { content: Array<{ data?: string }> })
        .content[1];
      expect(restoredBlock?.data).toBe(payload);
    } finally {
      worker.mockRestore();
    }
  });

  it("keeps the serialized summary prompt identical when media payloads are dropped", () => {
    // Direct proof that emptying `data` cannot change summarization input.
    const withPayload: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          { type: "image", data: "B".repeat(50_000), mimeType: "image/png" },
        ],
        timestamp: 1,
      },
    ];
    const projected = projectCompactionInlineMediaForTransfer(withPayload);

    expect(serializeConversation(convertToLlm(withPayload))).toBe(
      serializeConversation(convertToLlm(projected)),
    );
    expect(estimateMessagesTokens(withPayload)).toBe(estimateMessagesTokens(projected));
    // Text-only histories are returned by reference, so the common path is free.
    const textOnly: AgentMessage[] = [makeMessage(1)];
    expect(projectCompactionInlineMediaForTransfer(textOnly)).toBe(textOnly);
  });

  it("keeps timers responsive while budgeting exact large-history requests", async () => {
    const messages = Array.from({ length: 180 }, (_, index) =>
      makeMessage(index + 1, "x".repeat(12_000)),
    );
    const timer = new Promise<"timer">((resolve) => {
      setTimeout(() => resolve("timer"), 0);
    });
    const planning = buildSummarizationStagePlanWithWorker({
      messages,
      maxChunkTokens: 8_000,
      parts: 4,
      contextWindow: TEST_MODEL.contextWindow,
      model: TEST_MODEL,
      reserveTokens: 4_096,
    }).then(() => "planning" as const);

    await expect(Promise.race([timer, planning])).resolves.toBe("timer");
    await expect(planning).resolves.toBe("planning");
  }, 30_000);

  it("keeps timers responsive while planning large histories", async () => {
    // Planning large histories must happen off the main event loop; a 0ms timer
    // winning this race proves the worker path yielded control.
    const workerUrl = createSyntheticWorkerUrl(`
      import { parentPort } from "node:worker_threads";
      parentPort.on("message", () => parentPort.postMessage({
        status: "ok",
        value: {
          kind: "stageSplit",
          mode: "single",
        },
      }));
    `);
    const timer = new Promise<"timer">((resolve) => {
      setTimeout(() => resolve("timer"), 0);
    });
    const planning = runCompactionPlanningWorker({
      input: {
        kind: "stageSplit",
        messages: Array.from({ length: 180 }, (_, index) =>
          makeMessage(index + 1, "x".repeat(12_000)),
        ),
        maxChunkTokens: 8000,
        parts: 4,
      },
      timeoutMs: 30_000,
      workerUrl,
    }).then(() => "planning" as const);

    await expect(Promise.race([timer, planning])).resolves.toBe("timer");
    await expect(planning).resolves.toBe("planning");
  }, 30_000);
});
