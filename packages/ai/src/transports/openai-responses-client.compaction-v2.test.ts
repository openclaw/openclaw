import type { Context, StreamFn } from "@openclaw/llm-core";
import { Type } from "typebox";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../../../agent-core/src/harness/messages.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { streamSimpleOpenAICodexResponses } from "../providers/openai-chatgpt-responses.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import { requestPreparedOpenAIResponsesCompaction } from "./openai-responses-compact-request.js";
import { captureOpenAIResponsesCompaction } from "./openai-responses-compaction-replay.js";
import * as fixtures from "./openai-responses-prompt-observer.test-support.js";
import { outputItem } from "./openai-stream-cases.test-support.js";
const initialHost = getAiTransportHost();
const model = fixtures.createModel({
  id: "gpt-5.4",
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
});
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
  tools: [{ name: "lookup", description: "Read", parameters: Type.Object({ key: Type.String() }) }],
  messages: [
    fixtures.userMessage("remember copper", 1),
    fixtures.userMessage("runtime context", 2, { runtimeContext: { retained: true } }),
  ],
} satisfies Context;
const syntheticMessages = convertToLlm([
  fixtures.userMessage("real request", 1),
  { role: "compactionSummary", summary: "old summary", tokensBefore: 100, timestamp: 2 },
  {
    role: "custom",
    customType: "test-notice",
    content: "synthetic notice",
    display: false,
    timestamp: 3,
  },
]);
const checkpoint = (value = "opaque") =>
  outputItem("done", { type: "compaction", id: "cmp_provider_id", encrypted_content: value });
const completed = (status = "completed") =>
  fixtures.completedResponse("resp-test", [], {
    status,
    usage: {
      input_tokens: 1000,
      output_tokens: 10,
      input_tokens_details: { cached_tokens: 900 },
    },
  });
const failed = (status: "failed" | "incomplete", extra: object) => ({
  type: `response.${status}`,
  response: { id: status, status, ...extra },
});
let events: unknown[];
let requests: Array<{ url: string; body: Record<string, unknown>; headers: Headers }>;
let afterFetch: (() => void) | undefined;
let transport: StreamFn;
beforeEach(() => {
  events = [checkpoint(), completed()];
  requests = [];
  afterFetch = undefined;
  transport = createOpenAIResponsesTransportStreamFn();
  const captureFetch: typeof fetch = async (input, init) => {
    requests.push({
      url: input instanceof Request ? input.url : input.toString(),
      body: await fixtures.requestBody(init),
      headers: new Headers(init?.headers),
    });
    afterFetch?.();
    return fixtures.sseResponse(events);
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
      onPayload: (payload: unknown) =>
        Object.assign({}, payload, { prompt_cache_key: "hook-cache" }),
    };
    events = [completed()];
    expect((await (await transport(model, context, hooked)).result()).stopReason).toBe("stop");
    events = [checkpoint(), completed()];
    const result = await compact(context, hooked);
    const [normal, v2] = requests;
    assert(normal && v2, "Expected normal and compaction requests");
    expect(v2.url).toBe(normal.url);
    expect(v2.url.endsWith("/responses")).toBe(true);
    expect(v2.body).toEqual({
      ...normal.body,
      input: [...(normal.body.input as unknown[]), { type: "compaction_trigger" }],
    });
    expect(v2.body.store).toBe(false);
    expect(v2.headers.get("session_id")).toBe(normal.headers.get("session_id"));
    expect(result.output).toEqual([
      fixtures.inputMessage("remember copper"),
      { type: "compaction", encrypted_content: "opaque" },
    ]);
    expect(result.usage.input_tokens_details).toEqual({ cached_tokens: 900 });
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
    const first = await compact({ ...context, messages: syntheticMessages });
    expect(JSON.stringify(requests[0]?.body)).toContain("old summary");
    expect(first.output).toEqual([
      fixtures.inputMessage("real request"),
      { type: "compaction", encrypted_content: "opaque" },
    ]);
    const owner = fixtures.createAssistant(model, [], { timestamp: 3 });
    captureOpenAIResponsesCompaction(
      owner,
      first.item,
      "retained-users",
      model,
      first.replayMetadata,
      first.output,
    );
    events = [checkpoint("second"), completed()];
    const serializedOwner = JSON.stringify(owner);
    const second = await compact({
      ...context,
      messages: [JSON.parse(serializedOwner), fixtures.userMessage("now silver", 4)],
    });
    expect(second.output).toEqual([
      first.output[0],
      fixtures.inputMessage("now silver"),
      { type: "compaction", encrypted_content: "second" },
    ]);
    expect(JSON.stringify(requests[1]?.body)).toContain("opaque");
    expect(JSON.stringify(requests[1]?.body)).toContain("real request");
  });
});
it("bounds retained multilingual input without reviving older users", async () => {
  const result = await compact({
    ...context,
    messages: [fixtures.userMessage("oldest", 1), fixtures.userMessage("中".repeat(64_001), 2)],
  });
  expect(result.output).toHaveLength(2);
  expect(JSON.stringify(result.output)).not.toContain("oldest");
  expect(result.output[0]).toMatchObject({
    content: [{ type: "input_text", text: "中".repeat(64_000) }],
  });
});
it.each<[string, unknown[]]>([
  ["unfinished stream", [checkpoint()]],
  ["cancelled terminal", [checkpoint(), completed("cancelled")]],
  [
    "failed terminal",
    [
      checkpoint(),
      failed("failed", { error: { code: "server_error", message: "synthetic failure" } }),
    ],
  ],
  [
    "incomplete terminal",
    [
      checkpoint(),
      failed("incomplete", { output: [], incomplete_details: { reason: "max_output_tokens" } }),
    ],
  ],
  ["duplicate item", [checkpoint(), checkpoint(), completed()]],
  ["empty item", [checkpoint(""), completed()]],
])("rejects %s without adopting its checkpoint", async (_name, sequence) => {
  events = sequence;
  await expect(compact()).rejects.toThrow();
});
