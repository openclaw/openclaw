import { request as httpRequest } from "node:http";
// Copilot BYOK proxy tests verify SDK-local transport is guarded outbound fetch.
import { expectDefined } from "@openclaw/normalization-core";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCopilotByokProxy } from "./byok-proxy.js";
import { resolveCopilotProvider } from "./provider-bridge.js";

const ssrfRuntimeMock = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: ssrfRuntimeMock.fetchWithSsrFGuard,
}));

function getProxyCredentialHeader(headers: Record<string, string>): [string, string] {
  return expectDefined(
    Object.entries(headers).find(
      ([name, value]) =>
        /^x-openclaw-copilot-byok-[a-f0-9]{24}$/.test(name) && /^[a-f0-9]{24}$/.test(value),
    ),
    "proxy credential header",
  );
}

function createProvider(
  overrides: Partial<Parameters<typeof resolveCopilotProvider>[0]["model"]> = {},
  resolvedApiKey?: string,
) {
  return resolveCopilotProvider({
    model: {
      provider: "custom-proxy",
      api: "openai-responses",
      id: "proxy-model",
      baseUrl: "https://proxy.example/v1",
      ...overrides,
    },
    resolvedApiKey,
  });
}

const proxies: Array<Awaited<ReturnType<typeof createCopilotByokProxy>>> = [];
async function startProxy(provider: Parameters<typeof createCopilotByokProxy>[0]) {
  const proxy = await createCopilotByokProxy(provider);
  proxies.push(proxy);
  return proxy;
}

function expectFetch(
  request: Record<string, unknown>,
  init: Record<string, unknown>,
  headers?: Record<string, string>,
) {
  expect(ssrfRuntimeMock.fetchWithSsrFGuard).toHaveBeenCalledWith(
    expect.objectContaining({
      ...request,
      init: expect.objectContaining({
        ...init,
        ...(headers ? { headers: expect.objectContaining(headers) } : {}),
      }),
    }),
  );
}

function mockResponse(body: BodyInit | null, init?: ResponseInit) {
  ssrfRuntimeMock.fetchWithSsrFGuard.mockResolvedValue({
    response: new Response(body, init),
    release: vi.fn(async () => undefined),
  });
}

describe("createCopilotByokProxy", () => {
  afterEach(async () => {
    for (const proxy of proxies.splice(0)) {
      await proxy?.close();
    }
    ssrfRuntimeMock.fetchWithSsrFGuard.mockReset();
    vi.restoreAllMocks();
  });

  it("presents a loopback SDK endpoint and forwards through guarded fetch", async () => {
    const release = vi.fn(async () => undefined);
    ssrfRuntimeMock.fetchWithSsrFGuard.mockResolvedValue({
      response: new Response("ok", {
        status: 201,
        headers: {
          "content-encoding": "gzip",
          "content-length": "999",
          "x-upstream": "yes",
        },
      }),
      release,
    });
    const resolvedProvider = createProvider(
      {
        baseUrl: "https://proxy.example/v1?routing=blue",
      },
      "secret-key",
    );

    const proxy = await startProxy(resolvedProvider);
    expect(proxy?.provider.provider?.baseUrl).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{24}\/v1$/,
    );

    const response = await fetch(`${proxy?.provider.provider?.baseUrl}/responses?trace=request`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "proxy-model" }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("x-upstream")).toBe("yes");
    expect(await response.text()).toBe("ok");
    expectFetch(
      {
        auditContext: "copilot-byok-provider",
        requireHttps: true,
        url: "https://proxy.example/v1/responses?routing=blue&trace=request",
      },
      { method: "POST", signal: expect.any(AbortSignal) },
      {
        "accept-encoding": "identity",
        authorization: "Bearer secret-key",
        "content-type": "application/json",
      },
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("preserves binary request bytes across a redirect", async () => {
    const { fetchWithSsrFGuard } = await vi.importActual<
      typeof import("openclaw/plugin-sdk/ssrf-runtime")
    >("openclaw/plugin-sdk/ssrf-runtime");
    ssrfRuntimeMock.fetchWithSsrFGuard.mockImplementation(fetchWithSsrFGuard);
    const clientFetch = globalThis.fetch;
    const received: Buffer[] = [];
    const upstreamFetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const request = new Request(url, init);
      expect(request.method).toBe("POST");
      received.push(Buffer.from(await request.arrayBuffer()));
      return received.length === 1
        ? new Response(null, { status: 307, headers: { location: "/v1/replayed" } })
        : new Response("ok");
    });
    const proxy = await startProxy(createProvider());
    // Keep invalid UTF-8 and a nonzero offset: forwarding the backing pool would leak other bytes.
    const body = Buffer.from([42, 0, 255, 128, 192, 10, 42]).subarray(1, -1);

    const response = await clientFetch(`${proxy?.provider.provider?.baseUrl}/responses`, {
      method: "POST",
      body,
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
    expect(received).toEqual([body, body]);
  });

  it("forwards an empty POST request without a body", async () => {
    const method = "POST";
    mockResponse(null, { status: 204 });
    const proxy = await startProxy(createProvider());

    const response = await fetch(`${proxy?.provider.provider?.baseUrl}/responses`, { method });
    expect(response.status).toBe(204);
    expectFetch({}, { method });
    expect(ssrfRuntimeMock.fetchWithSsrFGuard.mock.calls[0]?.[0].init.body).toBeUndefined();
  });

  it("injects resolved bearer auth when the SDK request omits Authorization", async () => {
    mockResponse("ok", { status: 200 });
    const resolvedProvider = createProvider(
      {
        provider: "tencent-tokenplan",
        api: "openai-completions",
        id: "hy3",
        baseUrl: "https://tokenplan.example/v1",
        authHeader: true,
      },
      "tokenplan-secret",
    );

    const proxy = await startProxy(resolvedProvider);

    const response = await fetch(`${proxy?.provider.provider?.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "hy3" }),
    });

    expect(response.status).toBe(200);
    expectFetch(
      { url: "https://tokenplan.example/v1/chat/completions" },
      {},
      {
        authorization: "Bearer tokenplan-secret",
        "content-type": "application/json",
      },
    );
  });

  it("aborts in-flight upstream fetches when the proxy closes", async () => {
    let upstreamSignal: AbortSignal | undefined;
    ssrfRuntimeMock.fetchWithSsrFGuard.mockImplementation(async ({ init }: any) => {
      upstreamSignal = init.signal;
      await new Promise((_, reject) => {
        upstreamSignal?.addEventListener("abort", () => reject(new Error("upstream aborted")), {
          once: true,
        });
      });
      throw new Error("unreachable");
    });
    const resolvedProvider = createProvider();
    const proxy = await startProxy(resolvedProvider);

    const responsePromise = fetch(`${proxy?.provider.provider?.baseUrl}/responses`, {
      method: "POST",
      body: JSON.stringify({ model: "proxy-model" }),
    }).catch((error: unknown) => error);

    await vi.waitFor(() => {
      expect(upstreamSignal).toBeDefined();
    });

    await proxy?.close();

    expect(upstreamSignal?.aborted).toBe(true);
    await responsePromise;
  });

  it.each(["upstream error", "client disconnect", "proxy shutdown"] as const)(
    "releases an active response stream after %s",
    async (interruption) => {
      let source: ReadableStreamDefaultController<Uint8Array> | undefined;
      const cancel = vi.fn();
      const release = vi.fn(async () => undefined);
      let upstreamSignal: AbortSignal | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          source = controller;
          controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        },
        cancel,
      });
      ssrfRuntimeMock.fetchWithSsrFGuard
        .mockImplementationOnce(async ({ init }: Parameters<typeof fetchWithSsrFGuard>[0]) => {
          upstreamSignal = init?.signal ?? undefined;
          return { response: new Response(body), release };
        })
        .mockResolvedValueOnce({
          response: new Response("healthy"),
          release: vi.fn(async () => undefined),
        });
      const proxy = expectDefined(await startProxy(createProvider()), "BYOK proxy");
      const endpoint = `${proxy.provider.provider?.baseUrl}/responses`;
      const disconnect = new AbortController();
      try {
        const response = await fetch(endpoint, { signal: disconnect.signal });
        const reader = expectDefined(response.body, "proxy response body").getReader();
        expect((await reader.read()).done).toBe(false);
        const interrupted = reader.read().then(
          () => false,
          () => true,
        );
        if (interruption === "upstream error") {
          expectDefined(source, "upstream response controller").error(
            new Error("upstream stream interrupted"),
          );
        } else if (interruption === "client disconnect") {
          disconnect.abort();
        } else {
          await proxy.close();
        }
        await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
        expect(await interrupted).toBe(true);
        expect(upstreamSignal?.aborted).toBe(true);
        if (interruption !== "upstream error") {
          expect(cancel).toHaveBeenCalledTimes(1);
        }
        if (interruption !== "proxy shutdown") {
          expect(await (await fetch(endpoint)).text()).toBe("healthy");
        }
        reader.releaseLock();
      } finally {
        disconnect.abort();
        await proxy.close();
      }
    },
  );

  it("accepts Azure SDK paths that are rebuilt from the proxy origin", async () => {
    mockResponse("azure-ok", { status: 200 });
    const resolvedProvider = createProvider(
      {
        provider: "custom-azure",
        api: "azure-openai-responses",
        id: "deployment-gpt",
        baseUrl: "https://example.openai.azure.com/openai/v1",
        headers: {
          "X-OpenClaw-Copilot-Byok-Proxy-Token": "configured-value",
          "X-Trace": "test",
        },
      },
      "azure-key",
    );

    const proxy = await startProxy(resolvedProvider);
    expect(proxy?.provider.provider?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const sdkHeaders = expectDefined(proxy?.provider.provider?.headers, "Azure SDK headers");
    const [proxyCredentialHeader] = getProxyCredentialHeader(sdkHeaders);
    expect(sdkHeaders).toMatchObject({
      "X-OpenClaw-Copilot-Byok-Proxy-Token": "configured-value",
      "X-Trace": "test",
    });

    const response = await fetch(
      `${proxy?.provider.provider?.baseUrl}/openai/v1/responses?trace=request`,
      {
        method: "POST",
        headers: { ...sdkHeaders, "api-key": "azure-key" },
        body: JSON.stringify({ model: "deployment-gpt" }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("azure-ok");
    expectFetch(
      {
        requireHttps: true,
        url: "https://example.openai.azure.com/openai/v1/responses?trace=request",
      },
      {},
      {
        "accept-encoding": "identity",
        "api-key": "azure-key",
        "x-openclaw-copilot-byok-proxy-token": "configured-value",
        "x-trace": "test",
      },
    );
    const call = ssrfRuntimeMock.fetchWithSsrFGuard.mock.calls[0]?.[0] as
      | { init?: { headers?: Record<string, string> } }
      | undefined;
    expect(call?.init?.headers).not.toHaveProperty(proxyCredentialHeader);
  });

  it("rejects nonce-less Azure SDK paths before reading the request body", async () => {
    mockResponse("unexpected", { status: 200 });
    const proxy = await startProxy(
      createProvider({
        provider: "custom-azure",
        api: "azure-openai-responses",
        id: "deployment-gpt",
        baseUrl: "https://example.openai.azure.com/openai/v1",
      }),
    );
    const sdkHeaders = expectDefined(proxy?.provider.provider?.headers, "Azure SDK headers");
    const [proxyCredentialHeader] = getProxyCredentialHeader(sdkHeaders);

    const status = await new Promise<number>((resolve, reject) => {
      const client = httpRequest(
        `${proxy?.provider.provider?.baseUrl}/openai/v1/responses`,
        { method: "POST", headers: { "content-length": "1048576" } },
        (response) => {
          clearTimeout(timeout);
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      const timeout = setTimeout(() => {
        client.destroy();
        reject(new Error("proxy waited for the unauthenticated request body"));
      }, 1_000);
      client.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      client.flushHeaders();
    });

    expect(status).toBe(404);
    const wrongCredential = await fetch(
      `${proxy?.provider.provider?.baseUrl}/openai/v1/responses`,
      {
        method: "POST",
        headers: { [proxyCredentialHeader]: "wrong" },
        body: JSON.stringify({ model: "deployment-gpt" }),
      },
    );
    expect(wrongCredential.status).toBe(404);
    expect(ssrfRuntimeMock.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });

  it("does not inject bearer auth on nonce-less Azure SDK paths", async () => {
    mockResponse("azure-ok", { status: 200 });
    const resolvedProvider = createProvider(
      {
        provider: "custom-azure",
        api: "azure-openai-responses",
        id: "deployment-gpt",
        baseUrl: "https://example.openai.azure.com/openai/v1",
        authHeader: true,
      },
      "azure-bearer",
    );

    const proxy = await startProxy(resolvedProvider);
    const sdkHeaders = expectDefined(proxy?.provider.provider?.headers, "Azure SDK headers");

    const response = await fetch(`${proxy?.provider.provider?.baseUrl}/openai/v1/responses`, {
      method: "POST",
      headers: sdkHeaders,
      body: JSON.stringify({ model: "deployment-gpt" }),
    });

    expect(response.status).toBe(200);
    const call = ssrfRuntimeMock.fetchWithSsrFGuard.mock.calls[0]?.[0] as
      | { init?: { headers?: Record<string, string> } }
      | undefined;
    expect(call?.init?.headers).not.toHaveProperty("authorization");
  });
});
