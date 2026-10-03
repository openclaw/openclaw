// Real-behavior proof for the single-pass fast path.
//
// The other real-HTTP compaction suites cover rejection, cancellation and
// oversized fallback. None of them shows `summarizeInStages` completing a
// history that exceeds the chunk cap in ONE provider request and returning a
// non-empty summary, which is the behavior this PR actually changes.
//
// This runs the real production path against a real `node:http` loopback
// server: real sockets, real HTTP status codes and a real provider wire
// format, with no provider SDK mocking. It is deliberately NOT a trace against
// an official Anthropic or Bedrock endpoint and is not presented as one.
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { resolveSummarizationRequestBudget } from "../../packages/agent-core/src/harness/compaction/summarization-budget.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { estimateMessagesTokens, SAFETY_MARGIN } from "./compaction-planning.js";
import { summarizeInStages } from "./compaction.js";
import type { AgentMessage } from "./runtime/index.js";
import type { ExtensionContext } from "./sessions/index.js";

describe("compaction single-pass success over real HTTP", () => {
  it("summarizes an over-chunk-cap history in one provider request", async () => {
    const completionRequests: Array<{ path: string; body: string }> = [];

    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        completionRequests.push({
          path: request.url ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "loopback-compaction-success",
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "loopback-compaction-model",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content:
                    "Loopback single-pass summary: the engineer traced the deployment regression end to end and kept identifier 5cf86ba9 intact.",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 8828, completion_tokens: 64, total_tokens: 8892 },
          }),
        );
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Compaction loopback server did not expose a TCP port");
      }

      const model = {
        id: "loopback-compaction-model",
        name: "Loopback compaction model",
        api: "openai-completions",
        provider: "openai",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 8_192,
      } satisfies NonNullable<ExtensionContext["model"]>;

      const messages: AgentMessage[] = Array.from({ length: 120 }, (_, index) =>
        makeUserMessage(
          `Turn ${index}: the engineer inspected the deployment regression, compared staging against ` +
            `production, captured the failing request shape, and recorded opaque identifier 5cf86ba9 ` +
            `for follow-up. Additional narrative keeps this turn substantial for the token budget.`,
          index + 1,
        ),
      );
      const originalHistory = Buffer.from(JSON.stringify(messages));

      const reserveTokens = 2_000;
      const maxChunkTokens = 4_000;

      // Derive the single-pass precondition from the real production helpers
      // rather than hand-tuned constants: the history must exceed the chunk cap
      // yet still fit one whole summarization request.
      const { singlePassInputTokens, completionAllowanceTokens } =
        resolveSummarizationRequestBudget({ messages, model, reserveTokens });
      expect(estimateMessagesTokens(messages)).toBeGreaterThan(maxChunkTokens);
      expect(singlePassInputTokens * SAFETY_MARGIN + completionAllowanceTokens).toBeLessThanOrEqual(
        model.contextWindow,
      );

      const summary = await summarizeInStages({
        messages,
        model,
        apiKey: "loopback-test-key", // pragma: allowlist secret
        signal: new AbortController().signal,
        reserveTokens,
        maxChunkTokens,
        contextWindow: model.contextWindow,
        parts: 4,
      });

      // One pass: a map-reduce plan would have issued one request per chunk.
      expect(completionRequests).toHaveLength(1);
      expect(completionRequests[0]?.path).toBe("/v1/chat/completions");

      // The single request really carried the whole history, not one slice.
      const sentBody = completionRequests[0]?.body ?? "";
      expect(sentBody).toContain("Turn 0:");
      expect(sentBody).toContain("Turn 119:");

      // A real, non-empty summary came back over the wire.
      expect(summary.trim()).not.toBe("");
      expect(summary).toContain("5cf86ba9");

      // The source history is untouched.
      expect(Buffer.from(JSON.stringify(messages)).equals(originalHistory)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, 30_000);
});
