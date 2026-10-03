// Real-behavior proof for the single-pass recovery boundary.
//
// A verified whole-request fit may bypass the chunk budget, but *why* it failed
// decides what happens next:
//   - context overflow (input too large) -> safe to re-issue as bounded chunks;
//   - caller cancellation or a terminal transport timeout -> must stay terminal.
//
// The outer single-pass catch used to admit BOTH timeout and overflow, so a
// stalled one-pass request fell through to a second, chunked provider batch and
// prolonged compaction. These tests pin the boundary through the real
// `summarizeInStages` entrypoint against a real `node:http` loopback.
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { resolveSummarizationRequestBudget } from "../../packages/agent-core/src/harness/compaction/summarization-budget.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { estimateMessagesTokens, SAFETY_MARGIN } from "./compaction-planning.js";
import { summarizeInStages } from "./compaction.js";
import type { AgentMessage } from "./runtime/index.js";
import type { ExtensionContext } from "./sessions/index.js";

type Model = NonNullable<ExtensionContext["model"]>;

function loopbackModel(port: number): Model {
  return {
    id: "loopback-compaction-model",
    name: "Loopback compaction model",
    api: "openai-completions",
    provider: "openai",
    baseUrl: `http://127.0.0.1:${port}/v1`,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

function buildSinglePassMessages(): AgentMessage[] {
  return Array.from({ length: 120 }, (_, index) =>
    makeUserMessage(
      `Turn ${index}: the engineer inspected the deployment regression, compared staging against ` +
        `production, captured the failing request shape, and recorded opaque identifier 5cf86ba9 ` +
        `for follow-up. Additional narrative keeps this turn substantial for the token budget.`,
      index + 1,
    ),
  );
}

const SUCCESS_BODY = {
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
};

describe("compaction single-pass recovery boundary over real HTTP", () => {
  it("keeps a transport timeout terminal: exactly one provider request, then the timeout propagates", async () => {
    const requests: Array<{ path: string; body: string }> = [];

    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          path: request.url ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        // Every attempt looks like a stalled transport that finally reports a
        // timeout. The point of the test is that the outer single-pass catch must
        // NOT act on this class of error to start a chunked second batch.
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "The operation was aborted due to timeout",
              type: "timeout_error",
              code: "loopback_compaction_timeout",
            },
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

      const messages = buildSinglePassMessages();
      const reserveTokens = 2_000;
      const maxChunkTokens = 4_000;

      // Derive the single-pass precondition from the real production helpers so we
      // are genuinely on the verified whole-request fast path.
      const { singlePassInputTokens, completionAllowanceTokens } =
        resolveSummarizationRequestBudget({
          messages,
          model: loopbackModel(address.port),
          reserveTokens,
        });
      expect(estimateMessagesTokens(messages)).toBeGreaterThan(maxChunkTokens);
      expect(singlePassInputTokens * SAFETY_MARGIN + completionAllowanceTokens).toBeLessThanOrEqual(
        200_000,
      );

      const result = summarizeInStages({
        messages,
        model: loopbackModel(address.port),
        apiKey: "loopback-test-key", // pragma: allowlist secret
        signal: new AbortController().signal,
        reserveTokens,
        maxChunkTokens,
        contextWindow: 200_000,
        parts: 4,
      });

      await expect(result).rejects.toThrow(/timeout/i);
      // The terminal timeout must NOT have triggered a chunked second batch.
      expect(requests).toHaveLength(1);
      expect(requests[0]?.path).toBe("/v1/chat/completions");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, 30_000);

  it("still recovers from a context overflow by re-issuing as bounded chunks", async () => {
    const requests: Array<{ path: string; body: string }> = [];

    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          path: request.url ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        if (requests.length === 1) {
          // The whole-request attempt is rejected for being too large.
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                message: "Context length exceeded: prompt is too many tokens for this model.",
                type: "invalid_request_error",
                code: "context_length_exceeded",
              },
            }),
          );
          return;
        }
        // Bounded chunked retry succeeds.
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(SUCCESS_BODY));
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

      const messages = buildSinglePassMessages();
      const reserveTokens = 2_000;
      const maxChunkTokens = 4_000;
      const model = loopbackModel(address.port);

      const { singlePassInputTokens, completionAllowanceTokens } =
        resolveSummarizationRequestBudget({ messages, model, reserveTokens });
      expect(estimateMessagesTokens(messages)).toBeGreaterThan(maxChunkTokens);
      expect(singlePassInputTokens * SAFETY_MARGIN + completionAllowanceTokens).toBeLessThanOrEqual(
        200_000,
      );

      const summary = await summarizeInStages({
        messages,
        model,
        apiKey: "loopback-test-key", // pragma: allowlist secret
        signal: new AbortController().signal,
        reserveTokens,
        maxChunkTokens,
        contextWindow: 200_000,
        parts: 4,
      });

      // Context overflow must still trigger the bounded-chunk recovery: the first
      // whole-request attempt plus at least one chunked retry.
      expect(requests.length).toBeGreaterThanOrEqual(2);
      expect(requests[0]?.path).toBe("/v1/chat/completions");
      expect(summary.trim()).not.toBe("");
      expect(summary).toContain("5cf86ba9");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, 30_000);

  it("does not re-send the small tail when a mixed-size single-pass request times out", async () => {
    const requests: Array<{ path: string; body: string }> = [];

    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        requests.push({
          path: request.url ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "The operation was aborted due to timeout",
              type: "timeout_error",
              code: "loopback_compaction_timeout",
            },
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

      const bigBody = "Oversized turn payload. ".repeat(15_000);
      const messages: AgentMessage[] = [
        makeUserMessage(bigBody, 1),
        ...Array.from({ length: 4 }, (_, index) =>
          makeUserMessage(
            `Small follow-up turn ${index}: recorded opaque identifier 5cf86ba9 for later follow-up.`,
            index + 2,
          ),
        ),
      ];
      const reserveTokens = 2_000;
      const maxChunkTokens = 4_000;
      const model = loopbackModel(address.port);

      const { singlePassInputTokens, completionAllowanceTokens } =
        resolveSummarizationRequestBudget({ messages, model, reserveTokens });
      expect(singlePassInputTokens * SAFETY_MARGIN + completionAllowanceTokens).toBeLessThanOrEqual(
        200_000,
      );
      expect(singlePassInputTokens).toBeGreaterThan(83_000);

      const result = summarizeInStages({
        messages,
        model,
        apiKey: "loopback-test-key", // pragma: allowlist secret
        signal: new AbortController().signal,
        reserveTokens,
        maxChunkTokens,
        contextWindow: 200_000,
        parts: 4,
      });

      await expect(result).rejects.toThrow(/timeout/i);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.path).toBe("/v1/chat/completions");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }, 30_000);
});
