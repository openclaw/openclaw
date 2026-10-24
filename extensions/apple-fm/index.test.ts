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
import { applyProviderAuthConfigPatch } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import plugin from "./index.js";
import type { AppleFmFacts, AppleFmNative } from "./native.js";

const native = vi.hoisted(() => ({
  prepare: vi.fn<AppleFmNative["prepare"]>(),
  probe: vi.fn<AppleFmNative["probe"]>(),
  run: vi.fn<AppleFmNative["run"]>(),
  createAppleFmNative: vi.fn<typeof import("./native.js").createAppleFmNative>(),
}));
vi.mock("./native.js", () => ({ createAppleFmNative: native.createAppleFmNative }));

const facts: AppleFmFacts = { available: true, modelName: "AFM", contextWindow: 8_192 };
const bundled = { rootDir: "/dist/extensions/apple-fm", source: "/dist/apple-fm-HASH.mjs" };

function registeredProvider(location: { rootDir?: string; source: string } = bundled) {
  const registration = capturePluginRegistration({
    ...plugin,
    source: location.source,
    register: (api) => plugin.register({ ...api, rootDir: location.rootDir }),
  });
  const provider = registration.providers[0];
  const method = provider?.auth[0];
  const guided = method?.appGuidedSetup;
  const setup = method?.runNonInteractive;
  const validate = method?.validateNonInteractive;
  assert(provider && method && guided && setup && validate, "Apple registration missing");
  return { provider, method, guided, setup, validate };
}

function setupContext(config: OpenClawConfig = {}) {
  return {
    config,
    env: {},
    runtime: createNonExitingRuntimeEnv(),
    prompter: createTestWizardPrompter(),
    isRemote: false,
    openUrl: vi.fn(),
    oauth: { createVpsAwareHandlers: vi.fn() },
    baseConfig: config,
    authChoice: "apple-fm",
    opts: {},
    resolveApiKey: vi.fn(async () => null),
    toApiKeyCredential: vi.fn(() => null),
  } satisfies ProviderAuthContext & ProviderAuthMethodNonInteractiveContext;
}

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  native.prepare.mockReset().mockResolvedValue(facts);
  native.probe.mockReset().mockResolvedValue(facts);
  native.createAppleFmNative.mockReset().mockReturnValue(native);
});
afterEach(() => vi.restoreAllMocks());

it("lazily resolves native assets from the source when no root is registered", async () => {
  const { method } = registeredProvider({ source: "/src/apple-fm/index.ts" });
  expect(native.createAppleFmNative).not.toHaveBeenCalled();
  await method.appGuidedSetup?.detect({ config: {}, env: {} });
  await method.run(setupContext());
  expect(native.createAppleFmNative).toHaveBeenCalledExactlyOnceWith("/src/apple-fm");
  expect(native.probe).toHaveBeenCalledOnce();
  expect(native.prepare).toHaveBeenCalledOnce();
});

it("serves configured native facts and local auth only on Mac hosts", async () => {
  const measured = { modelName: "Future model", contextWindow: 16_384 };
  native.prepare.mockResolvedValue({ ...facts, ...measured });
  const { provider, method } = registeredProvider();
  const result = await method.run(setupContext());
  expect(native.createAppleFmNative).toHaveBeenCalledExactlyOnceWith(bundled.rootDir);
  const config = applyProviderAuthConfigPatch({}, result.configPatch, result);
  const configured = config.models?.providers?.["apple-fm"];

  expect(result).toMatchObject({ profiles: [], defaultModel: "apple-fm/system" });
  expect(configured?.models[0]).toMatchObject({
    id: "system",
    name: measured.modelName,
    contextWindow: measured.contextWindow,
    maxTokens: 1_024,
    compat: { supportsTools: true, supportsJsonSchemaResponseFormat: true },
  });
  expect([configured?.apiKey, configured?.localService]).toEqual([undefined, undefined]);
  const auth = () =>
    provider.resolveSyntheticAuth?.({ provider: "apple-fm", providerConfig: configured });
  expect(auth()).toMatchObject({ apiKey: "apple-fm-local" });
  expect(provider.resolveSyntheticAuth?.({ provider: "apple-fm" })).toBeUndefined();
  const noAuth = { apiKey: undefined, mode: "none", source: "none" } as const;
  const context = {
    config,
    env: {},
    resolveProviderApiKey: () => ({ apiKey: undefined }),
    resolveProviderAuth: () => noAuth,
  };
  expect(await provider.catalog?.run(context)).toEqual({ provider: configured });
  expect(native.probe).not.toHaveBeenCalled();
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  expect(await provider.catalog?.run(context)).toBeNull();
  expect(auth()).toBeUndefined();
});

it("prepares only the selected model and rechecks its eligibility before activation", async () => {
  const { guided } = registeredProvider();
  const context = { ...setupContext(), signal: new AbortController().signal };
  const selected = { ...context, modelRef: "apple-fm/system" };
  expect(await guided.detect(context)).toMatchObject({ modelRef: "apple-fm/system" });
  expect(await guided.detectAvailability?.(context)).toBe(true);
  expect(native.prepare).not.toHaveBeenCalled();
  expect(await guided.prepare({ ...context, modelRef: "another/model" })).toBeNull();
  expect(await guided.prepare(selected)).toMatchObject({ defaultModel: "apple-fm/system" });
  native.probe.mockResolvedValue(null);
  expect(await guided.detect(context)).toBeNull();
  native.prepare.mockResolvedValue({ ...facts, contextWindow: 4_096 });
  await expect(guided.prepare(selected)).rejects.toThrow("requires at least 8192");
  native.prepare.mockResolvedValue({ ...facts, available: false, reason: "Model unavailable" });
  await expect(guided.prepare(selected)).rejects.toThrow("Model unavailable");
  expect(native.probe).toHaveBeenCalledWith({ signal: context.signal, env: {} });
});

it.each([{ available: false }, { contextWindow: 8_191 }])("rejects %j", async (overrides) => {
  native.probe.mockResolvedValue({ ...facts, ...overrides });
  const { guided } = registeredProvider();
  const context = setupContext();
  expect(Boolean(await guided.detect(context))).toBe(false);
  expect(await guided.detectAvailability?.(context)).toBe(false);
  expect(native.prepare).not.toHaveBeenCalled();
});

it("preserves other providers, auth, model restrictions, and fallbacks during noninteractive setup", async () => {
  const model = { primary: "existing/model", fallbacks: ["backup/model"] };
  const models = { "existing/model": { alias: "Existing" } };
  const existing = { baseUrl: "https://example.com", models: [] };
  const config: OpenClawConfig = {
    auth: { profiles: { "existing:default": { provider: "existing", mode: "api_key" } } },
    agents: { defaults: { model, models } },
    models: { mode: "replace", providers: { existing } },
  };
  const before = structuredClone(config);
  const { setup } = registeredProvider();
  const updated = await setup(setupContext(config));
  expect(config).toEqual(before);
  expect(updated?.auth).toEqual(before.auth);
  expect(updated?.models?.mode).toBe("replace");
  expect(updated?.models?.providers?.existing).toEqual(existing);
  expect(updated?.agents?.defaults).toEqual({
    model,
    utilityModel: "apple-fm/system",
    models: { ...models, "apple-fm/system": { agentRuntime: { id: "openclaw" } } },
  });
});

it("rejects unsupported hosts before a noninteractive reset can proceed", async () => {
  native.probe.mockResolvedValue(null);
  const { validate } = registeredProvider();
  const context = setupContext();
  expect(await validate(context)).toBe(false);
  expect(context.runtime.error).toHaveBeenCalledWith(expect.stringContaining("macOS 27"));
  expect(native.prepare).not.toHaveBeenCalled();
});
