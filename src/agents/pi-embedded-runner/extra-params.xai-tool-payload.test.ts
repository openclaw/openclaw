import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createPiAiStreamSimpleMock } from "./extra-params.pi-ai-mock.js";
import { runExtraParamsCase } from "./extra-params.test-support.js";

vi.mock("@mariozechner/pi-ai", async (importOriginal) =>
  createPiAiStreamSimpleMock(() => importOriginal<typeof import("@mariozechner/pi-ai")>()),
);

function runToolPayloadCase(provider: "openai" | "xai", modelId: string) {
  return runExtraParamsCase({
    applyProvider: provider,
    applyModelId: modelId,
    model: {
      api: "openai-completions",
      provider,
      id: modelId,
    } as Model<"openai-completions">,
    payload: {
      model: modelId,
      messages: [],
      tools: [
        {
          type: "function",
          function: {
            name: "write",
            description: "write a file",
            parameters: { type: "object", properties: {} },
            strict: true,
          },
        },
      ],
    },
  }).payload as {
    tools?: Array<{ function?: Record<string, unknown> }>;
  };
}

describe("extra-params: xAI tool payload compatibility", () => {
  it("strips function.strict for xai providers", () => {
    const payload = runToolPayloadCase("xai", "grok-4-1-fast-reasoning");

    expect(payload.tools?.[0]?.function).not.toHaveProperty("strict");
  });

  it("keeps function.strict for non-xai providers", () => {
    const payload = runToolPayloadCase("openai", "gpt-5.4");

    expect(payload.tools?.[0]?.function?.strict).toBe(true);
  });
});
