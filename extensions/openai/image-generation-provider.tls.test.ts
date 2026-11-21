import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:https";
import { TLSSocket, getCACertificates, setDefaultCACertificates } from "node:tls";
// Prepare lazy SDK imports before starting request deadlines.
import "openclaw/plugin-sdk/image-generation";
import "openclaw/plugin-sdk/media-generation-runtime";
import "openclaw/plugin-sdk/provider-http";
import {
  acquireTestPortBlock,
  PROXY_FIXTURE_CERTIFICATE as cert,
  PROXY_FIXTURE_KEY as key,
} from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import { openAIImageConfig } from "./image-generation-provider.test-support.js";

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  resolveApiKeyForProvider: async () => ({ apiKey: "endpoint-key", mode: "api-key" }),
}));

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP4sAAAAASUVORK5CYII=",
  "base64",
);
const tls = { cert, key, serverName: "files.proxy.test" };
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
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    vi.stubEnv(name, "");
    vi.stubEnv(name.toLowerCase(), "");
  }
  setDefaultCACertificates([...originalCAs, cert]);
  const claim = await acquireTestPortBlock({ offsets: [0, 1] });
  releasePorts = () => claim.release();
  providerOrigin = `https://127.0.0.1:${claim.port}`;
  imageOrigin = `https://127.0.0.1:${claim.port + 1}`;
  for (const port of [claim.port, claim.port + 1]) {
    const server = createServer(
      { key, cert, requestCert: true, rejectUnauthorized: false },
      (request, response) => {
        request.resume();
        const socket = request.socket;
        assert(socket instanceof TLSSocket, "Expected TLS socket");
        requests.push({
          path: request.url ?? "",
          certificate: Boolean(socket.getPeerCertificate().raw),
          serverName: socket.servername,
        });
        if (request.method === "POST") {
          response
            .writeHead(200, { "Content-Type": "application/json" })
            .end(JSON.stringify({ data: [{ url: imageUrl }] }));
        } else if (request.url === "/redirect") {
          response.writeHead(302, { Location: `${imageOrigin}/image.png` }).end();
        } else {
          response.writeHead(200, { "Content-Type": "image/png" }).end(png);
        }
      },
    );
    servers.push(server);
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
  }
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

it.each(["same-origin", "cross-origin", "redirect"])("%s TLS identity", async (route) => {
  requests.length = 0;
  imageUrl = new URL(
    route === "redirect" ? "/redirect" : "/image.png",
    route === "cross-origin" ? imageOrigin : providerOrigin,
  ).href;
  const result = await provider.generateImage({
    provider: "openai",
    model: "gpt-image-2",
    prompt: "Synthetic image",
    cfg: openAIImageConfig({
      baseUrl: `${providerOrigin}/v1`,
      apiKey: "endpoint-key",
      request: { tls },
    }),
    ssrfPolicy: { allowedOrigins: [providerOrigin, imageOrigin] },
  });
  expect(result.images[0]?.buffer).toEqual(png);
  const providerPaths = ["/v1/images/generations", ...(route === "redirect" ? ["/redirect"] : [])];
  expect(requests.slice(0, providerPaths.length)).toEqual(
    providerPaths.map((path) => ({ path, certificate: true, serverName: tls.serverName })),
  );
  const imageRequest = requests.at(-1);
  expect(imageRequest).toMatchObject({
    path: "/image.png",
    certificate: route === "same-origin",
  });
  // Undici omits IP SNI on Node and sends the destination IP on Bun.
  const serverNames =
    route === "same-origin" ? [tls.serverName] : [false, new URL(imageOrigin).hostname];
  expect(serverNames).toContain(imageRequest?.serverName);
});
