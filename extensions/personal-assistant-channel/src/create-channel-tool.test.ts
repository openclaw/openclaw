import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChannelTool } from "./create-channel-tool.js";

function fakeApi(overrides: Record<string, unknown> = {}) {
  return {
    id: "personal-assistant-channel",
    name: "personal-assistant-channel",
    source: "test",
    config: {},
    pluginConfig: {
      assistantApiBaseUrl: "http://127.0.0.1:4000",
      assistantApiToken: "test-token",
      ...overrides.pluginConfig,
    },
    runtime: { version: "test" },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    registerTool() {},
    ...overrides,
  };
}

describe("create_channel tool", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a channel through the assistant api", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        created: true,
        mode: "created",
        channel: { id: "channel-1", name: "旅行", primary_thread_id: "thread-1" },
      }),
    });

    vi.stubGlobal("fetch", fetchMock);

    const tool = createChannelTool(fakeApi(), { sessionKey: "agent:test:session-1" });
    const result = await tool.execute("tool-1", { name: "旅行" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:4000/api/internal/openclaw/channels",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer test-token",
          "content-type": "application/json",
        }),
      }),
    );
    expect(result.content[0]?.text).toContain("旅行");
    expect(result.details).toMatchObject({
      created: true,
      mode: "created",
      channel: { id: "channel-1", name: "旅行" },
    });
  });

  it("requires an active session key", async () => {
    const tool = createChannelTool(fakeApi(), {});
    await expect(tool.execute("tool-1", { name: "旅行" })).rejects.toThrow(/active session/i);
  });

  it("surfaces assistant api errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: "not_found" }),
      }),
    );

    const tool = createChannelTool(fakeApi(), { sessionKey: "agent:test:session-1" });
    await expect(tool.execute("tool-1", { name: "旅行" })).rejects.toThrow(/not_found/i);
  });
});
