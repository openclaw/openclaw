import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:https";
import type { LookupFunction, Server } from "node:net";
import type { DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
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
import {
  collectRequest,
  registeredPreparedDecisionProvider,
  scoreAnswer,
  stubAmbientProxies,
} from "./transport.test-support.js";

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
    port: claim.port,
    async close() {
      await listener[Symbol.asyncDispose]();
      await claim.release();
    },
  };
}

type ModelProviderConfig = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string];

const batch = {
  state: { type: "json" as const, value: { evidence: "Synthetic outage" } },
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
let responsePayload: string;
let fixture: Awaited<ReturnType<typeof listen<ReturnType<typeof createServer>>>>;
let baseUrl: string;
let pinnedAddress = "10.123.0.5";

beforeAll(async () => {
  fixture = await listen(
    createServer(
      { key: PROXY_FIXTURE_KEY, cert: PROXY_FIXTURE_CERTIFICATE },
      (request, response) => {
        collectRequest(request, (body) => {
          const {
            url,
            headers: { host, authorization, "x-api-key": apiKey },
          } = request;
          received.push({ url, host, authorization, apiKey, body: JSON.parse(body) });
          if (redirect) {
            response.writeHead(302, { location: redirect });
            response.end();
          } else {
            response.setHeader("content-type", "application/json");
            response.end(responsePayload);
          }
        });
      },
    ),
  );
  baseUrl = `https://files.proxy.test:${fixture.port}`;
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
afterAll(() => fixture.close());
beforeEach(() => {
  received.length = 0;
  redirect = undefined;
  responsePayload = JSON.stringify(answer);
  pinnedAddress = "10.123.0.5";
  lookup.mockReset().mockResolvedValue([{ address: pinnedAddress, family: 4 }]);
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
  stubAmbientProxies();
  vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "0");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function provider(source: ModelProviderConfig | (() => ModelProviderConfig)) {
  const config = {
    get apiKey(): never {
      throw new Error("hosted key read");
    },
  };
  return registeredPreparedDecisionProvider(() => ({
    models: { providers: { typesafe: typeof source === "function" ? source() : source } },
    plugins: { entries: { typesafe: { config } } },
  }));
}
const context = (apiKey = "typesafe-local"): DecisionProviderContextV2 => ({
  model: { provider: "typesafe", id: "nemotron-deciffusion", name: "Nemotron" },
  config: {},
  auth: { mode: "api-key", apiKey },
  signal: new AbortController().signal,
  deadlineMonotonicMs: performance.now() + 3000,
  isAdmissible: () => true,
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
const evaluate = (overrides: Partial<ModelProviderConfig> = {}) =>
  provider(settings(overrides)).evaluate(
    batch,
    context(typeof overrides.apiKey === "string" ? overrides.apiKey : undefined),
  );
async function expectUnavailable(
  pending: ReturnType<typeof evaluate>,
  reason = "transport",
  requests = 0,
) {
  await expect(pending).resolves.toEqual({ status: "unavailable", reason });
  expect(received).toHaveLength(requests);
}
const tls = { ca: PROXY_FIXTURE_CERTIFICATE };
const bearer = (token: string) => ({ mode: "authorization-bearer" as const, token });
const header = (value: string) => ({
  mode: "header" as const,
  headerName: "X-Server-Key",
  value,
  prefix: "Token ",
});

const replacement = "replacement";
const override = "Bearer override";
const headerAuth = { mode: "header" as const, headerName: "X-API-Key", value: replacement };
const staleHeaders = { authorization: "Bearer stale", "x-api-key": "stale" };
const overrideRequest = (request: ModelProviderConfig["request"]) => ({
  apiKey: "synthetic-default",
  headers: staleHeaders,
  request: { tls, ...request },
});
it.each<[string, Partial<ModelProviderConfig>, string | undefined, string | undefined]>([
  ["anonymous", {}, undefined, undefined],
  ["api key", { apiKey: "synthetic-server-key" }, "Bearer synthetic-server-key", undefined],
  ["bearer", overrideRequest({ auth: bearer("override") }), override, "stale"],
  ["header", overrideRequest({ auth: headerAuth }), undefined, replacement],
  [
    "headers",
    overrideRequest({ headers: { Authorization: override, "X-API-Key": replacement } }),
    override,
    replacement,
  ],
])("uses private HTTPS with %s credentials", async (mode, config, authorization, apiKey) => {
  const registered = provider(
    settings({
      ...config,
      ...(mode === "bearer" ? { baseUrl: baseUrl + "/v1/" } : {}),
    }),
  );
  await expect(
    registered.evaluate(
      batch,
      context(typeof config.apiKey === "string" ? config.apiKey : undefined),
    ),
  ).resolves.toMatchObject({
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
      authorization,
      apiKey,
      body: {
        state: { evidence: "Synthetic outage" },
        model: "nemotron-deciffusion",
        questions: { q: { type: "noul", instructions: null } },
      },
    },
  ]);
  expect([...new Set(lookup.mock.calls.map(([host]) => host))]).toEqual(["files.proxy.test"]);
  expect(getPreparedPluginSecretInput).not.toHaveBeenCalled();
});

it("honors private-network opt-out and opt-in", async () => {
  await expectUnavailable(evaluate({ request: { allowPrivateNetwork: false, tls } }));
  pinnedAddress = "127.0.0.1";
  lookup.mockResolvedValue([{ address: pinnedAddress, family: 4 }]);
  await expect(evaluate({ request: { allowPrivateNetwork: true, tls } })).resolves.toMatchObject({
    status: "ok",
  });
  expect(received).toHaveLength(1);
});

it.each(["untrusted certificate", "hostname mismatch", "insecure override"])(
  "enforces TLS verification: %s",
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
    await expectUnavailable(evaluate({ apiKey: "synthetic-server-key" }), "transport", 1);
    expect(received[0]?.host).toBe(new URL(baseUrl).host);
  },
);

it.each([
  ["origin", { baseUrl: "https://other.proxy.test" }],
  ["policy", { request: { allowPrivateNetwork: false } }],
  ["credential", { apiKey: "synthetic-rotated" }],
  ["credential loss", { apiKey: endpointRef }],
] satisfies [string, Partial<ModelProviderConfig>][])(
  "rechecks provider %s after DNS",
  async (_change, update) => {
    let config = settings({ apiKey: "synthetic-server-key" });
    const registered = provider(() => config);
    lookup.mockImplementationOnce(async () => {
      config = { ...config, ...update };
      return [{ address: pinnedAddress, family: 4 }];
    });
    await expectUnavailable(registered.evaluate(batch, context("synthetic-server-key")));
  },
);

it("never bypasses a managed proxy refusal", async () => {
  const connects: string[] = [];
  const proxy = await listen(createHttpServer());
  proxy.listener.on("connect", (request, socket) => {
    connects.push(request.url ?? "");
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
  });
  try {
    const url = "http://127.0.0.1:" + proxy.port;
    vi.stubEnv("HTTPS_PROXY", url);
    vi.stubEnv("https_proxy", url);
    vi.stubEnv("OPENCLAW_PROXY_ACTIVE", "1");
    await expectUnavailable(evaluate({ apiKey: "synthetic-server-key" }));
    expect(connects).toEqual([new URL(baseUrl).host]);
  } finally {
    await proxy.close();
  }
});

it("observes provider credential loss, rotation and recovery", async () => {
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
    received.length = 0;
    const result = await registered.evaluate(
      batch,
      context(typeof key === "string" ? key : undefined),
    );
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

it.each<Partial<ModelProviderConfig>>([
  { headers: { Authorization: endpointRef } },
  { request: { auth: { mode: "authorization-bearer", token: endpointRef } } },
])("rejects unresolved headers/request auth", async (config) => {
  await expectUnavailable(evaluate(config), "credentials-unavailable");
  expect(lookup).not.toHaveBeenCalled();
});

it.each(["127.0.0.1", "169.254.169.254", "0.0.0.0"])(
  "rejects unsafe DNS answer %s",
  async (address) => {
    lookup.mockResolvedValue([{ address, family: 4 }]);
    await expectUnavailable(evaluate());
  },
);

const reflected = "synthetic-request-token";
const reflectedHeaders = { "X-API-Key": reflected };
const bearerRequest = { request: { tls, auth: bearer(reflected) } };
const headerRequest = { request: { tls, auth: header(reflected) } };
it.each([
  ["bearer", bearerRequest, false],
  ["header", headerRequest, false],
  ["escaped bearer", bearerRequest, true],
  ["escaped header", headerRequest, true],
  ["provider headers", { headers: reflectedHeaders }, true],
  ["request headers", { request: { tls, headers: reflectedHeaders } }, true],
] satisfies [string, Partial<ModelProviderConfig>, boolean][])(
  "rejects reflected %s credentials",
  async (name, config, escaped) => {
    responsePayload = JSON.stringify({ ...answer, model: reflected });
    if (escaped) {
      responsePayload = responsePayload.replaceAll("-", "\\u002d");
    }
    const result = await evaluate(config);
    expect(result).toEqual({ status: "unavailable", reason: "invalid-response" });
    expect(JSON.stringify(result)).not.toContain(reflected);
    if (name.endsWith("headers")) {
      expect(received).toHaveLength(1);
      expect(received[0]?.apiKey).toBe(reflected);
    }
  },
);

it.each(["authorization-bearer", "header"] as const)(
  "rejects empty %s auth before DNS",
  async (mode) => {
    const auth =
      mode === "authorization-bearer"
        ? bearer("")
        : { mode, headerName: "X-Server-Key", value: "" };
    await expectUnavailable(evaluate({ request: { auth } }), "credentials-unavailable");
    expect(lookup).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "preserves harmless rubric text with authenticated=%s",
  async (authenticated) => {
    const score = {
      state: { type: "text" as const, text: "synthetic" },
      questions: { q: { type: "score" as const, criteria: ["Bearer demo", "Routine"] } },
    };
    responsePayload = JSON.stringify({
      ...answer,
      answers: {
        q: scoreAnswer(0, { 0: 1, 1: 0 }, { 0: "Bearer demo", 1: "Routine" }, 1),
      },
    });
    const result = await provider(
      settings(authenticated ? { apiKey: "synthetic-server-key" } : {}),
    ).evaluate(score, context(authenticated ? "synthetic-server-key" : undefined));
    expect(result).toMatchObject({
      status: "ok",
      result: { answers: { q: { type: "score", score: 0, probabilities: [1, 0] } } },
    });
  },
);
