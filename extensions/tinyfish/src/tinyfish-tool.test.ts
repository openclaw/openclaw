import { describe, expect, it, vi } from "vitest";
import { createTinyFishTool } from "./tinyfish-tool.js";

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function createApi(pluginConfig: Record<string, unknown> = {}) {
  return {
    id: "tinyfish",
    name: "TinyFish",
    description: "test",
    source: "test",
    config: {},
    pluginConfig,
    runtime: {} as never,
    logger: noopLogger,
  } as never;
}

function sseResponse(events: string[]) {
  const payload = events.join("");
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    },
  );
}

describe("tinyfish automation tool", () => {
  it("serializes request params and returns the streaming URL when provided", async () => {
    const fetchWithGuard = vi.fn(async () => ({
      response: sseResponse([
        'data: {"type":"STARTED","run_id":"run-1"}\n\n',
        'data: {"type":"STREAMING_URL","streaming_url":"https://stream.example/run-1"}\n\n',
        'data: {"type":"COMPLETE","run_id":"run-1","status":"COMPLETED","result":{"ok":true}}\n\n',
      ]),
      finalUrl: "https://agent.tinyfish.ai/v1/automation/run-sse",
      release: async () => {},
    }));

    const tool = createTinyFishTool(createApi({ apiKey: "config-key" }), {
      fetchWithGuard,
      env: {},
    });

    const result = (await tool.execute("tool-1", {
      url: "https://example.com",
      goal: "Fill the public form",
      browser_profile: "stealth",
      proxy_config: {
        enabled: true,
        country_code: "us",
      },
    })) as { details: Record<string, unknown> };

    expect(fetchWithGuard).toHaveBeenCalledTimes(1);
    expect(fetchWithGuard.mock.calls[0]?.[0]).toMatchObject({
      init: {
        method: "POST",
        headers: expect.objectContaining({
          "X-API-Key": "config-key",
        }),
      },
    });
    expect(JSON.parse(String(fetchWithGuard.mock.calls[0]?.[0]?.init?.body))).toEqual({
      url: "https://example.com/",
      goal: "Fill the public form",
      browser_profile: "stealth",
      proxy_config: {
        enabled: true,
        country_code: "US",
      },
      api_integration: "openclaw",
    });
    expect(result.details).toEqual({
      run_id: "run-1",
      status: "COMPLETED",
      result: { ok: true },
      error: null,
      help_url: null,
      help_message: null,
      streaming_url: "https://stream.example/run-1",
    });
  });

  it("uses TINYFISH_API_KEY from the environment when plugin config is unset", async () => {
    const fetchWithGuard = vi.fn(async () => ({
      response: sseResponse([
        'data: {"type":"COMPLETE","run_id":"run-env","status":"COMPLETED","result":{"ok":true}}\n\n',
      ]),
      finalUrl: "https://agent.tinyfish.ai/v1/automation/run-sse",
      release: async () => {},
    }));

    const tool = createTinyFishTool(createApi(), {
      fetchWithGuard,
      env: {
        TINYFISH_API_KEY: "env-key",
      },
    });

    await tool.execute("tool-1", {
      url: "https://example.com",
      goal: "Collect the pricing table",
    });

    expect(fetchWithGuard.mock.calls[0]?.[0]?.init?.headers).toMatchObject({
      "X-API-Key": "env-key",
    });
  });

  it("points missing-key errors at plugins.entries.tinyfish.config.apiKey", async () => {
    const tool = createTinyFishTool(createApi(), {
      fetchWithGuard: vi.fn(),
      env: {},
    });

    await expect(
      tool.execute("tool-1", {
        url: "https://example.com",
        goal: "Collect the pricing table",
      }),
    ).rejects.toThrow(/plugins\.entries\.tinyfish\.config\.apiKey/);
  });

  it("succeeds when TinyFish omits the streaming URL event", async () => {
    const fetchWithGuard = vi.fn(async () => ({
      response: sseResponse([
        'data: {"type":"STARTED","run_id":"run-2"}\n\n',
        'data: {"type":"COMPLETE","run_id":"run-2","status":"COMPLETED","result":{"count":3}}\n\n',
      ]),
      finalUrl: "https://agent.tinyfish.ai/v1/automation/run-sse",
      release: async () => {},
    }));

    const tool = createTinyFishTool(createApi({ apiKey: "config-key" }), {
      fetchWithGuard,
      env: {},
    });

    const result = (await tool.execute("tool-1", {
      url: "https://example.com",
      goal: "Extract the table",
    })) as { details: Record<string, unknown> };

    expect(result.details).toEqual({
      run_id: "run-2",
      status: "COMPLETED",
      result: { count: 3 },
      error: null,
      help_url: null,
      help_message: null,
      streaming_url: null,
    });
  });

  it("preserves failed COMPLETE payload help fields", async () => {
    const fetchWithGuard = vi.fn(async () => ({
      response: sseResponse([
        'data: {"type":"STARTED","run_id":"run-3"}\n\n',
        'data: {"type":"COMPLETE","run_id":"run-3","status":"FAILED","error":{"message":"proxy exhausted","help_url":"https://docs.example/help","help_message":"Try another region"}}\n\n',
      ]),
      finalUrl: "https://agent.tinyfish.ai/v1/automation/run-sse",
      release: async () => {},
    }));

    const tool = createTinyFishTool(createApi({ apiKey: "config-key" }), {
      fetchWithGuard,
      env: {},
    });

    const result = (await tool.execute("tool-1", {
      url: "https://example.com",
      goal: "Submit the workflow",
    })) as { details: Record<string, unknown> };

    expect(result.details).toEqual({
      run_id: "run-3",
      status: "FAILED",
      result: null,
      error: {
        message: "proxy exhausted",
        help_url: "https://docs.example/help",
        help_message: "Try another region",
      },
      help_url: "https://docs.example/help",
      help_message: "Try another region",
      streaming_url: null,
    });
  });

  it("fails cleanly when the SSE payload is malformed", async () => {
    const fetchWithGuard = vi.fn(async () => ({
      response: sseResponse(["data: not-json\n\n"]),
      finalUrl: "https://agent.tinyfish.ai/v1/automation/run-sse",
      release: async () => {},
    }));

    const tool = createTinyFishTool(createApi({ apiKey: "config-key" }), {
      fetchWithGuard,
      env: {},
    });

    await expect(
      tool.execute("tool-1", {
        url: "https://example.com",
        goal: "Extract the table",
      }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("fails cleanly when the stream ends without COMPLETE", async () => {
    const fetchWithGuard = vi.fn(async () => ({
      response: sseResponse(['data: {"type":"STARTED","run_id":"run-4"}\n\n']),
      finalUrl: "https://agent.tinyfish.ai/v1/automation/run-sse",
      release: async () => {},
    }));

    const tool = createTinyFishTool(createApi({ apiKey: "config-key" }), {
      fetchWithGuard,
      env: {},
    });

    await expect(
      tool.execute("tool-1", {
        url: "https://example.com",
        goal: "Extract the table",
      }),
    ).rejects.toThrow(/COMPLETE/);
  });
});
