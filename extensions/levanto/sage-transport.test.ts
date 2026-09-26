import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeSageRequest } from "./sage-transport.js";
import type { SageBatchRequest, SageRequest } from "./sage-wire.js";

const request: SageRequest = {
  content: "synthetic document",
  question: { id: "q", kind: "yesno", instructions: "Urgent?" },
  reasoning: "off",
};
const answer = {
  id: "q",
  kind: "yesno",
  result: { answer: null, probability: 0.51 },
  meta: { model: "levanto-sage-v1.1", usage: { billed_input_tokens: 5 } },
};
function transport(fetchFn: typeof fetch) {
  return {
    baseUrl: "https://93.184.216.34/prefix/",
    headers: new Headers({ authorization: "Bearer synthetic-sage-fixture", "x-client": "test" }),
    deadline: { label: "Sage decision", deadlineAtMs: Date.now() + 500, timeoutMs: 500 },
    fetchFn,
    mode: "strict" as const,
    dispatcherPolicy: { mode: "direct" as const },
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Sage through the real guarded provider HTTP helper", () => {
  it("posts once beneath the configured prefix, preserving prepared headers and abstention", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(answer));
    // Plain stub exercises dispatcher construction; vi.fn uses the hermetic mock shortcut.
    const t = transport((input, init) => fetchFn(input, init));
    expect(await executeSageRequest(request, t)).toEqual(answer);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://93.184.216.34/prefix/decide");
    expect(init?.method).toBe("POST");
    assert(typeof init?.body === "string");
    expect(JSON.parse(init.body)).toEqual(request);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-sage-fixture");
    expect(new Headers(init?.headers).get("x-client")).toBe("test");
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(init?.redirect).toBe("manual");
    expect(init).toHaveProperty("dispatcher");
    expect(t.headers.has("content-type")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("uses a single native batch call and retains the envelope", async () => {
    const batch: SageBatchRequest = {
      requests: [
        { content: "doc", questions: [request.question, { ...request.question, id: "failed" }] },
      ],
      reasoning: "off",
    };
    const result = {
      results: [
        {
          answers: [
            { ok: true, result: answer },
            { ok: false, error: "Unavailable", result: null },
          ],
        },
      ],
      meta: { request_count: 1, question_count: 2, usage: { billed_input_tokens: 9 } },
    };
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(result));
    expect(await executeSageRequest(batch, transport(fetchFn))).toEqual(result);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0]![0]).toBe("https://93.184.216.34/prefix/decide/batch");
    const body = fetchFn.mock.calls[0]![1]?.body;
    assert(typeof body === "string");
    expect(JSON.parse(body)).toEqual(batch);
  });
  it.each([400, 401, 402, 429, 500, 503])(
    "does not retry HTTP %s and redacts reflected auth",
    async (status) => {
      vi.useFakeTimers();
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ detail: "synthetic-sage-fixture" }, { status }));
      const error = await executeSageRequest(request, transport(fetchFn)).catch((e: unknown) => e);
      expect(error).toMatchObject({ status });
      expect(String(error)).not.toContain("synthetic-sage-fixture");
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("rejects private addresses before fetch unless the prepared route explicitly trusts them", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(answer));
    await expect(
      executeSageRequest(request, { ...transport(fetchFn), baseUrl: "http://127.0.0.1/prefix" }),
    ).rejects.toThrow();
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(
      executeSageRequest(request, {
        ...transport(fetchFn),
        baseUrl: "http://127.0.0.1/prefix",
        allowPrivateNetwork: true,
      }),
    ).resolves.toEqual(answer);
  });
  it("does not replay a billable body/auth across a cross-origin 307", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 307, headers: { location: "https://93.184.216.35/decide" } }),
      )
      .mockResolvedValueOnce(Response.json({ detail: "missing body" }, { status: 400 }));
    await expect(executeSageRequest(request, transport(fetchFn))).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const redirected = fetchFn.mock.calls[1]![1];
    expect(redirected?.body).toBeUndefined();
    expect(new Headers(redirected?.headers).has("authorization")).toBe(false);
  });
  it("strips credentials on a cross-origin 303", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 303, headers: { location: "https://93.184.216.35/result" } }),
      )
      .mockResolvedValueOnce(Response.json(answer));
    await executeSageRequest(request, transport(fetchFn));
    const redirected = fetchFn.mock.calls[1]![1];
    expect(redirected?.method).toBe("GET");
    expect(redirected?.body).toBeUndefined();
    expect(new Headers(redirected?.headers).has("authorization")).toBe(false);
  });
  it.each(["{broken", JSON.stringify({ ...answer, id: "wrong" })])(
    "releases transport after malformed response %#",
    async (body) => {
      vi.useFakeTimers();
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
      await expect(executeSageRequest(request, transport(fetchFn))).rejects.toThrow();
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("rejects an oversized actual body and cancels its stream", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
        },
        cancel,
      }),
      {
        headers: { "content-length": "999999999" },
      },
    );
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(executeSageRequest(request, transport(fetchFn))).rejects.toThrow(
      "invalid or oversized",
    );
    expect(cancel).toHaveBeenCalled();
  });
  it.each([200, 503])("bounds the whole body read for HTTP %s and cleans up", async (status) => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const readStarted = createDeferred<void>();
    const stream = new ReadableStream(
      {
        pull() {
          readStarted.resolve();
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream, { status }));
    const pending = executeSageRequest(request, transport(fetchFn));
    const rejected = expect(pending).rejects.toThrow(/timed out|timeout/i);
    await readStarted.promise;
    await vi.advanceTimersByTimeAsync(501);
    await rejected;
    expect(cancel).toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("honors cancellation during body consumption", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const started = createDeferred<void>();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        new ReadableStream(
          {
            pull() {
              started.resolve();
            },
            cancel,
          },
          { highWaterMark: 0 },
        ),
      ),
    );
    const pending = executeSageRequest(request, {
      ...transport(fetchFn),
      signal: controller.signal,
    });
    const rejected = expect(pending).rejects.toThrow("caller cancelled");
    await started.promise;
    controller.abort(new Error("caller cancelled"));
    await rejected;
    expect(cancel).toHaveBeenCalled();
  });
  it("rejects before network when the caller is aborted or deadline expired/missing", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    for (const t of [
      { ...transport(fetchFn), signal: AbortSignal.abort(new Error("cancelled")) },
      { ...transport(fetchFn), deadline: { label: "Sage", deadlineAtMs: Date.now() - 1 } },
      { ...transport(fetchFn), deadline: { label: "Sage" } },
    ]) {
      await expect(executeSageRequest(request, t)).rejects.toThrow();
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
