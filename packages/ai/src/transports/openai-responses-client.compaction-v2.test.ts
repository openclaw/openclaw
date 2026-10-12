import { zstdDecompressSync } from "node:zlib";
import type { AssistantMessage, Context, Model, StreamFn } from "@openclaw/llm-core";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../../../agent-core/src/harness/messages.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { streamSimpleOpenAICodexResponses } from "../providers/openai-chatgpt-responses.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import { requestPreparedOpenAIResponsesCompaction } from "./openai-responses-compact-request.js";
import { captureOpenAIResponsesCompaction } from "./openai-responses-compaction-replay.js";

const initialHost = getAiTransportHost();
const model = {
  id: "gpt-5.4",
  name: "Synthetic ChatGPT",
  api: "openai-chatgpt-responses",
  provider: "openai",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model;
const options = {
  apiKey: `eyJhbGciOiJub25lIn0.${Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
  ).toString("base64url")}.signature`,
  sessionId: "v2-session",
  authProfileId: "v2-account",
  transport: "sse" as const,
};
const context = {
  systemPrompt: "Stable instructions",
  tools: [
    {
      name: "lookup",
      description: "Read a record",
      parameters: Type.Object({ key: Type.String() }),
    },
  ],
  messages: [
    { role: "user", content: "remember copper", timestamp: 1 },
    { role: "user", content: "runtime context", runtimeContext: { retained: true }, timestamp: 2 },
  ],
} satisfies Context;
const checkpoint = (value = "opaque") => ({
  type: "response.output_item.done",
  output_index: 0,
  item: { type: "compaction", id: "cmp_provider_id", encrypted_content: value },
});
const completed = (status = "completed") => ({
  type: "response.completed",
  response: {
    id: "resp-test",
    status,
    output: [],
    usage: {
      input_tokens: 1000,
      output_tokens: 10,
      total_tokens: 1010,
      input_tokens_details: { cached_tokens: 900 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  },
});
let events: unknown[];
let requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }>;
let afterFetch: (() => void) | undefined;
let transport: StreamFn;
beforeEach(() => {
  events = [checkpoint(), completed()];
  requests = [];
  afterFetch = undefined;
  const captureFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const raw = Buffer.from(await new Response(init?.body).arrayBuffer());
    requests.push({
      url: input instanceof Request ? input.url : input.toString(),
      body: JSON.parse(
        (headers.get("content-encoding") === "zstd" ? zstdDecompressSync(raw) : raw).toString(),
      ),
      headers,
    });
    afterFetch?.();
    return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  };
  configureAiTransportHost({ buildModelFetch: () => captureFetch });
  vi.stubGlobal("fetch", captureFetch);
});
afterEach(() => {
  configureAiTransportHost(initialHost);
  vi.unstubAllGlobals();
});
const compact = (input: Context = context, extra = {}) =>
  requestPreparedOpenAIResponsesCompaction(transport, model, input, { ...options, ...extra }, "v2");

describe.each([
  ["managed", () => createOpenAIResponsesTransportStreamFn()],
  [
    "native ChatGPT",
    (): StreamFn => (activeModel, requestContext, requestOptions) =>
      streamSimpleOpenAICodexResponses(
        { ...activeModel, api: "openai-chatgpt-responses" },
        requestContext,
        requestOptions,
      ),
  ],
] as const)("%s V2 compaction at the fetch boundary", (_transportName, createTransport) => {
  beforeEach(() => {
    transport = createTransport();
  });
  it("uses the normal final request including tools, developer context, hooks and cache identity", async () => {
    const hooked = {
      ...options,
      reasoning: "high" as const,
      onPayload: (payload: unknown) => {
        if (typeof payload !== "object" || payload === null) {
          throw new Error("Expected a request payload");
        }
        return { ...structuredClone(payload), prompt_cache_key: "hook-cache" };
      },
    };
    events = [completed()];
    const normalStream = await transport(model, context, hooked);
    expect((await normalStream.result()).stopReason).toBe("stop");
    events = [checkpoint(), completed()];
    const result = await compact(context, hooked);
    const [normal, v2] = requests;
    if (!normal || !v2) {
      throw new Error("Expected normal and compaction requests");
    }
    expect(v2.url).toBe(normal.url);
    expect(v2.url.endsWith("/responses")).toBe(true);
    expect(v2.body).toEqual({
      ...normal.body,
      input: [...(normal.body.input as unknown[]), { type: "compaction_trigger" }],
    });
    expect(v2.body.store).toBe(false);
    expect(v2.headers.get("session_id")).toBe(normal.headers.get("session_id"));
    expect(result.output).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "remember copper" }] },
      { type: "compaction", encrypted_content: "opaque" },
    ]);
    expect(result.usage.input_tokens_details).toEqual({ cached_tokens: 900 });
  });

  it("does not retain summaries or custom context as human-authored messages", async () => {
    const result = await compact({
      ...context,
      messages: convertToLlm([
        { role: "user", content: "real request", timestamp: 1 },
        { role: "compactionSummary", summary: "old summary", tokensBefore: 100, timestamp: 2 },
        {
          role: "custom",
          customType: "test-notice",
          content: "synthetic notice",
          display: false,
          timestamp: 3,
        },
      ]),
    });
    expect(JSON.stringify(requests[0]?.body)).toContain("old summary");
    expect(JSON.stringify(result.output)).not.toContain("old summary");
    expect(JSON.stringify(result.output)).not.toContain("synthetic notice");
    expect(JSON.stringify(result.output)).toContain("real request");
  });

  it("bounds retained multilingual input without reviving older users", async () => {
    const result = await compact({
      ...context,
      messages: [
        { role: "user", content: "oldest", timestamp: 1 },
        { role: "user", content: "中".repeat(64_001), timestamp: 2 },
      ],
    });
    expect(result.output).toHaveLength(2);
    expect(JSON.stringify(result.output)).not.toContain("oldest");
    expect(result.output[0]).toMatchObject({
      content: [{ type: "input_text", text: "中".repeat(64_000) }],
    });
  });

  it.each<[string, unknown[]]>([
    ["missing item", [completed()]],
    ["duplicate item", [checkpoint(), checkpoint(), completed()]],
    ["empty item", [checkpoint(""), completed()]],
    ["unfinished stream", [checkpoint()]],
    ["cancelled terminal", [checkpoint(), completed("cancelled")]],
    [
      "failed terminal",
      [
        checkpoint(),
        {
          type: "response.failed",
          response: {
            id: "failed",
            status: "failed",
            error: { code: "server_error", message: "synthetic failure" },
          },
        },
      ],
    ],
    [
      "incomplete terminal",
      [
        checkpoint(),
        {
          type: "response.incomplete",
          response: {
            id: "incomplete",
            status: "incomplete",
            output: [],
            incomplete_details: { reason: "max_output_tokens" },
          },
        },
      ],
    ],
  ])("rejects %s without adopting its checkpoint", async (_name, sequence) => {
    events = sequence;
    await expect(compact()).rejects.toThrow();
  });

  it("does not adopt an item after cancellation or carry it into the next attempt", async () => {
    const controller = new AbortController();
    afterFetch = () => controller.abort();
    await expect(compact(context, { signal: controller.signal })).rejects.toThrow();
    afterFetch = undefined;
    events = [checkpoint("retry-checkpoint"), completed()];
    expect((await compact()).item.encrypted_content).toBe("retry-checkpoint");
  });

  it("retains earlier users across two compactions and persisted replay", async () => {
    const first = await compact();
    const owner: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: "stop",
      timestamp: 3,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    captureOpenAIResponsesCompaction(
      owner,
      first.item,
      "retained-users",
      model,
      first.replayMetadata,
      first.output,
    );
    events = [checkpoint("second"), completed()];
    // Exercise serialized restart state rather than the live checkpoint object.
    const serializedOwner = JSON.stringify(owner);
    const second = await compact({
      ...context,
      messages: [
        JSON.parse(serializedOwner),
        { role: "user", content: "now silver", timestamp: 4 },
      ],
    });
    expect(second.output).toEqual([
      first.output[0],
      { type: "message", role: "user", content: [{ type: "input_text", text: "now silver" }] },
      { type: "compaction", encrypted_content: "second" },
    ]);
    expect(JSON.stringify(requests[1]?.body)).toContain("opaque");
    expect(JSON.stringify(requests[1]?.body)).toContain("remember copper");
  });
});
