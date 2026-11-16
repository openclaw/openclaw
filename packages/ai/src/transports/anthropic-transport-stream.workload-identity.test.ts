import type { Context, SimpleStreamOptions } from "@openclaw/llm-core";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import type { AnthropicTransportOptions } from "./anthropic-transport-options.js";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";
import {
  anthropicMessageDelta,
  anthropicMessageStart,
  createSseResponse,
  installAnthropicTransportTestHost,
  makeAnthropicTransportModel,
} from "./anthropic-transport-stream.test-support.js";

const buildGuardedModelFetchMock = vi.fn();
const guardedFetchMock = vi.fn();
const coreTransportHost = getAiTransportHost();
const WORKLOAD_IDENTITY_TOKEN = "sk-ant-oat01-workload";

type AnthropicStreamOptions = SimpleStreamOptions & AnthropicTransportOptions;

function queueReply() {
  guardedFetchMock.mockResolvedValueOnce(
    createSseResponse([
      anthropicMessageStart({ id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } }),
      anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 1, output_tokens: 1 }),
      { type: "message_stop" },
    ]),
  );
}

async function runTransportStream(context: Context, options: Partial<AnthropicStreamOptions> = {}) {
  return (
    await createAnthropicMessagesTransportStreamFn()(makeAnthropicTransportModel({}), context, {
      apiKey: WORKLOAD_IDENTITY_TOKEN,
      ...options,
    } as AnthropicStreamOptions)
  ).result();
}

function latestRequest() {
  const [, init] = guardedFetchMock.mock.calls.at(-1) ?? [];
  const headers = new Headers(init?.headers);
  const body = init?.body;
  return {
    headers,
    betas: (headers.get("anthropic-beta") ?? "").split(","),
    payload: typeof body === "string" ? (JSON.parse(body) as Record<string, unknown>) : {},
  };
}

beforeEach(() => {
  guardedFetchMock.mockReset();
  installAnthropicTransportTestHost({
    coreTransportHost,
    buildModelFetch: buildGuardedModelFetchMock,
    guardedFetch: guardedFetchMock,
  });
  configureAiTransportHost({
    ...getAiTransportHost(),
    isAnthropicWorkloadIdentityToken: (value) => value === WORKLOAD_IDENTITY_TOKEN,
  });
});

afterAll(() => {
  configureAiTransportHost(coreTransportHost);
});

it("sends workload identity tokens as plain bearer auth without subscription identity", async () => {
  queueReply();
  await runTransportStream({
    systemPrompt: "Follow policy.",
    messages: [makeUserMessage("Hello", 0)],
  });

  const { headers, betas, payload } = latestRequest();
  expect(headers.get("authorization")).toBe(`Bearer ${WORKLOAD_IDENTITY_TOKEN}`);
  expect(headers.get("x-api-key")).toBeNull();
  expect(headers.get("x-app")).toBeNull();
  expect(headers.get("user-agent") ?? "").not.toContain("claude-cli/");
  expect(betas).toContain("oauth-2025-04-20");
  expect(betas).not.toContain("claude-code-20250219");
  expect(JSON.stringify(payload.system)).not.toContain("Claude Code");
});

it("keeps payload-required betas alongside the OAuth beta", async () => {
  queueReply();
  await runTransportStream(
    { messages: [makeUserMessage("Hello", 0)] },
    { anthropicServerCompaction: true },
  );

  const { betas, payload } = latestRequest();
  expect(payload.context_management).toBeDefined();
  expect(betas).toEqual(expect.arrayContaining(["oauth-2025-04-20", "compact-2026-01-12"]));
});
