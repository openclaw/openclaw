import { request as httpRequest } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCopilotByokProxy } from "./byok-proxy.js";
import { resolveCopilotProvider } from "./provider-bridge.js";

const ssrfRuntimeMock = vi.hoisted(() => ({ fetchWithSsrFGuard: vi.fn() }));

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

const azureModel = {
  provider: "custom-azure",
  api: "azure-openai-responses",
  id: "deployment-gpt",
  baseUrl: "https://example.openai.azure.com/openai/v1",
};
const proxies: Array<Awaited<ReturnType<typeof createCopilotByokProxy>>> = [];
async function startProxy(
  overrides: Partial<Parameters<typeof resolveCopilotProvider>[0]["model"]> = {},
  resolvedApiKey?: string,
) {
  const providerConfig = resolveCopilotProvider({
    model: {
      provider: "custom-proxy",
      api: "openai-responses",
      id: "proxy-model",
      baseUrl: "https://proxy.example/v1",
      ...overrides,
    },
    resolvedApiKey,
  });
  const proxy = expectDefined(await createCopilotByokProxy(providerConfig), "BYOK proxy");
  proxies.push(proxy);
  const provider = expectDefined(proxy.provider.provider, "SDK provider");
  return {
    ...proxy,
    baseUrl: expectDefined(provider.baseUrl, "SDK base URL"),
    headers: provider.headers ?? {},
  };
}

function jsonPost(model: string, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model }),
  };
}

function upstreamRequest() {
  return expectDefined(ssrfRuntimeMock.fetchWithSsrFGuard.mock.calls[0]?.[0], "upstream request");
}

function mockResponse(body: BodyInit | null, init?: ResponseInit) {
  const release = vi.fn(async () => undefined);
  ssrfRuntimeMock.fetchWithSsrFGuard.mockResolvedValue({
    response: new Response(body, init),
    release,
  });
  return release;
}

async function expectResponse(response: Response, status: number, body: string) {
  expect(response.status).toBe(status);
  expect(await response.text()).toBe(body);
}

function expectUpstream(url: string, headers: Record<string, unknown>, init = {}) {
  expect(upstreamRequest()).toMatchObject({ requireHttps: true, url, init: { ...init, headers } });
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
    const release = mockResponse("ok", {
      status: 201,
      headers: {
        "content-encoding": "gzip",
        "content-length": "999",
        "x-upstream": "yes",
      },
    });
    const proxy = await startProxy(
      { baseUrl: "https://proxy.example/v1?routing=blue" },
      "secret-key",
    );
    expect(proxy.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{24}\/v1$/);
    const response = await fetch(
      `${proxy.baseUrl}/responses?trace=request`,
      jsonPost("proxy-model", { authorization: "Bearer secret-key" }),
    );
    await expectResponse(response, 201, "ok");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("x-upstream")).toBe("yes");
    expect(upstreamRequest().auditContext).toBe("copilot-byok-provider");
    expectUpstream(
      "https://proxy.example/v1/responses?routing=blue&trace=request",
      {
        "accept-encoding": "identity",
        authorization: "Bearer secret-key",
        "content-type": "application/json",
      },
      { method: "POST", signal: expect.any(AbortSignal) },
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
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      const request = new Request(url, init);
      expect(request.method).toBe("POST");
      received.push(Buffer.from(await request.arrayBuffer()));
      return received.length === 1
        ? new Response(null, { status: 307, headers: { location: "/v1/replayed" } })
        : new Response("ok");
    });
    const proxy = await startProxy();
    // Keep invalid UTF-8 and a nonzero offset: forwarding the backing pool would leak other bytes.
    const body = Buffer.from([42, 0, 255, 128, 192, 10, 42]).subarray(1, -1);
    const response = await clientFetch(`${proxy.baseUrl}/responses`, { method: "POST", body });
    await expectResponse(response, 200, "ok");
    expect(received).toEqual([body, body]);
  });

  it("forwards an empty POST request without a body", async () => {
    mockResponse(null, { status: 204 });
    const proxy = await startProxy();
    const response = await fetch(`${proxy.baseUrl}/responses`, { method: "POST" });
    expect(response.status).toBe(204);
    expect(upstreamRequest().init).toMatchObject({ method: "POST" });
    expect(upstreamRequest().init.body).toBeUndefined();
  });

  it("injects resolved bearer auth when the SDK request omits Authorization", async () => {
    mockResponse("ok");
    const proxy = await startProxy(
      { api: "openai-completions", authHeader: true },
      "tokenplan-secret",
    );
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, jsonPost("proxy-model"));
    expect(response.status).toBe(200);
    expect(upstreamRequest().url).toBe("https://proxy.example/v1/chat/completions");
    expect(upstreamRequest().init.headers).toMatchObject({
      authorization: "Bearer tokenplan-secret",
      "content-type": "application/json",
    });
  });

  it("aborts in-flight upstream fetches when the proxy closes", async () => {
    let upstreamSignal: AbortSignal | undefined;
    ssrfRuntimeMock.fetchWithSsrFGuard.mockImplementation(
      async ({ init }: Parameters<typeof fetchWithSsrFGuard>[0]) => {
        upstreamSignal = init?.signal ?? undefined;
        await new Promise((_, reject) => {
          upstreamSignal?.addEventListener("abort", () => reject(new Error("upstream aborted")), {
            once: true,
          });
        });
        throw new Error("unreachable");
      },
    );
    const proxy = await startProxy();
    const responsePromise = fetch(`${proxy.baseUrl}/responses`, jsonPost("proxy-model")).catch(
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());
    await proxy.close();
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
      const proxy = await startProxy();
      const endpoint = `${proxy.baseUrl}/responses`;
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

  it.each([false, true])(
    "accepts Azure SDK paths without injecting bearer auth (%s)",
    async (authHeader) => {
      mockResponse("azure-ok");
      const configuredHeaders = {
        "X-OpenClaw-Copilot-Byok-Proxy-Token": "configured-value",
        "X-Trace": "test",
      };
      const proxy = await startProxy(
        { ...azureModel, authHeader, headers: configuredHeaders },
        "azure-key",
      );
      expect(proxy.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const [proxyCredentialHeader] = getProxyCredentialHeader(proxy.headers);
      expect(proxy.headers).toMatchObject(configuredHeaders);
      const response = await fetch(
        `${proxy.baseUrl}/openai/v1/responses?trace=request`,
        jsonPost("deployment-gpt", {
          ...proxy.headers,
          ...(authHeader ? {} : { "api-key": "azure-key" }),
        }),
      );
      await expectResponse(response, 200, "azure-ok");
      expectUpstream("https://example.openai.azure.com/openai/v1/responses?trace=request", {
        "accept-encoding": "identity",
        ...(authHeader ? {} : { "api-key": "azure-key" }),
        "x-openclaw-copilot-byok-proxy-token": "configured-value",
        "x-trace": "test",
      });
      expect(upstreamRequest().init.headers).not.toHaveProperty(proxyCredentialHeader);
      expect(upstreamRequest().init.headers).not.toHaveProperty("authorization");
    },
  );

  it("rejects nonce-less Azure SDK paths before reading the request body", async () => {
    mockResponse("unexpected");
    const proxy = await startProxy(azureModel);
    const [proxyCredentialHeader] = getProxyCredentialHeader(proxy.headers);
    const status = await new Promise<number>((resolve, reject) => {
      const client = httpRequest(
        `${proxy.baseUrl}/openai/v1/responses`,
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
      `${proxy.baseUrl}/openai/v1/responses`,
      jsonPost("deployment-gpt", { [proxyCredentialHeader]: "wrong" }),
    );
    expect(wrongCredential.status).toBe(404);
    expect(ssrfRuntimeMock.fetchWithSsrFGuard).not.toHaveBeenCalled();
  });
});
