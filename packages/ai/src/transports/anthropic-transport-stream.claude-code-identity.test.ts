/**
 * Request-boundary tests for the Claude Code identity on the native Anthropic
 * Messages transport: which requests wait for the host's installed-CLI probe,
 * and what that decision puts on the wire.
 */
import type { Model } from "@openclaw/llm-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import {
  deferAnthropicClaudeCodeIdentityUntil,
  resetAnthropicClaudeCodeVersionForTests,
  setAnthropicClaudeCodeVersion,
} from "../providers/anthropic-model-contract.js";
import { createAnthropicMessagesTransportStreamFn } from "./anthropic-transport-stream.js";

type AnthropicStreamFn = ReturnType<typeof createAnthropicMessagesTransportStreamFn>;
type AnthropicStreamContext = Parameters<AnthropicStreamFn>[1];
type AnthropicStreamOptions = NonNullable<Parameters<AnthropicStreamFn>[2]>;

const coreTransportHost = getAiTransportHost();
const buildModelFetchMock = vi.fn();
const fetchMock = vi.fn();

function createSseResponse(events: Record<string, unknown>[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function createCompletedTurnResponse(): Response {
  return createSseResponse([
    {
      type: "message_start",
      message: { id: "msg_identity", usage: { input_tokens: 0, output_tokens: 0 } },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    { type: "message_stop" },
  ]);
}

function makeAnthropicTransportModel(): Model<"anthropic-messages"> {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
  } satisfies Model<"anthropic-messages">;
}

function latestAnthropicRequest() {
  const [, init] = (fetchMock.mock.calls.at(-1) ?? []) as [
    unknown,
    { headers?: HeadersInit; body?: unknown } | undefined,
  ];
  const body = init?.body;
  return {
    headers: new Headers(init?.headers),
    payload: typeof body === "string" ? (JSON.parse(body) as Record<string, unknown>) : {},
  };
}

function runTransportStream(apiKey: string, systemPrompt?: string) {
  const streamFn = createAnthropicMessagesTransportStreamFn();
  const context = {
    ...(systemPrompt ? { systemPrompt } : {}),
    messages: [{ role: "user", content: "hello" }],
  } as unknown as AnthropicStreamContext;
  const stream = streamFn(makeAnthropicTransportModel(), context, {
    apiKey,
  } as AnthropicStreamOptions);
  return Promise.resolve(stream).then((resolved) => resolved.result());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("anthropic transport stream Claude Code identity", () => {
  beforeEach(() => {
    buildModelFetchMock.mockReset();
    fetchMock.mockReset();
    buildModelFetchMock.mockReturnValue(fetchMock);
    fetchMock.mockImplementation(() => Promise.resolve(createCompletedTurnResponse()));
    configureAiTransportHost({ ...coreTransportHost, buildModelFetch: buildModelFetchMock });
  });

  afterEach(() => {
    configureAiTransportHost(coreTransportHost);
    resetAnthropicClaudeCodeVersionForTests();
  });

  it("waits for a pending Claude Code version probe and sends one version in both the user-agent and the billing block", async () => {
    // A fresh process: the host has started probing the installed Claude Code
    // but it has not answered yet. The first OAuth request must neither go out
    // with the pinned fallback nor mix two versions in one request.
    let finishProbe!: () => void;
    const probe = new Promise<void>((resolve) => {
      finishProbe = resolve;
    });
    deferAnthropicClaudeCodeIdentityUntil(probe);
    try {
      const pending = runTransportStream("sk-ant-oat-example", "Follow policy.");
      await delay(20);
      // The identity is settled before any other request work: the gate is
      // bounded from the probe's start, and building the guarded fetch can load
      // plugin metadata on a cold host, which would otherwise spend that budget.
      expect(buildModelFetchMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();

      setAnthropicClaudeCodeVersion("2.1.273");
      finishProbe();
      expect((await pending).stopReason).toBe("stop");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const request = latestAnthropicRequest();
      expect(request.headers.get("user-agent")).toBe("claude-cli/2.1.273");
      const system = request.payload.system as { text?: string }[] | undefined;
      expect(system?.[0]?.text).toBe(
        "x-anthropic-billing-header: cc_version=2.1.273; cc_entrypoint=sdk-cli;",
      );
    } finally {
      finishProbe();
    }
  });

  it("sends an API-key request without waiting for a pending Claude Code version probe", async () => {
    // Only the OAuth route presents the Claude Code identity, so an API-key
    // request must not sit behind the installed-CLI discovery gate.
    let finishProbe!: () => void;
    const probe = new Promise<void>((resolve) => {
      finishProbe = resolve;
    });
    deferAnthropicClaudeCodeIdentityUntil(probe);
    try {
      const pending = runTransportStream("sk-ant-api", "Follow policy.");
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      expect(buildModelFetchMock).toHaveBeenCalled();
      const request = latestAnthropicRequest();
      expect(request.headers.get("user-agent") ?? "").not.toContain("claude-cli");
      expect(JSON.stringify(request.payload.system ?? [])).not.toContain("cc_version");

      finishProbe();
      expect((await pending).stopReason).toBe("stop");
    } finally {
      finishProbe();
    }
  });
});
