import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:https";
import type { LookupFunction, Server } from "node:net";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  redactProviderResponseErrorText,
  resolveProviderHttpRequestConfigWithOriginTrust,
} from "openclaw/plugin-sdk/provider-http";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  acquireTestPortBlock,
  PROXY_FIXTURE_CERTIFICATE,
  PROXY_FIXTURE_KEY,
} from "openclaw/plugin-sdk/test-env";
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from "undici";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import plugin from "../index.js";
import type { ModelProviderConfig } from "./config.js";

vi.mock("openclaw/plugin-sdk/secret-input-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/secret-input-runtime")>()),
  getPreparedPluginSecretInput: vi.fn(),
}));
const { lookup } = vi.hoisted(() => ({ lookup: vi.fn<LookupFn>() }));
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup,
}));

// Only the fixture's final socket routing is substituted. The real guard must first
// authorize and pin this RFC1918 answer; TLS still verifies the original hostname.
class FixtureAgent extends Agent {
  constructor(options: Agent.Options = {}) {
    assert(options.connect && typeof options.connect !== "function" && "lookup" in options.connect);
    const pinnedLookup = options.connect.lookup;
    assert(pinnedLookup);
    const routedLookup: LookupFunction = (hostname, opts, callback) =>
      pinnedLookup(hostname, opts, (error, address, family) => {
        if (error) {
          callback(error, address, family);
          return;
        }
        if (Array.isArray(address)) {
          expect(address).toEqual([{ address: pinnedAddress, family: 4 }]);
          callback(null, [{ address: "127.0.0.1", family: 4 }]);
        } else {
          expect(address).toBe(pinnedAddress);
          callback(null, "127.0.0.1", 4);
        }
      });
    super({ ...options, connect: { ...options.connect, lookup: routedLookup } });
  }
}
async function listen<T extends Server>(listener: T) {
  const claim = await acquireTestPortBlock({ offsets: [0] });
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(claim.port, "127.0.0.1", resolve);
  });
  return {
    listener,
    claim,
    releaseListener: () =>
      new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

const batch = {
  state: { evidence: "Synthetic outage" },
  questions: { q: { type: "boolean" as const } },
};
const answer = {
  model: "nemotron-deciffusion",
  answers: { q: { type: "noul", noul: 0.75 } },
  usage: { input_tokens: 8, output_tokens: 1 },
};
const received: Array<{
  url?: string;
  host?: string;
  authorization?: string;
  apiKey?: string | string[];
  body: unknown;
}> = [];
let redirect: string | undefined;
let responseModel: string | undefined;
let escapeResponse = false;
let responsePayload: object | undefined;
let fixture: Awaited<ReturnType<typeof listen<ReturnType<typeof createServer>>>>;
let baseUrl: string;
let pinnedAddress = "10.123.0.5";

beforeAll(async () => {
  fixture = await listen(
    createServer(
      { key: PROXY_FIXTURE_KEY, cert: PROXY_FIXTURE_CERTIFICATE },
      (request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          received.push({
            url: request.url,
            host: request.headers.host,
            authorization: request.headers.authorization,
            apiKey: request.headers["x-api-key"],
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
          });
          if (redirect) {
            response.writeHead(302, { location: redirect });
            response.end();
          } else {
            response.setHeader("content-type", "application/json");
            const body = JSON.stringify(
              responsePayload ?? { ...answer, model: responseModel ?? answer.model },
            );
            response.end(
              escapeResponse ? body.replaceAll("-", String.fromCharCode(92) + "u002d") : body,
            );
          }
        });
      },
    ),
  );
  baseUrl = `https://files.proxy.test:${fixture.claim.port}`;
  // Network proof starts after host-policy/loader initialization, as on a running
  // Gateway. Cold import and deadline admission have separate registration.lazy tests.
  await import("./client.js");
  resolveProviderHttpRequestConfigWithOriginTrust({
    provider: "typesafe",
    baseUrl,
    defaultBaseUrl: baseUrl,
  });
  redactProviderResponseErrorText("{}", {});
});
afterAll(async () => {
  await fixture.releaseListener();
  await fixture.claim.release();
});
beforeEach(() => {
  received.length = 0;
  redirect = undefined;
  responseModel = undefined;
  escapeResponse = false;
  responsePayload = undefined;
  pinnedAddress = "10.123.0.5";
  vi.mocked(lookup).mockReset();
  vi.mocked(lookup).mockResolvedValue([{ address: "10.123.0.5", family: 4 }]);
  vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", {
    Agent: FixtureAgent,
    EnvHttpProxyAgent,
    ProxyAgent,
    fetch: undiciFetch,
  });
  vi.mocked(getPreparedPluginSecretInput).mockReset();
  vi.mocked(getPreparedPluginSecretInput).mockReturnValue({
    revision: 1,
    value: "synthetic-hosted-key",
  });
  for (const key of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    vi.stubEnv(key, "http://127.0.0.1:1");
  }
  vi.stubEnv("NO_PROXY", "");
  vi.stubEnv("no_proxy", "");
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
  vi.stubEnv("OPENCLAW_DEBUG_PROXY_ENABLED", "false");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function provider(source: ModelProviderConfig | (() => ModelProviderConfig)) {
  const registerDecisionProvider = vi.fn<OpenClawPluginApi["registerDecisionProvider"]>();
  plugin.register({
    runtime: {
      config: {
        current: () => ({
          models: { providers: { typesafe: typeof source === "function" ? source() : source } },
          plugins: {
            entries: {
              typesafe: {
                config: {
                  get apiKey(): never {
                    throw new Error("hosted key read");
                  },
                },
              },
            },
          },
        }),
      },
    },
    registerDecisionProvider,
  } as unknown as OpenClawPluginApi);
  const registered = registerDecisionProvider.mock.calls[0]?.[0];
  assert(registered);
  if (registered.contractVersion !== 1) {
    throw new Error("TypeSafe fixture registered an unexpected decision contract");
  }
  return registered;
}
const context = () => ({
  model: "nemotron-deciffusion",
  signal: new AbortController().signal,
  deadlineMonotonicMs: performance.now() + 3000,
});
const endpointRef = {
  source: "store",
  provider: "default",
  id: "SYNTHETIC_SYSTEM_ONE_TOKEN",
} as const;
const settings = (overrides: Partial<ModelProviderConfig> = {}): ModelProviderConfig => ({
  baseUrl,
  models: [],
  request: { tls: { ca: PROXY_FIXTURE_CERTIFICATE } },
  ...overrides,
});

it.each([false, true])(
  "uses models.providers.typesafe for private HTTPS with apiKey=%s",
  async (auth) => {
    const registered = provider(settings(auth ? { apiKey: "synthetic-server-key" } : {}));
    expect(registered.isReady?.()).toBe(true);
    await expect(registered.evaluate(batch, context())).resolves.toMatchObject({
      status: "ok",
      result: {
        model: "nemotron-deciffusion",
        answers: { q: { type: "boolean", probabilityTrue: 0.75 } },
      },
    });
    expect(received).toEqual([
      {
        url: "/v1/systemone",
        host: new URL(baseUrl).host,
        authorization: auth ? "Bearer synthetic-server-key" : undefined,
        body: {
          ...batch,
          model: "nemotron-deciffusion",
          questions: { q: { type: "noul", instructions: null } },
        },
      },
    ]);
    expect(lookup).toHaveBeenCalled();
    expect(lookup.mock.calls.every(([host]) => host === "files.proxy.test")).toBe(true);
    expect(getPreparedPluginSecretInput).not.toHaveBeenCalled();
  },
);

it("uses the common private-network opt-out and explicit opt-in", async () => {
  const tls = { ca: PROXY_FIXTURE_CERTIFICATE };
  await expect(
    provider(settings({ request: { allowPrivateNetwork: false, tls } })).evaluate(batch, context()),
  ).resolves.toEqual({ status: "unavailable", reason: "transport" });
  expect(received).toHaveLength(0);
  pinnedAddress = "127.0.0.1";
  lookup.mockResolvedValue([{ address: pinnedAddress, family: 4 }]);
  await expect(
    provider(settings({ request: { allowPrivateNetwork: true, tls } })).evaluate(batch, context()),
  ).resolves.toMatchObject({ status: "ok" });
  expect(received).toHaveLength(1);
});

it("applies the shared bearer override and /v1 base URL without duplicating paths", async () => {
  await expect(
    provider(
      settings({
        baseUrl: baseUrl + "/v1/",
        apiKey: "synthetic-key",
        headers: { authorization: "Bearer synthetic-stale" },
        request: {
          tls: { ca: PROXY_FIXTURE_CERTIFICATE },
          auth: { mode: "authorization-bearer", token: "synthetic-override" },
        },
      }),
    ).evaluate(batch, context()),
  ).resolves.toMatchObject({ status: "ok" });
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({
    url: "/v1/systemone",
    authorization: "Bearer synthetic-override",
  });
});

it.each(["header-auth", "request-headers"] as const)(
  "applies %s after provider header defaults",
  async (mode) => {
    const tls = { ca: PROXY_FIXTURE_CERTIFICATE };
    const request: NonNullable<ModelProviderConfig["request"]> =
      mode === "header-auth"
        ? { tls, auth: { mode: "header", headerName: "X-API-Key", value: "synthetic-replacement" } }
        : {
            tls,
            headers: {
              Authorization: "Bearer synthetic-override",
              "X-API-Key": "synthetic-replacement",
            },
          };
    await expect(
      provider(
        settings({
          apiKey: "synthetic-default",
          headers: {
            authorization: "Bearer synthetic-stale",
            "x-api-key": "synthetic-stale-header",
          },
          request,
        }),
      ).evaluate(batch, context()),
    ).resolves.toMatchObject({ status: "ok" });
    expect(received).toHaveLength(1);
    expect(received[0]?.authorization).toBe(
      mode === "header-auth" ? undefined : "Bearer synthetic-override",
    );
    expect(received[0]?.apiKey).toBe("synthetic-replacement");
  },
);

it.each(["untrusted certificate", "hostname mismatch", "insecure override"])(
  "preserves shared TLS verification: %s",
  async (failure) => {
    const config = settings(
      failure === "hostname mismatch"
        ? { baseUrl: baseUrl.replace("files.proxy.test", "other.proxy.test") }
        : { request: failure === "insecure override" ? { tls: { insecureSkipVerify: true } } : {} },
    );
    await expect(provider(config).evaluate(batch, context())).resolves.toMatchObject({
      status: "unavailable",
    });
    expect(received).toHaveLength(0);
  },
);

it.each(["https://api.typesafe.ai/v1/systemone", "https://other.proxy.test/sink"])(
  "never follows a redirect to %s",
  async (target) => {
    redirect = target;
    await expect(
      provider(settings({ apiKey: "synthetic-server-key" })).evaluate(batch, context()),
    ).resolves.toEqual({ status: "unavailable", reason: "transport" });
    expect(received).toHaveLength(1);
    expect(received[0]?.host).toBe(new URL(baseUrl).host);
  },
);

it.each(["origin", "policy", "credential", "credential loss"])(
  "rechecks current provider %s after DNS before dispatch",
  async (change) => {
    let config = settings({ apiKey: "synthetic-server-key" });
    const registered = provider(() => config);
    lookup.mockImplementationOnce(async () => {
      config = {
        ...config,
        ...(change === "origin"
          ? { baseUrl: "https://other.proxy.test" }
          : change === "policy"
            ? { request: { allowPrivateNetwork: false } }
            : { apiKey: change === "credential" ? "synthetic-rotated" : endpointRef }),
      };
      return [{ address: pinnedAddress, family: 4 }];
    });
    await expect(registered.evaluate(batch, context())).resolves.toEqual({
      status: "unavailable",
      reason: "transport",
    });
    expect(received).toHaveLength(0);
  },
);

it("honors an explicit managed proxy rather than bypassing its refusal", async () => {
  const connects: string[] = [];
  const proxy = await listen(createHttpServer());
  proxy.listener.on("connect", (request, socket) => {
    connects.push(request.url ?? "");
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
  });
  try {
    const url = "http://127.0.0.1:" + proxy.claim.port;
    vi.stubEnv("HTTPS_PROXY", url);
    vi.stubEnv("https_proxy", url);
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
    await expect(
      provider(settings({ apiKey: "synthetic-server-key" })).evaluate(batch, context()),
    ).resolves.toEqual({ status: "unavailable", reason: "transport" });
    expect(connects).toEqual([new URL(baseUrl).host]);
    expect(received).toHaveLength(0);
  } finally {
    await proxy.releaseListener();
    await proxy.claim.release();
  }
});

it("fails cold for unavailable provider secrets and observes rotation and recovery", async () => {
  let config = settings({ apiKey: endpointRef });
  const registered = provider(() => config);
  for (const key of [
    endpointRef,
    "synthetic-first",
    "synthetic-rotated",
    endpointRef,
    "synthetic-recovered",
  ]) {
    config = settings({ apiKey: key });
    expect(registered.isReady?.()).toBe(typeof key === "string");
    received.length = 0;
    const result = await registered.evaluate(batch, context());
    if (typeof key === "string") {
      expect(result.status).toBe("ok");
      expect(received).toHaveLength(1);
      expect(received[0]?.authorization).toBe("Bearer " + key);
    } else {
      expect(result).toEqual({ status: "unavailable", reason: "credentials-unavailable" });
      expect(received).toHaveLength(0);
    }
  }
  expect(getPreparedPluginSecretInput).not.toHaveBeenCalled();
});

it.each<ModelProviderConfig>([
  { baseUrl: "https://files.proxy.test", models: [], headers: { Authorization: endpointRef } },
  {
    baseUrl: "https://files.proxy.test",
    models: [],
    request: { auth: { mode: "authorization-bearer", token: endpointRef } },
  },
])("fails closed for unresolved configured headers/request auth", async (config) => {
  await expect(
    provider(settings({ ...config, baseUrl })).evaluate(batch, context()),
  ).resolves.toEqual({ status: "unavailable", reason: "credentials-unavailable" });
  expect(received).toHaveLength(0);
  expect(lookup).not.toHaveBeenCalled();
});

it.each(["127.0.0.1", "169.254.169.254", "0.0.0.0"])(
  "retains the common unsafe DNS restriction for %s",
  async (address) => {
    lookup.mockResolvedValue([{ address, family: 4 }]);
    await expect(provider(settings()).evaluate(batch, context())).resolves.toEqual({
      status: "unavailable",
      reason: "transport",
    });
    expect(received).toHaveLength(0);
  },
);

it.each(["authorization-bearer", "header"] as const)(
  "rejects reflected shared %s credentials without returning them",
  async (mode) => {
    responseModel = "synthetic-request-token";
    const result = await provider(
      settings({
        request: {
          tls: { ca: PROXY_FIXTURE_CERTIFICATE },
          auth:
            mode === "authorization-bearer"
              ? { mode, token: responseModel }
              : { mode, headerName: "X-Server-Key", value: responseModel, prefix: "Token " },
        },
      }),
    ).evaluate(batch, context());
    expect(result).toEqual({ status: "unavailable", reason: "invalid-response" });
    expect(JSON.stringify(result)).not.toContain(responseModel);
  },
);

it.each(["provider", "request"] as const)(
  "rejects credentials reflected from configured %s headers",
  async (owner) => {
    responseModel = "synthetic-configured-header-key";
    escapeResponse = true;
    const headers = { "X-API-Key": responseModel };
    const result = await provider(
      settings(
        owner === "provider"
          ? { headers }
          : { request: { tls: { ca: PROXY_FIXTURE_CERTIFICATE }, headers } },
      ),
    ).evaluate(batch, context());
    expect(received).toHaveLength(1);
    expect(received[0]?.apiKey).toBe(responseModel);
    expect(result).toEqual({ status: "unavailable", reason: "invalid-response" });
    expect(JSON.stringify(result)).not.toContain(responseModel);
  },
);

it.each(["authorization-bearer", "header"] as const)(
  "fails closed instead of sending anonymous requests for empty %s auth",
  async (mode) => {
    const auth =
      mode === "authorization-bearer"
        ? { mode, token: "" }
        : { mode, headerName: "X-Server-Key", value: "" };
    await expect(
      provider(settings({ request: { auth } })).evaluate(batch, context()),
    ).resolves.toEqual({ status: "unavailable", reason: "credentials-unavailable" });
    expect(received).toHaveLength(0);
    expect(lookup).not.toHaveBeenCalled();
  },
);

it.each(["authorization-bearer", "header"] as const)(
  "rejects JSON-escaped reflected %s credentials after decoding",
  async (mode) => {
    responseModel = "synthetic-request-token";
    escapeResponse = true;
    const auth =
      mode === "authorization-bearer"
        ? { mode, token: responseModel }
        : { mode, headerName: "X-Server-Key", value: responseModel, prefix: "Token " };
    const result = await provider(
      settings({ request: { tls: { ca: PROXY_FIXTURE_CERTIFICATE }, auth } }),
    ).evaluate(batch, context());
    expect(result).toEqual({ status: "unavailable", reason: "invalid-response" });
    expect(JSON.stringify(result)).not.toContain(responseModel);
  },
);

it.each([false, true])(
  "preserves harmless rubric text with authenticated=%s",
  async (authenticated) => {
    const score = {
      state: "synthetic",
      questions: { q: { type: "score" as const, criteria: ["Bearer demo", "Routine"] } },
    };
    responsePayload = {
      model: "nemotron-deciffusion",
      answers: {
        q: {
          type: "score",
          score: 0,
          confidence: 1,
          probabilities: { 0: 1, 1: 0 },
          legend: { 0: "Bearer demo", 1: "Routine" },
        },
      },
      usage: { input_tokens: 8, output_tokens: 1 },
    };
    const result = await provider(
      settings(authenticated ? { apiKey: "synthetic-server-key" } : {}),
    ).evaluate(score, context());
    expect(result).toMatchObject({
      status: "ok",
      result: { answers: { q: { type: "score", score: 0, probabilities: [1, 0] } } },
    });
  },
);
