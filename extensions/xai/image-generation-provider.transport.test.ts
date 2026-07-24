// xAI image generation transport proof covers configured-request forwarding.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

const resolveApiKeyForProviderMock = vi.hoisted(() =>
  vi.fn(async () => ({
    apiKey: "local-xai-key",
    source: "profile",
    mode: "api-key",
  })),
);

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

async function buildTransportProofProvider() {
  vi.resetModules();
  vi.doUnmock("openclaw/plugin-sdk/provider-http");
  vi.doMock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
    resolveApiKeyForProvider: resolveApiKeyForProviderMock,
  }));
  const { buildXaiImageGenerationProvider } = await import("./image-generation-provider.js");
  return buildXaiImageGenerationProvider();
}

type CapturedRequest = {
  body: string;
  headers: IncomingMessage["headers"];
  method?: string;
  url?: string;
};

const openServers: Server[] = [];

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, payload: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function startXaiImageServer(): Promise<{
  baseUrl: string;
  requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: await readRequestBody(request),
      });
      if (request.method === "POST" && request.url?.startsWith("/images/generations")) {
        writeJson(response, {
          data: [{ b64_json: "dGVzdA==" }],
        });
        return;
      }
      if (request.method === "POST" && request.url?.startsWith("/images/edits")) {
        writeJson(response, {
          data: [{ b64_json: "ZWRpdGVk" }],
        });
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    })().catch((error: unknown) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return { baseUrl, requests };
}

describe("xai image generation provider transport", () => {
  afterEach(async () => {
    for (const server of openServers) {
      server.close();
    }
    openServers.length = 0;
    vi.restoreAllMocks();
  });

  it("blocks default loopback image requests before reaching the server", async () => {
    const { baseUrl, requests } = await startXaiImageServer();
    const provider = await buildTransportProofProvider();

    await expect(
      provider.generateImage({
        provider: "xai",
        model: "grok-imagine-image",
        prompt: "test default deny",
        cfg: {
          models: {
            providers: {
              xai: { baseUrl },
            },
          },
        },
      } as any),
    ).rejects.toThrow();

    expect(requests).toHaveLength(0);
  });

  it("blocks explicit false loopback image requests before reaching the server", async () => {
    const { baseUrl, requests } = await startXaiImageServer();
    const provider = await buildTransportProofProvider();

    await expect(
      provider.generateImage({
        provider: "xai",
        model: "grok-imagine-image",
        prompt: "test explicit deny",
        cfg: {
          models: {
            providers: {
              xai: {
                baseUrl,
                request: { allowPrivateNetwork: false },
              },
            },
          },
        },
      } as any),
    ).rejects.toThrow();

    expect(requests).toHaveLength(0);
  });

  it("reaches local server when request.allowPrivateNetwork is true", async () => {
    const { baseUrl, requests } = await startXaiImageServer();
    const provider = await buildTransportProofProvider();

    await provider.generateImage({
      provider: "xai",
      model: "grok-imagine-image",
      prompt: "test opt-in",
      cfg: {
        models: {
          providers: {
            xai: {
              baseUrl,
              request: { allowPrivateNetwork: true },
            },
          },
        },
      },
    } as any);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toContain("/images/generations");
  });

  it("includes configured headers when request policy is set", async () => {
    const { baseUrl, requests } = await startXaiImageServer();
    const provider = await buildTransportProofProvider();

    await provider.generateImage({
      provider: "xai",
      model: "grok-imagine-image",
      prompt: "test headers",
      cfg: {
        models: {
          providers: {
            xai: {
              baseUrl,
              request: {
                allowPrivateNetwork: true,
                headers: { "X-Custom": "test-value" },
              },
            },
          },
        },
      },
    } as any);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers["x-custom"]).toBe("test-value");
  });
});
