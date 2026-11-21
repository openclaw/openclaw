import type { DecisionBatchV2, DecisionProviderContextV2 } from "openclaw/plugin-sdk/decisions";
import { getPreparedPluginSecretInput } from "openclaw/plugin-sdk/secret-input-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { beforeEach, expect, it, vi } from "vitest";
import { buildFoundryDecisionProvider } from "./decision-provider.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

vi.mock("openclaw/plugin-sdk/secret-input-runtime", () => ({
  getPreparedPluginSecretInput: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: vi.fn() }));

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
  vi.mocked(fetchWithSsrFGuard).mockImplementation(async (request) => {
    request.beforeRequest?.();
    return { response: Response.json(payload, { status }), release, finalUrl: request.url };
  });
  return release;
}

beforeEach(() => {
  vi.mocked(getPreparedPluginSecretInput).mockReset().mockReturnValue({ revision: 1 });
  vi.mocked(fetchWithSsrFGuard).mockReset();
});

it("declares a separate plugin-owned route and reads only its prepared credential", () => {
  const route = buildFoundryDecisionProvider(() => cfg);
  expect(manifest.contracts.decisionProviders).toEqual([route.id]);
  expect(manifest.modelCatalog.providers[id].authScope).toBe(route.provider?.authScope);
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
    expect(fetchWithSsrFGuard).not.toHaveBeenCalled();
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
  expect(fetchWithSsrFGuard).toHaveBeenCalledOnce();
  const [request] = vi.mocked(fetchWithSsrFGuard).mock.calls[0]!;
  expect(request).toMatchObject({
    url: `https://${host}/providers/microsoft/v1/systemone`,
    requireHttps: true,
    policy: { hostnameAllowlist: [host] },
    maxRedirects: 0,
    capture: false,
    init: { method: "POST", headers: { "api-key": key } },
  });
  expect(new Headers(request.init?.headers).get("authorization")).toBeNull();
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
  const { fetchWithSsrFGuard: guardedFetch } = await vi.importActual<
    typeof import("openclaw/plugin-sdk/ssrf-runtime")
  >("openclaw/plugin-sdk/ssrf-runtime");
  const paths: (string | undefined)[] = [];
  await withServer(
    (request, response) => {
      paths.push(request.url);
      request.resume();
      response.writeHead(307, { location: "/unexpected-second-arrival" }).end();
    },
    async (origin) => {
      vi.mocked(fetchWithSsrFGuard).mockImplementation((request) =>
        guardedFetch({
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

it.each([
  [307, "transport"],
  [401, "authentication"],
  [429, "rate-limited"],
  [503, "transport"],
] as const)("classifies HTTP %s without retry or raw diagnostics", async (status, reason) => {
  respond({ message: key }, status);
  expect(await buildFoundryDecisionProvider(() => cfg).evaluate(batch, context())).toEqual({
    status: "unavailable",
    reason,
  });
  expect(fetchWithSsrFGuard).toHaveBeenCalledOnce();
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

it("rechecks request admission just before dispatch and propagates caller cancellation", async () => {
  const send = vi.fn();
  let allowed = true;
  vi.mocked(fetchWithSsrFGuard).mockImplementation(async (request) => {
    allowed = false;
    request.beforeRequest?.();
    return send();
  });
  const provider = buildFoundryDecisionProvider(() => cfg);
  expect(await provider.evaluate(batch, context({ isAdmissible: () => allowed }))).toEqual({
    status: "unavailable",
    reason: "transport",
  });
  expect(send).not.toHaveBeenCalled();
  const cancelled = new Error("fixture cancellation");
  await expect(
    provider.evaluate(batch, context({ signal: AbortSignal.abort(cancelled) })),
  ).rejects.toBe(cancelled);
});
