import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerXMemoAutoCapture } from "./auto-capture.js";

function mockResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("xmemo auto-capture", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>>;
  let logs: Array<{ level: string; message: string }>;

  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    handlers = {};
    logs = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.XMEMO_KEY;
  });

  function mockApi(pluginConfig: Record<string, unknown> = {}): OpenClawPluginApi {
    return {
      config: {
        plugins: {
          entries: {
            "xmemo-memory": {
              config: pluginConfig,
            },
          },
        },
      },
      pluginConfig,
      on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
        handlers[event] = handler;
      },
      logger: {
        info: (message: string) => logs.push({ level: "info", message }),
        warn: (message: string) => logs.push({ level: "warn", message }),
      },
    } as unknown as OpenClawPluginApi;
  }

  async function capture(
    messages: Array<{ role: string; content: string }>,
    pluginConfig: Record<string, unknown> = {},
  ) {
    registerXMemoAutoCapture(mockApi({ apiKey: "key", autoCapture: true, ...pluginConfig }));
    await handlers.agent_end?.(
      { success: true, messages },
      { sessionId: "session-1", sessionKey: "session-1" },
    );
  }

  it("stores a user preference when auto-capture is enabled", async () => {
    fetchMock.mockResolvedValue(mockResponse({ id: "mem-1" }));
    await capture([{ role: "user", content: "I prefer dark mode" }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.content).toBe("I prefer dark mode");
    expect(body.metadata.category).toBe("preference");
  });

  it("does nothing when autoCapture is disabled", async () => {
    registerXMemoAutoCapture(mockApi({ apiKey: "key", autoCapture: false }));
    await handlers.agent_end?.(
      { success: true, messages: [{ role: "user", content: "I prefer dark mode" }] },
      { sessionId: "session-1" },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when the plugin is not configured", async () => {
    registerXMemoAutoCapture(mockApi({ autoCapture: true }));
    await handlers.agent_end?.(
      { success: true, messages: [{ role: "user", content: "I prefer dark mode" }] },
      { sessionId: "session-1" },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips non-user messages", async () => {
    await capture([
      { role: "assistant", content: "I will remember that" },
      { role: "system", content: "system prompt" },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips messages without a capture trigger", async () => {
    await capture([{ role: "user", content: "hello world" }]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stores at most three capturable memories per run", async () => {
    fetchMock.mockResolvedValue(mockResponse({ id: "mem-1" }));
    await capture([
      { role: "user", content: "I prefer dark mode" },
      { role: "user", content: "My email is a@b.com" },
      { role: "user", content: "I decided to use TypeScript" },
      { role: "user", content: "I love Kimi" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("respects custom triggers", async () => {
    fetchMock.mockResolvedValue(mockResponse({ id: "mem-1" }));
    await capture(
      [
        { role: "user", content: "plain message" },
        { role: "user", content: "storethis decision" },
      ],
      {
        customTriggers: ["storethis"],
      },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.content).toBe("storethis decision");
  });

  it("passes an AbortSignal to the underlying request", async () => {
    fetchMock.mockResolvedValue(mockResponse({ id: "mem-1" }));
    await capture([{ role: "user", content: "I prefer dark mode" }]);

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
