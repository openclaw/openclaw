/**
 * Request-boundary tests for the Claude Code identity on the Anthropic
 * provider: which requests wait for the host's installed-CLI probe, and what
 * that decision puts on the wire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";
import {
  deferAnthropicClaudeCodeIdentityUntil,
  resetAnthropicClaudeCodeVersionForTests,
  setAnthropicClaudeCodeVersion,
} from "./anthropic-model-contract.js";

const anthropicMockState = vi.hoisted(() => ({ configs: [] as unknown[] }));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      // The payload is captured through onPayload, so the request never has to
      // reach a transport.
      create: vi.fn(() => {
        throw new Error("stop after constructor");
      }),
    };

    constructor(config: unknown) {
      anthropicMockState.configs.push(config);
    }
  },
}));

import { streamSimpleAnthropic } from "./anthropic.js";

const buildModelFetchMock = vi.fn(() => undefined);

function makeAnthropicModel(): Model<"anthropic-messages"> {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
  } satisfies Model<"anthropic-messages">;
}

async function captureAnthropicRequest(apiKey: string, context: Context) {
  let payload: unknown;
  const stream = streamSimpleAnthropic(makeAnthropicModel(), context, {
    apiKey,
    onPayload: (next: unknown) => {
      payload = next;
      return next;
    },
  });
  await stream.result();
  return { payload: payload as { system?: unknown } | undefined };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function latestClientHeaders(): Record<string, string> | undefined {
  const config = anthropicMockState.configs.at(-1) as
    | { defaultHeaders?: Record<string, string> }
    | undefined;
  return config?.defaultHeaders;
}

describe("Anthropic provider Claude Code identity", () => {
  beforeEach(() => {
    anthropicMockState.configs = [];
    buildModelFetchMock.mockClear();
    configureAiTransportHost({ buildModelFetch: buildModelFetchMock });
  });

  afterEach(() => {
    configureAiTransportHost({});
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
      const pending = captureAnthropicRequest("sk-ant-oat01-test-token", {
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
      });
      await delay(20);
      // The identity is settled before any other request work: the gate is
      // bounded from the probe's start, so host work such as building the
      // model fetch must not run first and spend that budget.
      expect(buildModelFetchMock).not.toHaveBeenCalled();
      expect(anthropicMockState.configs).toHaveLength(0);

      setAnthropicClaudeCodeVersion("2.1.273");
      finishProbe();
      const { payload } = await pending;

      expect(anthropicMockState.configs).toHaveLength(1);
      expect(latestClientHeaders()?.["user-agent"]).toBe("claude-cli/2.1.273");
      expect(payload?.system).toEqual([
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.273; cc_entrypoint=sdk-cli;",
        },
        {
          type: "text",
          text: "You are Claude Code, Anthropic's official CLI for Claude.",
          cache_control: { type: "ephemeral" },
        },
      ]);
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
      const pending = captureAnthropicRequest("sk-ant-provider", {
        systemPrompt: "Follow policy.",
        messages: [{ role: "user", content: "hello", timestamp: 1 }],
      });
      await vi.waitFor(() => {
        expect(anthropicMockState.configs).toHaveLength(1);
      });
      expect(buildModelFetchMock).toHaveBeenCalled();
      expect(latestClientHeaders()?.["user-agent"] ?? "").not.toContain("claude-cli");

      finishProbe();
      const { payload } = await pending;
      expect(JSON.stringify(payload?.system ?? [])).not.toContain("cc_version");
    } finally {
      finishProbe();
    }
  });
});
