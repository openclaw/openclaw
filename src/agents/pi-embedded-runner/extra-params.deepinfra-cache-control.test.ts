import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { runExtraParamsCase } from "./extra-params.test-support.js";

type StreamPayload = {
  messages: Array<{
    role: string;
    content: unknown;
  }>;
};

function runDeepInfraPayload(payload: StreamPayload, modelId: string) {
  runExtraParamsCase({
    cfg: {
      plugins: {
        entries: {
          deepinfra: {
            enabled: true,
          },
        },
      },
    },
    model: {
      api: "openai-completions",
      provider: "deepinfra",
      id: modelId,
    } as Model<"openai-completions">,
    payload,
  });
}

describe("extra-params: DeepInfra Anthropic cache_control", () => {
  it("injects cache_control into system message for DeepInfra Anthropic models", () => {
    const payload = {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ],
    };

    runDeepInfraPayload(payload, "anthropic/claude-opus-4-6");

    expect(payload.messages[0].content).toEqual([
      { type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral" } },
    ]);
    expect(payload.messages[1].content).toBe("Hello");
  });

  it("adds cache_control to last content block when system message is already array", () => {
    const payload = {
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "Part 1" },
            { type: "text", text: "Part 2" },
          ],
        },
      ],
    };

    runDeepInfraPayload(payload, "anthropic/claude-opus-4-6");

    const content = payload.messages[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "Part 1" });
    expect(content[1]).toEqual({
      type: "text",
      text: "Part 2",
      cache_control: { type: "ephemeral" },
    });
  });

  it("does not inject cache_control for DeepInfra non-Anthropic models", () => {
    const payload = {
      messages: [{ role: "system", content: "You are a helpful assistant." }],
    };

    runDeepInfraPayload(payload, "google/gemini-2.5-pro");

    expect(payload.messages[0].content).toBe("You are a helpful assistant.");
  });

  it("leaves payload unchanged when no system message exists", () => {
    const payload = {
      messages: [{ role: "user", content: "Hello" }],
    };

    runDeepInfraPayload(payload, "anthropic/claude-opus-4-6");

    expect(payload.messages[0].content).toBe("Hello");
  });
});
