import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createPiAiStreamSimpleMock } from "./extra-params.pi-ai-mock.js";
import { runExtraParamsCase } from "./extra-params.test-support.js";

vi.mock("@mariozechner/pi-ai", async (importOriginal) =>
  createPiAiStreamSimpleMock(() => importOriginal<typeof import("@mariozechner/pi-ai")>()),
);

describe("extra-params: xAI tool payload compatibility", () => {
  it("strips function.strict for xai providers", () => {
    const payload = runExtraParamsCase({
      applyProvider: "xai",
      applyModelId: "grok-4-1-fast-reasoning",
      model: {
        api: "openai-completions",
        provider: "xai",
        id: "grok-4-1-fast-reasoning",
      } as Model<"openai-completions">,
      payload: {
        model: "grok-4-1-fast-reasoning",
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

    expect(payload.tools?.[0]?.function).not.toHaveProperty("strict");
  });

  it("keeps function.strict for non-xai providers", () => {
    const payload = runExtraParamsCase({
      applyProvider: "openai",
      applyModelId: "gpt-5.4",
      model: {
        api: "openai-completions",
        provider: "openai",
        id: "gpt-5.4",
      } as Model<"openai-completions">,
      payload: {
        model: "gpt-5.4",
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

    expect(payload.tools?.[0]?.function?.strict).toBe(true);
  });
});
