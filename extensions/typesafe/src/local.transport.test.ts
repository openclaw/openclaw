import assert from "node:assert/strict";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { evaluate } from "./client.js";
import { runtimeConfig } from "./config.js";
import {
  closeServer,
  collectRequest,
  decisionContext,
  mixedFixture,
  mockJsonResponse as mockResponse,
  registeredDecisionProvider,
  stubAmbientProxies,
} from "./transport.test-support.js";

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  getPreparedPluginSecretInput: vi.fn(),
}));
vi.mock("node:dns/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dns/promises")>();
  return { ...actual, lookup: vi.fn(actual.lookup) };
});

const baseUrl = "http://127.0.0.1:8009";
const input = { ...mixedFixture.input, model: "kev-latest" };
const wireInput = { ...mixedFixture.localInput, model: input.model };
const decisionBatch = { ...mixedFixture.batch, model: input.model };
const localAnswer = { ...mixedFixture.localResponse, model: input.model };
const expectedResult = {
  ...mixedFixture.result,
  result: { ...mixedFixture.result.result, model: input.model },
};

beforeEach(() => {
  vi.mocked(getPreparedPluginSecretInput).mockReset();
  vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ revision: 1, value: "hosted-secret" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.mocked(lookup).mockReset();
});

function registeredProvider(endpoint?: string) {
  return registeredDecisionProvider(() => ({
    plugins: {
      entries: { typesafe: { config: { baseUrl: endpoint, apiKey: "hosted-materialized" } } },
    },
  }));
}

it("refuses hosted dispatch for local Kev", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    registeredProvider().evaluate(
      { state: "local-only evidence", questions: { q: { type: "boolean" } } },
      decisionContext(input.model, 10000),
    ),
  ).resolves.toEqual({ status: "unavailable", reason: "unsupported-input" });
  expect(fetch).not.toHaveBeenCalled();
});

it.each(["http://127.0.0.1:8009/", "https://localhost"])(
  "accepts an explicit loopback origin %s",
  (url) => {
    expect(runtimeConfig({ baseUrl: url, apiKey: "ignored-secret" })).toEqual({
      baseUrl: new URL(url).origin,
      timeoutMs: 30000,
    });
  },
);

it.each([
  "https://remote.example",
  "http://localhost.example",
  "http://localhost:8009/v1",
  "http://localhost:8009?x=1",
  "http://localhost:8009#x",
  "http://user:password@localhost:8009",
  "file:///localhost",
  "http://localhost:65536",
  "http://127.1:8009",
  "http://2130706433:8009",
  "http://localhost.:8009",
  null,
])("rejects unsafe loopback endpoint %s", (url) => {
  expect(() => runtimeConfig({ baseUrl: url })).toThrow("baseUrl");
});

it.each([-1, "15"])("rejects invalid local latency metadata %s", async (latency_ms) => {
  mockResponse({ ...localAnswer, latency_ms });
  await expect(evaluate(input, runtimeConfig({ baseUrl }))).rejects.toThrow("invalid response");
});

it("never sends a stale hosted key locally", async () => {
  const fetch = mockResponse(localAnswer);
  await expect(
    evaluate(input, { ...runtimeConfig({ baseUrl }), apiKey: "hosted-secret" }),
  ).resolves.toHaveProperty("evaluation.model", "kev-latest");
  expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("authorization")).toBeNull();
});

it.each(["127.0.0.1", "localhost", "[::1]"])("reuses local %s sockets", async (hostname) => {
  const received: { url?: string; authorization?: string; host?: string; body: string }[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    sockets.add(request.socket);
    collectRequest(request, (body) => {
      const {
        url,
        headers: { authorization, host },
      } = request;
      received.push({ url, authorization, host, body });
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(localAnswer));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, hostname === "[::1]" ? "::1" : "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert(address && typeof address === "object");
    stubAmbientProxies();
    if (hostname === "localhost") {
      vi.mocked(lookup).mockRejectedValue(new Error("Synthetic untrusted localhost resolver"));
    }
    const provider = registeredProvider(`http://${hostname}:${address.port}`);
    expect(provider.isReady?.()).toBe(true);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(provider.evaluate(decisionBatch, decisionContext(input.model))).resolves.toEqual(
        expectedResult,
      );
    }
    expect(getPreparedPluginSecretInput).not.toHaveBeenCalled();
    expect(received).toHaveLength(5);
    expect(sockets.size).toBeLessThan(received.length);
    expect(received[0]).toMatchObject({
      url: "/v1/systemone",
      authorization: undefined,
      host: `${hostname}:${address.port}`,
    });
    expect(JSON.parse(received[0]!.body)).toEqual(wireInput);
    if (hostname === "localhost") {
      expect(lookup).not.toHaveBeenCalled();
    }
  } finally {
    await closeServer(server);
  }
});
