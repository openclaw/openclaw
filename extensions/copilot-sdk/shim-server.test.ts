import { afterEach, describe, expect, it, vi } from "vitest";
import type { SdkClient } from "./sdk-client.js";
import { startShimServer } from "./shim-server.js";

function buildFakeClient(overrides: Partial<SdkClient> = {}): SdkClient {
  return {
    listModels: vi.fn(async () => [{ id: "gpt-5", name: "GPT-5" }, { id: "claude-sonnet-4.5" }]),
    runPrompt: vi.fn(async ({ prompt }) => ({ content: `echo:${prompt}` })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

describe("copilot-sdk shim server", () => {
  const handles: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    while (handles.length) {
      await handles
        .pop()!
        .close()
        .catch(() => undefined);
    }
  });

  it("binds to loopback on an ephemeral port and serves /v1/models", async () => {
    const client = buildFakeClient();
    const handle = await startShimServer({ client });
    handles.push(handle);

    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);

    const { status, body } = await fetchJson(`${handle.url}/models`);
    expect(status).toBe(200);
    expect((body as { object: string }).object).toBe("list");
    const data = (body as { data: Array<{ id: string; owned_by: string }> }).data;
    expect(data.map((m) => m.id)).toEqual(["gpt-5", "claude-sonnet-4.5"]);
    expect(data[0].owned_by).toBe("github-copilot");
  });

  it("returns an OpenAI-shaped completion for non-streaming requests", async () => {
    const client = buildFakeClient();
    const handle = await startShimServer({ client });
    handles.push(handle);

    const { status, body } = await fetchJson(`${handle.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "Hi" },
        ],
      }),
    });

    expect(status).toBe(200);
    const completion = body as {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      model: string;
    };
    expect(completion.model).toBe("gpt-5");
    expect(completion.choices[0].finish_reason).toBe("stop");
    expect(completion.choices[0].message.content).toContain("echo:");
    expect(completion.choices[0].message.content).toContain("[system]");
    expect(completion.choices[0].message.content).toContain("[user]\nHi");
    expect(client.runPrompt).toHaveBeenCalledOnce();
  });

  it("emits an SSE stream ending in [DONE] for stream:true", async () => {
    const client = buildFakeClient({
      runPrompt: vi.fn(async () => ({ content: "hello world" })),
    });
    const handle = await startShimServer({ client });
    handles.push(handle);

    const res = await fetch(`${handle.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [{ role: "user", content: "Say hi" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("hello world");
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
  });

  it("rejects requests that declare tools with HTTP 400 when rejectToolRequests is true", async () => {
    const client = buildFakeClient();
    const handle = await startShimServer({ client, rejectToolRequests: true });
    handles.push(handle);

    const { status, body } = await fetchJson(`${handle.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "x", parameters: {} } }],
      }),
    });

    expect(status).toBe(400);
    expect((body as { error: { type: string } }).error.type).toBe("tools_not_supported");
    expect(client.runPrompt).not.toHaveBeenCalled();
  });

  it("strips tools by default (rejectToolRequests defaults to false)", async () => {
    const client = buildFakeClient();
    const handle = await startShimServer({ client });
    handles.push(handle);

    const { status } = await fetchJson(`${handle.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "x", parameters: {} } }],
      }),
    });

    expect(status).toBe(200);
    expect(client.runPrompt).toHaveBeenCalledOnce();
  });

  it("logs warning when tools are stripped with rejectToolRequests=false", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const client = buildFakeClient();
      const handle = await startShimServer({ client, rejectToolRequests: false });
      handles.push(handle);

      const { status } = await fetchJson(`${handle.url}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-5",
          messages: [{ role: "user", content: "hi" }],
          tools: [{ type: "function", function: { name: "x", parameters: {} } }],
        }),
      });

      expect(status).toBe(200);
      expect(warnSpy).toHaveBeenCalledWith(
        "copilot-sdk shim: stripping tools from request (not supported by Copilot CLI)",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("silently drops tools when rejectToolRequests is false", async () => {
    const client = buildFakeClient();
    const handle = await startShimServer({ client, rejectToolRequests: false });
    handles.push(handle);

    const { status } = await fetchJson(`${handle.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "x", parameters: {} } }],
      }),
    });

    expect(status).toBe(200);
    expect(client.runPrompt).toHaveBeenCalledOnce();
  });

  it("returns 400 when body is missing required fields", async () => {
    const client = buildFakeClient();
    const handle = await startShimServer({ client });
    handles.push(handle);

    const { status, body } = await fetchJson(`${handle.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5" }),
    });
    expect(status).toBe(400);
    expect((body as { error: { type: string } }).error.type).toBe("invalid_request");
  });

  it("returns 404 for unknown routes", async () => {
    const client = buildFakeClient();
    const handle = await startShimServer({ client });
    handles.push(handle);

    const { status } = await fetchJson(`${handle.url}/completions`);
    expect(status).toBe(404);
  });

  it("converts SDK runPrompt errors into HTTP 500", async () => {
    const client = buildFakeClient({
      runPrompt: vi.fn(async () => {
        throw new Error("sdk boom");
      }),
    });
    const handle = await startShimServer({ client });
    handles.push(handle);

    const { status, body } = await fetchJson(`${handle.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(status).toBe(500);
    expect((body as { error: { message: string } }).error.message).toBe("sdk boom");
  });

  it("falls back to ephemeral port on EADDRINUSE", async () => {
    const client = buildFakeClient();
    // Occupy a fixed port
    const blocker = await startShimServer({ client, port: 19876 });
    handles.push(blocker);
    expect(blocker.port).toBe(19876);

    // Second server on the same fixed port should fall back to ephemeral
    const fallback = await startShimServer({ client, port: 19876 });
    handles.push(fallback);
    expect(fallback.port).not.toBe(19876);
    expect(fallback.port).toBeGreaterThan(0);

    // Both servers should respond
    const { status: s1 } = await fetchJson(`${blocker.url}/models`);
    const { status: s2 } = await fetchJson(`${fallback.url}/models`);
    expect(s1).toBe(200);
    expect(s2).toBe(200);
  });
});
