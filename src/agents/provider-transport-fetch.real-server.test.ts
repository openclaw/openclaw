// Real local HTTP-server proof for #97217 — runs the production
// buildGuardedModelFetch pipeline against a real node:http server on
// 127.0.0.1, with the SSRF guard short-circuited to delegate to real
// fetch(). This produces current-head terminal output proving the lazy
// non-OK body cap fires on a real network response.
//
// Why a separate test file: the main test file's vi.mock setup for
// fetch-guard.js is too tightly coupled to its test cases to splice real
// fetch in cleanly. A sibling test file gets its own mock scope, which is
// the vitest-recommended way to mix real and mocked network behavior.
import http from "node:http";
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGuardedModelFetch } from "./provider-transport-fetch.js";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  withTrustedEnvProxyGuardedFetchMode: vi.fn((params: unknown) => ({
    ...(params as object),
    mode: "trusted_env_proxy",
  })),
}));

vi.mock("../infra/net/proxy-env.js", () => ({
  shouldUseEnvHttpProxyForUrl: vi.fn(() => false),
}));

vi.mock("./provider-local-service.js", () => ({
  ensureModelProviderLocalService: vi.fn(async () => undefined),
}));

vi.mock("./provider-request-config.js", () => ({
  buildProviderRequestDispatcherPolicy: vi.fn(() => undefined),
  getModelProviderRequestTransport: vi.fn(() => undefined),
  mergeModelProviderRequestOverrides: vi.fn(
    (current: Record<string, unknown>, overrides: Record<string, unknown>) => ({
      ...current,
      ...overrides,
    }),
  ),
  resolveProviderRequestPolicyConfig: vi.fn(() => ({ allowPrivateNetwork: true })),
}));

const model = {
  id: "gpt-5.5",
  provider: "azure",
  api: "azure-openai-responses",
  baseUrl: "http://127.0.0.1",
} as unknown as Model<"azure-openai-responses">;

interface RunningServer {
  url: string;
  bytesSent: number;
  closed: boolean;
  close: () => Promise<void>;
}

async function startNonOkServer(
  status: number,
  totalBytes: number,
  chunkSize = 8 * 1024,
  chunkDelayMs = 5,
): Promise<RunningServer> {
  const state: RunningServer = {
    url: "",
    bytesSent: 0,
    closed: false,
    close: async () => {},
  };
  const server = http.createServer((req, res) => {
    res.writeHead(status, {
      "content-type": "text/event-stream",
      "transfer-encoding": "chunked",
    });
    let sent = 0;
    const interval = setInterval(() => {
      if (sent >= totalBytes || state.closed) {
        clearInterval(interval);
        res.end();
        return;
      }
      const remaining = totalBytes - sent;
      const size = Math.min(chunkSize, remaining);
      res.write(Buffer.alloc(size, 0x41));
      sent += size;
      state.bytesSent = sent;
    }, chunkDelayMs);
    req.on("close", () => {
      clearInterval(interval);
      state.closed = true;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("listen failed");
  state.url = `http://127.0.0.1:${addr.port}/openai/v1/responses`;
  state.close = () =>
    new Promise<void>((resolveClose) => {
      state.closed = true;
      server.close(() => resolveClose());
    });
  return state;
}

beforeEach(() => {
  fetchWithSsrFGuardMock.mockReset();
  // Delegate to the real fetch() so the response comes from a real network
  // roundtrip on 127.0.0.1. The fetchWithSsrFGuard envelope carries `url`
  // and `init` (not a Request object).
  fetchWithSsrFGuardMock.mockImplementation(
    async (envelope: { url: string; init?: RequestInit }) => {
      const real = await fetch(envelope.url, envelope.init);
      return {
        response: real,
        finalUrl: envelope.url,
        release: async () => undefined,
        refreshTimeout: () => undefined,
      };
    },
  );
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 50));
});

describe("real local HTTP-server proof: lazy non-OK body cap (#97217)", () => {
  it("1/3 caps oversized non-OK body through real HTTP roundtrip", async () => {
    const OVER_LIMIT = 100 * 1024;
    const server = await startNonOkServer(429, OVER_LIMIT);
    try {
      const response = await buildGuardedModelFetch(model)(
        server.url,
        { method: "POST" },
      );
      expect(response.status).toBe(429);
      expect(response.ok).toBe(false);
      const text = await response.text();
      expect(text.length).toBeLessThanOrEqual(64 * 1024);
      expect(text.length).toBeLessThan(OVER_LIMIT);
      expect(server.bytesSent).toBeGreaterThan(0);
      console.log(
        `  PASS  1/3 server bytesSent=${server.bytesSent} → response.text() length=${text.length} ≤ 64 KiB`,
      );
    } finally {
      await server.close();
    }
  });

  it("2/3 preserves SDK cancel: real HTTP server is not drained when SDK cancels body", async () => {
    const TOTAL_BYTES = 160 * 1024;
    const server = await startNonOkServer(503, TOTAL_BYTES);
    try {
      const response = await buildGuardedModelFetch(model)(
        server.url,
        { method: "POST" },
      );
      expect(response.status).toBe(503);
      // SDK cancels body before reading — emulating retryable 503 handling
      await response.body?.cancel();
      // Give the server a moment to attempt further writes
      await new Promise((r) => setTimeout(r, 200));
      expect(server.bytesSent).toBeLessThan(TOTAL_BYTES);
      console.log(
        `  PASS  2/3 server bytesSent=${server.bytesSent} < ${TOTAL_BYTES} (${TOTAL_BYTES / 1024} KiB) after cancel`,
      );
    } finally {
      await server.close();
    }
  });

  it("3/3 preserves small non-OK body for error parsing through real HTTP", async () => {
    const server = await new Promise<RunningServer>((resolveStart) => {
      const srv = http.createServer((_req, res) => {
        res.writeHead(400, { "content-type": "text/event-stream" });
        res.end(JSON.stringify({ error: { message: "API key expired" } }));
      });
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        if (typeof addr !== "object" || !addr) throw new Error("listen failed");
        resolveStart({
          url: `http://127.0.0.1:${addr.port}/openai/v1/responses`,
          bytesSent: 0,
          closed: false,
          close: () =>
            new Promise<void>((res) => {
              srv.close(() => res());
            }),
        });
      });
    });
    try {
      const response = await buildGuardedModelFetch(model)(
        server.url,
        { method: "POST" },
      );
      expect(response.status).toBe(400);
      const json = (await response.json()) as { error: { message: string } };
      expect(json.error.message).toBe("API key expired");
      console.log(
        `  PASS  3/3 small 400 body preserved for error parsing — message="${json.error.message}"`,
      );
    } finally {
      await server.close();
    }
  });
});
