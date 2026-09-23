import type {
  OpenClawConfig,
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  capturePluginRegistration,
  createNonExitingRuntimeEnv,
  createTestWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import type { AppleFmFacts } from "./native.js";

const native = vi.hoisted(() => ({
  prepare: vi.fn<import("./native.js").AppleFmNative["prepare"]>(),
  probe: vi.fn<import("./native.js").AppleFmNative["probe"]>(),
  run: vi.fn<import("./native.js").AppleFmNative["run"]>(),
  createAppleFmNative: vi.fn<typeof import("./native.js").createAppleFmNative>(),
}));
vi.mock("./native.js", () => ({ createAppleFmNative: native.createAppleFmNative }));

const facts: AppleFmFacts = {
  available: true,
  modelName: "AFM 3 Core Advanced",
  contextWindow: 8_192,
};

function registeredProvider(
  location: { rootDir?: string; source: string } = {
    rootDir: "/test/plugins/apple-fm",
    source: "/test/dist/apple-fm-entry.mjs",
  },
) {
  const registration = capturePluginRegistration({
    ...plugin,
    source: location.source,
    register: (api) => plugin.register({ ...api, rootDir: location.rootDir }),
  });
  const provider = registration.providers[0];
  const method = provider?.auth[0];
  if (!provider || !method) {
    throw new Error("Apple Foundation Models registration missing");
  }
  return { provider, method, registration };
}

function authContext(config: OpenClawConfig = {}): ProviderAuthContext {
  return {
    config,
    env: {},
    runtime: createNonExitingRuntimeEnv(),
    prompter: createTestWizardPrompter(),
    isRemote: false,
    openUrl: vi.fn(),
    oauth: { createVpsAwareHandlers: vi.fn() },
  };
}

function nonInteractiveContext(config: OpenClawConfig): ProviderAuthMethodNonInteractiveContext {
  return {
    config,
    baseConfig: config,
    authChoice: "apple-fm",
    opts: {},
    runtime: createNonExitingRuntimeEnv(),
    resolveApiKey: vi.fn(async () => null),
    toApiKeyCredential: vi.fn(() => null),
  };
}

describe("Apple Foundation Models setup", () => {
  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    native.prepare.mockReset().mockResolvedValue(facts);
    native.probe.mockReset().mockResolvedValue(facts);
    native.run.mockReset();
    native.createAppleFmNative.mockReset().mockReturnValue(native);
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    {
      name: "bundled shared chunks",
      rootDir: "/bundle/dist/extensions/apple-fm",
      source: "/bundle/dist/apple-fm-entry-HASH.mjs",
      expected: "/bundle/dist/extensions/apple-fm",
    },
    {
      name: "standalone package",
      rootDir: "/plugins/apple-fm",
      source: "/plugins/apple-fm/dist/index.js",
      expected: "/plugins/apple-fm",
    },
    {
      name: "legacy source registration",
      source: "/checkout/extensions/apple-fm/index.ts",
      expected: "/checkout/extensions/apple-fm",
    },
  ])("binds native helper assets to their registration root for $name", async (location) => {
    const { method } = registeredProvider(location);
    expect(native.createAppleFmNative).not.toHaveBeenCalled();
    await method.appGuidedSetup?.detect({ config: {}, env: {} });
    await method.run(authContext());
    expect(native.createAppleFmNative).toHaveBeenCalledExactlyOnceWith(location.expected);
    expect(native.probe).toHaveBeenCalledOnce();
    expect(native.prepare).toHaveBeenCalledOnce();
  });

  it("configures the measured native model without creating credentials or a service", async () => {
    const { provider, method } = registeredProvider();
    const result = await method.run(authContext());
    const configured = result.configPatch?.models?.providers?.["apple-fm"];

    expect(result.profiles).toEqual([]);
    expect(result.defaultModel).toBe("apple-fm/system");
    expect(configured?.models[0]).toMatchObject({
      id: "system",
      name: facts.modelName,
      contextWindow: 8_192,
      maxTokens: 1_024,
      compat: { supportsTools: true, supportsJsonSchemaResponseFormat: true },
    });
    expect(configured?.apiKey).toBeUndefined();
    expect(configured?.localService).toBeUndefined();
    expect(
      provider.resolveSyntheticAuth?.({ provider: "apple-fm", providerConfig: configured }),
    ).toMatchObject({
      apiKey: "apple-fm-local",
    });
    expect(provider.resolveSyntheticAuth?.({ provider: "apple-fm" })).toBeUndefined();
  });

  it.each([
    {
      result: { ...facts, available: false, reason: "Enable Apple Intelligence" },
      error: "Enable Apple Intelligence",
    },
    { result: { ...facts, contextWindow: 4_096 }, error: "requires at least 8192" },
  ])("rejects an unusable system model: $error", async ({ result, error }) => {
    native.prepare.mockResolvedValue(result);
    await expect(registeredProvider().method.run(authContext())).rejects.toThrow(error);
  });

  it("retains a larger context window reported by the native model", async () => {
    native.prepare.mockResolvedValue({
      ...facts,
      modelName: "Future system model",
      contextWindow: 16_384,
    });
    const result = await registeredProvider().method.run(authContext());
    expect(result.configPatch?.models?.providers?.["apple-fm"]?.models[0]).toMatchObject({
      name: "Future system model",
      contextWindow: 16_384,
    });
  });

  it("prepares only the selected model and rechecks its eligibility before activation", async () => {
    const guided = registeredProvider().method.appGuidedSetup;
    if (!guided) {
      throw new Error("Apple guided setup missing");
    }
    const context = { config: {}, env: {}, signal: new AbortController().signal };
    expect(await guided.detect(context)).toMatchObject({ modelRef: "apple-fm/system" });
    expect(await guided.prepare({ ...context, modelRef: "another/model" })).toBeNull();
    expect(await guided.prepare({ ...context, modelRef: "apple-fm/system" })).toMatchObject({
      defaultModel: "apple-fm/system",
    });
    native.probe.mockResolvedValue(null);
    expect(await guided.detect(context)).toBeNull();
    native.prepare.mockResolvedValue({ ...facts, contextWindow: 4_096 });
    await expect(guided.prepare({ ...context, modelRef: "apple-fm/system" })).rejects.toThrow(
      "requires at least 8192",
    );
    native.prepare.mockResolvedValue({ ...facts, available: false, reason: "Model unavailable" });
    await expect(guided.prepare({ ...context, modelRef: "apple-fm/system" })).rejects.toThrow(
      "Model unavailable",
    );
    expect(native.probe).toHaveBeenCalledWith({ signal: context.signal, env: {} });
  });

  it.each([
    { result: null, visible: false },
    { result: { ...facts, available: false }, visible: false },
    { result: { ...facts, contextWindow: 0 }, visible: false },
    { result: { ...facts, contextWindow: 4_096 }, visible: false },
    { result: { ...facts, contextWindow: 8_191 }, visible: false },
    { result: facts, visible: true },
    { result: { ...facts, contextWindow: 16_384 }, visible: true },
  ])("offers only an available 8K or larger model: $result", async ({ result, visible }) => {
    native.probe.mockResolvedValue(result);
    const guided = registeredProvider().method.appGuidedSetup!;
    const context = { config: {}, env: {} };
    expect(Boolean(await guided.detect(context))).toBe(visible);
    expect(await guided.detectAvailability?.(context)).toBe(visible);
    expect(native.prepare).not.toHaveBeenCalled();
  });

  it("preserves other providers, auth, model restrictions, and fallbacks during noninteractive setup", async () => {
    const config: OpenClawConfig = {
      auth: { profiles: { "existing:default": { provider: "existing", mode: "api_key" } } },
      agents: {
        defaults: {
          model: { primary: "existing/model", fallbacks: ["backup/model"] },
          models: { "existing/model": { alias: "Existing" } },
        },
      },
      models: {
        mode: "replace",
        providers: { existing: { baseUrl: "https://example.com", models: [] } },
      },
    };
    const before = structuredClone(config);
    const setup = registeredProvider().method.runNonInteractive;
    if (!setup) {
      throw new Error("Apple noninteractive setup missing");
    }
    const updated = await setup(nonInteractiveContext(config));
    expect(config).toEqual(before);
    expect(updated?.auth).toEqual(before.auth);
    expect(updated?.models?.mode).toBe("replace");
    expect(updated?.models?.providers?.existing).toEqual(before.models?.providers?.existing);
    expect(updated?.agents?.defaults?.model).toEqual(before.agents?.defaults?.model);
    expect(updated?.agents?.defaults?.utilityModel).toBe("apple-fm/system");
    expect(updated?.agents?.defaults?.models).toEqual({
      ...before.agents?.defaults?.models,
      "apple-fm/system": { agentRuntime: { id: "openclaw" } },
    });
  });

  it("propagates developer-tool failures without creating a setup proposal", async () => {
    native.prepare.mockRejectedValue(new Error("Install Apple Swift tools with macOS 27 SDK"));
    await expect(registeredProvider().method.run(authContext())).rejects.toThrow("macOS 27 SDK");
  });

  it("rejects unsupported hosts before a noninteractive reset can proceed", async () => {
    native.probe.mockResolvedValue(null);
    const validator = registeredProvider().method.validateNonInteractive;
    if (!validator) {
      throw new Error("Apple reset preflight missing");
    }
    const context = nonInteractiveContext({});
    expect(await validator(context)).toBe(false);
    expect(context.runtime.error).toHaveBeenCalledWith(expect.stringContaining("macOS 27"));
    expect(native.prepare).not.toHaveBeenCalled();
  });

  it("keeps catalog reads on configured facts and unavailable on non-Mac hosts", async () => {
    const { provider, method } = registeredProvider();
    const config = (await method.run(authContext())).configPatch ?? {};
    const context = {
      config,
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({
        apiKey: undefined,
        mode: "none" as const,
        source: "none" as const,
      }),
    };
    expect(await provider.catalog?.run(context)).toMatchObject({
      provider: { models: [{ id: "system", contextWindow: 8_192 }] },
    });
    expect(native.probe).not.toHaveBeenCalled();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    expect(await provider.catalog?.run(context)).toBeNull();
    expect(
      provider.resolveSyntheticAuth?.({
        provider: "apple-fm",
        providerConfig: config.models?.providers?.["apple-fm"],
      }),
    ).toBeUndefined();
  });
});
