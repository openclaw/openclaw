import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPrivateData,
} from "../../infra/diagnostic-events.js";
import { createClaudeCliModelCallDiagnostics } from "./model-call-diagnostics.js";
import type { PreparedCliRunContext } from "./types.js";

const CONTENT_LIMIT_BYTES = 128 * 1024;

function createContext(): PreparedCliRunContext {
  return {
    backendResolved: { id: "claude-cli", modelProvider: "anthropic" },
    contextWindowInfo: undefined,
    normalizedModel: "claude-test",
    params: {
      config: {
        diagnostics: { enabled: true, otel: { enabled: true, traces: true, captureContent: true } },
      },
      runId: "claude-diagnostics-test",
      agentId: "claude-diagnostics-agent",
      sessionId: "session-test",
    },
  } as PreparedCliRunContext;
}

const createDiagnostics = (prompt = "hello", systemPrompt?: string) =>
  createClaudeCliModelCallDiagnostics({
    context: createContext(),
    prompt,
    systemPrompt,
    transport: "stdio",
  });

async function captureModelContent(
  observe: (
    diagnostics: NonNullable<ReturnType<typeof createClaudeCliModelCallDiagnostics>>,
  ) => void,
  text = "final visible answer",
  prompt = "hello",
  systemPrompt?: string,
) {
  let completed: DiagnosticEventPrivateData | undefined;
  const stop = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
    if (event.type === "model.call.completed") {
      completed = privateData;
    }
  });
  try {
    const diagnostics = expectDefined(
      createDiagnostics(prompt, systemPrompt),
      "Claude CLI diagnostics",
    );
    diagnostics.emitStarted();
    observe(diagnostics);
    diagnostics.emitCompleted({ text });
    await waitForDiagnosticEventsDrained();
    return expectDefined(completed?.modelContent, "model content");
  } finally {
    stop();
  }
}

const thinkingBlocks = (length: number) =>
  Array.from({ length }, (_, index) => ({
    type: "thinking",
    thinking: `reason-${index}`,
  }));

describe("Claude CLI model-call diagnostics", () => {
  beforeEach(resetDiagnosticEventsForTest);
  afterEach(resetDiagnosticEventsForTest);

  it("does not create diagnostics without an active event listener", () => {
    expect(createDiagnostics()).toBeUndefined();
  });

  it("bounds large prompt and assistant content during a burst", async () => {
    const largeText = "€".repeat(256 * 1024);
    const content = await captureModelContent(
      (diagnostics) => {
        for (let index = 0; index < 250; index += 1) {
          diagnostics.observeAssistantMessage({
            content: [{ type: "text", text: `${index}:${largeText}` }],
          });
        }
      },
      "done",
      largeText,
      largeText,
    );
    const inputJson = JSON.stringify(content.inputMessages);
    const outputJson = JSON.stringify(content.outputMessages);
    expect(Buffer.byteLength(inputJson, "utf8")).toBeLessThanOrEqual(CONTENT_LIMIT_BYTES + 256);
    expect(Buffer.byteLength(content.systemPrompt ?? "", "utf8")).toBeLessThanOrEqual(
      CONTENT_LIMIT_BYTES,
    );
    expect(Buffer.byteLength(outputJson, "utf8")).toBeLessThanOrEqual(CONTENT_LIMIT_BYTES);
    expect(outputJson).toContain("...(truncated)");
  });

  it("bounds serialized escaped content across many envelopes", async () => {
    const { outputMessages } = await captureModelContent((diagnostics) => {
      for (let index = 0; index < 199; index += 1) {
        diagnostics.observeAssistantMessage({ content: `part-${index}:\u0000`.repeat(100) });
      }
    }, "done");
    expect(Buffer.byteLength(JSON.stringify(outputMessages), "utf8")).toBeLessThanOrEqual(
      CONTENT_LIMIT_BYTES,
    );
  });

  it("keeps fallback response text when prior non-text envelopes fill the limit", async () => {
    const { outputMessages } = await captureModelContent((diagnostics) => {
      for (const block of thinkingBlocks(200)) {
        diagnostics.observeAssistantMessage({ content: [block] });
      }
    });
    expect(outputMessages).toHaveLength(200);
    expect(JSON.stringify(outputMessages)).toContain("final visible answer");
    expect(JSON.stringify(outputMessages)).toContain("...(truncated)");
  });

  it("keeps fallback response text when non-text content fills the byte budget", async () => {
    const { outputMessages } = await captureModelContent((diagnostics) => {
      diagnostics.observeAssistantMessage({
        content: [{ type: "thinking", thinking: "€".repeat(256 * 1024) }],
      });
    });
    const outputJson = JSON.stringify(outputMessages);
    expect(outputJson).toContain("final visible answer");
    expect(outputJson).toContain("...(truncated)");
    expect(Buffer.byteLength(outputJson, "utf8")).toBeLessThanOrEqual(CONTENT_LIMIT_BYTES + 512);
  });

  it.each([{ content: "" }, { content: [{ type: "text", text: "" }] }])(
    "keeps the fallback reserve after empty text content (%j)",
    async ({ content }) => {
      const { outputMessages } = await captureModelContent((diagnostics) => {
        diagnostics.observeAssistantMessage({ content });
        diagnostics.observeAssistantMessage({ content: thinkingBlocks(200) });
      });
      const outputJson = JSON.stringify(outputMessages);
      expect(outputJson).toContain("final visible answer");
      expect(outputJson).toContain("...(truncated)");
    },
  );

  it.each(["tool_use", "server_tool_use", "mcp_tool_use"])(
    "captures visible assistant content without opaque %s fields",
    async (toolType) => {
      const { outputMessages } = await captureModelContent((diagnostics) => {
        diagnostics.observeAssistantMessage({
          content: [
            { type: "text", text: "Visible reply" },
            { type: "thinking", thinking: "Visible reasoning", signature: "opaque-signature" },
            { type: toolType, name: "lookup", id: "call-1", input: { hidden: "tool arguments" } },
            { type: "text", text: 42 },
            null,
          ],
          stop_reason: "tool_use",
        });
      }, "Visible reply");
      expect(outputMessages).toEqual([
        {
          role: "assistant",
          content: [
            { type: "text", text: "Visible reply" },
            { type: "thinking", thinking: "Visible reasoning" },
            { type: "tool_call", name: "lookup", id: "call-1" },
          ],
          stopReason: "tool_use",
        },
      ]);
    },
  );

  it("bounds text probing after the capture budget is exhausted", async () => {
    const { outputMessages } = await captureModelContent((diagnostics) => {
      diagnostics.observeAssistantMessage({ content: thinkingBlocks(198) });
      diagnostics.observeAssistantMessage({
        content: [
          ...Array.from({ length: 10_000 }, () => ({ type: "thinking", thinking: "later" })),
          { type: "text", text: "outside-probe-window" },
        ],
      });
    });
    const outputJson = JSON.stringify(outputMessages);
    expect(outputJson).toContain("final visible answer");
    expect(outputJson).not.toContain("outside-probe-window");
  });

  it("counts the truncation marker within the output item limit", async () => {
    const { outputMessages } = await captureModelContent((diagnostics) => {
      diagnostics.observeAssistantMessage({
        content: Array.from({ length: 201 }, (_, index) => ({
          type: "text",
          text: `part-${index}`,
        })),
      });
    }, "done");
    const messages = outputMessages as Array<{ content?: unknown[] }>;
    const itemCount = messages.reduce((sum, message) => sum + (message.content?.length ?? 0), 0);
    expect(itemCount).toBe(200);
    expect(JSON.stringify(messages)).toContain("...(truncated)");
  });
});
