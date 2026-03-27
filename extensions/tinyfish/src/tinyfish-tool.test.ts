import { SsrFBlockedError } from "openclaw/plugin-sdk/infra-runtime";
import { describe, expect, it, vi } from "vitest";
import { createTinyFishTool } from "./tinyfish-tool.js";

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

type MockFetchRequest = {
  init?: RequestInit;
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

function allowPublicHostname() {
  return vi.fn(async () => ({ hostname: "example.com" }) as never);
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
      resolveHostname: allowPublicHostname(),
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
    const firstCalls = fetchWithGuard.mock.calls as MockFetchRequest[][];
    const firstRequest = firstCalls[0]?.[0];
    expect(firstRequest).toMatchObject({
      init: {
        method: "POST",
        headers: expect.objectContaining({
          "X-API-Key": "config-key",
        }),
      },
    });
    expect(JSON.parse(String(firstRequest?.init?.body))).toEqual({
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
      resolveHostname: allowPublicHostname(),
    });

    await tool.execute("tool-1", {
      url: "https://example.com",
      goal: "Collect the pricing table",
    });

    const firstCalls = fetchWithGuard.mock.calls as MockFetchRequest[][];
    const firstRequest = firstCalls[0]?.[0];
    expect(firstRequest?.init?.headers).toMatchObject({
      "X-API-Key": "env-key",
    });
  });

  it("rejects TinyFish base URLs with query strings or fragments", async () => {
    const fetchWithGuard = vi.fn();
    const tool = createTinyFishTool(
      createApi({
        apiKey: "config-key",
        baseUrl: "https://proxy.example/api?tenant=a#frag",
      }),
      {
        fetchWithGuard,
        env: {},
        resolveHostname: allowPublicHostname(),
      },
    );

    await expect(
      tool.execute("tool-1", {
        url: "https://example.com",
        goal: "Collect the pricing table",
      }),
    ).rejects.toThrow(/query parameters or fragments/);
    expect(fetchWithGuard).not.toHaveBeenCalled();
  });

  it("rejects TinyFish base URLs with embedded credentials", async () => {
    const fetchWithGuard = vi.fn();
    const tool = createTinyFishTool(
      createApi({
        apiKey: "config-key",
        baseUrl: "https://user:pass@proxy.example/api",
      }),
      {
        fetchWithGuard,
        env: {},
        resolveHostname: allowPublicHostname(),
      },
    );

    await expect(
      tool.execute("tool-1", {
        url: "https://example.com",
        goal: "Collect the pricing table",
      }),
    ).rejects.toThrow(/embedded credentials/);
    expect(fetchWithGuard).not.toHaveBeenCalled();
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

  it("surfaces unresolved SecretRef api keys with the TinyFish config path", async () => {
    const tool = createTinyFishTool(
      createApi({
        apiKey: {
          source: "env",
          provider: "default",
          id: "TINYFISH_API_KEY",
        },
      }),
      {
        fetchWithGuard: vi.fn(),
        env: {},
      },
    );

    await expect(
      tool.execute("tool-1", {
        url: "https://example.com",
        goal: "Collect the pricing table",
      }),
    ).rejects.toThrow(/plugins\.entries\.tinyfish\.config\.apiKey: unresolved SecretRef/);
  });

  it("rejects target URLs with embedded credentials", async () => {
    const tool = createTinyFishTool(createApi({ apiKey: "config-key" }), {
      fetchWithGuard: vi.fn(),
      env: {},
      resolveHostname: vi.fn(),
    });

    await expect(
      tool.execute("tool-1", {
        url: "https://user:pass@example.com/private",
        goal: "Open the page",
      }),
    ).rejects.toThrow(/embedded credentials/);
  });

  it("rejects non-public target URLs before forwarding to TinyFish", async () => {
    const fetchWithGuard = vi.fn();
    const tool = createTinyFishTool(createApi({ apiKey: "config-key" }), {
      fetchWithGuard,
      env: {},
      resolveHostname: vi.fn(async () => {
        throw new SsrFBlockedError("blocked");
      }),
    });

    await expect(
      tool.execute("tool-1", {
        url: "http://127.0.0.1/private",
        goal: "Open the page",
      }),
    ).rejects.toThrow(/public website/);
    expect(fetchWithGuard).not.toHaveBeenCalled();
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
      resolveHostname: allowPublicHostname(),
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
      resolveHostname: allowPublicHostname(),
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
      resolveHostname: allowPublicHostname(),
    });

    await expect(
      tool.execute("tool-1", {
        url: "https://example.com",
        goal: "Extract the table",
      }),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("caps oversized TinyFish error bodies", async () => {
    const fetchWithGuard = vi.fn(async () => ({
      response: new Response("x".repeat(5000), {
        status: 502,
        headers: {
          "content-type": "text/plain",
        },
      }),
      finalUrl: "https://agent.tinyfish.ai/v1/automation/run-sse",
      release: async () => {},
    }));

    const tool = createTinyFishTool(createApi({ apiKey: "config-key" }), {
      fetchWithGuard,
      env: {},
      resolveHostname: allowPublicHostname(),
    });

    let thrown: Error | undefined;
    try {
      await tool.execute("tool-1", {
        url: "https://example.com",
        goal: "Extract the table",
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toMatch(new RegExp(`x{${2048}}`));
    expect(String(thrown)).not.toMatch(new RegExp(`x{2500}`));
  });

  it("returns immediately after COMPLETE without waiting for EOF", async () => {
    let cancelCalled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"type":"STARTED","run_id":"run-5"}\n\n' +
              'data: {"type":"COMPLETE","run_id":"run-5","status":"COMPLETED","result":{"ok":true}}\n\n' +
              ": heartbeat\n\n",
          ),
        );
      },
      cancel() {
        cancelCalled = true;
      },
    });

    const fetchWithGuard = vi.fn(async () => ({
      response: new Response(stream, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
        },
      }),
      finalUrl: "https://agent.tinyfish.ai/v1/automation/run-sse",
      release: async () => {},
    }));

    const tool = createTinyFishTool(createApi({ apiKey: "config-key" }), {
      fetchWithGuard,
      env: {},
      resolveHostname: allowPublicHostname(),
    });

    const result = (await Promise.race([
      tool.execute("tool-1", {
        url: "https://example.com",
        goal: "Extract the table",
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Timed out waiting for TinyFish COMPLETE")), 250);
      }),
    ])) as { details: Record<string, unknown> };

    expect(result.details).toMatchObject({
      run_id: "run-5",
      status: "COMPLETED",
      result: { ok: true },
    });
    expect(cancelCalled).toBe(true);
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
      resolveHostname: allowPublicHostname(),
    });

    await expect(
      tool.execute("tool-1", {
        url: "https://example.com",
        goal: "Extract the table",
      }),
    ).rejects.toThrow(/COMPLETE/);
  });
});
