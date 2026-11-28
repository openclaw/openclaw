import { attachModelProviderRequestTransport } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { DecisionBatchV2, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { fetchWithProviderHttpGuard } from "openclaw/plugin-sdk/provider-http";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildFoundryDecisionProvider } from "./decision-provider.js";

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  getPreparedPluginSecretInput: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/provider-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-http")>()),
  fetchWithProviderHttpGuard: vi.fn(),
}));

const id = "microsoft-foundry-systemone";
const model = "microsoft-decision-1.1";
const host = "example.services.ai.azure.com";
const key = "fixture-systemone-key";
const deployment = "fixture-deployment";
const cfg = {
  plugins: {
    entries: { "microsoft-foundry": { config: { decision: { resourceHost: host, deployment } } } },
  },
};
const batch = {
  state: { type: "json", value: { text: "I was charged twice" } },
  questions: {
    billed: { type: "boolean", instructions: { condition: "mentions billing" } },
    team: { type: "choice", criteria: { help: "Support", billing: "Duplicate charge" } },
    severity: { type: "score", criteria: ["Low", "High"] },
  },
} as const satisfies DecisionBatchV2;
const reply = {
  model: "Microsoft-Decision-1.1",
  answers: {
    billed: { type: "noul", noul: 0.9 },
    team: { type: "choice", choice: "billing", probabilities: { help: 0.07, billing: 0.92 } },
    severity: {
      type: "score",
      score: 0.27,
      probabilities: { 0: 0.7, 1: 0.3 },
      legend: { 0: "Low", 1: "High" },
    },
  },
  usage: { input_tokens: 70, output_tokens: 0, cost: 0.1 },
};

function context(extra: Partial<DecisionProviderContextV2> = {}): DecisionProviderContextV2 {
  return {
    model: { id: model, provider: id, name: model },
    auth: { mode: "api-key", apiKey: key },
    config: cfg,
    signal: new AbortController().signal,
    deadlineMonotonicMs: performance.now() + 5000,
    isAdmissible: () => true,
    ...extra,
  };
}

function respond(payload: unknown = reply, status = 200) {
  const release = vi.fn(async () => {});
  vi.mocked(fetchWithProviderHttpGuard).mockImplementation(async (request) => ({
    response: Response.json(payload, { status }),
    release,
    finalUrl: request.url,
  }));
  return release;
}

beforeEach(() => {
  vi.mocked(getPreparedPluginSecretInput).mockReset().mockReturnValue({ revision: 1 });
  vi.mocked(fetchWithProviderHttpGuard).mockReset();
});
afterEach(() => vi.unstubAllEnvs());

it("reads only the prepared Foundry Decision credential", () => {
  const route = buildFoundryDecisionProvider(() => cfg);
  const resolve = route.provider?.resolveSyntheticAuth;
  expect(resolve).toBeDefined();
  expect(resolve?.({ provider: id, config: cfg })).toBeUndefined();
  vi.mocked(getPreparedPluginSecretInput).mockReturnValue({ value: ` ${key}\n`, revision: 1 });
  expect(resolve?.({ provider: id, config: cfg })).toMatchObject({ apiKey: key, mode: "api-key" });
  expect(getPreparedPluginSecretInput).toHaveBeenLastCalledWith(
    "microsoft-foundry",
    "decision.apiKey",
  );
});

it.each([
  { resourceHost: "other.services.ai.azure.com", deployment },
  { resourceHost: host, deployment: "other-deployment" },
])(
  "never sends a prepared request to a different live resource or deployment",
  async (decision) => {
    const alternate = { plugins: { entries: { "microsoft-foundry": { config: { decision } } } } };
    const provider = buildFoundryDecisionProvider(() => alternate);
    expect(
      provider.provider?.resolveSyntheticAuth?.({ provider: id, config: cfg }),
    ).toBeUndefined();
    expect(getPreparedPluginSecretInput).not.toHaveBeenCalled();
    expect(await provider.evaluate(batch, context())).toEqual({
      status: "unavailable",
      reason: "transport",
    });
    expect(fetchWithProviderHttpGuard).not.toHaveBeenCalled();
  },
);

it("sends one tightly scoped request and decodes mixed results with shared System One semantics", async () => {
  const release = respond();
  expect(await buildFoundryDecisionProvider(() => cfg).evaluate(batch, context())).toEqual({
    status: "ok",
    result: {
      model: reply.model,
      answers: {
        billed: { type: "boolean", probabilityTrue: 0.9 },
        team: reply.answers.team,
        severity: { type: "score", score: 0.27, probabilities: [0.7, 0.3] },
      },
      usage: { inputTokens: 70, outputTokens: 0 },
    },
  });
  expect(fetchWithProviderHttpGuard).toHaveBeenCalledOnce();
  const [request] = vi.mocked(fetchWithProviderHttpGuard).mock.calls[0]!;
  expect(request).toMatchObject({
    url: `https://${host}/providers/microsoft/v1/systemone`,
    requireHttps: true,
    maxRedirects: 0,
    capture: false,
    init: { method: "POST" },
  });
  expect(request.policy).toEqual({ hostnameAllowlist: [host] });
  const headers = new Headers(request.init?.headers);
  expect([headers.get("api-key"), headers.get("authorization")]).toEqual([key, null]);
  expect(JSON.parse(String(request.init?.body))).toEqual({
    model: deployment,
    state: batch.state.value,
    questions: {
      ...batch.questions,
      billed: { type: "noul", instructions: '{"condition":"mentions billing"}' },
    },
  });
  expect(release).toHaveBeenCalledOnce();
});

it("keeps a guarded POST from following a redirect with evidence or credentials", async () => {
  // Keep the mock Azure host and real loopback server off the host's ambient proxy.
  vi.stubEnv("NO_PROXY", `${host},127.0.0.1`);
  vi.stubEnv("no_proxy", `${host},127.0.0.1`);
  const paths: (string | undefined)[] = [];
  await withServer(
    (request, response) => {
      paths.push(request.url);
      request.resume();
      response.writeHead(307, { location: "/unexpected-second-arrival" }).end();
    },
    async (origin) => {
      vi.mocked(fetchWithProviderHttpGuard).mockImplementation((request) =>
        fetchWithSsrFGuard({
          ...request,
          // Only the test can redirect the transport to loopback.
          url: `${origin}/providers/microsoft/v1/systemone`,
          requireHttps: false,
          policy: { allowedHostnames: ["127.0.0.1"] },
        }),
      );
      expect(await buildFoundryDecisionProvider(() => cfg).evaluate(batch, context())).toEqual({
        status: "unavailable",
        reason: "transport",
      });
      expect(paths).toEqual(["/providers/microsoft/v1/systemone"]);
    },
  );
});

it("keeps the fixed Foundry route while applying prepared proxy and TLS policy", async () => {
  respond();
  const prepared = context({
    model: attachModelProviderRequestTransport(
      { ...context().model, baseUrl: "https://unused.fixture.test/v1" },
      {
        proxy: { mode: "env-proxy", tls: { ca: "fixture-proxy-ca" } },
        tls: { ca: "fixture-target-ca" },
      },
    ),
  });
  await expect(
    buildFoundryDecisionProvider(() => cfg).evaluate(batch, prepared),
  ).resolves.toMatchObject({
    status: "ok",
  });
  expect(fetchWithProviderHttpGuard).toHaveBeenCalledWith(
    expect.objectContaining({
      url: `https://${host}/providers/microsoft/v1/systemone`,
      dispatcherPolicy: {
        mode: "env-proxy",
        connect: { ca: "fixture-target-ca" },
        proxyTls: { ca: "fixture-proxy-ca" },
      },
    }),
  );
});

it("keeps prepared model headers and auth overrides off the resource-bound wire request", async () => {
  respond();
  const preparedModel = attachModelProviderRequestTransport(
    { ...context().model, headers: { "Api-Key": "wrong-key", Authorization: "Bearer other" } },
    { auth: { mode: "header", headerName: "Api-Key", value: "wrong-key" } },
  );
  await expect(
    buildFoundryDecisionProvider(() => cfg).evaluate(batch, context({ model: preparedModel })),
  ).resolves.toMatchObject({ status: "ok" });
  const headers = new Headers(
    vi.mocked(fetchWithProviderHttpGuard).mock.calls[0]?.[0].init?.headers,
  );
  expect([headers.get("api-key"), headers.get("authorization")]).toEqual([key, null]);
});

it("keeps the admitted route through DNS and refuses a later request with the old binding", async () => {
  vi.stubEnv("NO_PROXY", host);
  vi.stubEnv("no_proxy", host);
  let live = cfg;
  const provider = buildFoundryDecisionProvider(() => live);
  const send = vi.fn<typeof fetch>().mockResolvedValue(Response.json(reply));
  vi.mocked(fetchWithProviderHttpGuard).mockImplementationOnce((request) =>
    fetchWithSsrFGuard({
      ...request,
      fetchImpl: send,
      lookupFn: async () => {
        live = {
          plugins: {
            entries: {
              "microsoft-foundry": {
                config: { decision: { resourceHost: host, deployment: "replacement" } },
              },
            },
          },
        };
        return [{ address: "93.184.216.34", family: 4 }];
      },
    }),
  );
  await expect(provider.evaluate(batch, context())).resolves.toMatchObject({ status: "ok" });
  expect(send).toHaveBeenCalledOnce();
  const [url, init] = send.mock.calls[0]!;
  expect(url).toBe(`https://${host}/providers/microsoft/v1/systemone`);
  expect(new Headers(init?.headers).get("api-key")).toBe(key);
  expect(JSON.parse(String(init?.body))).toMatchObject({ model: deployment });

  await expect(provider.evaluate(batch, context())).resolves.toEqual({
    status: "unavailable",
    reason: "transport",
  });
  expect(fetchWithProviderHttpGuard).toHaveBeenCalledOnce();
});

it("classifies Foundry HTTP 415 as unsupported input without retry or raw diagnostics", async () => {
  respond({ message: key }, 415);
  expect(await buildFoundryDecisionProvider(() => cfg).evaluate(batch, context())).toEqual({
    status: "unavailable",
    reason: "unsupported-input",
  });
  expect(fetchWithProviderHttpGuard).toHaveBeenCalledOnce();
});

it.each([
  { ...reply, model: "Microsoft-Decision-1" },
  { ...reply, refusal: "synthetic refusal" },
  { ...reply, provider: key },
  {
    ...reply,
    answers: {
      ...reply.answers,
      severity: { ...reply.answers.severity, legend: { 0: "High", 1: "Low" } },
    },
  },
])("fails closed on a malformed, refused, or credential-reflecting result %#", async (payload) => {
  respond(payload);
  expect(await buildFoundryDecisionProvider(() => cfg).evaluate(batch, context())).toEqual({
    status: "unavailable",
    reason: "invalid-response",
  });
});
