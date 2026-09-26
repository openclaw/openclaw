import { describe, expect, it, vi } from "vitest";
import { runBoundedCodexAppServerTurn } from "./bounded-turn.js";
import { createClientFactory } from "./bounded-turn.test-harness.js";

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
  return runBoundedCodexAppServerTurn({
    model: { mode: "required", id: "gpt-5.4" },
    timeoutMs: 5_000,
    options: { clientFactory: fake.factory },
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

  it("falls back once on an explicit Codex schema-dialect rejection", async () => {
    const fake = createClientFactory({ rejectOutputSchema: true });
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

  it("does not retry unrelated failures", async () => {
    const fake = createClientFactory({
      errorBeforeCompletion: { message: "terminal upstream failure", willRetry: false },
    });

    await expect(runSchemaTurn(fake)).rejects.toThrow("terminal upstream failure");

    expect(fake.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  });
});
