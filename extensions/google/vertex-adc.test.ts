// Google tests cover Vertex ADC auth behavior.
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetGoogleVertexAuthorizedUserTokenCacheForTest,
  resolveGoogleVertexAuthorizedUserHeaders,
} from "./vertex-adc.js";

type RaceOutcome<T> =
  | { status: "resolved"; value: T }
  | { status: "rejected"; error: unknown }
  | { status: "pending" };

async function settleOrPending<T>(promise: Promise<T>, timeoutMs: number): Promise<RaceOutcome<T>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ status: "resolved" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ),
      new Promise<{ status: "pending" }>((resolve) => {
        timeout = setTimeout(() => resolve({ status: "pending" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function startHangingTokenServer(): Promise<{
  origin: string;
  paths: string[];
  waitForRequestCount: (count: number) => Promise<void>;
  destroyOpenSockets: () => void;
  close: () => Promise<void>;
}> {
  type Waiter = {
    count: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timeout?: ReturnType<typeof setTimeout>;
  };
  const paths: string[] = [];
  const sockets = new Set<Socket>();
  const waiters: Waiter[] = [];
  const resolveWaiters = () => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter || paths.length < waiter.count) {
        continue;
      }
      waiters.splice(index, 1);
      if (waiter.timeout) {
        clearTimeout(waiter.timeout);
      }
      waiter.resolve();
    }
  };
  const server = createServer((req) => {
    paths.push(req.url ?? "");
    req.resume();
    resolveWaiters();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected loopback TCP address");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    paths,
    waitForRequestCount: async (count: number) => {
      if (paths.length >= count) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const waiter: Waiter = { count, resolve, reject };
        waiter.timeout = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new Error(`server received ${paths.length} request(s), expected ${count}`));
        }, 1_000);
        waiters.push(waiter);
      });
    },
    destroyOpenSockets: () => {
      for (const socket of sockets) {
        socket.destroy();
      }
    },
    close: async () => {
      for (const waiter of waiters.splice(0)) {
        if (waiter.timeout) {
          clearTimeout(waiter.timeout);
        }
        waiter.reject(new Error("server closed"));
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function writeAuthorizedUserCredentials(refreshToken: string): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-google-vertex-adc-timeout-"));
  const credentialsPath = path.join(tempDir, "application_default_credentials.json");
  await writeFile(
    credentialsPath,
    JSON.stringify({
      type: "authorized_user",
      client_id: "client-id",
      client_secret: "client-secret",
      refresh_token: refreshToken,
    }),
    "utf8",
  );
  return credentialsPath;
}

describe("Google Vertex ADC", () => {
  afterEach(() => {
    resetGoogleVertexAuthorizedUserTokenCacheForTest();
    vi.unstubAllEnvs();
  });

  it("times out authorized_user token refreshes when the OAuth endpoint hangs", async () => {
    const credentialsPath = await writeAuthorizedUserCredentials("timeout-refresh-token");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", credentialsPath);
    const server = await startHangingTokenServer();
    let pendingRefresh: Promise<Record<string, string>> | undefined;
    let timedRefresh: Promise<Record<string, string>> | undefined;

    try {
      pendingRefresh = resolveGoogleVertexAuthorizedUserHeaders(
        async (input, init) => {
          expect(input).toBe("https://oauth2.googleapis.com/token");
          return await fetch(`${server.origin}/token-without-deadline`, {
            method: init?.method,
            headers: init?.headers,
            body: init?.body,
          });
        },
        { tokenRefreshTimeoutMs: 50 },
      );
      await server.waitForRequestCount(1);
      expect(await settleOrPending(pendingRefresh, 250)).toEqual({ status: "pending" });
      server.destroyOpenSockets();
      await pendingRefresh.catch(() => undefined);
      resetGoogleVertexAuthorizedUserTokenCacheForTest();

      timedRefresh = resolveGoogleVertexAuthorizedUserHeaders(
        async (input, init) => {
          expect(input).toBe("https://oauth2.googleapis.com/token");
          return await fetch(`${server.origin}/token-with-deadline`, init);
        },
        { tokenRefreshTimeoutMs: 50 },
      );
      await server.waitForRequestCount(2);
      const outcome = await settleOrPending(timedRefresh, 500);
      if (outcome.status !== "rejected") {
        throw new Error(`expected token refresh timeout rejection, got ${outcome.status}`);
      }
      expect(`${String((outcome.error as { name?: unknown })?.name)} ${String(outcome.error)}`)
        .toMatch(/abort|timeout/i);
      expect(server.paths).toEqual(["/token-without-deadline", "/token-with-deadline"]);
    } finally {
      server.destroyOpenSockets();
      await pendingRefresh?.catch(() => undefined);
      await timedRefresh?.catch(() => undefined);
      await server.close();
    }
  });
});
