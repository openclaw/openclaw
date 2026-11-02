import { createApiRegistry, type ApiRegistry } from "@openclaw/ai";
import { resetApiProviders } from "@openclaw/ai/providers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "../llm/utils/event-stream.js";
import { ensureCustomApiRegistered } from "./custom-api-registry.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "./stream-message-shared.js";

let registry: ApiRegistry;
const model = { api: "test-custom-api", provider: "custom", id: "m" };

function register(streamFn: Parameters<typeof ensureCustomApiRegistered>[2]) {
  expect(ensureCustomApiRegistered(registry, model.api, streamFn)).toBe(true);
  return registry.getApiProvider(model.api)!;
}

describe("ensureCustomApiRegistered", () => {
  beforeEach(() => {
    registry = createApiRegistry();
  });

  it("registers a custom api provider once", () => {
    const streamFn = vi.fn(() => createAssistantMessageEventStream());
    register(streamFn);
    expect(ensureCustomApiRegistered(registry, model.api, streamFn)).toBe(false);
  });

  it("delegates both stream entrypoints to the provided stream function", () => {
    const stream = createAssistantMessageEventStream();
    const streamFn = vi.fn(() => stream);
    const provider = register(streamFn);
    expect(provider.stream(model as never, { messages: [] }, { maxTokens: 32 })).toBe(stream);
    expect(provider.streamSimple(model as never, { messages: [] }, { maxTokens: 32 })).toBe(stream);
    expect(streamFn).toHaveBeenCalledTimes(2);
  });

  it("adapts async stream factories to the synchronous provider contract", async () => {
    const message = buildAssistantMessage({
      model,
      content: [{ type: "text", text: "done" }],
      stopReason: "stop",
      usage: buildUsageWithNoCost({}),
    });
    const streamFn = async () => {
      await Promise.resolve();
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message });
      return stream;
    };
    const stream = register(streamFn).stream(model as never, { messages: [] }, {});

    expect(stream).not.toBeInstanceOf(Promise);
    await expect(stream.result()).resolves.toBe(message);
  });

  it("converts async stream factory failures into terminal stream errors", async () => {
    const streamFn = async () => {
      throw new Error("factory failed");
    };
    const stream = register(streamFn).stream(model as never, { messages: [] }, {});

    await expect(stream.result()).resolves.toMatchObject({
      stopReason: "error",
      errorMessage: "factory failed",
    });
  });

  it("keeps plugin api providers when refreshing built-ins", () => {
    const sourceId = "plugin:test-reset-api";
    const api = "test-reset-plugin-api";
    const streamFn = vi.fn(() => createAssistantMessageEventStream());
    registry.registerApiProvider({ api, stream: streamFn, streamSimple: streamFn }, sourceId);

    resetApiProviders(registry);

    expect(registry.getApiProvider(api)).toBeDefined();
    expect(registry.getApiProvider("openai-responses")).toBeDefined();
  });
});
