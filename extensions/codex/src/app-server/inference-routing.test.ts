import { createNativeSessionBindingScope } from "openclaw/plugin-sdk/agent-harness-session-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CodexInferenceAuthorizationError,
  createCodexInferenceModelBinding,
} from "./inference-dispatch.js";
import { readCodexInferenceMetadata } from "./inference-metadata.js";
import {
  ownCodexInferenceClient as ownClient,
  prepareCodexInferenceThreadConfig as prepareConfig,
  assertCodexInferenceRouteConfig as assertRoute,
  bindCodexInferenceThread as bindThread,
  getCodexInferenceThread as threadRoute,
  getCodexInferenceThreadQualification as qualifyThread,
} from "./inference-routing.js";
import type { CodexConfigReadResponse, JsonObject } from "./protocol.js";
import type { CodexBindingAuthority } from "./session-binding.js";
import { createClientHarness, stubCodexInferenceTransportEnv } from "./test-support.js";
import { fingerprintCodexThreadConfig } from "./thread-fingerprints.js";

const clients: ReturnType<typeof createClientHarness>[] = [];
const openaiUrl = "https://api.openai.com/v1";
const chatgptUrl = "https://chatgpt.com/backend-api/codex";
const proxyUrl = "http://proxy.example:80";
const bothProxies = { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl };
type ThreadParams = Parameters<typeof prepareConfig>[0];
type ModelParams = Parameters<typeof createCodexInferenceModelBinding>[0];
type ModelRequest = Parameters<ReturnType<typeof createCodexInferenceModelBinding>>[0];
beforeEach(stubCodexInferenceTransportEnv);
afterEach(() => {
  for (const entry of clients.splice(0)) {
    entry.client.close();
  }
  vi.unstubAllEnvs();
});
function harness(options?: Parameters<typeof createClientHarness>[0]) {
  const value = createClientHarness(options);
  clients.push(value);
  return value;
}
function owned(h = harness()) {
  ownClient(h.client);
  return h;
}
const snapshot = (config: JsonObject = {}): CodexConfigReadResponse => ({ config, origins: {} });
const makeProvider = (name: string, extra: JsonObject = {}) => ({
  name,
  base_url: `https://${name.toLowerCase()}.example/v1`,
  ...extra,
});
const captureDefaults = {
  assertCurrent: () => {},
  release: () => {},
  cancel: () => {},
  nativeReviewRequired: false,
  recordNativeReviewRequirement: () => {},
};
function required<T>(value: T | undefined): T {
  if (!value) {
    throw new Error("expected an owned route");
  }
  return value;
}
function prepareThread(
  client: ReturnType<typeof createClientHarness>["client"],
  effectiveConfig?: CodexConfigReadResponse,
  overrides: Partial<ThreadParams> = {},
) {
  return prepareConfig(threadParams(client, { effectiveConfig, ...overrides }));
}
function threadParams(client: ThreadParams["client"], overrides: Partial<ThreadParams> = {}) {
  return {
    client,
    binding: undefined,
    clientId: "fixture-native-client",
    cwd: "/workspace",
    assertCurrent: () => {},
    ...overrides,
  };
}
function modelBinding(
  client: ModelParams["client"],
  overrides: Pick<ModelParams, "captureModelSource"> & Partial<ModelParams>,
) {
  return createCodexInferenceModelBinding({
    client,
    provider: "fixture",
    assertCurrent: () => {},
    memoryConfigured: () => false,
    resolveModelThreadId: () => undefined,
    ...overrides,
  });
}
const requestFor = (signal: AbortSignal, overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  path: "/responses",
  body: { model: "a" },
  metadata: { requestKind: "turn", threadId: "root", turnId: "turn" },
  headers: {},
  transport: "http" as const,
  signal,
  ...overrides,
});
const configFor = (shape: "nested" | "flat", definition: JsonObject): JsonObject =>
  shape === "nested"
    ? { model_providers: { configured: definition } }
    : { "model_providers.configured": definition };
type RouteArgs = Parameters<typeof assertRoute>;
function routeCheck(client: RouteArgs[0], route: RouteArgs[1]) {
  return (config: RouteArgs[2], provider?: RouteArgs[3], providers?: RouteArgs[4]) => () =>
    assertRoute(client, route, config, provider, providers);
}
function accountHarness(type: string | null = "apiKey", configRead?: CodexConfigReadResponse) {
  return harness({
    onWrite(line, send) {
      const request = JSON.parse(line);
      if (request.method === "config/read" && configRead) {
        send({ id: request.id, result: configRead });
      } else {
        expect(request.method).toBe("account/read");
        send({ id: request.id, result: { account: type === null ? null : { type } } });
      }
    },
  });
}

async function prepare(
  h: ReturnType<typeof harness>,
  type: string,
  effectiveConfig: CodexConfigReadResponse = snapshot(),
  oauth = false,
) {
  const index = h.writes.length;
  const pending = prepareThread(h.client, effectiveConfig);
  const request = JSON.parse(await h.waitForWrite(index));
  expect(request.method).toBe("account/read");
  h.send({ id: request.id, result: { account: { type } } });
  const prepared = required(await pending);
  if (!oauth) {
    expect(prepared.config).toEqual({ openai_base_url: prepared.route.baseUrl });
  } else {
    expect(prepared.config).toEqual({
      model_provider: "openclaw_token_sharing",
      model_providers: {
        openclaw_token_sharing: {
          name: "OpenClaw subscription sharing",
          base_url: prepared.route.baseUrl,
          wire_api: "responses",
          requires_openai_auth: true,
          supports_websockets: false,
        },
      },
    });
    const check = routeCheck(h.client, prepared.route);
    expect(check(prepared.config, "openclaw_token_sharing")).not.toThrow();
    expect(check(prepared.config, "openai")).toThrow();
  }
  return prepared.route;
}

it("keeps proxy restarts equivalent without losing inference policy identity", async () => {
  const fingerprint = async (modelPolicyEnforced: boolean) => {
    const h = owned(accountHarness());
    const prepared = required(await prepareThread(h.client, snapshot(), { modelPolicyEnforced }));
    return fingerprintCodexThreadConfig(
      { config: prepared.config },
      undefined,
      undefined,
      undefined,
      { inferenceRoute: prepared.route, inferenceProviderRoutes: prepared.providers },
    );
  };
  const enforced = await fingerprint(true);
  expect(await fingerprint(true)).toBe(enforced);
  expect(await fingerprint(false)).not.toBe(enforced);
});

it.each(["thread/closed", "thread/archived", "thread/deleted"] as const)(
  "releases bounded provenance on %s, preserving peers",
  async (method) => {
    const h = owned();
    const route = await prepare(h, "apiKey");
    for (let index = 0; index < 256; index += 1) {
      bindThread(h.client, `thread-${index}`, route);
    }
    expect(() => bindThread(h.client, "replacement", route)).toThrow("thread limit reached");
    h.send({ method, params: { threadId: "thread-0" } });
    expect(threadRoute(h.client, "thread-0")).toBeUndefined();
    expect(threadRoute(h.client, "thread-1")).toBe(route);
    expect(() => bindThread(h.client, "replacement", route)).not.toThrow();
    expect(threadRoute(h.client, "replacement")).toBe(route);
  },
);

it.each([
  { preparedConfig: false, rejectAdmission: 0 },
  { preparedConfig: true, rejectAdmission: 0 },
  { preparedConfig: true, rejectAdmission: 2 },
  { preparedConfig: true, rejectAdmission: 3 },
])("admits current route owners (%j)", async ({ preparedConfig, rejectAdmission }) => {
  let retained = false;
  let admissions = 0;
  let accountType = "apiKey";
  const failure = new Error("route owner superseded");
  const authority: CodexBindingAuthority = {
    ...createNativeSessionBindingScope(() => {}),
    withCurrent: async (consume) => {
      if (++admissions === rejectAdmission) {
        throw failure;
      }
      retained = true;
      try {
        return consume();
      } finally {
        retained = false;
      }
    },
  };
  const h = harness({
    onWrite(line, send) {
      expect(retained).toBe(true);
      const request = JSON.parse(line);
      expect(["config/read", "account/read"]).toContain(request.method);
      send({
        id: request.id,
        result: request.method === "config/read" ? snapshot() : { account: { type: accountType } },
      });
    },
  });
  owned(h);
  const protect = vi.spyOn(h.client, "protectPrivateTransportSecret");
  const input = threadParams(h.client, {
    effectiveConfig: preparedConfig
      ? snapshot(rejectAdmission ? { features: { memories: true } } : {})
      : undefined,
    assertCurrent: authority.assertCurrent,
    authority,
  });
  if (rejectAdmission) {
    await expect(prepareConfig(input)).rejects.toBe(failure);
    expect(protect).not.toHaveBeenCalled();
    expect(h.writes).toHaveLength(1);
    // A refused owner update must not leave the old auth route installed.
    if (rejectAdmission === 2) {
      accountType = "chatgpt";
    }
  }
  const route = required((await prepareConfig(input))?.route);
  expect(protect).toHaveBeenCalledOnce();
  expect(retained).toBe(false);
  if (rejectAdmission) {
    expect(route.upstream).toBe(accountType === "chatgpt" ? chatgptUrl : openaiUrl);
  } else {
    expect(admissions).toBe(preparedConfig ? 3 : 4);
    expect(h.writes.map((line) => JSON.parse(line).method)).toEqual(
      preparedConfig ? ["account/read"] : ["config/read", "account/read"],
    );
  }
});

it.each([false, true])("qualifies phase1 memory (configured=%s)", async (configured) => {
  const h = harness();
  const captureModelSource = vi.fn(async () => undefined);
  const bind = modelBinding(h.client, {
    memoryConfigured: () => configured,
    captureModelSource,
  });
  // Stock detached extraction omits nested thread identity and has no phase2 subagent tag.
  const body = {
    model: "phase1-model",
    client_metadata: {
      thread_id: "seed-thread",
      "x-codex-turn-metadata": JSON.stringify({
        request_kind: "memory",
        thread_source: "memory_consolidation",
      }),
    },
  };
  const metadata = readCodexInferenceMetadata(body);
  expect(metadata.subagent).toBeUndefined();
  const pending = bind(requestFor(new AbortController().signal, { body, metadata }));
  if (configured) {
    const execution = await pending;
    execution.assertCurrent();
    execution.release();
  } else {
    await expect(pending).rejects.toThrow(CodexInferenceAuthorizationError);
  }
  expect(captureModelSource).not.toHaveBeenCalled();
});

it("keeps the selected provider when excess optional routes fill the client budget", async () => {
  const h = owned(accountHarness(null));
  const effectiveConfig = snapshot({
    model_provider: "provider8",
    model_providers: Object.fromEntries(
      Array.from({ length: 9 }, (_, i) => [`provider${i}`, makeProvider(`provider${i}`)]),
    ),
  });
  const input = threadParams(h.client, { effectiveConfig, operatorBacked: true });
  const prepared = required(await prepareConfig(input));
  expect(prepared.route.upstream).toBe("https://provider8.example/v1");
  expect(prepared.providers?.size).toBe(8);
  bindThread(h.client, "parent", prepared.route, prepared.providers);
  const qualification = qualifyThread(h.client, "parent");
  expect(
    ["provider8", "provider0", "provider7"].map((id) => qualification?.hasProvider(id)),
  ).toEqual([true, true, false]);
  expect(prepared.config).not.toHaveProperty("model_providers.provider7");
  await expect(prepareConfig({ ...input, modelProvider: "provider7" })).rejects.toThrow(
    "inference route limit reached",
  );
});

it.each(["/alpha/search", "/images/generations"])("binds %s ownership", async (path) => {
  const h = harness();
  const controller = new AbortController();
  const release = vi.fn();
  const cancel = vi.fn();
  const resolveModelThreadId = vi.fn((): string | undefined => "root");
  const model = vi.fn((ref: { provider: string; model: string } | undefined) => {
    if (ref?.model !== "allowed") {
      throw new Error("model denied");
    }
    return { assertCurrent: () => {}, signal: controller.signal, release };
  });
  const source = { assertCurrent: () => {}, release: () => {}, bindModelExecution: model };
  const captureModelSource = vi.fn(async () => ({ ...captureDefaults, source, cancel }));
  const bind = modelBinding(h.client, { resolveModelThreadId, captureModelSource });
  const image = path.startsWith("/images/");
  const request = requestFor(controller.signal, {
    path,
    body: { model: "allowed" },
    metadata: image
      ? { nativeImageTurnId: "native-turn" }
      : { requestKind: "turn", threadId: "root", turnId: "native-turn" },
  });
  const execution = await bind(request);
  execution.assertCurrent();
  expect(captureModelSource).toHaveBeenCalledWith(
    expect.objectContaining({ client: h.client, threadId: "root", turnId: "native-turn" }),
  );
  expect(model).toHaveBeenCalledWith({ provider: "fixture", model: "allowed" });
  execution.release();
  expect(release).toHaveBeenCalledOnce();
  await expect(bind({ ...request, body: { model: "denied" } })).rejects.toThrow(
    "operator role cannot use this model",
  );
  if (image) {
    expect(cancel).not.toHaveBeenCalled();
    const parent = await bind({
      ...request,
      path: "/responses",
      metadata: { requestKind: "turn", threadId: "root", turnId: "native-turn" },
    });
    parent.assertCurrent();
    parent.release();
    expect(resolveModelThreadId).toHaveBeenCalledWith({
      client: h.client,
      turnId: "native-turn",
    });
    resolveModelThreadId.mockReturnValue(undefined);
    await expect(bind(request)).rejects.toThrow("cannot verify the owner");
    expect(captureModelSource).toHaveBeenCalledTimes(3);
  } else {
    expect(cancel).toHaveBeenCalledOnce();
    expect(resolveModelThreadId).not.toHaveBeenCalled();
  }
});

it.each(["capture", "source", "before forwarding"] as const)("sanitizes %s", async (stage) => {
  const h = harness();
  const controller = new AbortController();
  const release = vi.fn();
  const modelRelease = vi.fn();
  const privateFailure = new Error("synthetic private owner details");
  let stale = stage !== "before forwarding";
  const assertCurrent = () => {
    if (stale) {
      throw privateFailure;
    }
  };
  const source = {
    assertCurrent,
    release: () => {},
    bindModelExecution: () => ({
      assertCurrent: () => {},
      signal: controller.signal,
      release: modelRelease,
    }),
  };
  const bind = modelBinding(h.client, {
    captureModelSource: async () => {
      if (stage === "capture") {
        throw privateFailure;
      }
      return { ...captureDefaults, source, assertCurrent, release };
    },
  });
  const pending = bind(requestFor(controller.signal));
  if (stage === "before forwarding") {
    const execution = await pending;
    stale = true;
    expect(() => execution.assertCurrent()).toThrow(CodexInferenceAuthorizationError);
    controller.abort(privateFailure);
    expect(() => execution.assertCurrent()).toThrow(privateFailure);
    execution.release();
    expect(modelRelease).toHaveBeenCalledOnce();
  } else {
    await expect(pending).rejects.toThrow(CodexInferenceAuthorizationError);
    await expect(pending).rejects.toThrow("cannot verify the owner");
    expect(modelRelease).not.toHaveBeenCalled();
  }
  expect(release).toHaveBeenCalledTimes(stage === "capture" ? 0 : 1);
});

it.each([false, true])("projects only operator-backed routes (%s)", async (operatorBacked) => {
  const effectiveConfig = snapshot({
    model_provider: "current",
    model_providers: {
      current: makeProvider("Current"),
      restored: makeProvider("azure", { base_url: "https://restored.example/v1" }),
      signed: makeProvider("Signed", { aws: {} }),
    },
  });
  const config = {
    "model_providers.flat": makeProvider("Flat", {
      env_key: "SYNTHETIC_PROVIDER_KEY",
      query_params: { region: "synthetic" },
      http_headers: { "x-synthetic-routing": "keep" },
    }),
  };
  const original = structuredClone({ effectiveConfig, config });
  const h = owned(accountHarness("apiKey", effectiveConfig));
  const prepared = required(await prepareThread(h.client, undefined, { config, operatorBacked }));
  expect({ effectiveConfig, config }).toEqual(original);
  expect(h.writes.map((line) => JSON.parse(line).method)).toEqual(
    operatorBacked ? ["config/read", "account/read"] : ["config/read"],
  );
  expect(prepared.route.upstream).toBe("https://current.example/v1");
  expect(
    ["restored", "flat", "openai", "signed"].map((id) => prepared.providers?.has(id) ?? false),
  ).toEqual([operatorBacked, operatorBacked, operatorBacked, false]);
  expect(prepared.config["model_providers.flat"]).toEqual({
    ...config["model_providers.flat"],
    base_url: prepared.providers?.get("flat")?.baseUrl ?? "https://flat.example/v1",
  });
  const check = routeCheck(h.client, prepared.route);
  expect(check(prepared.config, "current", prepared.providers)).not.toThrow();
  bindThread(h.client, "parent", prepared.route, prepared.providers);
  const captured = qualifyThread(h.client, "parent");
  expect(captured?.hasProvider("restored")).toBe(operatorBacked);
  expect(captured?.hasProvider("signed")).toBe(false);
  if (operatorBacked) {
    const bypass = { "model_providers.restored.base_url": "https://bypass.example" };
    expect(check({ ...prepared.config, ...bypass }, "current", prepared.providers)).toThrow(
      "overridden",
    );
    // A later parent configuration does not rewrite an older child's captured provenance.
    bindThread(h.client, "parent", prepared.route);
    expect(qualifyThread(h.client, "parent")?.hasProvider("restored")).toBe(false);
    expect(captured?.hasProvider("restored")).toBe(true);
  }
  h.client.close();
  expect(() => captured?.assertCurrent()).toThrow("closed");
});

it("fails closed for host OAuth on native backend and custom provider configurations", async () => {
  const h = harness();
  ownClient(h.client, {}, { resolve: vi.fn() });
  const configs: CodexConfigReadResponse["config"][] = [
    { openai_base_url: "https://chatgpt.com/backend-api/codex" },
    { openai_base_url: "https://models.example.com/v1" },
    { model_provider: "bedrock" },
    { features: { respect_system_proxy: true } },
  ];
  for (const config of configs) {
    await expect(prepareThread(h.client, snapshot(config))).rejects.toThrow("public Responses");
  }
  expect(h.writes).toEqual([]);
  const route = await prepare(h, "apiKey", undefined, true);
  expect(route.upstream).toBe(openaiUrl);
});
it("leaves unowned native clients completely untouched", async () => {
  const h = harness();
  expect(await prepareThread(h.client)).toBeUndefined();
  expect(h.writes).toEqual([]);
});

it("resolves native ChatGPT account state and retains only exact host-owned route trust", async () => {
  const h = owned();
  const route = await prepare(h, "chatgpt");
  expect(route.upstream).toBe(chatgptUrl);
  expect(new URL(route.baseUrl).pathname.endsWith("/backend-api/codex")).toBe(true);
  const config = { openai_base_url: route.baseUrl };
  const check = routeCheck(h.client, route);
  expect(check(config)).not.toThrow();
  expect(check(config, "different-provider")).toThrow("overridden");
  expect(check({ ...config, model_provider: "different-provider" })).toThrow("overridden");
  expect(check({ ...config, "features.respect_system_proxy": true })).toThrow("overridden");
  expect(() => assertRoute(h.client, { ...route }, config)).toThrow("overridden");
  expect(check({ openai_base_url: "http://127.0.0.1:1/v1" })).toThrow("overridden");
  bindThread(h.client, "root", route);
  expect(threadRoute(h.client, "root")).toBe(route);
  bindThread(h.client, "peer", route);
  bindThread(h.client, "root", undefined);
  expect(threadRoute(h.client, "root")).toBeUndefined();
  expect(threadRoute(h.client, "peer") === route).toBe(true);
  expect(() => route.assertCurrent()).not.toThrow();
  h.send({ method: "account/updated", params: { authMode: "chatgptAuthTokens" } });
  expect(await prepare(h, "chatgpt")).toBe(route);
  h.client.close();
  expect(check(config)).toThrow();
});

it("preserves an explicit native upstream and revokes routes on account-mode changes", async () => {
  const h = owned();
  const route = await prepare(h, "chatgpt", snapshot({ openai_base_url: openaiUrl }));
  expect(route.upstream).toBe(openaiUrl);
  h.send({ method: "account/updated", params: { authMode: "apiKey" } });
  expect(() => route.assertCurrent()).toThrow();
  await expect(prepareThread(h.client)).rejects.toThrow("ownership changed");
});

it("keeps the physical client owner across same-build module copies", async () => {
  const h = owned();
  const route = await prepare(h, "apiKey");
  bindThread(h.client, "root", route);
  vi.resetModules();
  const { getCodexInferenceThread: copiedRoute, assertCodexInferenceRouteConfig: copiedAssert } =
    await import("./inference-routing.js");
  expect(copiedRoute(h.client, "root") === route).toBe(true);
  expect(() => copiedAssert(h.client, route, { openai_base_url: route.baseUrl })).not.toThrow();
  h.client.close();
  expect(() => copiedRoute(h.client, "root")).toThrow("closed");
});

const legacyProfiles: CodexConfigReadResponse["config"][] = [
  { model_provider: "bedrock" },
  {
    model_provider: "amazon-bedrock",
    model_providers: { "amazon-bedrock": { base_url: "https://models.example.com/v1" } },
  },
  {
    model_provider: "signed",
    "model_providers.signed.base_url": "https://models.example.com/v1",
    "model_providers.signed.aws.region": "synthetic",
  },
  { features: { respect_system_proxy: true } },
  { openai_base_url: "http://127.0.0.1:1234/v1" },
  { openai_base_url: "https://models.example.com/v1?api-version=synthetic" },
];
async function expectUnsupported(
  config: CodexConfigReadResponse["config"],
  env?: Record<string, string>,
) {
  const h = accountHarness();
  ownClient(h.client, { env });
  await expect(prepareThread(h.client, snapshot(config))).resolves.toBeUndefined();
  expect(h.writes).toEqual([]);
}
it.each(legacyProfiles)("leaves unsupported native config untouched (%j)", (config) =>
  expectUnsupported(config),
);
it.each(["CODEX_CA_CERTIFICATE", "SSL_CERT_FILE", "HTTPS_PROXY"])(
  "leaves native-specific %s transport untouched",
  (key) => expectUnsupported({}, { [key]: "synthetic-native-setting" }),
);

it.each(["nested", "flat"] as const)("preserves %s provider auth/query settings", async (shape) => {
  const h = owned();
  const definition = {
    name: "azure",
    base_url: "https://models.example.com/v1",
    env_key: "SYNTHETIC_PROVIDER_KEY",
    http_headers: { "x-synthetic-routing": "keep" },
    query_params: { "api-version": "synthetic", region: "synthetic" },
    supports_websockets: true,
  };
  const prepared = required(
    await prepareThread(h.client, snapshot({ model_provider: "openai" }), {
      modelProvider: "configured",
      config: configFor(shape, definition),
    }),
  );
  expect(h.writes).toEqual([]);
  expect(prepared.route.upstream).toBe(definition.base_url);
  expect(prepared.route.baseUrl).toContain("/azure-api.");
  const routed = { ...definition, base_url: prepared.route.baseUrl };
  expect(prepared.config).toMatchObject(configFor(shape, routed));
  const check = routeCheck(h.client, prepared.route);
  expect(check(prepared.config, "configured")).not.toThrow();
  expect(check(prepared.config, "openai")).toThrow("overridden");
});

it.each([
  { env: { HTTPS_PROXY: proxyUrl, https_proxy: "http://other.example:80" }, supported: false },
  { env: { HTTP_PROXY: proxyUrl, NO_PROXY: "127.0.0.1" }, supported: false },
  { env: bothProxies, supported: false },
  {
    env: { ...bothProxies, NO_PROXY: "127.0.0.1,localhost" },
    supported: true,
  },
  { env: { HTTPS_PROXY: proxyUrl }, supported: true },
  { env: { HTTPS_PROXY: " " + proxyUrl + " " }, supported: false },
  { env: { HTTPS_PROXY: proxyUrl, REQUEST_METHOD: "GET" }, supported: false },
])("qualifies native/relay proxies (%j)", async ({ env, supported }) => {
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  const h = owned(accountHarness());
  const prepared = await prepareThread(h.client, snapshot());
  expect(prepared !== undefined).toBe(supported);
  if (!supported) {
    expect(h.writes).toEqual([]);
  }
});

it("does not guess an endpoint without native account evidence", async () => {
  const h = owned(accountHarness("unknown"));
  expect(await prepareThread(h.client, snapshot())).toBeUndefined();
});
