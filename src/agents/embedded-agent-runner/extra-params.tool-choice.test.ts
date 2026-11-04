// Coverage for forwarding a request's required client tool to provider stream options.
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLlmStreamSimpleMock } from "../../../test/helpers/agents/llm-stream-simple-mock.js";
import { applyExtraParamsToAgent } from "./extra-params.js";
import { testing as extraParamsTesting } from "./extra-params.test-support.js";

vi.mock("./logger.js", () => ({
  log: {
    isEnabled: () => false,
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../../llm/stream.js", () => createLlmStreamSimpleMock());

beforeEach(() => {
  extraParamsTesting.setProviderRuntimeDepsForTest({
    prepareProviderExtraParams: () => undefined,
    resolveProviderExtraParamsForTransport: () => undefined,
    wrapProviderStreamFn: () => undefined,
  });
});

afterEach(() => {
  extraParamsTesting.resetProviderRuntimeDepsForTest();
});

const ANTHROPIC_MODEL = {
  id: "claude-haiku-5-5",
  api: "anthropic-messages",
  provider: "anthropic",
} as never;
const OPENAI_MODEL = { id: "gpt-5.4", api: "openai-completions", provider: "openai" } as never;

function callOptionsFor(params: {
  model: Parameters<StreamFn>[0];
  override?: Record<string, unknown>;
  cfg?: unknown;
}) {
  const underlying = vi.fn(() => ({
    push: vi.fn(),
    result: vi.fn(async () => undefined),
    [Symbol.asyncIterator]: vi.fn(async function* () {}),
  })) as unknown as StreamFn;
  const agent: { streamFn?: StreamFn } = { streamFn: underlying };
  const { provider, id } = params.model as unknown as { provider: string; id: string };
  applyExtraParamsToAgent(agent, params.cfg as never, provider, id, params.override);
  void agent.streamFn?.(params.model, { messages: [], tools: [] }, undefined);
  return vi.mocked(underlying).mock.calls[0]?.[2] as Record<string, unknown> | undefined;
}

describe("request tool choice forwarding", () => {
  it("forces the named client tool on Anthropic Messages", () => {
    const options = callOptionsFor({
      model: ANTHROPIC_MODEL,
      override: { toolChoice: { type: "function", name: "read" } },
    });

    expect(options?.toolChoice).toEqual({ type: "tool", name: "read" });
  });

  it("maps required to Anthropic any", () => {
    const options = callOptionsFor({
      model: ANTHROPIC_MODEL,
      override: { toolChoice: { type: "required" } },
    });

    expect(options?.toolChoice).toBe("any");
  });

  it("leaves other provider APIs on the gateway emulation", () => {
    const options = callOptionsFor({
      model: OPENAI_MODEL,
      override: { toolChoice: { type: "function", name: "read" } },
    });

    expect(options?.toolChoice).toBeUndefined();
  });

  it("ignores a configured toolChoice so only checked requests force tools", () => {
    const options = callOptionsFor({
      model: ANTHROPIC_MODEL,
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-haiku-5-5": {
                params: { toolChoice: { type: "function", name: "read" } },
              },
            },
          },
        },
      },
    });

    expect(options?.toolChoice).toBeUndefined();
  });
});
