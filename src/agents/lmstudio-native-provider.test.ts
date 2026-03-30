import { describe, it, expect, vi, beforeEach } from "vitest";

// --- mocks ---
const pushMock = vi.fn();
const endMock = vi.fn();

vi.mock("@mariozechner/pi-ai", () => ({
  createAssistantMessageEventStream: () => ({
    push: pushMock,
    end: endMock,
  }),
}));

const runMock = vi.fn();

vi.mock("./tool-runtime.js", () => ({
  ToolRuntime: vi.fn().mockImplementation(() => ({
    run: runMock,
  })),
}));

vi.mock("./tool-protocol.js", () => ({
  normalizeContextMessages: vi.fn((m) => m),
  buildOpenAITools: vi.fn(() => []),
  safeJsonParse: vi.fn((s) => {
    try {
      return JSON.parse(s);
    } catch {
      return {};
    }
  }),
}));

// --- import after mocks ---
import { streamLMStudioNative } from "./lmstudio-native-provider";

describe("streamLMStudioNative", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  const baseModel = {
    id: "test-model",
    api: "test-api",
    provider: "lmstudio-native",
    baseUrl: "http://test",
  } as any;

  it("should stream a simple text response", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: "hello world",
            },
          },
        ],
      }),
    });

    streamLMStudioNative(baseModel, { messages: [] } as any);

    await new Promise((r) => setTimeout(r, 10));

    expect(pushMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "start" })
    );

    expect(pushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "text_delta",
        delta: "hello world",
      })
    );

    expect(endMock).toHaveBeenCalled();
  });

  it("should execute tool call and continue loop", async () => {
    (fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "1",
                    function: {
                      name: "testTool",
                      arguments: '{"a":1}',
                    },
                  },
                ],
              },
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: "after tool",
              },
            },
          ],
        }),
      });

    runMock.mockResolvedValue({ result: 42 });

    streamLMStudioNative(
      baseModel,
      {
        messages: [],
        tools: [{ name: "testTool", execute: vi.fn() }],
      } as any
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(runMock).toHaveBeenCalledWith("testTool", { a: 1 });

    expect(pushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "toolcall_start",
        name: "testTool",
      })
    );

    expect(pushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "text_delta",
        delta: "after tool",
      })
    );
  });

  it("should handle fetch error response", async () => {
    (fetch as any).mockResolvedValue({
      ok: false,
      text: async () => "fail",
    });

    streamLMStudioNative(baseModel, { messages: [] } as any);

    await new Promise((r) => setTimeout(r, 10));

    expect(pushMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
      })
    );

    expect(endMock).toHaveBeenCalled();
  });

  it("should handle missing message gracefully", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{}] }),
    });

    streamLMStudioNative(baseModel, { messages: [] } as any);

    await new Promise((r) => setTimeout(r, 10));

    expect(endMock).toHaveBeenCalled();
  });

  it("should handle JSON parse failure in tool args", async () => {
    (fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "1",
                  function: {
                    name: "testTool",
                    arguments: "INVALID_JSON",
                  },
                },
              ],
            },
          },
        ],
      }),
    });

    runMock.mockResolvedValue("ok");

    streamLMStudioNative(
      baseModel,
      {
        messages: [],
        tools: [{ name: "testTool", execute: vi.fn() }],
      } as any
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(runMock).toHaveBeenCalledWith("testTool", {});
  });

  it("should include Authorization header when apiKey is provided", async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "ok" } }],
      }),
    });

    streamLMStudioNative(
      baseModel,
      { messages: [] } as any,
      { apiKey: "secret" }
    );

    await new Promise((r) => setTimeout(r, 10));

    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer secret",
        }),
      })
    );
  });
});