import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import {
  CodexInferenceAuthorizationError,
  createCodexInferenceModelBinding,
} from "./inference-dispatch.js";
import { readCodexInferenceMetadata } from "./inference-metadata.js";
import {
  ownCodexInferenceClient,
  prepareCodexInferenceThreadConfig,
  assertCodexInferenceRouteConfig,
  bindCodexInferenceThread,
  getCodexInferenceThread,
  getCodexInferenceThreadQualification,
} from "./inference-routing.js";
import type { CodexConfigReadResponse } from "./protocol.js";
import { createClientHarness } from "./test-support.js";

const clients: ReturnType<typeof createClientHarness>[] = [];
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
function prepareThread(
  client: ReturnType<typeof createClientHarness>["client"],
  effectiveConfig?: CodexConfigReadResponse,
) {
  return prepareCodexInferenceThreadConfig({
    client,
    binding: undefined,
    clientId: "fixture-native-client",
    cwd: "/workspace",
    effectiveConfig,
    assertCurrent: () => {},
  });
}

async function prepare(
  h: ReturnType<typeof harness>,
  type: string,
  snapshot: CodexConfigReadResponse = { config: {}, origins: {} },
) {
  const index = h.writes.length;
  const pending = prepareThread(h.client, snapshot);
  const request = JSON.parse(await h.waitForWrite(index));
  expect(request.method).toBe("account/read");
  h.send({ id: request.id, result: { account: { type } } });
  const prepared = await pending;
  if (!prepared) {
    throw new Error("expected an owned route");
  }
  expect(prepared.config).toEqual({ openai_base_url: prepared.route.baseUrl });
  return prepared.route;
}

describe("managed inference route ownership", () => {
  it.each([false, true])(
    "qualifies stock phase1 memory metadata at the binding boundary (configured=%s)",
    async (configured) => {
      const h = harness();
      const captureModelSource = vi.fn(async () => undefined);
      const bind = createCodexInferenceModelBinding({
        client: h.client,
        provider: "fixture",
        assertCurrent: () => {},
        memoryConfigured: () => configured,
        resolveModelThreadId: () => undefined,
        captureModelSource,
      });
      // Stock detached extraction omits nested thread identity and has no phase2 subagent tag.
      const body = {
        model: "phase1-model",
        client_metadata: {
          "x-codex-installation-id": "fixture-installation",
          "x-codex-window-id": "seed-thread:0",
          session_id: "seed-thread",
          thread_id: "seed-thread",
          turn_id: "extraction-turn",
          root_turn_id: "extraction-turn",
          "x-codex-turn-metadata": JSON.stringify({
            request_kind: "memory",
            thread_source: "memory_consolidation",
            turn_trigger: "memory_consolidation",
            turn_id: "extraction-turn",
            root_turn_id: "extraction-turn",
          }),
        },
      };
      const metadata = readCodexInferenceMetadata(body);
      expect(metadata.subagent).toBeUndefined();
      const pending = bind({
        path: "/responses",
        body,
        metadata,
        headers: {},
        transport: "http",
        signal: new AbortController().signal,
      });
      if (configured) {
        const execution = await pending;
        execution.assertCurrent();
        execution.release();
      } else {
        await expect(pending).rejects.toThrow(CodexInferenceAuthorizationError);
      }
      expect(captureModelSource).not.toHaveBeenCalled();
    },
  );

  it("keeps the selected provider when excess optional routes fill the client budget", async () => {
    const h = harness({
      onWrite(line, send) {
        const request = JSON.parse(line);
        expect(request.method).toBe("account/read");
        send({ id: request.id, result: { account: null } });
      },
    });
    ownCodexInferenceClient(h.client);
    const effectiveConfig: CodexConfigReadResponse = {
      config: {
        model_provider: "provider8",
        model_providers: Object.fromEntries(
          Array.from({ length: 9 }, (_, index) => [
            `provider${index}`,
            { name: `Provider ${index}`, base_url: `https://provider${index}.example/v1` },
          ]),
        ),
      },
      origins: {},
    };
    const input = {
      client: h.client,
      clientId: "fixture-native-client",
      binding: undefined,
      cwd: "/workspace",
      effectiveConfig,
      operatorBacked: true,
      assertCurrent: () => {},
    };
    const prepared = await prepareCodexInferenceThreadConfig(input);
    if (!prepared) {
      throw new Error("expected the selected provider to remain routable");
    }
    expect(prepared.route.upstream).toBe("https://provider8.example/v1");
    expect(prepared.providers?.size).toBe(8);
    bindCodexInferenceThread(h.client, "parent", prepared.route, prepared.providers);
    const qualification = getCodexInferenceThreadQualification(h.client, "parent");
    expect(qualification?.hasProvider("provider8")).toBe(true);
    expect(qualification?.hasProvider("provider0")).toBe(true);
    expect(qualification?.hasProvider("provider7")).toBe(false);
    expect(prepared.config).not.toHaveProperty("model_providers.provider7");
    await expect(
      prepareCodexInferenceThreadConfig({ ...input, modelProvider: "provider7" }),
    ).rejects.toThrow("inference route limit reached");
  });

  it.each(["/alpha/search", "/images/generations", "/images/edits"])(
    "binds the actual native tool model on %s to its live turn owner",
    async (path) => {
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
      const captureModelSource = vi.fn(async () => ({
        source: { assertCurrent: () => {}, release: () => {}, bindModelExecution: model },
        assertCurrent: () => {},
        release: () => {},
        cancel,
        nativeReviewRequired: false,
        recordNativeReviewRequirement: () => {},
      }));
      const bind = createCodexInferenceModelBinding({
        client: h.client,
        provider: "fixture",
        assertCurrent: () => {},
        memoryConfigured: () => false,
        resolveModelThreadId,
        captureModelSource,
      });
      const image = path.startsWith("/images/");
      const request = {
        path,
        body: { model: "allowed" },
        metadata: image
          ? { nativeImageTurnId: "native-turn" }
          : { requestKind: "turn", threadId: "root", turnId: "native-turn" },
        headers: {},
        transport: "http" as const,
        signal: controller.signal,
      };
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
    },
  );

  it.each(["capture", "source", "before forwarding"] as const)(
    "sanitizes an owner failure during %s and releases the acquired capture",
    async (stage) => {
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
      const bind = createCodexInferenceModelBinding({
        client: h.client,
        provider: "fixture",
        assertCurrent: () => {},
        memoryConfigured: () => false,
        resolveModelThreadId: () => undefined,
        captureModelSource: () => {
          if (stage === "capture") {
            throw privateFailure;
          }
          return Promise.resolve({
            source: {
              sourceIdentity: {},
              modelPolicyRequired: true,
              assertCurrent,
              release: () => {},
              bindModelExecution: () => ({
                assertCurrent: () => {},
                signal: controller.signal,
                release: modelRelease,
              }),
            },
            assertCurrent,
            release,
            cancel: () => {},
            nativeReviewRequired: false,
            recordNativeReviewRequirement: () => {},
          });
        },
      });
      const pending = bind({
        path: "/responses",
        body: { model: "a" },
        metadata: { requestKind: "turn", threadId: "root", turnId: "turn" },
        headers: {},
        transport: "http",
        signal: controller.signal,
      });
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
    },
  );

  it.each([false, true])(
    "projects configured provider routes only for an operator-backed parent (%s)",
    async (operatorBacked) => {
      const snapshot: CodexConfigReadResponse = {
        config: {
          model_provider: "current",
          model_providers: {
            current: { name: "Current", base_url: "https://current.example/v1" },
            restored: { name: "azure", base_url: "https://restored.example/v1" },
            signed: { name: "Signed", base_url: "https://signed.example/v1", aws: {} },
          },
        },
        origins: {},
      };
      const config = {
        "model_providers.flat": {
          name: "Flat",
          base_url: "https://flat.example/v1",
          env_key: "SYNTHETIC_PROVIDER_KEY",
          query_params: { region: "synthetic" },
          http_headers: { "x-synthetic-routing": "keep" },
        },
      };
      const original = structuredClone({ snapshot, config });
      const h = harness({
        onWrite(line, send) {
          const request = JSON.parse(line);
          if (request.method === "config/read") {
            send({ id: request.id, result: snapshot });
          } else {
            expect(request.method).toBe("account/read");
            send({ id: request.id, result: { account: { type: "apiKey" } } });
          }
        },
      });
      ownCodexInferenceClient(h.client);
      const prepared = await prepareCodexInferenceThreadConfig({
        client: h.client,
        clientId: "fixture-native-client",
        binding: undefined,
        cwd: "/workspace",
        config,
        operatorBacked,
        assertCurrent: () => {},
      });
      if (!prepared) {
        throw new Error("expected a qualified selected provider");
      }
      expect({ snapshot, config }).toEqual(original);
      expect(h.writes.map((line) => JSON.parse(line).method)).toEqual(
        operatorBacked ? ["config/read", "account/read"] : ["config/read"],
      );
      expect(prepared.route.upstream).toBe("https://current.example/v1");
      expect(prepared.providers?.has("restored") ?? false).toBe(operatorBacked);
      expect(prepared.providers?.has("flat") ?? false).toBe(operatorBacked);
      expect(prepared.providers?.has("openai") ?? false).toBe(operatorBacked);
      expect(prepared.providers?.has("signed") ?? false).toBe(false);
      expect(prepared.config["model_providers.flat"]).toEqual({
        ...config["model_providers.flat"],
        base_url: prepared.providers?.get("flat")?.baseUrl ?? "https://flat.example/v1",
      });
      expect(() =>
        assertCodexInferenceRouteConfig(
          h.client,
          prepared.route,
          prepared.config,
          "current",
          prepared.providers,
        ),
      ).not.toThrow();
      bindCodexInferenceThread(h.client, "parent", prepared.route, prepared.providers);
      const captured = getCodexInferenceThreadQualification(h.client, "parent");
      expect(captured?.hasProvider("restored")).toBe(operatorBacked);
      expect(captured?.hasProvider("signed")).toBe(false);
      if (operatorBacked) {
        expect(() =>
          assertCodexInferenceRouteConfig(
            h.client,
            prepared.route,
            { ...prepared.config, "model_providers.restored.base_url": "https://bypass.example" },
            "current",
            prepared.providers,
          ),
        ).toThrow("overridden");
        // A later parent configuration does not rewrite an older child's captured provenance.
        bindCodexInferenceThread(h.client, "parent", prepared.route);
        expect(
          getCodexInferenceThreadQualification(h.client, "parent")?.hasProvider("restored"),
        ).toBe(false);
        expect(captured?.hasProvider("restored")).toBe(true);
      }
      h.client.close();
      expect(() => captured?.assertCurrent()).toThrow("closed");
    },
  );

  it("leaves unowned native clients completely untouched", async () => {
    const h = harness();
    expect(await prepareThread(h.client)).toBeUndefined();
    expect(h.writes).toEqual([]);
  });

  it.each([
    ["apiKey", "https://api.openai.com/v1"],
    ["chatgpt", "https://chatgpt.com/backend-api/codex"],
  ])(
    "resolves %s from native account state and retains only exact host-owned route trust",
    async (type, upstream) => {
      const h = harness();
      ownCodexInferenceClient(h.client);
      const route = await prepare(h, type);
      expect(route.upstream).toBe(upstream);
      expect(new URL(route.baseUrl).pathname.endsWith("/backend-api/codex")).toBe(true);
      const config = { openai_base_url: route.baseUrl };
      expect(() => assertCodexInferenceRouteConfig(h.client, route, config)).not.toThrow();
      expect(() =>
        assertCodexInferenceRouteConfig(h.client, route, config, "different-provider"),
      ).toThrow("overridden");
      expect(() =>
        assertCodexInferenceRouteConfig(h.client, route, {
          ...config,
          model_provider: "different-provider",
        }),
      ).toThrow("overridden");
      expect(() =>
        assertCodexInferenceRouteConfig(h.client, route, {
          ...config,
          "features.respect_system_proxy": true,
        }),
      ).toThrow("overridden");
      expect(() => assertCodexInferenceRouteConfig(h.client, { ...route }, config)).toThrow(
        "overridden",
      );
      expect(() =>
        assertCodexInferenceRouteConfig(h.client, route, {
          openai_base_url: "http://127.0.0.1:1/v1",
        }),
      ).toThrow("overridden");
      bindCodexInferenceThread(h.client, "root", route);
      expect(getCodexInferenceThread(h.client, "root")).toBe(route);
      bindCodexInferenceThread(h.client, "peer", route);
      bindCodexInferenceThread(h.client, "root", undefined);
      expect(getCodexInferenceThread(h.client, "root")).toBeUndefined();
      expect(getCodexInferenceThread(h.client, "peer") === route).toBe(true);
      expect(() => route.assertCurrent()).not.toThrow();
      h.send({
        method: "account/updated",
        params: { authMode: type === "chatgpt" ? "chatgptAuthTokens" : "apiKey" },
      });
      expect(await prepare(h, type)).toBe(route);
      h.client.close();
      expect(() => assertCodexInferenceRouteConfig(h.client, route, config)).toThrow();
    },
  );

  it("preserves an explicit native upstream and revokes routes on account-mode changes", async () => {
    const h = harness();
    ownCodexInferenceClient(h.client);
    const route = await prepare(h, "chatgpt", {
      config: { openai_base_url: "https://api.openai.com/v1" },
      origins: {},
    });
    expect(route.upstream).toBe("https://api.openai.com/v1");
    h.send({ method: "account/updated", params: { authMode: "apiKey" } });
    expect(() => route.assertCurrent()).toThrow();
    await expect(prepareThread(h.client)).rejects.toThrow("ownership changed");
  });

  it("keeps the physical client owner across same-build module copies", async () => {
    const h = harness();
    ownCodexInferenceClient(h.client);
    const route = await prepare(h, "apiKey");
    bindCodexInferenceThread(h.client, "root", route);
    vi.resetModules();
    const copy = await import("./inference-routing.js");
    expect(copy.getCodexInferenceThread(h.client, "root") === route).toBe(true);
    expect(() =>
      copy.assertCodexInferenceRouteConfig(h.client, route, { openai_base_url: route.baseUrl }),
    ).not.toThrow();
    h.client.close();
    expect(() => copy.getCodexInferenceThread(h.client, "root")).toThrow("closed");
  });

  const legacyProfiles: CodexConfigReadResponse["config"][] = [
    { model_provider: "bedrock" },
    {
      model_provider: "amazon-bedrock",
      model_providers: { "amazon-bedrock": { base_url: "https://models.example.com/v1" } },
    },
    {
      model_provider: "ollama",
      model_providers: { ollama: { base_url: "https://models.example.com/v1" } },
    },
    {
      model_provider: "signed",
      model_providers: { signed: { base_url: "https://models.example.com/v1", aws: {} } },
    },
    {
      model_provider: "signed",
      "model_providers.signed.base_url": "https://models.example.com/v1",
      "model_providers.signed.aws.region": "synthetic",
    },
    { features: { respect_system_proxy: true } },
    { openai_base_url: "http://127.0.0.1:1234/v1" },
    { openai_base_url: "https://models.example.com/v1?api-version=synthetic" },
    { openai_base_url: "https://models.example.com/v1?" },
  ];
  it.each(legacyProfiles)(
    "preserves unsupported native profiles without redirecting them (%j)",
    async (config) => {
      const fake = createFakeCodexAppServerClient(async () => ({ account: { type: "apiKey" } }));
      ownCodexInferenceClient(fake.client);
      try {
        const outcome = await prepareThread(fake.client, { config, origins: {} }).then(
          (prepared) => ({ route: prepared?.route }),
          (error: unknown) => ({ error }),
        );
        expect(fake.request).not.toHaveBeenCalled();
        expect("error" in outcome).toBe(false);
        expect("route" in outcome && outcome.route === undefined).toBe(true);
      } finally {
        fake.close();
      }
    },
  );

  it("keeps the configured OpenAI-compatible endpoint on an owned route", async () => {
    const h = harness();
    ownCodexInferenceClient(h.client);
    const route = await prepare(h, "apiKey", {
      config: { openai_base_url: "https://models.example.com/v1" },
      origins: {},
    });
    expect(route.upstream).toBe("https://models.example.com/v1");
  });

  it.each(["nested", "flat"] as const)(
    "routes a %s custom Responses provider without changing native authentication or query settings",
    async (shape) => {
      const h = harness();
      ownCodexInferenceClient(h.client);
      const definition = {
        name: "azure",
        base_url: "https://models.example.com/v1",
        env_key: "SYNTHETIC_PROVIDER_KEY",
        http_headers: { "x-synthetic-routing": "keep" },
        query_params: { "api-version": "synthetic", region: "synthetic" },
        supports_websockets: true,
      };
      const prepared = await prepareCodexInferenceThreadConfig({
        client: h.client,
        clientId: "fixture-native-client",
        binding: undefined,
        cwd: "/workspace",
        modelProvider: "configured",
        config:
          shape === "nested"
            ? { model_providers: { configured: definition } }
            : { "model_providers.configured": definition },
        effectiveConfig: { config: { model_provider: "openai" }, origins: {} },
        assertCurrent: () => {},
      });
      if (!prepared) {
        throw new Error("expected an owned custom provider route");
      }
      expect(h.writes).toEqual([]);
      expect(prepared.route.upstream).toBe(definition.base_url);
      expect(prepared.route.baseUrl).toContain("/azure-api.");
      expect(prepared.config).toMatchObject(
        shape === "nested"
          ? {
              model_providers: {
                configured: { ...definition, base_url: prepared.route.baseUrl },
              },
            }
          : {
              "model_providers.configured": { ...definition, base_url: prepared.route.baseUrl },
            },
      );
      expect(() =>
        assertCodexInferenceRouteConfig(h.client, prepared.route, prepared.config, "configured"),
      ).not.toThrow();
      expect(() =>
        assertCodexInferenceRouteConfig(h.client, prepared.route, prepared.config, "openai"),
      ).toThrow("overridden");
    },
  );

  it.each(["CODEX_CA_CERTIFICATE", "SSL_CERT_FILE", "HTTPS_PROXY"])(
    "leaves a native-specific %s transport untouched",
    async (key) => {
      const fake = createFakeCodexAppServerClient(async () => ({ account: { type: "apiKey" } }));
      ownCodexInferenceClient(fake.client, { env: { [key]: "synthetic-native-setting" } });
      try {
        expect(await prepareThread(fake.client, { config: {}, origins: {} })).toBeUndefined();
        expect(fake.request).not.toHaveBeenCalled();
      } finally {
        fake.close();
      }
    },
  );

  it.each([
    {
      env: { HTTPS_PROXY: "http://proxy.example:80", https_proxy: "http://other.example:80" },
      supported: false,
    },
    { env: { HTTP_PROXY: "http://proxy.example:80", NO_PROXY: "127.0.0.1" }, supported: false },
    {
      env: { HTTP_PROXY: "http://proxy.example:80", HTTPS_PROXY: "http://proxy.example:80" },
      supported: false,
    },
    {
      env: {
        HTTP_PROXY: "http://proxy.example:80",
        HTTPS_PROXY: "http://proxy.example:80",
        NO_PROXY: "127.0.0.1,localhost",
      },
      supported: true,
    },
    { env: { HTTPS_PROXY: "http://proxy.example:80" }, supported: true },
    { env: { HTTPS_PROXY: " http://proxy.example:80 " }, supported: false },
    { env: { HTTPS_PROXY: "http://proxy.example:80", REQUEST_METHOD: "GET" }, supported: false },
  ])(
    "qualifies both native and relay proxy routing ($supported): $env",
    async ({ env, supported }) => {
      for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
        vi.stubEnv(key, undefined);
        vi.stubEnv(key.toLowerCase(), undefined);
      }
      vi.stubEnv("REQUEST_METHOD", undefined);
      for (const [key, value] of Object.entries(env)) {
        vi.stubEnv(key, value);
      }
      const h = harness({
        onWrite(line, send) {
          const request = JSON.parse(line);
          expect(request.method).toBe("account/read");
          send({ id: request.id, result: { account: { type: "apiKey" } } });
        },
      });
      ownCodexInferenceClient(h.client);
      const prepared = await prepareThread(h.client, { config: {}, origins: {} });
      expect(prepared !== undefined).toBe(supported);
      if (!supported) {
        expect(h.writes).toEqual([]);
      }
    },
  );

  it("does not guess an endpoint without native account evidence", async () => {
    const h = harness();
    ownCodexInferenceClient(h.client);
    const pending = prepareThread(h.client, { config: {}, origins: {} });
    const request = JSON.parse(await h.waitForWrite(0));
    h.send({ id: request.id, result: { account: { type: "unknown" } } });
    expect(await pending).toBeUndefined();
  });
});
