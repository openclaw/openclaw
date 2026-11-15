// End-to-end: real Content-Disposition download → production uploadImageFromUrl →
// production uploadFile → loopback custom S3 PUT/GET with encoded delimiter filenames.
// Urbit auth/scry are stubbed only to point signing at the local S3 fixture.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readRemoteMediaBuffer } from "openclaw/plugin-sdk/media-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticate } from "./urbit/auth.js";
import { scryUrbitPath } from "./urbit/channel-ops.js";

// mock-isolation: Loopback downloads need an allowlisted origin; keep the real downloader.
vi.mock("openclaw/plugin-sdk/media-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/media-runtime")>();
  return {
    ...actual,
    readRemoteMediaBuffer: vi.fn((opts: Parameters<typeof actual.readRemoteMediaBuffer>[0]) => {
      const origin = new URL(opts.url).origin;
      return actual.readRemoteMediaBuffer({
        ...opts,
        ssrfPolicy: { allowedOrigins: [origin] },
      });
    }),
  };
});

// mock-isolation: Loopback S3 proof must not authenticate against a live Urbit ship.
vi.mock("./urbit/auth.js", () => ({
  authenticate: vi.fn(),
}));

// mock-isolation: Storage discovery is stubbed so the signed PUT targets the local S3 fixture.
vi.mock("./urbit/channel-ops.js", () => ({
  scryUrbitPath: vi.fn(),
}));

import { uploadImageFromUrl } from "./urbit/upload.js";

const mockAuthenticate = vi.mocked(authenticate);
const mockScryUrbitPath = vi.mocked(scryUrbitPath);
const mockReadRemoteMediaBuffer = vi.mocked(readRemoteMediaBuffer);

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

const BUCKET = "uploads";

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected an ephemeral loopback address");
  }
  const origin = `http://127.0.0.1:${(address as AddressInfo).port}`;
  return {
    origin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

describe("uploadImageFromUrl Content-Disposition → custom S3 e2e", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(["photo#1.png", "photo?v=1.png"] as const)(
    "downloads %s via Content-Disposition, uploads through production uploadFile, and retrieves bytes",
    async (fileName) => {
      const objects = new Map<string, Buffer>();
      const s3 = await listen((request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const pathname = decodeURIComponent(url.pathname);
        void (async () => {
          try {
            if (request.method === "PUT") {
              const prefix = `/${BUCKET}/`;
              if (!pathname.startsWith(prefix)) {
                response.writeHead(404);
                response.end("missing bucket prefix");
                return;
              }
              const key = pathname.slice(prefix.length);
              const chunks: Buffer[] = [];
              for await (const chunk of request) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              }
              objects.set(key, Buffer.concat(chunks));
              response.writeHead(200);
              response.end();
              return;
            }
            if (request.method === "GET") {
              const key = pathname.replace(/^\//, "");
              const body = objects.get(key);
              if (!body) {
                response.writeHead(404);
                response.end("not found");
                return;
              }
              response.writeHead(200, { "content-type": "image/png" });
              response.end(body);
              return;
            }
            response.writeHead(405);
            response.end();
          } catch (error) {
            response.writeHead(500);
            response.end(String(error));
          }
        })();
      });

      const image = await listen((_request, response) => {
        response.writeHead(200, {
          "content-type": "image/png",
          "content-disposition": `attachment; filename="${fileName}"`,
        });
        response.end(PNG_BYTES);
      });

      try {
        mockAuthenticate.mockResolvedValue("urbauth-~zod=fake-cookie");
        mockScryUrbitPath.mockImplementation(async (_deps, { path }) => {
          if (path === "/storage/configuration.json") {
            return {
              currentBucket: BUCKET,
              buckets: [BUCKET],
              publicUrlBase: `${s3.origin}/`,
              presignedUrl: "",
              region: "us-east-1",
              service: "custom",
            };
          }
          if (path === "/storage/credentials.json") {
            return {
              "storage-update": {
                credentials: {
                  endpoint: s3.origin,
                  accessKeyId: "AKIAFAKELOOPBACK",
                  secretAccessKey: "fake-secret-loopback",
                },
              },
            };
          }
          throw new Error(`Unexpected scry path: ${path}`);
        });

        const sourceUrl = `${image.origin}/download?id=123`;
        const publicUrl = await uploadImageFromUrl(sourceUrl, {
          shipUrl: "https://ship.example.com",
          shipName: "~zod",
          getCode: async () => "fixture-code",
          dangerouslyAllowPrivateNetwork: true,
        });

        const parsed = new URL(publicUrl);
        expect(parsed.origin).toBe(s3.origin);
        expect(parsed.hash).toBe("");
        expect(parsed.search).toBe("");
        expect(parsed.pathname).toContain(encodeURIComponent(fileName));
        expect(decodeURIComponent(parsed.pathname)).toContain(fileName);

        const retrieved = await fetch(publicUrl);
        expect(retrieved.status).toBe(200);
        const retrievedBytes = Buffer.from(await retrieved.arrayBuffer());
        expect(retrievedBytes.equals(PNG_BYTES)).toBe(true);
        expect(mockReadRemoteMediaBuffer).toHaveBeenCalled();
        expect(objects.size).toBe(1);
        const storedKey = [...objects.keys()][0] ?? "";
        expect(storedKey).toContain(fileName);

        console.log(
          `[tlon content-disposition custom-s3 e2e] source=${sourceUrl} fileName=${fileName} publicUrl=${publicUrl} bytes=${retrievedBytes.length} storedKey=${storedKey}`,
        );
      } finally {
        await image.close();
        await s3.close();
      }
    },
  );
});
