import http from "node:http";
import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
} from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { streamAnthropic } from "../../../packages/ai/src/providers/anthropic.js";
import {
  appendHistory,
  collectCompactionEnds,
  createAssistant,
  createAutoCompactionSettings,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { compactionHandler } from "./agent-session-loop-resource-loader.test-support.js";
import type { ExtensionFactory } from "./extensions/types.js";
import { SessionManager } from "./session-manager.js";

registerAgentSessionLoopTestLifecycle();

type RefusalCase = {
  overflow?: boolean;
  overlap?: boolean;
  threshold?: boolean;
  queued?: boolean;
  later?: boolean;
};

describe("AgentSession refusal compaction", () => {
  it.each<[string, RefusalCase, number]>([
    ["refusal explanation resembles overflow", { overlap: true }, 1],
    ["threshold maintenance after refusal", { threshold: true }, 1],
    ["threshold maintenance preserves explicit queued user", { threshold: true, queued: true }, 2],
    ["actual overflow still retries", { overflow: true }, 2],
    ["explicit later user turn after refusal", { later: true }, 1],
  ])("%s", async (_name, scenario, expectedRequests) => {
    const { overflow, overlap, threshold, queued, later } = scenario;
    const requests: Array<{ url: string | undefined; body: unknown }> = [];
    const explanation = overlap
      ? "This request is refused; prompt is too long."
      : "This request is not allowed.";
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push({ url: request.url, body: JSON.parse(body) });
        if (requests.length === 1 && overflow) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "prompt is too long: 1200 tokens > 1000 maximum",
              },
            }),
          );
          return;
        }
        const refused = requests.length === 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          [
            {
              type: "message_start",
              message: { id: `msg_${requests.length}`, usage: { input_tokens: 2 } },
            },
            ...(refused
              ? []
              : [
                  {
                    type: "content_block_start",
                    index: 0,
                    content_block: { type: "text", text: "" },
                  },
                  {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "text_delta", text: "Explicit next turn completed." },
                  },
                  { type: "content_block_stop", index: 0 },
                ]),
            {
              type: "message_delta",
              delta: refused
                ? {
                    stop_reason: "refusal",
                    stop_details: {
                      type: "refusal",
                      category: "reasoning_extraction",
                      explanation,
                    },
                  }
                : { stop_reason: "end_turn" },
              usage: { input_tokens: 2, output_tokens: refused ? 0 : 1 },
            },
            { type: "message_stop" },
          ]
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected loopback TCP server");
      }
      const model = {
        ...testModel,
        id: "claude-opus-5",
        name: "Claude Opus 5 SDK compaction proof",
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: `http://127.0.0.1:${address.port}`,
        contextWindow: threshold ? 32_768 : 65_536,
        maxTokens: 16,
      } satisfies Model<"anthropic-messages">;
      const sessionManager = SessionManager.inMemory();
      await appendHistory(
        sessionManager,
        createAssistant(
          model,
          "Earlier answer.",
          "stop",
          threshold ? model.contextWindow - 15 : 10,
        ),
      );
      streamMocks.streamSimple.mockImplementation(
        (_activeModel: Model, context: Context, options?: SimpleStreamOptions) =>
          streamAnthropic(model, context, { ...options, apiKey: "redacted-fixture-token" }),
      );
      let queuedUser = false;
      const handlers: ExtensionFactory = (api) => {
        api.on("session_before_compact", async (event) => {
          if (queued && !queuedUser) {
            queuedUser = true;
            await session.followUp("explicit queued user turn");
          }
          return compactionHandler(event);
        });
      };
      const { session } = await createTestSession({
        model,
        sessionManager,
        settingsManager: createAutoCompactionSettings(),
        extension: handlers,
      });
      const compactions = collectCompactionEnds(session);
      const assistants: AssistantMessage[] = [];
      session.subscribe((event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          assistants.push(event.message);
        }
      });
      await session.prompt(threshold ? "current user request ".repeat(12) : "current user request");
      const firstTurnRequests = requests.length;
      expect(assistants[0]?.stopReason).toBe("error");
      if (!overflow) {
        expect(assistants[0]?.diagnostics).toContainEqual(
          expect.objectContaining({ type: "provider_refusal" }),
        );
      }
      if (later) {
        await session.prompt("explicit later user turn");
      }
      expect(firstTurnRequests).toBe(expectedRequests);
      expect(requests.every(({ url }) => url === "/v1/messages")).toBe(true);
      if (threshold || overflow) {
        expect(compactions).toContainEqual(
          expect.objectContaining({
            reason: overflow ? "overflow" : "threshold",
            outcome: expect.objectContaining({ status: "completed", willRetry: Boolean(overflow) }),
          }),
        );
      }
      if (!overflow) {
        expect(
          compactions.some(({ outcome }) => outcome.status === "completed" && outcome.willRetry),
        ).toBe(false);
      }
      if (queued || later) {
        expect(JSON.stringify(requests[1]?.body)).toContain(
          later ? "explicit later user turn" : "explicit queued user turn",
        );
      }
      if (later) {
        expect(requests).toHaveLength(2);
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
