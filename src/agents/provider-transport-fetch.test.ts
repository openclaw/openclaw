import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { Stream } from "openai/streaming";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, vi } from "vitest";
import { prepareModelRequestBody } from "../../packages/ai/src/transports/model-request-body.js";
import { withinTest } from "../../test/helpers/promise.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { mintSecretSentinel } from "../secrets/sentinel.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  buildGuardedModelFetch,
  buildProviderRequestDispatcherPolicyMock,
  ensureModelProviderLocalServiceMock,
  fetchWithSsrFGuardMock,
  installProviderTransportFetchTestHooks,
  latestGuardedFetchParams,
  managedStreamCleanupRegistrations,
  resolveProviderRequestPolicyConfigMock,
  shouldUseEnvHttpProxyForUrlMock,
} from "./provider-transport-fetch.test-harness.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const model = makeProviderModelFixture<"openai-responses">({
  id: "fixture-model",
  provider: "openrouter",
  api: "openai-responses",
  baseUrl: "https://openrouter.ai/api/v1",
});
const streaming: RequestInit = {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: '{"stream":true}',
};
const localModel = { ...model, provider: "local", baseUrl: "http://127.0.0.1:18000/v1" };

function mockResponse(
  response: Response,
  release = vi.fn(async () => {}),
  refreshTimeout?: () => void,
) {
  fetchWithSsrFGuardMock.mockResolvedValue({
    response,
    finalUrl: `${model.baseUrl}/responses`,
    release,
    refreshTimeout,
  });
  return release;
}

function mockStream(
  chunks: string[],
  contentType?: string,
  options: Parameters<typeof responseStream>[1] = {},
) {
  const source = responseStream(chunks, options);
  const release = mockResponse(
    new Response(source.stream, {
      headers: contentType ? { "content-type": contentType } : undefined,
    }),
  );
  return { ...source, release };
}

function privateNetworkPolicy(allowPrivateNetwork = false, trustConfiguredBaseUrlOrigin = true) {
  resolveProviderRequestPolicyConfigMock.mockReturnValue({
    allowPrivateNetwork,
    trustConfiguredBaseUrlOrigin,
  });
}

function responseStream(
  chunks: string[],
  options: { open?: boolean; cancel?: (reason: unknown) => Promise<void> } = {},
) {
  let close!: () => void;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      close = () => controller.close();
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }
      if (!options.open) {
        controller.close();
      }
    },
    cancel: options.cancel,
  });
  return { stream, close };
}

function request(init: RequestInit = { method: "POST" }, target: Model = model) {
  return buildGuardedModelFetch(target)(`${target.baseUrl}/responses`, init);
}

async function parseSse(response: Response) {
  const items: unknown[] = [];
  for await (const item of Stream.fromSSEResponse(response, new AbortController())) {
    items.push(item);
  }
  return items;
}

describe("buildGuardedModelFetch", () => {
  installProviderTransportFetchTestHooks();

  it("waits for local reconciliation and releases its lease after consuming the body", async () => {
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "1");
    vi.stubEnv("OPENCLAW_DEBUG_PROXY_URL", "http://127.0.0.1:7799");
    const entered = createDeferredCore();
    const lease = createDeferredCore<{ release: () => void }>();
    const release = vi.fn();
    ensureModelProviderLocalServiceMock.mockImplementation(() => {
      entered.resolve();
      return lease.promise;
    });
    try {
      const pending = request({ method: "POST" }, localModel);
      await entered.promise;
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
      lease.resolve({ release });
      const response = await pending;
      await expect(response.text()).resolves.toBe("ok");
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(resolveProviderRequestPolicyConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({ request: { proxy: undefined } }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the completed body and releases its local lease when guard cleanup fails", async () => {
    const releaseLease = vi.fn();
    ensureModelProviderLocalServiceMock.mockResolvedValue({ release: releaseLease });
    const releaseGuard = mockResponse(
      new Response("ok"),
      vi.fn(async () => {
        throw new Error("synthetic guard cleanup failure");
      }),
    );

    await expect((await request({}, localModel)).text()).resolves.toBe("ok");

    expect(releaseGuard).toHaveBeenCalledOnce();
    expect(releaseLease).toHaveBeenCalledOnce();
  });

  it("releases the local lease when guarded fetch fails", async () => {
    const release = vi.fn();
    const error = new Error("network down");
    ensureModelProviderLocalServiceMock.mockResolvedValue({ release });
    fetchWithSsrFGuardMock.mockRejectedValue(error);
    await expect(request({}, localModel)).rejects.toBe(error);
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    ["caps model metadata", undefined, false, MAX_TIMER_TIMEOUT_MS],
    ["combines an explicit timeout with caller abort", 750, true, 750],
  ] as const)("%s for local startup and guarded fetch", async (_, timeout, caller, expected) => {
    const target = { ...localModel, requestTimeoutMs: Number.MAX_SAFE_INTEGER };
    const timeoutController = new AbortController();
    const callerController = new AbortController();
    const combinedController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const anySpy = vi.spyOn(AbortSignal, "any").mockReturnValue(combinedController.signal);
    const signal = caller ? callerController.signal : undefined;
    try {
      const response = await buildGuardedModelFetch(target, timeout)(
        `${target.baseUrl}/responses`,
        {
          method: "POST",
          signal,
        },
      );
      await response.text();
      expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(expected);
      expect(ensureModelProviderLocalServiceMock).toHaveBeenCalledWith(
        target,
        undefined,
        caller ? combinedController.signal : timeoutController.signal,
      );
      expect(latestGuardedFetchParams().timeoutMs).toBe(expected);
      expect(latestGuardedFetchParams().signal).toBe(signal);
      if (caller) {
        expect(anySpy).toHaveBeenCalledExactlyOnceWith([signal, timeoutController.signal]);
      } else {
        expect(anySpy).not.toHaveBeenCalled();
      }
    } finally {
      timeoutSpy.mockRestore();
      anySpy.mockRestore();
    }
  });

  it.each([false, true])(
    "scopes provider DNS trust with an explicit dispatcher=%s",
    async (explicit) => {
      const target = { ...model, provider: "openai", baseUrl: "https://api.openai.com/v1" };
      shouldUseEnvHttpProxyForUrlMock.mockReturnValue(true);
      const dispatcherPolicy = explicit ? { mode: "direct" as const } : undefined;
      buildProviderRequestDispatcherPolicyMock.mockReturnValue(dispatcherPolicy);
      await (await request({}, target)).text();
      const params = latestGuardedFetchParams();
      expect(params.policy).toEqual({
        allowRfc2544BenchmarkRange: true,
        allowIpv6UniqueLocalRange: true,
        hostnameAllowlist: ["api.openai.com"],
      });
      expect(params.dispatcherPolicy).toEqual(dispatcherPolicy);
      expect(params.mode).toBe(explicit ? undefined : "trusted_env_proxy");
    },
  );

  it("does not extend provider DNS exemptions to another hostname", async () => {
    const target = { ...model, provider: "openai", baseUrl: "https://api.openai.com/v1" };
    const response = await buildGuardedModelFetch(target)("https://uploads.openai.com/v1/files", {
      method: "POST",
    });
    await response.text();
    expect(latestGuardedFetchParams().policy).toBeUndefined();
  });

  it.each([
    ["configured origin", true, 1234, { allowedOrigins: ["http://10.0.0.5:1234"] }],
    ["explicit private-network denial", false, 1234, undefined],
    ["different port", true, 4321, undefined],
  ] as const)("limits private trust to %s", async (_, trust, port, expected) => {
    const target = { ...model, baseUrl: "http://10.0.0.5:1234/v1" };
    resolveProviderRequestPolicyConfigMock.mockReturnValue({
      allowPrivateNetwork: false,
      trustConfiguredBaseUrlOrigin: trust,
      policy: { endpointClass: "custom" },
    });
    const response = await buildGuardedModelFetch(target)(`http://10.0.0.5:${port}/v1/responses`);
    await response.text();
    expect(latestGuardedFetchParams().policy).toEqual(expected);
  });

  it.each([
    "169.254.169.254",
    "[fd00:ec2::254]",
    "metadata-server.example",
    "instance-data.ec2.internal",
  ])("does not implicitly trust metadata endpoint %s", async (host) => {
    privateNetworkPolicy();
    await (await request({}, { ...model, baseUrl: `http://${host}/v1` })).text();
    expect(latestGuardedFetchParams().policy).toBeUndefined();
  });

  it("rejects implicit NAT64 trust and explains the operator opt-in", async () => {
    privateNetworkPolicy();
    fetchWithSsrFGuardMock.mockRejectedValue(new SsrFBlockedError("Blocked address"));
    await expect(
      request(
        {},
        {
          ...model,
          provider: "nat64-lab",
          baseUrl: "http://[64:ff9b:1::8.8.8.8]:1234/v1",
        },
      ),
    ).rejects.toThrow(
      "models.providers.nat64-lab.request.allowPrivateNetwork=true only for an operator-controlled endpoint",
    );
    expect(latestGuardedFetchParams().policy).toBeUndefined();
  });

  it("uses only explicit private-network opt-in for NAT64 literals", async () => {
    privateNetworkPolicy(true);
    await (await request({}, { ...model, baseUrl: "http://[64:ff9b:1::8.8.8.8]:1234/v1" })).text();
    expect(latestGuardedFetchParams().policy).toEqual({ allowPrivateNetwork: true });
  });

  it("releases guarded fetch slots when an unsanitized stream is abandoned", async () => {
    const source = responseStream(["chunk-1", "chunk-2"], { open: true });
    const release = mockResponse(new Response(source.stream));
    const response = await buildGuardedModelFetch(model, undefined, { sanitizeSse: false })(
      `${model.baseUrl}/responses`,
      streaming,
    );
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    const registration = managedStreamCleanupRegistrations.at(-1);
    expect(registration).toBeDefined();
    await registration!.held.finalize();
    expect(release).toHaveBeenCalledOnce();
    expect(managedStreamCleanupRegistrations).toHaveLength(0);
  });

  it("synthesizes split JSON without a content type into SDK-readable SSE", async () => {
    mockStream(['{"ok"', ": true}"]);
    const response = await request(streaming);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await expect(parseSse(response)).resolves.toEqual([{ ok: true }]);
  });

  it.each([undefined, "application/json; charset=utf-8"])(
    "recognizes split SSE before EOF with content-type %s",
    async (contentType) => {
      const source = mockStream(["d", "ata", ': {"ok": true}\n\n'], contentType, { open: true });
      let response: Response;
      try {
        // Returning before close proves sniffing does not wait for the open stream's EOF.
        response = await request(streaming);
        expect(response.headers.get("content-type")).toContain("text/event-stream");
      } finally {
        source.close();
      }
      await expect(parseSse(response)).resolves.toEqual([{ ok: true }]);
    },
  );

  it("preserves non-retryable SSE error bodies for provider HTTP error parsing", async () => {
    mockResponse(
      new Response('{"error":{"message":"API key expired"}}', {
        status: 400,
        headers: { "content-type": "text/event-stream", "retry-after": "239" },
      }),
    );
    const response = await request();
    expect(response.status).toBe(400);
    expect(response.headers.get("x-should-retry")).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: { message: "API key expired" } });
  });

  it("accepts a large batch of small SSE events followed by a large split event", async () => {
    const count = 5_000;
    const refreshTimeout = vi.fn();
    const payload = { text: "x".repeat(70 * 1024) };
    mockResponse(
      new Response(
        responseStream([
          'data: {"ok":true}\n\n'.repeat(count),
          `data: ${JSON.stringify(payload)}`,
          "\n\n",
        ]).stream,
        { headers: { "content-type": "text/event-stream" } },
      ),
      vi.fn(async () => {}),
      refreshTimeout,
    );
    const items = await parseSse(await request());
    expect(items).toHaveLength(count + 1);
    expect(items.slice(0, count)).toEqual(Array.from({ length: count }, () => ({ ok: true })));
    expect(items.at(-1)).toEqual(payload);
    expect(refreshTimeout).toHaveBeenCalledTimes(3);
  });

  it.for([
    { contentType: "text/event-stream", error: /exceeded max buffer size/i },
    { contentType: "application/json", error: /exceeded.*bytes while synthesizing SSE/i },
  ])(
    "reports oversized $contentType and releases resources while a clone stays unread",
    async ({ contentType, error }, { signal }) => {
      const upstream = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(17 * 1024 * 1024));
          },
        }),
        { headers: { "content-type": contentType } },
      );
      const unreadClone = upstream.clone();
      const release = mockResponse(upstream);
      const reading = (await request(streaming)).text();
      try {
        await expect(withinTest(reading, signal)).rejects.toThrow(error);
        expect(release).toHaveBeenCalledOnce();
        expect(upstream.body!.locked).toBe(false);
      } finally {
        await unreadClone.body!.cancel();
        await reading.catch(() => undefined);
      }
    },
  );

  it("returns the capped error body before guarded cleanup finishes", async () => {
    const pendingRelease = createDeferredCore();
    const release = mockResponse(
      new Response(new Uint8Array(100 * 1024), { status: 429 }),
      vi.fn(() => pendingRelease.promise),
    );
    try {
      const response = await request();
      expect(response.status).toBe(429);
      expect(response.headers.get("x-should-retry")).toBe("false");
      // Resolving cleanup only afterward detects a response-body/cleanup deadlock.
      expect((await response.text()).length).toBe(64 * 1024);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      pendingRelease.resolve();
    }
  });

  it("lets the SDK cancel a retryable error before consuming its whole body", async () => {
    let bytesPulled = 0;
    const total = 80 * 1024;
    mockResponse(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (bytesPulled < total) {
              const chunk = new Uint8Array(8 * 1024);
              bytesPulled += chunk.byteLength;
              controller.enqueue(chunk);
            } else {
              controller.close();
            }
          },
        }),
        { status: 503 },
      ),
    );
    const response = await request();
    expect(response.status).toBe(503);
    expect(response.headers.get("x-should-retry")).toBeNull();
    await response.body!.cancel();
    expect(bytesPulled).toBeLessThan(total);
  });

  it.each([
    { contentType: "application/json", body: '{"ok":true}' },
    { contentType: "text/event-stream", body: 'data: {"ok":true}\n\n' },
  ])(
    "preserves consumer cancellation through $contentType cleanup failure",
    async ({ contentType, body }) => {
      const cancel = vi.fn(async () => {
        throw new Error("upstream cancellation failed");
      });
      const { release } = mockStream([body], contentType, { open: true, cancel });
      const response = await buildGuardedModelFetch(model, undefined, { onSseComment: vi.fn() })(
        `${model.baseUrl}/responses`,
        streaming,
      );
      await expect(response.body!.cancel("consumer stopped")).resolves.toBeUndefined();
      expect(cancel).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { cap: "10", status: 429, retryAfter: "30", expected: "false" },
    { cap: "10s", status: 429, retryAfter: "30", expected: null },
    { cap: "0", status: 429, retryAfter: "239", expected: null },
  ])(
    "applies SDK retry cap $cap to $status/$retryAfter",
    async ({ cap, status, retryAfter, expected }) => {
      process.env.OPENCLAW_SDK_RETRY_MAX_WAIT_SECONDS = cap;
      mockResponse(new Response(null, { status, headers: { "retry-after": retryAfter } }));
      const response = await request();
      expect(response.status).toBe(status);
      expect(response.headers.get("retry-after")).toBe(retryAfter);
      expect(response.headers.get("x-should-retry")).toBe(expected);
    },
  );
});

describe("buildGuardedModelFetch headers", () => {
  const headerModel = {
    ...model,
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
  };
  const url = `${headerModel.baseUrl}/responses`;
  const egressHeaders = () => new Headers(fetchWithSsrFGuardMock.mock.lastCall?.[0]?.init?.headers);

  installProviderTransportFetchTestHooks();

  it.each(["Request", "custom iterator"] as const)(
    "resolves %s header sentinels only at egress without mutating the caller",
    async (form) => {
      const secret = form === "Request" ? "request-form-secret" : "iterable-header-secret";
      const sentinel = mintSecretSentinel(secret, { label: "header-form" });
      const header = form === "Request" ? "authorization" : "x-api-key";
      const prefix = form === "Request" ? "Bearer " : "";
      const original = form === "Request" ? `${prefix}${sentinel}` : "original-value";
      const headers = new Headers({ [header]: original });
      if (form === "custom iterator") {
        headers[Symbol.iterator] = function* () {
          yield [header, sentinel];
          return undefined;
        };
      }
      const headerRequest =
        form === "Request"
          ? new Request(url, { method: "POST", headers, body: '{"stream":true}' })
          : undefined;
      await (
        await buildGuardedModelFetch(headerModel)(
          headerRequest ?? url,
          headerRequest ? undefined : { headers },
        )
      ).text();
      expect(egressHeaders().get(header)).toBe(`${prefix}${secret}`);
      expect(headers.get(header)).toBe(original);
      if (headerRequest) {
        expect(
          new Headers(ensureModelProviderLocalServiceMock.mock.lastCall?.[1]).get(header),
        ).toBe(original);
        expect(headerRequest.headers.get(header)).toBe(original);
        const init = fetchWithSsrFGuardMock.mock.lastCall?.[0]?.init;
        expect(init.method).toBe("POST");
        await expect(new Response(init.body).text()).resolves.toBe('{"stream":true}');
      }
    },
  );

  it("escapes resolved query credentials without changing URL structure", async () => {
    const sentinel = mintSecretSentinel("gemini&scope=two+#%", { label: "gemini-query" });
    await (await buildGuardedModelFetch(headerModel)(`${url}?key=${sentinel}`)).text();
    expect(latestGuardedFetchParams().url).toBe(`${url}?key=gemini%26scope%3Dtwo%2B%23%25`);
  });

  it("rejects unregistered sentinels before guarded fetch", async () => {
    const unknown = "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end";
    await expect(
      buildGuardedModelFetch(headerModel)(url, {
        headers: { Authorization: `Bearer ${unknown}` },
      }),
    ).rejects.toThrow(
      `Secret sentinel ${unknown} is not registered in this process; refusing to send request`,
    );
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });
});

describe("buildGuardedModelFetch SSE readability", () => {
  const completionModel = { ...model, api: "openai-completions" as const };
  const url = `${completionModel.baseUrl}/chat/completions`;

  installProviderTransportFetchTestHooks();

  it.each(["prepared HTML", "untyped HTML"])(
    "rejects %s instead of returning a successful stream",
    async (mode) => {
      const { release } = mockStream(
        ["<html>not the API</html>"],
        mode === "prepared HTML" ? "text/html" : undefined,
      );
      const body =
        mode === "prepared HTML"
          ? (await prepareModelRequestBody(undefined)({ model: completionModel.id, stream: true }))
              .body
          : '{"stream":true}';
      await expect(
        buildGuardedModelFetch(completionModel)(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      ).rejects.toMatchObject({
        name: "ProviderHttpError",
        status: 200,
        code: "invalid_provider_content_type",
        errorType: "invalid_response",
        message: expect.stringMatching(/baseUrl.*\/v1 path prefix/),
      });
      expect(release).toHaveBeenCalled();
    },
  );

  it.each(["sanitized", "official", "opt-out"])(
    "observes comment lines without event separators on %s streams",
    async (mode) => {
      const chunks = [
        "\uFEFF: keep",
        "alive\r",
        "\n: second\n: third\r",
        'event: ping\n\ndata: {"ok": true}\n\n',
      ];
      mockStream(chunks, "text/event-stream");
      const target =
        mode === "official"
          ? { ...completionModel, provider: "openai", baseUrl: "https://api.openai.com/v1" }
          : completionModel;
      const onSseComment = vi.fn();
      const response = await buildGuardedModelFetch(target, undefined, {
        onSseComment,
        sanitizeSse: mode !== "opt-out",
      })(`${target.baseUrl}/responses`, { method: "POST" });

      if (mode === "sanitized") {
        await expect(response.text()).resolves.toBe('data: {"ok": true}\n\n');
      } else {
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(
          new TextEncoder().encode(chunks.join("")),
        );
      }
      expect(onSseComment).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    {
      name: "mixed chunked framing and multiline data, excluding blank keepalives",
      chunks: [
        "event: ping\ndata\ndata:\ndata: \t\uFEFF\u00A0\n\nData: ignored\n data: ignored\ndatabase: ignored\n\n",
        'data: {"ok"',
        ": true}\n",
        "\n",
        "event: ping\r",
        "\rdata: \u0085\r",
        "\rdata: \u200B\r\r",
        'data:\r\ndata: {\r\ndata: "ok": true}\r\ndata: \t\r',
        "\n\r",
        "\n",
        "event: ping\ndata\ndata: \t\uFEFF\u00A0",
      ],
      expected:
        'data: {"ok": true}\n\ndata: \u0085\r\rdata: \u200B\r\r' +
        'data:\r\ndata: {\r\ndata: "ok": true}\r\ndata: \t\r\n\r\n',
    },
    {
      name: "a readable EOF tail ending with a blank data line",
      chunks: ['data: {"ok": true}\ndata: \t'],
      expected: 'data: {"ok": true}\ndata: \t',
    },
  ])("preserves $name", async ({ chunks, expected }) => {
    mockStream(chunks, "text/event-stream");
    await expect((await buildGuardedModelFetch(completionModel)(url)).text()).resolves.toBe(
      expected,
    );
  });
});
