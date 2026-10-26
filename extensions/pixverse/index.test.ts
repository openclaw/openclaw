import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  capturePluginRegistration,
  createQueuedWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { createNoBrowserAuth } from "../test-support/no-browser-auth.test-support.js";
import { createRuntimeSpies } from "../test-support/runtime-spies.js";
import {
  PIXVERSE_BASE_URL_BY_REGION,
  PIXVERSE_DEFAULT_VIDEO_MODEL_REF,
  PIXVERSE_PROVIDER_ID,
} from "./constants.js";
import plugin from "./index.js";

function registerPixVerseProvider() {
  const provider = capturePluginRegistration(plugin).providers[0];
  const auth = provider?.auth?.[0];
  if (!provider || !auth) {
    throw new Error("expected PixVerse setup provider and auth method");
  }
  return { provider, auth };
}

const proxyProvider = {
  baseUrl: "https://proxy.example/openapi/v2",
  models: [],
  params: { quality: "720p" },
};
const createProxyConfig = () => ({ models: { providers: { pixverse: proxyProvider } } });

function createRuntimeContext(
  region: "international" | "cn",
  config: ProviderAuthContext["config"] = createProxyConfig(),
) {
  const { prompter, select } = createQueuedWizardPrompter({
    selectValues: [region],
    textValues: ["pixverse-test-key"],
  });
  const ctx = {
    config,
    env: {},
    workspaceDir: "/tmp/pixverse-workspace",
    prompter,
    runtime: createRuntimeSpies(),
    secretInputMode: "plaintext",
    isRemote: false,
    ...createNoBrowserAuth(),
  } satisfies ProviderAuthContext;
  return { ctx, select };
}

describe("pixverse plugin", () => {
  it("registers provider auth for the setup wizard", () => {
    expect(
      capturePluginRegistration(plugin).videoGenerationProviders.map((provider) => provider.id),
    ).toEqual([PIXVERSE_PROVIDER_ID]);
    const { provider, auth } = registerPixVerseProvider();
    expect(provider).toMatchObject({
      id: PIXVERSE_PROVIDER_ID,
      docsPath: "/providers/pixverse",
      envVars: ["PIXVERSE_API_KEY"],
    });
    expect(auth).toMatchObject({
      id: "api-key",
      kind: "api_key",
      wizard: {
        choiceId: "pixverse-api-key",
        groupId: "pixverse",
        onboardingScopes: ["image-generation"],
      },
    });
  });

  it("prompts for the PixVerse region and writes provider config", async () => {
    const { auth } = registerPixVerseProvider();
    const { ctx, select } = createRuntimeContext("cn");
    const result = await auth.run(ctx);
    const prompt = select.mock.calls[0]?.[0];
    expect(prompt?.initialValue).toBe("international");
    expect(prompt?.options.map(({ value, hint }) => ({ value, hint }))).toEqual([
      { value: "international", hint: PIXVERSE_BASE_URL_BY_REGION.international },
      { value: "cn", hint: PIXVERSE_BASE_URL_BY_REGION.cn },
    ]);
    expect(result.defaultModel).toBeUndefined();
    expect(result.notes).toEqual([`PixVerse endpoint: CN (${PIXVERSE_BASE_URL_BY_REGION.cn})`]);
    expect(result.profiles).toEqual([
      {
        profileId: "pixverse:default",
        credential: { type: "api_key", provider: PIXVERSE_PROVIDER_ID, key: "pixverse-test-key" },
      },
    ]);
    expect(result.configPatch?.models?.providers?.pixverse).toEqual({
      ...proxyProvider,
      baseUrl: PIXVERSE_BASE_URL_BY_REGION.cn,
      region: "cn",
    });
    expect(result.configPatch?.agents?.defaults?.mediaModels?.video).toEqual({
      primary: PIXVERSE_DEFAULT_VIDEO_MODEL_REF,
    });
  });

  it("preserves an existing video generation default through setup", async () => {
    const { auth } = registerPixVerseProvider();
    const { ctx } = createRuntimeContext("international", {
      agents: { defaults: { mediaModels: { video: { primary: "openai/sora-2" } } } },
    });
    const result = await auth.run(ctx);
    expect(result.configPatch?.agents?.defaults?.mediaModels?.video).toEqual({
      primary: "openai/sora-2",
    });
  });

  it.each([
    [{}, proxyProvider.baseUrl, "international"],
    [{ pixverseRegion: "cn" }, PIXVERSE_BASE_URL_BY_REGION.cn, "cn"],
  ] as const)("non-interactive setup %j selects %s (%s)", async (opts, baseUrl, region) => {
    const { auth } = registerPixVerseProvider();
    if (!auth.runNonInteractive) {
      throw new Error("expected PixVerse non-interactive auth method");
    }
    const config = createProxyConfig();
    const result = await auth.runNonInteractive({
      authChoice: "pixverse-api-key",
      config,
      baseConfig: config,
      opts,
      runtime: createRuntimeSpies(),
      resolveApiKey: vi.fn(async () => ({ key: "fixture-value", source: "profile" as const })),
      toApiKeyCredential: vi.fn(() => null),
    });
    expect(result?.models?.providers?.pixverse).toMatchObject({
      baseUrl,
      params: { quality: "720p" },
      region,
    });
  });
});
