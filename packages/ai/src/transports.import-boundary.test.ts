import { expect, it, vi } from "vitest";
import { makeProviderModel } from "./providers/provider-model.test-support.js";

vi.mock("@google/genai", () => {
  throw new Error("Generic transport helpers must not initialize the Google SDK");
});

vi.mock("@anthropic-ai/sdk", () => {
  throw new Error("Shared Anthropic helpers must not initialize the Anthropic SDK");
});

vi.mock("openai", () => {
  throw new Error("Generic transport helpers must not initialize the OpenAI SDK");
});

// mock-isolation: importing the real partitioner would conceal an eager dependency.
vi.mock("./utils/reasoning-tag-text-partitioner.js", () => {
  throw new Error("Generic runtime helpers must not initialize provider reasoning parsing");
});

it("loads generic transports without initializing a provider SDK", async () => {
  expect((await import("./transports.js")).createTransportAwareStreamFnForModel).toBeTypeOf(
    "function",
  );
});

it("loads generic runtime helpers without initializing provider reasoning parsing", async () => {
  await expect(import("./internal/runtime.js")).resolves.toHaveProperty(
    "stream",
    expect.any(Function),
  );
});

it("defers the Anthropic client SDK and contains a first-use import failure", async () => {
  const { streamAnthropic } = await import("./internal/anthropic.js");
  const onPayload = vi.fn();
  const stream = streamAnthropic(
    makeProviderModel("anthropic-messages", "anthropic", "synthetic"),
    { messages: [] },
    { apiKey: "synthetic", onPayload },
  );
  const events = [];
  for await (const event of stream) {
    events.push(event.type);
  }
  expect(events).toEqual(["error"]);
  expect((await stream.result()).stopReason).toBe("error");
  expect(onPayload).not.toHaveBeenCalled();
});
