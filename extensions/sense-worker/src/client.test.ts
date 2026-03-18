import { afterEach, describe, expect, it, vi } from "vitest";
import { callSense, checkSenseHealth } from "./client.js";

describe("sense worker client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("checks health", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "ok" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    const result = await checkSenseHealth({ baseUrl: "http://sense.local:8787" });
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.url).toBe("http://sense.local:8787/health");
    expect(result.body).toEqual({ status: "ok" });
  });

  it("posts execute payload", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "ok", result: "done" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await callSense(
      "summarize",
      "hello",
      { mode: "short" },
      { baseUrl: "http://sense.local:8787" },
    );
    expect(result.body).toEqual({ status: "ok", result: "done" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://sense.local:8787/execute");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      task: "summarize",
      input: "hello",
      params: { mode: "short" },
    });
    expect(init?.headers).toMatchObject({ Accept: "application/json" });
  });

  it("sends shared token from explicit config", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "ok", result: "done" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await checkSenseHealth({
      baseUrl: "http://sense.local:8787",
      token: "test-shared-token",
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.headers).toMatchObject({
      Accept: "application/json",
      "X-Sense-Worker-Token": "test-shared-token",
    });
  });

  it("sends shared token from env fallback", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SENSE_WORKER_TOKEN", "env-shared-token");

    await checkSenseHealth({ baseUrl: "http://sense.local:8787" });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.headers).toMatchObject({
      Accept: "application/json",
      "X-Sense-Worker-Token": "env-shared-token",
    });
  });

  it("fails on invalid json", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("not-json", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    await expect(checkSenseHealth()).rejects.toThrow(/invalid json/i);
  });

  it("fails on timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      ),
    );
    await expect(checkSenseHealth({ timeoutMs: 1 })).rejects.toThrow(/timed out/i);
  });
});
