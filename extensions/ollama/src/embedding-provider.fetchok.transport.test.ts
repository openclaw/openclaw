// Real-transport regression proof for Ollama embedding error redaction.
// Drives the production embedding path through the real SSRF guard and loopback
// sockets, without mocking global fetch, SSRF runtime, or logging redaction.
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { buffer as consumeBuffer } from "node:stream/consumers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { createOllamaEmbeddingProvider } from "./embedding-provider.js";

type OllamaRequest = {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  proxyAuthorization: string | undefined;
  proxyAuth: string | undefined;
  body: string;
};

type OllamaServer = {
  baseUrl: string;
  requests: OllamaRequest[];
};

const servers: Array<{ close: () => Promise<void> }> = [];

function mixPercentEscapeCase(value: string): string {
  return value.replace(/%[0-9A-F]{2}/gu, (escape, offset: number) =>
    offset % 2 === 0 ? escape.toLowerCase() : escape,
  );
}

async function startOllamaServer(
  respond: (request: OllamaRequest) => { status: number; body: string },
): Promise<OllamaServer> {
  const requests: OllamaRequest[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const bodyBuffer = await consumeBuffer(req);
      const request: OllamaRequest = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        proxyAuthorization: req.headers["proxy-authorization"],
        proxyAuth:
          typeof req.headers["x-proxy-auth"] === "string" ? req.headers["x-proxy-auth"] : undefined,
        body: bodyBuffer.toString("utf8"),
      };
      requests.push(request);
      const response = respond(request);
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(response.body);
    })();
  });

  const port = await listenOnLoopback(server);

  servers.push({
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  });

  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

type EmbeddingOptions = Parameters<typeof createOllamaEmbeddingProvider>[0];
function createOptions(baseUrl: string, remote: EmbeddingOptions["remote"] = {}): EmbeddingOptions {
  return {
    config: {},
    provider: "ollama",
    model: "test-embedding",
    fallback: "none",
    remote: { baseUrl, ...remote },
  };
}

async function captureEmbeddingError(options: EmbeddingOptions): Promise<Error | undefined> {
  const { provider } = await createOllamaEmbeddingProvider(options);
  try {
    await provider.embed("hello", { inputType: "query" });
  } catch (error) {
    return error as Error;
  }
  return undefined;
}

function expectRequest(server: OllamaServer, headers: Partial<OllamaRequest>) {
  expect(server.requests).toEqual([
    {
      method: "POST",
      url: "/api/embed",
      authorization: undefined,
      proxyAuthorization: undefined,
      proxyAuth: undefined,
      body: JSON.stringify({ model: "test-embedding", input: "hello" }),
      ...headers,
    },
  ]);
}

describe("Ollama embedding provider real transport", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    const pending = servers.splice(0);
    await Promise.all(pending.map((server) => server.close()));
  });

  it("redacts bare authorization credentials reflected under unknown fields", async () => {
    const authorizationCredential = "v9M2q7L4n8R6t1W5c3K0";
    const proxyAuthorizationCredential = "p4Z8m1D7s5J2x9Q6h3V0";
    const server = await startOllamaServer((request) => ({
      status: 429,
      body: JSON.stringify({
        error: "rate limit exceeded",
        upstreamEcho: request.authorization?.replace(/^\S+\s+/u, ""),
        proxyUpstreamEcho: request.proxyAuthorization?.replace(/^\S+\s+/u, ""),
      }),
    }));

    const error = await captureEmbeddingError(
      createOptions(server.baseUrl, {
        headers: {
          Authorization: `Bearer ${authorizationCredential}`,
          "Proxy-Authorization": `Basic ${proxyAuthorizationCredential}`,
        },
      }),
    );
    expectRequest(server, {
      authorization: `Bearer ${authorizationCredential}`,
      proxyAuthorization: `Basic ${proxyAuthorizationCredential}`,
    });
    expect(error?.message).toContain("Ollama embed HTTP 429");
    expect(error?.message).toContain("rate limit exceeded");
    expect(error?.message).not.toContain(authorizationCredential);
    expect(error?.message).not.toContain(proxyAuthorizationCredential);
  });

  it("redacts a form-serialized custom SecretRef header from embed errors", async () => {
    const proxyAuth = "proxy AAAAUNIQUEOLLAMA~PROXYSECRET XXXX11112222";
    const formEncodedProxyAuth = new URLSearchParams([["value", proxyAuth]])
      .toString()
      .slice("value=".length);
    const reflectedFormEncodedProxyAuth = mixPercentEscapeCase(formEncodedProxyAuth);
    vi.stubEnv("OLLAMA_PROXY_AUTH", proxyAuth);
    const server = await startOllamaServer((request) => ({
      status: 403,
      body: JSON.stringify({
        error: "forbidden",
        upstreamEcho: request.proxyAuth
          ? mixPercentEscapeCase(
              new URLSearchParams([["value", request.proxyAuth]]).toString().slice("value=".length),
            )
          : undefined,
      }),
    }));

    const ollama = {
      baseUrl: server.baseUrl,
      models: [],
      headers: {
        "X-Proxy-Auth": { source: "env" as const, provider: "default", id: "OLLAMA_PROXY_AUTH" },
      },
    };
    const error = await captureEmbeddingError({
      ...createOptions(server.baseUrl),
      remote: undefined,
      config: { models: { providers: { ollama } } },
    });

    expectRequest(server, { proxyAuth });
    expect(error?.message).toContain("Ollama embed HTTP 403");
    expect(error?.message).toContain("forbidden");
    expect(error?.message).not.toContain(proxyAuth);
    expect(error?.message).not.toContain(formEncodedProxyAuth);
    expect(error?.message).not.toContain(reflectedFormEncodedProxyAuth);
    expect(error?.message).not.toContain("UNIQUEOLLAMAPROXYSECRET");
  });

  it("redacts a configured header prefix split by the 8 KiB error cap", async () => {
    const proxyAuth = "embedding-boundary-credential-secret";
    const retainedPrefix = proxyAuth.slice(0, -5);
    const safeMarker = "bounded embedding diagnostic: ";
    const body = `${safeMarker}${"x".repeat(8 * 1024 - safeMarker.length - retainedPrefix.length)}${proxyAuth} trailing text`;
    const server = await startOllamaServer(() => ({ status: 429, body }));

    const error = await captureEmbeddingError(
      createOptions(server.baseUrl, {
        headers: { "X-Proxy-Auth": proxyAuth },
      }),
    );

    expect(error?.message).toContain(safeMarker);
    expect(error?.message).not.toContain(retainedPrefix);
    expect(error?.message).not.toContain(proxyAuth);
  });

  it("returns normalized vectors on a successful response", async () => {
    const apiKey = "ollama_test_success_credential";
    const proxyAuth = "ollama_test_success_proxy_credential";
    const server = await startOllamaServer(() => ({
      status: 200,
      body: JSON.stringify({ embeddings: [[3, 4]] }),
    }));
    const options = createOptions(server.baseUrl, {
      apiKey,
      headers: { "X-Proxy-Auth": proxyAuth },
    });
    const { provider } = await createOllamaEmbeddingProvider(options);

    const vector = await provider.embed("hello", { inputType: "query" });

    expectRequest(server, { authorization: `Bearer ${apiKey}`, proxyAuth });
    expect(vector[0]).toBeCloseTo(0.6, 5);
    expect(vector[1]).toBeCloseTo(0.8, 5);
  });
});
