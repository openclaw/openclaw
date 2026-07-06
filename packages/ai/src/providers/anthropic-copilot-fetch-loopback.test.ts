import http from "node:http";
import type { AddressInfo } from "node:net";
// Real-SDK loopback proof for the github-copilot Anthropic host fetch wiring.
//
// Why this file exists: the constructor-capture test in anthropic.test.ts uses
// vi.mock("@anthropic-ai/sdk"), which proves the constructor receives the
// host-built fetch but never lets the real SDK invoke it. ClawSweeper's review
// of #100550 rated that proof 🦪 because it does not exercise the real SDK
// network path. This file uses the real @anthropic-ai/sdk + http.createServer
// loopback so the SDK actually drives fetch on the wire through the host helper.
//
// Scope: github-copilot createClient branch only. Foundry/OAuth/api-key get the
// same pattern in follow-up siblings.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";
import { streamAnthropic } from "./anthropic.js";

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server;
let serverPort: number;
let receivedRequests: CapturedRequest[];

function respondWithMinimalAnthropicSse(res: http.ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(
    "event: message_start\n" +
      'data: {"type":"message_start","message":{"id":"msg_loopback","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n\n',
  );
  res.write(
    "event: content_block_start\n" +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
  );
  res.write(
    "event: content_block_delta\n" +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n',
  );
  res.write(`event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`);
  res.write(
    "event: message_delta\n" +
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
  );
  res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  res.end();
}

beforeAll(async () => {
  receivedRequests = [];
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      receivedRequests.push({
        method: req.method ?? "?",
        url: req.url ?? "?",
        headers: req.headers,
        body,
      });
      respondWithMinimalAnthropicSse(res);
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  serverPort = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  configureAiTransportHost({});
});

function makeCopilotModel(baseUrl: string): Model<"anthropic-messages"> {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "github-copilot",
    api: "anthropic-messages",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  } satisfies Model<"anthropic-messages">;
}

describe("github-copilot Anthropic host fetch wiring (loopback proof)", () => {
  it("routes the SDK request through the host-provided fetch", async () => {
    const recordingFetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const recordingFetch: typeof fetch = async (input, init) => {
      const fetchInput: RequestInfo | URL =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input
            : input instanceof Request
              ? input
              : String(input);
      const fetchInit: RequestInit | undefined =
        input instanceof Request && init === undefined ? input : init;
      const recordedUrl =
        typeof fetchInput === "string"
          ? fetchInput
          : fetchInput instanceof URL
            ? fetchInput.href
            : fetchInput.url;
      recordingFetchCalls.push({ url: recordedUrl, init });
      return globalThis.fetch(fetchInput, fetchInit);
    };
    configureAiTransportHost({ buildModelFetch: () => recordingFetch });

    receivedRequests = [];

    const model = makeCopilotModel(`http://127.0.0.1:${serverPort}`);
    const context = {
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
    } satisfies Context;

    const stream = streamAnthropic(model, context, { apiKey: "copilot-test-token" });

    const eventTypes: string[] = [];
    for await (const event of stream) {
      if (event && typeof event === "object" && "type" in event) {
        eventTypes.push(String((event as { type: unknown }).type));
      }
    }

    // Assertion 1: the host-provided fetch was invoked by the real SDK.
    expect(recordingFetchCalls).toHaveLength(1);
    const recordedUrl = recordingFetchCalls[0].url;
    expect(recordedUrl).toBe(`http://127.0.0.1:${serverPort}/v1/messages`);

    const recordedInit = recordingFetchCalls[0].init;
    expect(recordedInit?.method).toBe("POST");

    // Assertion 2: the loopback server actually received the request — proving
    // the recording fetch was invoked on the real network path, not in-memory.
    // The SDK attaches the Authorization header internally (authToken on this
    // branch), so it shows up on the wire here, not necessarily on init.headers.
    expect(receivedRequests).toHaveLength(1);
    expect(receivedRequests[0].method).toBe("POST");
    expect(receivedRequests[0].url).toBe("/v1/messages");
    expect(receivedRequests[0].headers.authorization).toBe("Bearer copilot-test-token");
    expect(receivedRequests[0].headers["content-type"]).toMatch(/json/);
    // github-copilot dynamic headers added by buildCopilotDynamicHeaders()
    expect(receivedRequests[0].headers["x-initiator"]).toBe("user");
    expect(receivedRequests[0].headers["openai-intent"]).toBe("conversation-edits");

    // Assertion 3: streamAnthropic parsed the loopback SSE response into
    // AssistantMessageEvents — proves the full real-SDK → host-fetch → HTTP →
    // SSE-parser pipeline, not just the constructor wiring. Event type names
    // are streamAnthropic's normalized names, not Anthropic SDK raw names.
    expect(eventTypes.length).toBeGreaterThanOrEqual(5);
    expect(eventTypes).toContain("start");
    expect(eventTypes).toContain("text_start");
    expect(eventTypes).toContain("text_delta");
    expect(eventTypes).toContain("text_end");
    expect(eventTypes).toContain("done");

    // Assertion 4: the request body is valid Anthropic messages JSON.
    const parsedBody = JSON.parse(receivedRequests[0].body) as {
      model?: string;
      messages?: unknown[];
      stream?: boolean;
    };
    expect(parsedBody.model).toBe("claude-sonnet-4-6");
    expect(parsedBody.stream).toBe(true);
    expect(Array.isArray(parsedBody.messages)).toBe(true);
  });
});
