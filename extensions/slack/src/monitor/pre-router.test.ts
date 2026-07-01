import { describe, expect, it, vi } from "vitest";
import { runPreRouterHook } from "./pre-router.js";

const payload = {
  prompt: "show me last week's brief",
  channel: "C0123",
  user: "U0123",
  ts: "1717423420.000100",
};

function makeFetchResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200;
  const ok = init.ok ?? status < 400;
  return {
    ok,
    status,
    statusText: ok ? "OK" : "ERR",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("runPreRouterHook", () => {
  it("returns null when OPENCLAW_PRE_ROUTER_URL is unset", async () => {
    // The hook MUST be a no-op when the env var is unset — that's the
    // default state, and we must not change behavior for the 99% of
    // OpenClaw installs that don't run a pre-router service.
    const fetchFn = vi.fn();
    const result = await runPreRouterHook(payload, {
      readUrl: () => undefined,
      fetchFn,
    });
    expect(result).toBeNull();
    // The most important assertion: we don't even attempt the network
    // call when the hook is off.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns response string on 200 OK with matched=true", async () => {
    const fetchFn = vi.fn(async () =>
      makeFetchResponse({ matched: true, response: "hello from pattern" }),
    );
    const result = await runPreRouterHook(payload, {
      readUrl: () => "http://example.test/dispatch",
      readTimeoutMs: () => 2000,
      fetchFn,
    });
    expect(result).toBe("hello from pattern");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("http://example.test/dispatch");
    const init2 = init as RequestInit;
    expect(init2.method).toBe("POST");
    expect(JSON.parse(init2.body as string)).toEqual(payload);
  });

  it("returns null on 200 OK with matched=false", async () => {
    const fetchFn = vi.fn(async () => makeFetchResponse({ matched: false }));
    const log = vi.fn();
    const result = await runPreRouterHook(payload, {
      readUrl: () => "http://example.test/dispatch",
      fetchFn,
      log,
    });
    expect(result).toBeNull();
    // We log misses at INFO so operators can observe hook activity.
    expect(log).toHaveBeenCalledWith(expect.stringContaining("miss"));
  });

  it("returns null on HTTP 500", async () => {
    const fetchFn = vi.fn(async () => makeFetchResponse({ error: "boom" }, { status: 500 }));
    const error = vi.fn();
    const result = await runPreRouterHook(payload, {
      readUrl: () => "http://example.test/dispatch",
      fetchFn,
      error,
    });
    expect(result).toBeNull();
    // Errors must surface in logs so operators can debug a dead pre-router.
    expect(error).toHaveBeenCalledWith(expect.stringContaining("HTTP 500"));
  });

  it("returns null on fetch timeout (AbortError)", async () => {
    // Real fetch with AbortController: we simulate by making fetch
    // throw an AbortError after signal.abort() fires.
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const error = vi.fn();
    const result = await runPreRouterHook(payload, {
      readUrl: () => "http://example.test/dispatch",
      // 50ms timeout so the test completes quickly.
      readTimeoutMs: () => 50,
      fetchFn,
      error,
    });
    expect(result).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("fetch failed"));
  });

  it("returns null on malformed JSON body", async () => {
    const fetchFn = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => {
            throw new SyntaxError("Unexpected token");
          },
          text: async () => "not json",
        }) as unknown as Response,
    );
    const error = vi.fn();
    const result = await runPreRouterHook(payload, {
      readUrl: () => "http://example.test/dispatch",
      fetchFn,
      error,
    });
    expect(result).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("non-JSON"));
  });

  it("returns null when matched field is missing", async () => {
    // Schema regression guard: if a future pre-router service forgets
    // to include `matched`, we must not treat the body as a hit. Falls
    // through to LLM.
    const fetchFn = vi.fn(async () => makeFetchResponse({ response: "would-be reply" }));
    const error = vi.fn();
    const result = await runPreRouterHook(payload, {
      readUrl: () => "http://example.test/dispatch",
      fetchFn,
      error,
    });
    expect(result).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("malformed"));
  });

  it("returns null when matched=true but response is missing", async () => {
    // matched=true without a response string is contract violation —
    // we can't post an empty message to Slack, so we fall through.
    const fetchFn = vi.fn(async () => makeFetchResponse({ matched: true }));
    const error = vi.fn();
    const result = await runPreRouterHook(payload, {
      readUrl: () => "http://example.test/dispatch",
      fetchFn,
      error,
    });
    expect(result).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("malformed"));
  });

  it("returns null on network error (DNS, refused, etc.)", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const error = vi.fn();
    const result = await runPreRouterHook(payload, {
      readUrl: () => "http://example.test/dispatch",
      fetchFn,
      error,
    });
    expect(result).toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));
  });

  it("logs pattern_id and latency_ms on hit for observability", async () => {
    const fetchFn = vi.fn(async () =>
      makeFetchResponse({
        matched: true,
        response: "ok",
        pattern_id: "help",
        latency_ms: 12.3,
      }),
    );
    const log = vi.fn();
    await runPreRouterHook(payload, {
      readUrl: () => "http://example.test/dispatch",
      fetchFn,
      log,
    });
    // The hit log line includes pattern_id + latency so ops can audit
    // matcher behavior without re-running the request.
    expect(log).toHaveBeenCalledWith(expect.stringContaining("hit pattern=help"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("latency_ms=12.3"));
  });
});
