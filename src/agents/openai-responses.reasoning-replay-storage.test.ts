import { zstdDecompressSync } from "node:zlib";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../../packages/ai/src/host.js";
import { streamOpenAICodexResponses } from "../../packages/ai/src/providers/openai-chatgpt-responses.js";
import { streamOpenAIResponses } from "../../packages/ai/src/providers/openai-responses.js";
import { createOpenAIResponsesTransportStreamFn } from "../../packages/ai/src/transports/openai-responses-client.js";
import type { Context, Model } from "../../packages/ai/src/types.js";
import { prepareTranscriptMessageAppendForWorker } from "../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import { parseSessionEntries } from "./sessions/session-manager-codec.js";

const originalHost = getAiTransportHost();
afterEach(() => {
  configureAiTransportHost(originalHost);
  vi.unstubAllGlobals();
});

const model = {
  id: "gpt-5.6-luna",
  name: "Synthetic reasoning replay",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} satisfies Model<"openai-responses">;
const managed = createOpenAIResponsesTransportStreamFn();
const options = { apiKey: "synthetic-test-key" };
const nativeToken = [
  Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
  Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-replay" } }),
  ).toString("base64url"),
  "signature",
].join(".");
const streams = [
  { name: "managed", native: false, call: (context: Context) => managed(model, context, options) },
  {
    name: "package",
    native: false,
    call: (context: Context) => streamOpenAIResponses(model, context, options),
  },
  {
    name: "native ChatGPT",
    native: true,
    call: (context: Context) =>
      streamOpenAICodexResponses(
        { ...model, api: "openai-chatgpt-responses", baseUrl: "https://chatgpt.test/backend-api" },
        context,
        { apiKey: nativeToken, transport: "sse" },
      ),
  },
];

function reasoningInput(request: Record<string, unknown> | undefined) {
  const input = request?.input;
  return Array.isArray(input)
    ? input.find(
        (item: unknown): item is Record<string, unknown> =>
          isRecord(item) && item.type === "reasoning",
      )
    : undefined;
}

it.each(streams)(
  "$name respects reasoning replay after canonical storage preparation",
  async (fixture) => {
    const reasoning = {
      id: "rs_synthetic_replay",
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: "Synthetic reasoning summary." }],
      content: [{ type: "reasoning_text", text: "Synthetic cleartext reasoning." }],
      encrypted_content: "Q".repeat(128),
    };
    const tool = {
      id: "fc_synthetic_replay",
      call_id: "call_synthetic_replay",
      type: "function_call",
      status: "completed",
      name: "probe",
      arguments: "{}",
    };
    const requests: Record<string, unknown>[] = [];
    const virtualFetch: typeof fetch = async (input, init) => {
      const outgoing = new Request(input, init);
      const body = Buffer.from(await outgoing.arrayBuffer());
      const request: unknown = JSON.parse(
        (outgoing.headers.get("content-encoding") === "zstd"
          ? zstdDecompressSync(body)
          : body
        ).toString("utf8"),
      );
      if (!isRecord(request)) {
        throw new Error("SDK request body is not a JSON object");
      }
      requests.push(request);
      if (requests.length > 3) {
        throw new Error("Unexpected physical SDK request");
      }
      const output = requests.length === 1 ? [reasoning, tool] : [];
      const response = {
        id: `resp_synthetic_${requests.length}`,
        object: "response",
        model: model.id,
        status: "completed",
        output,
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      };
      const events = [
        { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
        ...output.map((item, output_index) => ({
          type: "response.output_item.done",
          output_index,
          item,
        })),
        { type: "response.completed", response },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    vi.stubGlobal("fetch", virtualFetch);
    configureAiTransportHost({ buildModelFetch: () => virtualFetch });
    const firstContext = {
      messages: [{ role: "user", content: "Run the synthetic probe.", timestamp: 1 }],
    } satisfies Context;
    const call = async (context: Context) => {
      const result = fixture.call(context);
      return await (await result).result();
    };
    const assistant = await call(firstContext);
    expect(assistant.errorMessage).toBeUndefined();
    expect(assistant.stopReason).toBe("toolUse");
    expect(assistant.content.map((block) => block.type)).toEqual(["thinking", "toolCall"]);
    const toolResult = {
      role: "toolResult",
      toolCallId: "call_synthetic_replay|fc_synthetic_replay",
      toolName: "probe",
      content: [{ type: "text", text: "Synthetic probe completed." }],
      isError: false,
      timestamp: 2,
    } satisfies Context["messages"][number];
    const history = [...firstContext.messages, assistant, toolResult];
    expect((await call({ messages: history })).stopReason).toBe("stop");

    const prepared = prepareTranscriptMessageAppendForWorker({ message: assistant });
    const [entry] = parseSessionEntries(
      `{"type":"message","id":"msg_synthetic_reload","parentId":null,"timestamp":"2026-10-11T00:00:00.000Z","message":${prepared.messageJson}}`,
    );
    if (entry?.type !== "message" || entry.message.role !== "assistant") {
      throw new Error("Canonical assistant storage bytes did not reload");
    }
    const reloaded = entry.message;
    const persistedThinking = reloaded.content.find((block) => block.type === "thinking");
    if (persistedThinking?.type !== "thinking" || !persistedThinking.thinkingSignature) {
      throw new Error("Stored assistant lost its reasoning signature");
    }
    const storedSignature: unknown = JSON.parse(persistedThinking.thinkingSignature);
    expect(storedSignature).toMatchObject({ summary: [] });
    expect(storedSignature).not.toHaveProperty("content");
    expect(
      (await call({ messages: [...firstContext.messages, reloaded, toolResult] })).stopReason,
    ).toBe("stop");
    expect(requests).toHaveLength(3);
    const warm = reasoningInput(requests[1]);
    const cold = reasoningInput(requests[2]);
    expect(warm).toBeDefined();
    expect(warm?.encrypted_content).toBe(reasoning.encrypted_content);
    expect(cold?.encrypted_content).toBe(reasoning.encrypted_content);
    if (fixture.native) {
      // Codex's native reasoning input preserves its summary and reasoning-text payloads.
      expect(warm?.summary).toEqual(reasoning.summary);
      expect(warm?.content).toEqual(reasoning.content);
    } else {
      expect(JSON.stringify(cold)).toBe(JSON.stringify(warm));
      expect(warm?.summary).toEqual([]);
      expect(warm).not.toHaveProperty("content");
    }
  },
);
