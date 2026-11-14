import assert from "node:assert/strict";
import {
  validateDecisionBatchV2,
  type DecisionBatchV2,
  type DecisionProviderContextV2,
} from "openclaw/plugin-sdk/decisions";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerLevantoTestProvider } from "./registration.test-support.js";

const { lookup } = vi.hoisted(() => ({ lookup: vi.fn<LookupFn>() }));
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) => {
      const fetchImpl = params.fetchImpl;
      // Keep plain fixture I/O explicit while the real guard prepares DNS and dispatchers.
      return actual.fetchWithSsrFGuard(
        fetchImpl && !vi.isMockFunction(fetchImpl)
          ? { ...params, fetchImpl: (input, init) => fetchImpl(input, init) }
          : params,
      );
    },
  };
});

const batch: DecisionBatchV2 = {
  state: { type: "text", text: "synthetic document" },
  questions: { q: { type: "boolean", instructions: "Urgent?" } },
};
const request = {
  content: "synthetic document",
  question: { id: "q", kind: "yesno", instructions: "Urgent?" },
  reasoning: "off",
};
const answer = {
  id: "q",
  kind: "yesno",
  result: { answer: null, probability: 0.51 },
  meta: { model: "levanto-sage-v1.3", usage: { input_tokens: 5, output_tokens: 1 } },
};
const unavailable = (reason: string) => ({ status: "unavailable", reason });
function pendingBody(status = 200) {
  const started = createDeferred<void>();
  const cancel = vi.fn();
  const response = new Response(
    new ReadableStream({ pull: () => started.resolve(), cancel }, { highWaterMark: 0 }),
    { status },
  );
  return { started: started.promise, cancel, response };
}
function fixture(fetchFn: typeof fetch, overrides: Partial<DecisionProviderContextV2> = {}) {
  vi.stubGlobal("fetch", fetchFn);
  const provider = registerLevantoTestProvider(vi.fn(async () => ({ width: 1, height: 1 })));
  assert(provider?.contractVersion === 2);
  const context: DecisionProviderContextV2 = {
    model: {
      provider: "levanto",
      id: "levanto-sage",
      name: "Sage",
      baseUrl: "https://93.184.216.34/prefix/",
      headers: { authorization: "Bearer synthetic-sage-fixture", "x-client": "test" },
    },
    config: {},
    auth: { mode: "api-key", apiKey: "synthetic-sage-fixture" },
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 500,
    reasoning: "off",
    isAdmissible: () => true,
    ...overrides,
  };
  return { context, evaluate: (input = batch) => provider.evaluate(input, context) };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  lookup.mockReset();
});

describe("Sage through the real guarded provider HTTP helper", () => {
  it.each<DecisionBatchV2>([
    ...[0, 1].map((count): DecisionBatchV2 => ({
      questions: batch.questions,
      state: {
        type: "list",
        items: Array.from({ length: count }, (_, id) => ({ id: String(id), content: "item" })),
      },
    })),
    {
      state: {
        type: "image",
        dataUri:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOZkAAAAASUVORK5CYII=",
      },
      questions: {
        q: {
          type: "choice",
          criteria: Object.fromEntries(Array.from({ length: 21 }, (_, id) => [String(id), null])),
        },
      },
    },
  ])(
    "rejects vendor limits accepted by the shared Decision contract before HTTP %#",
    async (input) => {
      expect(validateDecisionBatchV2(input)).toBe(true);
      const fetchFn = vi.fn<typeof fetch>();
      expect(await fixture(fetchFn).evaluate(input)).toEqual(unavailable("unsupported-input"));
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );
  it("posts once beneath the configured prefix, preserving prepared headers and abstention", async () => {
    lookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(answer));
    // Plain stub exercises dispatcher construction; vi.fn uses the hermetic mock shortcut.
    const { context, evaluate } = fixture((input, init) => fetchFn(input, init));
    expect(await evaluate()).toMatchObject({
      status: "ok",
      result: {
        answers: {
          q: { type: "boolean", answer: null, probabilityTrue: 0.51, metadata: { native: answer } },
        },
      },
    });
    expect(lookup).toHaveBeenCalledWith("93.184.216.34", { all: true });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://93.184.216.34/prefix/decide");
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    assert(typeof init?.body === "string");
    expect(JSON.parse(init.body)).toEqual(request);
    expect(Object.fromEntries(new Headers(init?.headers))).toMatchObject({
      authorization: "Bearer synthetic-sage-fixture",
      "x-client": "test",
      "content-type": "application/json",
    });
    expect(init).toHaveProperty("dispatcher");
    expect(new Headers(omitNullRequestHeaders(context.model.headers)).has("content-type")).toBe(
      false,
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rechecks admission after DNS and preserves the authority error without fetching", async () => {
    const started = createDeferred<void>();
    const resolved = createDeferred<{ address: string; family: number }[]>();
    lookup.mockImplementationOnce(async () => {
      started.resolve();
      return resolved.promise;
    });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(answer));
    const authorityError = new Error("synthetic owner closed during DNS");
    let admitted = true;
    const { context, evaluate } = fixture((input, init) => fetchFn(input, init), {
      isAdmissible: () => {
        if (!admitted) {
          throw authorityError;
        }
        return true;
      },
    });
    context.model.baseUrl = "https://sage.example/prefix";
    const pending = evaluate();
    const rejected = expect(pending).rejects.toBe(authorityError);
    await started.promise;
    admitted = false;
    resolved.resolve([{ address: "93.184.216.34", family: 4 }]);
    await rejected;
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it.each([
    [400, "unsupported-input"],
    [401, "authentication"],
    [429, "rate-limited"],
    [503, "transport"],
  ] as const)("does not retry HTTP %s and redacts reflected auth", async (status, reason) => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ detail: "synthetic-sage-fixture" }, { status }));
    const outcome = await fixture(fetchFn).evaluate();
    expect(outcome).toEqual(unavailable(reason));
    expect(JSON.stringify(outcome)).not.toContain("synthetic-sage-fixture");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects private addresses before fetch unless the prepared route explicitly trusts them", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(Response.json(answer));
    const { context, evaluate } = fixture(fetchFn);
    context.model.baseUrl = "http://127.0.0.1/prefix";
    expect(await evaluate()).toEqual(unavailable("transport"));
    expect(fetchFn).not.toHaveBeenCalled();
    const trustedRoute = {
      baseUrl: context.model.baseUrl,
      models: [],
      request: { allowPrivateNetwork: true },
    };
    expect(
      await fixture(fetchFn, {
        model: context.model,
        config: { models: { providers: { levanto: trustedRoute } } },
      }).evaluate(),
    ).toMatchObject({ status: "ok" });
  });
  it.each([307, 303])("strips body and credentials on a cross-origin %s", async (status) => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status, headers: { location: "https://93.184.216.35/decide" } }),
      )
      .mockResolvedValueOnce(
        status === 307
          ? Response.json({ detail: "missing body" }, { status: 400 })
          : Response.json(answer),
      );
    expect(await fixture(fetchFn).evaluate()).toMatchObject({
      status: status === 307 ? "unavailable" : "ok",
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const redirected = fetchFn.mock.calls[1]![1];
    if (status === 303) {
      expect(redirected?.method).toBe("GET");
    }
    expect(redirected?.body).toBeUndefined();
    expect(new Headers(redirected?.headers).has("authorization")).toBe(false);
  });
  it("releases transport after malformed response", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response("{broken"));
    expect(await fixture(fetchFn).evaluate()).toEqual(unavailable("invalid-response"));
    expect(vi.getTimerCount()).toBe(0);
  });
  it("rejects an oversized actual body and cancels its stream", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
      },
      cancel,
    });
    const response = new Response(stream, { headers: { "content-length": "999999999" } });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response);
    expect(await fixture(fetchFn).evaluate()).toEqual(unavailable("invalid-response"));
    expect(cancel).toHaveBeenCalled();
  });
  it.each([200, 503])("bounds the whole body read for HTTP %s and cleans up", async (status) => {
    const { started, cancel, response } = pendingBody(status);
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response);
    const pending = fixture(fetchFn).evaluate();
    await started;
    await vi.advanceTimersByTimeAsync(501);
    expect(await pending).toEqual(unavailable("transport"));
    expect(cancel).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("honors cancellation during body consumption", async () => {
    const controller = new AbortController();
    const { started, cancel, response } = pendingBody();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(response);
    const pending = fixture(fetchFn, { signal: controller.signal }).evaluate();
    const rejected = expect(pending).rejects.toThrow("caller cancelled");
    await started;
    controller.abort(new Error("caller cancelled"));
    await rejected;
    expect(cancel).toHaveBeenCalled();
  });
  it("stops before network when the caller is aborted or deadline expired", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      fixture(fetchFn, { signal: AbortSignal.abort(new Error("cancelled")) }).evaluate(),
    ).rejects.toThrow("cancelled");
    expect(
      await fixture(fetchFn, { deadlineMonotonicMs: performance.now() - 1 }).evaluate(),
    ).toEqual(unavailable("transport"));
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
import { omitNullRequestHeaders } from "openclaw/plugin-sdk/provider-request-headers";
