import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { inspect } from "node:util";
import { DEFAULT_CONNECTION_CONFIG } from "baileys/lib/Defaults/index.js";
import { getWAUploadToServer } from "baileys/lib/Utils/messages-media.js";
import {
  acquireTestPortBlock,
  PROXY_FIXTURE_CERTIFICATE,
  PROXY_FIXTURE_KEY,
  useAutoCleanupTempDirTracker,
} from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockBaileys } from "../../../test/mocks/baileys.js";
import * as baileys from "./session.runtime.js";

vi.mock("./session.runtime.js", () => createMockBaileys().mod);

// Public test-only proxy identity, distinct from the trusted upload origin.
const proxyCertificate = `-----BEGIN CERTIFICATE-----
MIIBjzCCATagAwIBAgIUKxluVZ59XWOYKMJjWHTyIb5BuWUwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJMTI3LjAuMC4xMCAXDTI2MDkyNzE4NDgzOFoYDzIxMjYwOTAz
MTg0ODM4WjAUMRIwEAYDVQQDDAkxMjcuMC4wLjEwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAR3Gq4w66O4uoei8K86L+rKXx1+qiGnJpXo7VbUJEtrv25TRC/HDefe
6k0RuxRFpw/newYpnqvF9CsFOvmqvABQo2QwYjAdBgNVHQ4EFgQUsg1k4SrypK4D
gDeHBSLmmJygEnowHwYDVR0jBBgwFoAUsg1k4SrypK4DgDeHBSLmmJygEnowDwYD
VR0TAQH/BAUwAwEB/zAPBgNVHREECDAGhwR/AAABMAoGCCqGSM49BAMCA0cAMEQC
IEy2BTSiIVTojtVYf3orClZyIO76muqzwEU+9XFtoyiGAiAetVyPuNkcVLpu/4LV
ecBva5X3bQd+EErWLdOmkH2xaQ==
-----END CERTIFICATE-----`;
const privateKeyLabel = "PRIVATE KEY";
const proxyKey = `-----BEGIN ${privateKeyLabel}-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgzk20LvFo1771C4dQ
g3jJFhhV9i6pH+3gQ6cRDnXzQuqhRANCAAR3Gq4w66O4uoei8K86L+rKXx1+qiGn
JpXo7VbUJEtrv25TRC/HDefe6k0RuxRFpw/newYpnqvF9CsFOvmqvABQ
-----END ${privateKeyLabel}-----`;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const suiteTempDirs = useAutoCleanupTempDirTracker(afterAll);
const mediaBytes = Buffer.from("WhatsApp upload boundary fixture\n");
const receipt = {
  url: "https://media.example.test/uploaded",
  direct_path: "/uploaded/fixture",
};
const proxyEnvKeys = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "all_proxy",
  "ALL_PROXY",
  "no_proxy",
  "NO_PROXY",
  "OPENCLAW_PROXY_ACTIVE",
  "OPENCLAW_PROXY_CA_FILE",
];

type SocketOptions = Parameters<typeof baileys.makeWASocket>[0];
type PortClaim = Awaited<ReturnType<typeof acquireTestPortBlock>>;

describe("WhatsApp session media upload", () => {
  const listeners: Array<{ server: net.Server; claim: PortClaim }> = [];
  const sockets = new Set<Duplex>();
  const received: Array<{ host: string | undefined; body: Buffer }> = [];
  const proxyRequests: string[] = [];
  const agents = new Set<NonNullable<SocketOptions["agent"]>>();
  let createWaSocket: typeof import("./session.js").createWaSocket;
  let originalCas: string[];
  let originPort: number;
  let httpProxyUrl: string;
  let httpsProxyUrl: string;
  let proxyCaFile: string;
  let wrongProxyCaFile: string;

  function trackSocket(socket: Duplex) {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  }

  async function listen(server: net.Server) {
    const claim = await acquireTestPortBlock({ offsets: [0] });
    listeners.push({ server, claim });
    server.on("connection", trackSocket);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(claim.port, "127.0.0.1", resolve);
    });
    return claim.port;
  }

  function connectProxy(request: http.IncomingMessage, client: Duplex, head: Buffer) {
    const authority = request.url ?? "";
    if (authority !== `127.0.0.1:${originPort}` && authority !== `files.proxy.test:${originPort}`) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    proxyRequests.push(authority);
    const upstream = trackSocket(net.connect(originPort, "127.0.0.1"));
    trackSocket(client);
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
  }

  beforeAll(async () => {
    ({ createWaSocket } = await import("./session.js"));
    originalCas = tls.getCACertificates("default");
    tls.setDefaultCACertificates([...originalCas, PROXY_FIXTURE_CERTIFICATE]);
    const fixtureDir = suiteTempDirs.make("openclaw-whatsapp-upload-ca-");
    proxyCaFile = path.join(fixtureDir, "proxy-ca.pem");
    wrongProxyCaFile = path.join(fixtureDir, "wrong-ca.pem");
    await fs.writeFile(proxyCaFile, proxyCertificate);
    await fs.writeFile(wrongProxyCaFile, PROXY_FIXTURE_CERTIFICATE);

    originPort = await listen(
      https.createServer(
        { key: PROXY_FIXTURE_KEY, cert: PROXY_FIXTURE_CERTIFICATE },
        (request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            received.push({ host: request.headers.host, body: Buffer.concat(chunks) });
            response.writeHead(200, { "content-type": "application/json", connection: "close" });
            response.end(JSON.stringify(receipt));
          });
        },
      ),
    );
    const proxyPort = await listen(http.createServer().on("connect", connectProxy));
    httpProxyUrl = `http://127.0.0.1:${proxyPort}`;
    const secureProxyPort = await listen(
      https.createServer({ key: proxyKey, cert: proxyCertificate }).on("connect", connectProxy),
    );
    httpsProxyUrl = `https://127.0.0.1:${secureProxyPort}`;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    received.length = 0;
    proxyRequests.length = 0;
    for (const key of proxyEnvKeys) {
      vi.stubEnv(key, undefined);
    }
  });

  afterEach(() => {
    for (const agent of agents) {
      agent.destroy();
    }
    agents.clear();
    for (const socket of sockets) {
      socket.destroy();
    }
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    tls.setDefaultCACertificates(originalCas);
    await Promise.all(
      listeners.map(async ({ server, claim }) => {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        await claim.release();
      }),
    );
  });

  async function createUploadSession() {
    const authDir = tempDirs.make("openclaw-whatsapp-upload-auth-");
    await createWaSocket(false, false, { authDir });
    const options = vi.mocked(baileys.makeWASocket).mock.calls.at(-1)?.[0];
    if (!options) {
      throw new Error("WhatsApp session did not create its Baileys socket");
    }
    if (options.agent) {
      agents.add(options.agent);
    }
    if (options.fetchAgent) {
      agents.add(options.fetchAgent);
    }
    const filePath = path.join(authDir, "media.enc");
    await fs.writeFile(filePath, mediaBytes);
    return { options, filePath };
  }

  async function upload(session: Awaited<ReturnType<typeof createUploadSession>>, host: string) {
    const warnings: unknown[][] = [];
    const uploadMedia = getWAUploadToServer(
      {
        ...DEFAULT_CONNECTION_CONFIG,
        ...session.options,
        logger: {
          ...DEFAULT_CONNECTION_CONFIG.logger,
          warn: (...args: unknown[]) => warnings.push(args),
        },
      },
      async () => ({
        auth: "fixture-auth",
        ttl: 60,
        fetchDate: new Date(0),
        hosts: [{ hostname: `${host}:${originPort}`, maxContentLengthBytes: 1024 }],
      }),
    );
    try {
      const result = await uploadMedia(session.filePath, {
        mediaType: "image",
        fileEncSha256B64: "fixture-sha256",
      });
      expect(result).toMatchObject({ mediaUrl: receipt.url, directPath: receipt.direct_path });
    } catch (cause) {
      throw new Error(`Baileys upload diagnostics: ${inspect(warnings)}`, { cause });
    }
  }

  it.each([
    { name: "without a proxy", proxy: "none" },
    { name: "through the lowercase proxy in preference to uppercase", proxy: "http" },
    { name: "through a managed HTTPS proxy", proxy: "https" },
  ])("uploads the complete media and receives its receipt $name", async ({ proxy }) => {
    if (proxy === "http") {
      vi.stubEnv("https_proxy", httpProxyUrl);
      vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:1");
    }
    if (proxy === "https") {
      vi.stubEnv("HTTPS_PROXY", httpsProxyUrl);
      vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
      vi.stubEnv("OPENCLAW_PROXY_CA_FILE", wrongProxyCaFile);
      const untrustedProxySession = await createUploadSession();
      await expect(upload(untrustedProxySession, "127.0.0.1")).rejects.toThrow(/certificate/i);
      expect(proxyRequests).toEqual([]);
      expect(received).toEqual([]);
      vi.stubEnv("OPENCLAW_PROXY_CA_FILE", proxyCaFile);
    }
    const session = await createUploadSession();
    await upload(session, "127.0.0.1");
    expect(received).toEqual([{ host: `127.0.0.1:${originPort}`, body: mediaBytes }]);
    expect(proxyRequests).toEqual(proxy === "none" ? [] : [`127.0.0.1:${originPort}`]);
  });

  it.each([true, false])(
    "selects each upload host independently (WebSocket bypass: %s)",
    async (bypassWebSocket) => {
      vi.stubEnv("HTTPS_PROXY", httpProxyUrl);
      vi.stubEnv("NO_PROXY", bypassWebSocket ? "mmg.whatsapp.net,127.0.0.0/8" : "127.0.0.0/8");
      const session = await createUploadSession();
      expect(Boolean(session.options.agent)).toBe(!bypassWebSocket);
      await upload(session, "127.0.0.1");
      await upload(session, "files.proxy.test");
      expect(received).toEqual([
        { host: `127.0.0.1:${originPort}`, body: mediaBytes },
        { host: `files.proxy.test:${originPort}`, body: mediaBytes },
      ]);
      expect(proxyRequests).toEqual([`files.proxy.test:${originPort}`]);
    },
  );
});
