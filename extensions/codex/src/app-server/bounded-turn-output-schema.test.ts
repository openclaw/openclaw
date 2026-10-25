import { afterEach, describe, expect, it, vi } from "vitest";
import { runBoundedCodexAppServerTurn } from "./bounded-turn.js";
import { createClientFactory } from "./bounded-turn.test-harness.js";
import * as sharedClients from "./shared-client.js";

afterEach(() => vi.restoreAllMocks());

const outputSchema = {
  type: "object",
  properties: { result: { type: "string" } },
  required: ["result"],
  additionalProperties: false,
};

function runSchemaTurn(
  fake: ReturnType<typeof createClientFactory>,
  overrides: { assertCurrent?: () => void } = {},
) {
  vi.spyOn(sharedClients, "createIsolatedCodexAppServerClient").mockImplementation(fake.factory);
  return runBoundedCodexAppServerTurn({
    model: { mode: "required", id: "gpt-5.4" },
    timeoutMs: 5_000,
    options: {},
    taskLabel: "isolated completion",
    developerInstructions: "Return structured output.",
    input: [{ type: "text", text: "Extract the result.", text_elements: [] }],
    outputSchema,
    requiredModalities: ["text"],
    isolation: "configured-transport",
    ...overrides,
  });
}

describe("runBoundedCodexAppServerTurn output schemas", () => {
  it("forwards the final-output schema to turn/start", async () => {
    const fake = createClientFactory();

    await runSchemaTurn(fake);

    const turnStart = fake.request.mock.calls.find(([method]) => method === "turn/start")?.[1];
    expect(turnStart).toMatchObject({ outputSchema });
  });

  it.each([
    true,
    "unexpected status 400 Bad Request: Invalid schema for response_format 'codex_output_schema': 'additionalProperties' is required, url: https://example.invalid/responses, request id: test-request",
  ])("falls back once on an explicit Codex schema-dialect rejection (%s)", async (rejection) => {
    const fake = createClientFactory({ rejectOutputSchema: rejection });
    const assertCurrent = vi.fn();

    await expect(runSchemaTurn(fake, { assertCurrent })).resolves.toMatchObject({
      text: "The message was sent successfully.",
    });

    const turns = fake.request.mock.calls.filter(([method]) => method === "turn/start");
    expect(turns).toHaveLength(2);
    expect(turns[0]?.[1]).toMatchObject({ outputSchema });
    expect(turns[1]?.[1]).not.toHaveProperty("outputSchema");
    expect(turns[1]?.[1]).toMatchObject({
      input: [
        { type: "text", text: "Extract the result.", text_elements: [] },
        expect.objectContaining({ text: expect.stringContaining(JSON.stringify(outputSchema)) }),
      ],
    });

    const threads = fake.request.mock.calls.filter(([method]) => method === "thread/start");
    expect(threads).toHaveLength(2);
    expect(threads[1]?.[1]).toMatchObject({
      developerInstructions: "Return structured output.",
    });
    expect(fake.factory).toHaveBeenNthCalledWith(2, expect.objectContaining({ assertCurrent }));
  });

  it.each([
    "terminal upstream failure",
    "unexpected status 400 Bad Request: Invalid request",
    "unexpected status 429 Too Many Requests: Invalid schema for response_format 'codex_output_schema': rejected",
  ])("does not retry unrelated failures (%s)", async (message) => {
    const fake = createClientFactory({
      errorBeforeCompletion: { message, willRetry: false },
    });

    await expect(runSchemaTurn(fake)).rejects.toThrow(message);

    expect(fake.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  });

  it("does not renew the deadline after native schema rejection", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const fake = createClientFactory({
      rejectOutputSchema: true,
      beforeRequest: async (method) => {
        if (method === "turn/start") {
          now = 5_001;
        }
      },
    });

    await expect(runSchemaTurn(fake)).rejects.toMatchObject({
      name: "TimeoutError",
      timeoutMs: 5_000,
    });
    expect(fake.factory).toHaveBeenCalledTimes(1);
  });

  it("rechecks caller authority before the fallback starts", async () => {
    const retired = new Error("completion owner retired");
    let current = true;
    const fake = createClientFactory({
      rejectOutputSchema: true,
      beforeRequest: async (method) => {
        if (method === "turn/start") {
          current = false;
        }
      },
    });

    await expect(
      runSchemaTurn(fake, {
        assertCurrent: () => {
          if (!current) {
            throw retired;
          }
        },
      }),
    ).rejects.toBe(retired);
    expect(fake.factory).toHaveBeenCalledTimes(1);
  });
});
