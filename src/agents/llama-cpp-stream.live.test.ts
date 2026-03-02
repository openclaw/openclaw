import { describe, expect, it } from "vitest";
import { isTruthyEnvValue } from "../infra/env.js";
import { createLlamaCppStreamFn } from "./llama-cpp-stream.js";

const MODEL_PATH = process.env.LLAMA_CPP_MODEL_PATH ?? "";
const LIVE =
  isTruthyEnvValue(process.env.LLAMA_CPP_LIVE_TEST) || isTruthyEnvValue(process.env.LIVE);

const describeLive = LIVE && MODEL_PATH ? describe : describe.skip;

describeLive("llama-cpp live", () => {
  it("generates text response", async () => {
    const streamFn = createLlamaCppStreamFn(MODEL_PATH);

    const stream = streamFn(
      {
        id: "test-model",
        api: "llama-cpp",
        provider: "llama-cpp",
        contextWindow: 32768,
      } as unknown as Parameters<typeof streamFn>[0],
      {
        messages: [{ role: "user", content: "Reply with just the word 'ok'." }],
        systemPrompt: "You are a helpful assistant.",
      },
      { maxTokens: 50 },
    );

    const events = [];
    for await (const event of stream) {
      console.log(`📨 Event type: ${event.type}`);
      if (event.type === "error") {
        console.error("❌ Stream error:", event.error?.errorMessage);
        console.error("Full error details:", JSON.stringify(event.error, null, 2));
      }
      events.push(event);
    }

    console.log(`\n📊 Total events: ${events.length}`);
    console.log(`Event types: ${events.map((e) => e.type).join(", ")}`);

    const errorEvent = events.find((e) => e.type === "error");
    if (errorEvent) {
      throw new Error(
        `❌ Model inference failed: ${errorEvent.error?.errorMessage || "Unknown error"}`,
      );
    }

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    expect(doneEvent.message.content.length).toBeGreaterThan(0);

    const text = doneEvent.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    expect(text.length).toBeGreaterThan(0);
  }, 90000);

  it("handles tool calling", async () => {
    const streamFn = createLlamaCppStreamFn(MODEL_PATH);

    const stream = streamFn(
      {
        id: "test-model",
        api: "llama-cpp",
        provider: "llama-cpp",
        contextWindow: 32768,
      } as unknown as Parameters<typeof streamFn>[0],
      {
        messages: [{ role: "user", content: "What time is it? Use the get_time tool." }],
        tools: [
          {
            name: "get_time",
            description: "Get the current time",
            parameters: {
              type: "object",
              properties: {},
            },
          },
        ],
      },
      { maxTokens: 200 },
    );

    const events = [];
    for await (const event of stream) {
      if (event.type === "error") {
        console.error("❌ Stream error:", event.error?.errorMessage);
      }
      events.push(event);
    }

    const errorEvent = events.find((e) => e.type === "error");
    if (errorEvent) {
      throw new Error(
        `❌ Tool calling test failed: ${errorEvent.error?.errorMessage || "Unknown error"}`,
      );
    }

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();

    const toolCalls = doneEvent.message.content.filter((block) => block.type === "toolCall");
    expect(toolCalls.length).toBeGreaterThan(0);
    expect(toolCalls[0].name).toBe("get_time");
  }, 90000);

  it("handles multi-turn conversation", async () => {
    const streamFn = createLlamaCppStreamFn(MODEL_PATH);

    const stream = streamFn(
      {
        id: "test-model",
        api: "llama-cpp",
        provider: "llama-cpp",
        contextWindow: 32768,
      } as unknown as Parameters<typeof streamFn>[0],
      {
        messages: [
          { role: "user", content: "My name is Alice." },
          { role: "assistant", content: "Nice to meet you, Alice!" },
          { role: "user", content: "What's my name?" },
        ],
        systemPrompt: "You are a helpful assistant.",
      },
      { maxTokens: 100 },
    );

    const events = [];
    for await (const event of stream) {
      if (event.type === "error") {
        console.error("❌ Stream error:", event.error?.errorMessage);
      }
      events.push(event);
    }

    const errorEvent = events.find((e) => e.type === "error");
    if (errorEvent) {
      throw new Error(
        `❌ Multi-turn test failed: ${errorEvent.error?.errorMessage || "Unknown error"}`,
      );
    }

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();

    const text = doneEvent.message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text.toLowerCase())
      .join("");

    expect(text).toContain("alice");
  }, 90000);
});
