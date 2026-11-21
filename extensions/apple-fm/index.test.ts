import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import {
  capturePluginRegistration,
  createNonExitingRuntimeEnv,
} from "openclaw/plugin-sdk/plugin-test-runtime";
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
  const [provider] = capturePluginRegistration({
    ...plugin,
    source: location.source,
    register: (api) => plugin.register({ ...api, rootDir: location.rootDir }),
  }).providers;
  const method = provider?.auth[0];
  const guided = method?.appGuidedSetup;
  const setup = method?.runNonInteractive;
  const validate = method?.validateNonInteractive;
  assert(provider && method && guided && setup && validate, "Apple registration missing");
  return { provider, method, guided, setup, validate };
}

const setupContext = (config: OpenClawConfig = {}) => ({
  config,
  env: {},
  runtime: createNonExitingRuntimeEnv(),
  baseConfig: config,
  authChoice: "apple-fm",
  opts: {},
  resolveApiKey: vi.fn(async () => null),
  toApiKeyCredential: vi.fn(() => null),
});

beforeEach(() => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  native.prepare.mockReset().mockResolvedValue(facts);
  native.probe.mockReset().mockResolvedValue(facts);
  native.createAppleFmNative.mockReset().mockReturnValue(native);
});
afterEach(() => vi.restoreAllMocks());

it("serves configured native facts and local auth only on Mac hosts", async () => {
  const model = { primary: "existing/model", fallbacks: ["backup/model"] };
  const models = { "existing/model": { alias: "Existing" } };
  const existing = { baseUrl: "https://example.com", models: [] };
  const base = {
    auth: { profiles: { "existing:default": { provider: "existing", mode: "api_key" } } },
    agents: { defaults: { model, models } },
    models: { mode: "replace", providers: { existing } },
  } satisfies OpenClawConfig;
  const expected = structuredClone(base);
  native.prepare.mockResolvedValue({ ...facts, modelName: "Future model", contextWindow: 16_384 });
  const { provider, setup } = registeredProvider();
  const config = await setup(setupContext(base));
  assert(config);
  expect(native.createAppleFmNative).toHaveBeenCalledExactlyOnceWith(bundled.rootDir);
  const configured = config?.models?.providers?.["apple-fm"];
  expect(base).toEqual(expected);
  Object.assign(expected.models.providers, { "apple-fm": configured });
  Object.assign(expected.agents.defaults, {
    utilityModel: "apple-fm/system",
    models: { ...models, "apple-fm/system": { agentRuntime: { id: "openclaw" } } },
  });
  expect(config).toEqual(expected);
  expect(configured?.models[0]).toMatchObject({
    id: "system",
    name: "Future model",
    contextWindow: 16_384,
    maxTokens: 1_024,
    compat: { supportsTools: true, supportsJsonSchemaResponseFormat: true },
  });
  expect([configured?.apiKey, configured?.localService]).toEqual([undefined, undefined]);
  const auth = () =>
    provider.resolveSyntheticAuth?.({ provider: "apple-fm", providerConfig: configured });
  expect(auth()).toMatchObject({ apiKey: "apple-fm-local" });
  expect(provider.resolveSyntheticAuth?.({ provider: "apple-fm" })).toBeUndefined();
  const noAuth = () => ({ apiKey: undefined, mode: "none", source: "none" }) as const;
  const context = {
    config,
    env: {},
    resolveProviderApiKey: () => ({ apiKey: undefined }),
    resolveProviderAuth: noAuth,
  };
  expect(await provider.catalog?.run(context)).toEqual({ provider: configured });
  expect(native.probe).not.toHaveBeenCalled();
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  expect(await provider.catalog?.run(context)).toBeNull();
  expect(auth()).toBeUndefined();
});

it.each([
  [facts, null],
  [null, "macOS 27"],
  [{ ...facts, available: false, reason: "Model unavailable" }, "Model unavailable"],
  [{ ...facts, contextWindow: 8_191 }, "requires at least 8192"],
] as const)("checks native eligibility before activation: %j", async (detected, error) => {
  native.probe.mockResolvedValue(detected);
  const { guided, validate } = registeredProvider({ source: "/src/apple-fm/index.ts" });
  expect(native.createAppleFmNative).not.toHaveBeenCalled();
  const context = { ...setupContext(), signal: new AbortController().signal };
  expect(await guided.detect(context)).toEqual(
    error ? null : expect.objectContaining({ modelRef: "apple-fm/system" }),
  );
  expect(await guided.detectAvailability?.(context)).toBe(!error);
  expect(await validate(context)).toBe(!error);
  if (error) {
    expect(context.runtime.error).toHaveBeenCalledWith(expect.stringContaining(error));
  }
  expect(await guided.prepare({ ...context, modelRef: "another/model" })).toBeNull();
  expect(native.prepare).not.toHaveBeenCalled();
  if (detected) {
    native.prepare.mockResolvedValue(detected);
    const result = guided.prepare({ ...context, modelRef: "apple-fm/system" });
    if (error) {
      await expect(result).rejects.toThrow(error);
    } else {
      expect(await result).toMatchObject({ profiles: [], defaultModel: "apple-fm/system" });
    }
  }
  expect(native.probe).toHaveBeenCalledWith({ signal: context.signal, env: {} });
  expect(native.createAppleFmNative).toHaveBeenCalledExactlyOnceWith("/src/apple-fm");
});
