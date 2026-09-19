import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { wrapStreamFnWithProviderPromptState } from "../../../../src/agents/embedded-agent-runner/provider-prompt-state.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import type { OpenAIResponsesOptions } from "./openai-responses-contracts.js";

const host = getAiTransportHost();
const fetchMock = vi.fn<typeof fetch>();
const bodies: unknown[] = [];
const model: Model<"openai-responses"> = {
  id: "gpt-6-astra",
  name: "fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  contextWindow: 32768,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context: Context = {
  messages: [{ role: "user", content: "ADMITTED_ORIGINAL", timestamp: 0 }],
  tools: [{ name: "read", description: "Read", parameters: Type.Object({}) }],
};
beforeEach(() => {
  bodies.length = 0;
  fetchMock.mockReset().mockImplementation(async (_url, init) => {
    if (typeof init?.body !== "string") {
      throw new Error("Expected real serialized Responses body");
    }
    bodies.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({
        error: { code: "invalid_encrypted_content", message: "invalid_encrypted_content" },
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  });
  configureAiTransportHost({
    ...host,
    buildModelFetch: () => fetchMock,
    plugin: {
      ...host.plugin,
      resolveTransportTurnState: () => ({ metadata: { turn: "normalized" } }),
    },
  });
});
afterEach(() => configureAiTransportHost(host));

describe("Responses private final payload", () => {
  it("admits after metadata, image sanitization and async-tool policy, then serializes that body", async () => {
    let admitted: unknown;
    let retained: Record<string, unknown> | undefined;
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: createOpenAIResponsesTransportStreamFn(),
      state: {},
      effectiveContextTokenBudget: 32768,
      assertFinalPayload(body) {
        expect(body).toMatchObject({
          metadata: { hook: "retained", turn: "normalized" },
          tools: [{ type: "function", name: "read", async: true }],
        });
        expect(JSON.stringify(body)).not.toContain("data:image/png;base64,invalid!");
        expect(Object.isFrozen(body)).toBe(true);
        admitted = body;
        queueMicrotask(() => {
          if (retained) {
            retained.input = [];
          }
        });
      },
    });
    const options = {
      apiKey: "synthetic-not-a-secret",
      asyncToolExecution: true,
      transport: "auto",
      onPayload(body) {
        if (!body || typeof body !== "object") {
          throw new Error("Missing body");
        }
        retained = {
          ...body,
          metadata: { hook: "retained" },
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: "ADMITTED_ORIGINAL" },
                { type: "input_image", image_url: "data:image/png;base64,invalid!" },
              ],
            },
          ],
        };
        return retained;
      },
    } satisfies OpenAIResponsesOptions;
    const stream = await wrapped(model, context, options);
    await stream.result();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodies).toEqual([admitted]);
    expect(JSON.stringify(bodies[0])).toContain("ADMITTED_ORIGINAL");
  });

  it("refuses an explicit socket-only private target before dispatch instead of silently downgrading", async () => {
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: createOpenAIResponsesTransportStreamFn(),
      state: {},
      effectiveContextTokenBudget: 32768,
      assertFinalPayload(body) {
        expect(Object.isFrozen(body)).toBe(true);
      },
    });
    const stream = await wrapped(model, context, { apiKey: "***", transport: "websocket" });
    expect((await stream.result()).errorMessage).toContain("exact full-history HTTP request");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a retry's replacement of an admitted graph without affecting ordinary recovery", async () => {
    const wrapped = wrapStreamFnWithProviderPromptState({
      streamFn: createOpenAIResponsesTransportStreamFn(),
      state: {},
      effectiveContextTokenBudget: 32768,
      assertFinalPayload(body) {
        expect(Object.isFrozen(body)).toBe(true);
      },
    });
    const stream = await wrapped(model, context, {
      apiKey: "synthetic-not-a-secret",
      onPayload(body) {
        if (!body || typeof body !== "object" || !("input" in body) || !Array.isArray(body.input)) {
          throw new Error("Missing input");
        }
        return {
          ...body,
          input: [...body.input, { type: "reasoning", id: "r", encrypted_content: "fixture" }],
        };
      },
    });
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("substituted the admitted payload");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
