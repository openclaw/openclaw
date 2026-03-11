import { describe, expect, it, vi } from "vitest";
import { createAnthropicVertexStreamFn } from "./anthropic-vertex-stream.js";

// Mock the auth module to avoid real GCP token refresh
vi.mock("./anthropic-vertex-auth.js", async (importOriginal) => {
  const mod: Record<string, unknown> = await importOriginal();
  return {
    ...mod,
    getVertexAccessToken: vi.fn().mockResolvedValue("test-gcp-access-token"),
  };
});

// Mock streamSimple to capture what's passed to it
vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const mod: Record<string, unknown> = await importOriginal();
  return {
    ...mod,
    streamSimple: vi.fn((_model, _context, _options) => {
      // Return a minimal event stream mock
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: true, value: undefined }),
        }),
        result: async () => ({}),
      };
    }),
  };
});

describe("createAnthropicVertexStreamFn", () => {
  it("creates a stream function", () => {
    const streamFn = createAnthropicVertexStreamFn({
      project: "my-project",
      region: "us-east5",
    });
    expect(typeof streamFn).toBe("function");
  });

  it("passes correct Vertex baseUrl to streamSimple", async () => {
    const { streamSimple } = await import("@mariozechner/pi-ai");
    const streamFn = createAnthropicVertexStreamFn({
      project: "test-proj",
      region: "us-east5",
    });

    const mockModel = {
      id: "claude-sonnet-4-6@20250514",
      api: "anthropic-messages",
      provider: "anthropic-vertex",
      baseUrl: "https://original.example.com",
    };
    const mockContext = { messages: [], systemPrompt: "test" };

    // The StreamFn returns a promise (async wrapper)
    await streamFn(mockModel as never, mockContext as never, undefined);

    expect(streamSimple).toHaveBeenCalledTimes(1);
    const call = (streamSimple as ReturnType<typeof vi.fn>).mock.calls[0];
    const passedModel = call[0];

    // baseUrl should be the Vertex endpoint with trailing #
    expect(passedModel.baseUrl).toBe(
      "https://us-east5-aiplatform.googleapis.com/v1/projects/test-proj/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-6@20250514:streamRawPredict#",
    );
  });

  it("injects Bearer auth header from GCP token", async () => {
    const { streamSimple } = await import("@mariozechner/pi-ai");
    (streamSimple as ReturnType<typeof vi.fn>).mockClear();

    const streamFn = createAnthropicVertexStreamFn({
      project: "proj",
      region: "us-east5",
    });

    const mockModel = {
      id: "claude-opus-4-6@20250514",
      api: "anthropic-messages",
      provider: "anthropic-vertex",
    };

    await streamFn(mockModel as never, { messages: [] } as never, undefined);

    const call = (streamSimple as ReturnType<typeof vi.fn>).mock.calls[0];
    const passedModel = call[0];
    expect(passedModel.headers?.Authorization).toBe("Bearer test-gcp-access-token");
  });

  it("onPayload removes model field and adds anthropic_version", async () => {
    const { streamSimple } = await import("@mariozechner/pi-ai");
    (streamSimple as ReturnType<typeof vi.fn>).mockClear();

    const streamFn = createAnthropicVertexStreamFn({
      project: "proj",
      region: "us-east5",
    });

    const mockModel = {
      id: "claude-sonnet-4-6@20250514",
      api: "anthropic-messages",
      provider: "anthropic-vertex",
    };

    await streamFn(mockModel as never, { messages: [] } as never, undefined);

    const call = (streamSimple as ReturnType<typeof vi.fn>).mock.calls[0];
    const passedOptions = call[2];
    expect(typeof passedOptions.onPayload).toBe("function");

    // Simulate the payload that buildParams would produce
    const payload = {
      model: "claude-sonnet-4-6@20250514",
      messages: [],
      max_tokens: 4096,
      stream: true,
    };
    passedOptions.onPayload(payload, mockModel);

    // model should be removed
    expect(payload).not.toHaveProperty("model");
    // anthropic_version should be added
    expect((payload as Record<string, unknown>).anthropic_version).toBe("vertex-2023-10-16");
  });

  it("chains with existing onPayload callback", async () => {
    const { streamSimple } = await import("@mariozechner/pi-ai");
    (streamSimple as ReturnType<typeof vi.fn>).mockClear();

    const originalOnPayload = vi.fn();
    const streamFn = createAnthropicVertexStreamFn({
      project: "proj",
      region: "us-east5",
    });

    const mockModel = {
      id: "claude-sonnet-4-6@20250514",
      api: "anthropic-messages",
      provider: "anthropic-vertex",
    };

    await streamFn(
      mockModel as never,
      { messages: [] } as never,
      {
        onPayload: originalOnPayload,
      } as never,
    );

    const call = (streamSimple as ReturnType<typeof vi.fn>).mock.calls[0];
    const passedOptions = call[2];
    const payload = { model: "claude-sonnet-4-6@20250514", messages: [] };
    passedOptions.onPayload(payload, mockModel);

    expect(originalOnPayload).toHaveBeenCalledOnce();
  });

  it("preserves existing model headers", async () => {
    const { streamSimple } = await import("@mariozechner/pi-ai");
    (streamSimple as ReturnType<typeof vi.fn>).mockClear();

    const streamFn = createAnthropicVertexStreamFn({
      project: "proj",
      region: "us-east5",
    });

    const mockModel = {
      id: "claude-sonnet-4-6@20250514",
      api: "anthropic-messages",
      provider: "anthropic-vertex",
      headers: { "x-custom": "value" },
    };

    await streamFn(mockModel as never, { messages: [] } as never, undefined);

    const call = (streamSimple as ReturnType<typeof vi.fn>).mock.calls[0];
    const passedModel = call[0];
    expect(passedModel.headers["x-custom"]).toBe("value");
    expect(passedModel.headers.Authorization).toBe("Bearer test-gcp-access-token");
  });
});
