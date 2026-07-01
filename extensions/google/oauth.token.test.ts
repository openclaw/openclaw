// Google tests cover oauth.token error body boundary behavior.
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeCodeForTokens, refreshTokensForGeminiCli } from "./oauth.token.js";

const GOOGLE_OAUTH_ERROR_BODY_MAX_BYTES = 8 * 1024;
const STREAM_CHUNK = Buffer.alloc(4 * 1024, "x");
const STREAM_BODY_BYTES = 1024 * 1024;

const { mockFetchWithTimeout } = vi.hoisted(() => ({
  mockFetchWithTimeout: vi.fn(),
}));

vi.mock("./oauth.http.js", () => ({
  fetchWithTimeout: mockFetchWithTimeout,
}));

vi.mock("./oauth.credentials.js", () => ({
  resolveOAuthClientConfig: () => ({
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
  }),
}));

vi.mock("./oauth.project.js", () => ({
  resolveGoogleOAuthIdentity: async () => ({ email: "test@example.com" }),
  resolveGooglePersonalOAuthIdentity: async () => ({ email: "test@example.com" }),
}));

async function listenLoopbackServer(server: Server): Promise<number> {
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected loopback TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe("requestTokenGrant bounded error reads", () => {
  let server: Server;
  let baseUrl: string;
  let streamClosed: Promise<void>;
  let resolveStreamClosed: () => void;
  let streamCompleted: boolean;

  beforeEach(() => {
    vi.useRealTimers();
    mockFetchWithTimeout.mockReset();
    vi.stubEnv("GOOGLE_CLIENT_ID", "test-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-client-secret");
    for (const key of [
      "ALL_PROXY",
      "all_proxy",
      "HTTP_PROXY",
      "http_proxy",
      "HTTPS_PROXY",
      "https_proxy",
    ]) {
      vi.stubEnv(key, "");
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe("error body bounded reads via loopback HTTP server", () => {
    beforeEach(async () => {
      streamClosed = new Promise<void>((resolve) => {
        resolveStreamClosed = resolve;
      });
      streamCompleted = false;

      server = createServer((req, res) => {
        if (req.url === "/small") {
          res.writeHead(400, {
            "content-type": "application/json; charset=utf-8",
          });
          res.end('{"error":"invalid_grant","error_description":"Bad Request"}');
          return;
        }

        // Oversized error response
        res.writeHead(500, {
          "content-type": "text/html; charset=utf-8",
        });
        let written = 0;
        let closed = false;
        res.once("close", () => {
          closed = true;
          resolveStreamClosed();
        });
        const writeNext = () => {
          if (closed) return;
          if (written >= STREAM_BODY_BYTES) {
            streamCompleted = true;
            res.end();
            return;
          }
          written += STREAM_CHUNK.byteLength;
          const writeMore = () => setTimeout(writeNext, 2);
          if (res.write(STREAM_CHUNK)) {
            writeMore();
          } else {
            res.once("drain", writeMore);
          }
        };
        writeNext();
      });

      const port = await listenLoopbackServer(server);
      baseUrl = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
      await closeServer(server);
    });

    it("bounds oversized OAuth error body text", async () => {
      const rawResponse = await fetch(`${baseUrl}/large`);
      mockFetchWithTimeout.mockResolvedValue(rawResponse);

      const error = await exchangeCodeForTokens("test-code", "test-verifier").catch(
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(Error);
      const message = String((error as Error).message);
      expect(message).toContain("Token exchange failed:");

      // After bounded read, the stream should be cancelled before completion
      await expect(streamClosed).resolves.toBeUndefined();
      expect(streamCompleted).toBe(false);

      console.log(
        `[google oauth.token loopback proof] oversized path: ` +
          `cap=${GOOGLE_OAUTH_ERROR_BODY_MAX_BYTES} ` +
          `streamed=${STREAM_BODY_BYTES} ` +
          `message_length=${message.length}`,
      );
    });

    it("preserves complete small error body text within the limit", async () => {
      const rawResponse = await fetch(`${baseUrl}/small`);
      mockFetchWithTimeout.mockResolvedValue(rawResponse);

      const error = await exchangeCodeForTokens("test-code", "test-verifier").catch(
        (err: unknown) => err,
      );

      expect(error).toBeInstanceOf(Error);
      const message = String((error as Error).message);
      expect(message).toBe(
        'Token exchange failed: {"error":"invalid_grant","error_description":"Bad Request"}',
      );

      console.log(
        `[google oauth.token loopback proof] small body path: ` +
          `message_length=${message.length}`,
      );
    });
  });

  describe("refreshTokensForGeminiCli error body bounded reads", () => {
    beforeEach(async () => {
      streamClosed = new Promise<void>((resolve) => {
        resolveStreamClosed = resolve;
      });
      streamCompleted = false;

      server = createServer((req, res) => {
        // Oversized error response for refresh path
        res.writeHead(503, {
          "content-type": "text/html; charset=utf-8",
        });
        let written = 0;
        let closed = false;
        res.once("close", () => {
          closed = true;
          resolveStreamClosed();
        });
        const writeNext = () => {
          if (closed) return;
          if (written >= STREAM_BODY_BYTES) {
            streamCompleted = true;
            res.end();
            return;
          }
          written += STREAM_CHUNK.byteLength;
          const writeMore = () => setTimeout(writeNext, 2);
          if (res.write(STREAM_CHUNK)) {
            writeMore();
          } else {
            res.once("drain", writeMore);
          }
        };
        writeNext();
      });

      const port = await listenLoopbackServer(server);
      baseUrl = `http://127.0.0.1:${port}`;
    });

    afterEach(async () => {
      await closeServer(server);
    });

    it("bounds oversized OAuth error body text during token refresh", async () => {
      const rawResponse = await fetch(`${baseUrl}/large`);
      mockFetchWithTimeout.mockResolvedValue(rawResponse);

      const error = await refreshTokensForGeminiCli({
        refresh: "test-refresh-token",
      }).catch((err: unknown) => err);

      expect(error).toBeInstanceOf(Error);
      const message = String((error as Error).message);
      expect(message).toContain("Token exchange failed:");

      await expect(streamClosed).resolves.toBeUndefined();
      expect(streamCompleted).toBe(false);
    });
  });
});
