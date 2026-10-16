import { once } from "node:events";
import { createServer, type Server } from "node:https";
import { TLSSocket, getCACertificates, setDefaultCACertificates } from "node:tls";
// Prepare lazy SDK imports before starting request deadlines.
import "openclaw/plugin-sdk/image-generation";
import "openclaw/plugin-sdk/media-generation-runtime";
import "openclaw/plugin-sdk/provider-http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  acquireTestPortBlock,
  PROXY_FIXTURE_CERTIFICATE,
  PROXY_FIXTURE_KEY,
} from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: async () => ({ apiKey: "endpoint-key", mode: "api-key" }),
}));

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP4sAAAAASUVORK5CYII=",
  "base64",
);
const provider = buildOpenAIImageGenerationProvider({
  ensureAuthProfileStoreAsync: async () => ({ version: 1, profiles: {} }),
  listProfilesForProvider: () => [],
  isProviderApiKeyConfiguredAsync: async () => true,
});
const servers: Server[] = [];
const requests: Array<{ path: string; certificate: boolean; serverName: string | false | null }> =
  [];
const originalCAs = getCACertificates("default");
let providerOrigin: string;
let imageOrigin: string;
let imageUrl: string;
let releasePorts: (() => Promise<void>) | undefined;

beforeAll(async () => {
  for (const name of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    vi.stubEnv(name, "");
  }
  setDefaultCACertificates([...originalCAs, PROXY_FIXTURE_CERTIFICATE]);
  const claim = await acquireTestPortBlock({ offsets: [0, 1] });
  releasePorts = () => claim.release();
  providerOrigin = `https://127.0.0.1:${claim.port}`;
  imageOrigin = `https://127.0.0.1:${claim.port + 1}`;
  for (const port of [claim.port, claim.port + 1]) {
    const server = createServer(
      {
        key: PROXY_FIXTURE_KEY,
        cert: PROXY_FIXTURE_CERTIFICATE,
        requestCert: true,
        rejectUnauthorized: false,
      },
      (request, response) => {
        request.resume();
        const socket = request.socket;
        if (!(socket instanceof TLSSocket)) {
          throw new Error("Expected TLS socket");
        }
        requests.push({
          path: request.url ?? "",
          certificate: Boolean(socket.getPeerCertificate().raw),
          serverName: socket.servername,
        });
        if (request.method === "POST") {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ data: [{ url: imageUrl }] }));
        } else if (request.url === "/redirect") {
          response.writeHead(302, { Location: `${imageOrigin}/image.png` });
          response.end();
        } else {
          response.setHeader("Content-Type", "image/png");
          response.end(png);
        }
      },
    );
    servers.push(server);
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
  }
});

beforeEach(() => {
  requests.length = 0;
});

afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
  await releasePorts?.();
  setDefaultCACertificates(originalCAs);
  vi.unstubAllEnvs();
});

it.each(["same-origin", "cross-origin", "redirect"])(
  "scopes provider TLS identity for %s image downloads",
  async (route) => {
    imageUrl =
      route === "same-origin"
        ? `${providerOrigin}/image.png`
        : route === "redirect"
          ? `${providerOrigin}/redirect`
          : `${imageOrigin}/image.png`;
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          openai: {
            baseUrl: `${providerOrigin}/v1`,
            apiKey: "endpoint-key",
            models: [],
            request: {
              tls: {
                cert: PROXY_FIXTURE_CERTIFICATE,
                key: PROXY_FIXTURE_KEY,
                serverName: "files.proxy.test",
              },
            },
          },
        },
      },
    };
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Synthetic image",
      cfg,
      ssrfPolicy: { allowedOrigins: [providerOrigin, imageOrigin] },
    });
    expect(result.images[0]?.buffer).toEqual(png);
    expect(requests[0]).toEqual({
      path: "/v1/images/generations",
      certificate: true,
      serverName: "files.proxy.test",
    });
    if (route === "redirect") {
      expect(requests[1]).toEqual({
        path: "/redirect",
        certificate: true,
        serverName: "files.proxy.test",
      });
    }
    const imageRequest = requests.at(-1);
    expect(imageRequest).toMatchObject({
      path: "/image.png",
      certificate: route === "same-origin",
    });
    if (route === "same-origin") {
      expect(imageRequest?.serverName).toBe("files.proxy.test");
    } else {
      // Undici omits IP SNI on Node and sends the destination IP on Bun.
      expect([false, new URL(imageOrigin).hostname]).toContain(imageRequest?.serverName);
    }
  },
);
