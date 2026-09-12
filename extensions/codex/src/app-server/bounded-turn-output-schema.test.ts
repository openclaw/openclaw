import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it, vi } from "vitest";
import { runBoundedCodexAppServerTurn } from "./bounded-turn.js";
import {
  createFakeCodexAppServerClient,
  threadStartResult as createThreadStartResult,
  turnStartResult,
} from "./codex-app-server.test-fixtures.js";
import { assertCodexPassiveTurnItems } from "./protocol-validators.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";

function codexModel() {
  return {
    id: "gpt-5.4",
    model: "gpt-5.4",
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: "gpt-5.4",
    description: "test model",
    hidden: false,
    isDefault: true,
    inputModalities: ["text"],
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "fast" }],
    defaultReasoningEffort: "low",
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
  };
}

function threadStartResponse() {
  const response = createThreadStartResult("thread-schema", "/tmp/schema");
  return {
    ...response,
    thread: {
      ...response.thread,
      sessionId: "session-schema",
      ephemeral: true,
      modelProvider: "openai",
    },
    model: "gpt-5.4",
    modelProvider: "openai",
    approvalPolicy: "on-request",
    sandbox: { type: "readOnly", networkAccess: false },
  };
}

function invalidOutputSchemaError() {
  return {
    error: {
      type: "invalid_request_error",
      code: "invalid_json_schema",
      message: "The native transport does not support this schema.",
      param: "text.format.schema",
    },
  };
}

function createSchemaClient(
  options: { rejectNativeSchema?: boolean; terminalError?: string } = {},
) {
  const fixture = createFakeCodexAppServerClient(async (method: string, params?: unknown) => {
    if (method === "model/list") {
      return { data: [codexModel()], nextCursor: null };
    }
    if (method === "config/read") {
      return { config: {}, layers: [{ name: { type: "user" } }] };
    }
    if (method === "configRequirements/read") {
      return { requirements: null };
    }
    if (method === "thread/start") {
      return threadStartResponse();
    }
    if (method === "mcpServerStatus/list") {
      return { data: [], nextCursor: null };
    }
    if (method === "turn/start") {
      const hasOutputSchema = isRecord(params) && isRecord(params.outputSchema);
      const submittedInput = isRecord(params) && Array.isArray(params.input) ? params.input : [];
      queueMicrotask(() => {
        for (const handler of fixture.notifications) {
          if (options.terminalError) {
            void handler({
              method: "error",
              params: {
                threadId: "thread-schema",
                turnId: "turn-schema",
                error: { message: options.terminalError },
                willRetry: false,
              },
            });
            continue;
          }
          if (options.rejectNativeSchema && hasOutputSchema) {
            void handler({
              method: "error",
              params: {
                threadId: "thread-schema",
                turnId: "turn-schema",
                error: { message: JSON.stringify(invalidOutputSchemaError()) },
                willRetry: false,
              },
            });
            continue;
          }
          void handler({
            method: "turn/completed",
            params: {
              threadId: "thread-schema",
              turn: {
                ...turnStartResult("turn-schema", "completed").turn,
                items: [
                  { id: "prompt-echo", type: "userMessage", content: submittedInput },
                  { id: "answer", type: "agentMessage", text: '{"result":"ok"}' },
                ],
                startedAt: 1,
                completedAt: 2,
                durationMs: 1,
              },
            },
          });
        }
      });
      return { turn: { ...turnStartResult("turn-schema").turn, startedAt: 1 } };
    }
    throw new Error(`unexpected request: ${method}`);
  });
  const client = Object.assign(fixture.client, { close: vi.fn() });
  return {
    factory: vi.fn(async () => client) as unknown as CodexAppServerClientFactory,
    request: fixture.request,
  };
}

describe("runBoundedCodexAppServerTurn output schemas", () => {
  it("forwards the final-output schema to turn/start", async () => {
    const fake = createSchemaClient();
    const outputSchema = {
      type: "object",
      properties: { result: { type: "string" } },
      required: ["result"],
      additionalProperties: false,
    };

    await runBoundedCodexAppServerTurn({
      model: { mode: "required", id: "gpt-5.4" },
      timeoutMs: 5_000,
      options: { clientFactory: fake.factory },
      taskLabel: "isolated completion",
      developerInstructions: "Return structured output.",
      input: [{ type: "text", text: "Extract the result.", text_elements: [] }],
      outputSchema,
      requiredModalities: ["text"],
      isolation: "configured-transport",
    });

    const turnStart = fake.request.mock.calls.find(([method]) => method === "turn/start")?.[1];
    expect(turnStart).toMatchObject({ outputSchema });
  });

  it("falls back once when Codex rejects the native schema subset", async () => {
    const fake = createSchemaClient({ rejectNativeSchema: true });
    const assertCurrent = vi.fn();
    const outputSchema = {
      type: "object",
      properties: { result: { type: "string" } },
    };

    const result = await runBoundedCodexAppServerTurn({
      model: { mode: "required", id: "gpt-5.4" },
      timeoutMs: 5_000,
      assertCurrent,
      options: { clientFactory: fake.factory },
      taskLabel: "isolated completion",
      developerInstructions: "Return structured output.",
      input: [{ type: "text", text: "Extract the result.", text_elements: [] }],
      outputSchema,
      requiredModalities: ["text"],
      isolation: "configured-transport",
      requireNoExternalCapabilities: true,
    });

    expect(result.text).toBe('{"result":"ok"}');
    expect(() =>
      assertCodexPassiveTurnItems(result.items, result.submittedInput, "isolated completion"),
    ).not.toThrow();

    const turns = fake.request.mock.calls.filter(([method]) => method === "turn/start");
    expect(turns).toHaveLength(2);
    expect(turns[0]?.[1]).toMatchObject({ outputSchema });
    expect(turns[1]?.[1]).not.toHaveProperty("outputSchema");
    expect(fake.request.mock.calls.filter(([method]) => method === "thread/start")).toHaveLength(2);
    expect(fake.factory).toHaveBeenNthCalledWith(2, expect.objectContaining({ assertCurrent }));
    expect(turns[1]?.[1]).toMatchObject({
      input: expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining(JSON.stringify(outputSchema)) }),
      ]),
    });
    expect(result.submittedInput).toHaveLength(2);
  });

  it("does not retry an unrelated terminal error", async () => {
    const fake = createSchemaClient({ terminalError: "terminal upstream failure" });

    await expect(
      runBoundedCodexAppServerTurn({
        model: { mode: "required", id: "gpt-5.4" },
        timeoutMs: 5_000,
        options: { clientFactory: fake.factory },
        taskLabel: "isolated completion",
        developerInstructions: "Return structured output.",
        input: [{ type: "text", text: "Extract the result.", text_elements: [] }],
        outputSchema: { type: "object" },
        requiredModalities: ["text"],
        isolation: "configured-transport",
      }),
    ).rejects.toThrow("terminal upstream failure");

    expect(fake.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  });
});
