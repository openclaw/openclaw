import type {
  ProviderAuthContext,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { markdownToIR } from "openclaw/plugin-sdk/text-chunking";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENAI_CODEX_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL } from "./default-models.js";

const refreshOpenAICodexTokenMock = vi.hoisted(() => vi.fn());
const loginOpenAICodexDeviceCodeMock = vi.hoisted(() => vi.fn());

vi.mock("./openai-chatgpt-provider.runtime.js", () => ({
  refreshOpenAICodexToken: refreshOpenAICodexTokenMock,
}));

vi.mock("./openai-chatgpt-device-code.js", () => ({
  loginOpenAICodexDeviceCode: loginOpenAICodexDeviceCodeMock,
}));

let buildOpenAIProvider: typeof import("./openai-provider.js").buildOpenAIProvider;
const CODEX_PROVIDER_CONFIG = {
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
} as const;
const tokens = { access: "access-token", refresh: "refresh-token", expires: 1_700_000_000_000 };
function runDeviceCode(
  overrides: Partial<Omit<ProviderAuthContext, "prompter">> = {},
  prompter: Partial<ProviderAuthContext["prompter"]> = {},
) {
  const context = {
    isRemote: false,
    openUrl: vi.fn(async () => {}),
    prompter: {
      note: vi.fn(async () => {}),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      ...prompter,
    },
    runtime: { log: vi.fn(), error: vi.fn() },
    config: {},
    oauth: {},
    ...overrides,
  } as never;
  return buildOpenAIProvider()
    .auth?.find((method) => method.id === "device-code")
    ?.run(context);
}
function catalogModel(
  id: string,
  overrides: Partial<ProviderRuntimeModel> = {},
): ProviderRuntimeModel {
  return {
    provider: "openai",
    id,
    name: id,
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
    contextWindow: 400_000,
    maxTokens: 128_000,
    ...overrides,
  };
}
function resolveModel(
  modelId: string,
  find: (provider: string, id: string) => ProviderRuntimeModel | null = () => null,
  overrides: Partial<Omit<ProviderResolveDynamicModelContext, "modelRegistry">> = {},
) {
  return buildOpenAIProvider().resolveDynamicModel?.({
    provider: "openai",
    modelId,
    providerConfig: CODEX_PROVIDER_CONFIG,
    modelRegistry: { find },
    ...overrides,
  } as never);
}

describe("OpenAI provider Codex transport hooks", () => {
  beforeAll(async () => {
    ({ buildOpenAIProvider } = await import("./openai-provider.js"));
  });

  beforeEach(() => {
    refreshOpenAICodexTokenMock.mockReset();
    loginOpenAICodexDeviceCodeMock.mockReset();
  });

  it("exposes ChatGPT OAuth on the canonical OpenAI provider", () => {
    const provider = buildOpenAIProvider();

    expect(provider.id).toBe("openai");
    expect(provider.aliases).toBeUndefined();
    expect(provider.hookAliases).toEqual(["azure-openai", "azure-openai-responses"]);
    expect(
      provider.auth.map(({ id, wizard, kind, starterModel }) => [
        id,
        wizard?.choiceId,
        kind === "oauth" || kind === "device_code" ? [starterModel] : [],
      ]),
    ).toEqual([
      ["oauth", "openai", [OPENAI_CODEX_DEFAULT_MODEL]],
      ["device-code", "openai-device-code", [OPENAI_CODEX_DEFAULT_MODEL]],
      ["siwc", "openai-token-sharing", [OPENAI_DEFAULT_MODEL]],
      ["api-key", "openai-api-key", []],
    ]);
    expect(provider.oauthProfileIdRepairs).toBeUndefined();
  });

  it("stores device-code logins as OpenAI OAuth profiles", async () => {
    const controller = new AbortController();
    loginOpenAICodexDeviceCodeMock.mockResolvedValueOnce(tokens);

    const result = await runDeviceCode({ signal: controller.signal });

    expect(loginOpenAICodexDeviceCodeMock).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );

    expect(result?.profiles?.[0]).toMatchObject({
      profileId: "openai:default",
      credential: {
        type: "oauth",
        provider: "openai",
        access: "access-token",
        refresh: "refresh-token",
      },
    });
    expect(result?.defaultModel).toBe("openai/gpt-6-astra");
    expect(result?.configPatch?.agents?.defaults?.models).toEqual({
      "openai/gpt-6-astra": {},
    });
  });

  it.each(["structured", "note"])(
    "presents a bounded device-code link through %s UI",
    async (surface) => {
      const deviceCode = vi.fn(async () => {});
      const note = vi.fn(async (_message: string, _title?: string) => {});
      const openUrl = vi.fn(async () => {});
      type LoginOptions = Parameters<
        typeof import("./openai-chatgpt-device-code.js").loginOpenAICodexDeviceCode
      >[0];
      loginOpenAICodexDeviceCodeMock.mockImplementationOnce(
        async ({ onVerification }: LoginOptions) => {
          await onVerification({
            verificationUrl: "https://auth.openai.com/codex/device",
            userCode: "ABCD-EFGH",
            expiresInMs: 15 * 60_000,
          });
          return tokens;
        },
      );

      await runDeviceCode(
        { isRemote: true, openUrl },
        { ...(surface === "structured" ? { deviceCode } : {}), note },
      );

      expect(openUrl).toHaveBeenCalledWith("https://auth.openai.com/codex/device");
      if (surface === "note") {
        expect(note).toHaveBeenCalledOnce();
        const [message] = note.mock.calls[0]!;
        expect(markdownToIR(message, { linkify: false }).links.map((link) => link.href)).toEqual([
          "https://auth.openai.com/codex/device",
        ]);
        expect(message).toContain("\nCode: ABCD-EFGH\n");
        return;
      }
      expect(deviceCode).toHaveBeenCalledWith({
        title: "OpenAI Codex device code",
        code: "ABCD-EFGH",
        expiresInMinutes: 15,
        message: "Enter this one-time code on the sign-in page.",
      });
      expect(note).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["gpt-5.5-pro", "gpt-5.5-pro", 1_000_000, 272_000, 30, 180, 0],
    ["gpt-5.4", "gpt-5.4", 1_050_000, 272_000, 2.5, 15, 0.25],
    ["gpt-5.4-codex", "gpt-5.4", 1_050_000, 272_000, 2.5, 15, 0.25],
    ["gpt-5.4-pro", "gpt-5.4-pro", 1_050_000, 272_000, 30, 180, 0],
    ["gpt-5.4-mini", "gpt-5.4-mini", 400_000, 272_000, 0.75, 4.5, 0.075],
    ["gpt-5.3-codex-spark", "gpt-5.3-codex-spark", 128_000, 128_000, 0.75, 4.5, 0.075],
  ] as const)(
    "preserves %s Codex metadata with synthesized and fallback template models",
    (modelId, canonicalId, contextWindow, contextTokens, inputCost, outputCost, cacheRead) => {
      const templateIds =
        modelId === "gpt-5.5-pro"
          ? ["gpt-5.4", "gpt-5.4-pro", "gpt-5.3-codex"]
          : ["gpt-5.3-codex", "gpt-5.4"];
      // Remove each preferred template in turn, ending with no catalog metadata.
      for (let firstAvailable = 0; firstAvailable <= templateIds.length; firstAvailable++) {
        const available = templateIds.slice(firstAvailable);
        const model = resolveModel(modelId, (providerId, id) =>
          providerId === "openai" && available.includes(id)
            ? catalogModel(id, {
                name: `Template ${id}`,
                contextWindow: 8_192,
                contextTokens: 4_096,
                maxTokens: 1_024,
                headers: { "x-template": id },
              })
            : null,
        );

        expect(model).toMatchObject({
          ...CODEX_PROVIDER_CONFIG,
          provider: "openai",
          id: canonicalId,
          name: canonicalId,
          reasoning: true,
          input: modelId === "gpt-5.3-codex-spark" ? ["text"] : ["text", "image"],
          contextWindow,
          contextTokens,
          maxTokens: 128_000,
          cost: available.length
            ? { input: inputCost, output: outputCost, cacheRead, cacheWrite: 0 }
            : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        });
        expect(model?.headers).toEqual(
          available.length ? { "x-template": available[0] } : undefined,
        );
      }
    },
  );

  it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])(
    "resolves %s through the Codex Responses transport without live catalog metadata",
    (modelId) => {
      const model = resolveModel(modelId, undefined, { authProfileMode: "oauth" });

      expect(model).toMatchObject({
        ...CODEX_PROVIDER_CONFIG,
        provider: "openai",
        id: modelId,
        input: ["text", "image"],
        contextWindow: 372_000,
        contextTokens: 272_000,
        maxTokens: 128_000,
        thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
      });
    },
  );

  it("does not invent a bare GPT-5.6 alias for the Codex transport", () => {
    expect(resolveModel("gpt-5.6", undefined, { authProfileMode: "oauth" })).toBeUndefined();
  });

  it.each([
    { name: "fills a missing map", thinkingLevelMap: undefined, expectedOff: null },
    { name: "preserves explicit overrides", thinkingLevelMap: { off: "low" }, expectedOff: "low" },
  ])("$name on registry-backed GPT-5.6 models", ({ thinkingLevelMap, expectedOff }) => {
    const model = resolveModel(
      "gpt-5.6-luna",
      () =>
        catalogModel("gpt-5.6-luna", {
          name: "GPT-5.6 Luna",
          input: ["text"],
          cost: { input: 1, output: 6, cacheRead: 0.1, cacheWrite: 1.25 },
          contextWindow: 372_000,
          ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
        }),
      { authProfileMode: "oauth" },
    );

    expect(model).toMatchObject({
      ...CODEX_PROVIDER_CONFIG,
      input: ["text", "image"],
      thinkingLevelMap: { off: expectedOff, xhigh: "xhigh", max: "max" },
    });
  });

  it("keeps default Codex-backed OpenAI catalog models on the Codex Responses transport", () => {
    const model = resolveModel("gpt-5.5", () => catalogModel("gpt-5.5"), {
      providerConfig: { api: "openai-chatgpt-responses" },
    });

    expect(model).toMatchObject({
      ...CODEX_PROVIDER_CONFIG,
      provider: "openai",
      id: "gpt-5.5",
    });
  });

  it("refreshes ChatGPT OAuth credentials under the OpenAI provider", async () => {
    const provider = buildOpenAIProvider();
    refreshOpenAICodexTokenMock.mockResolvedValueOnce({
      access: "new-access",
      refresh: "new-refresh",
      expires: 1_700_000_000_000,
    });

    await expect(
      provider.refreshOAuth?.({
        type: "oauth",
        provider: "openai",
        access: "old-access",
        refresh: "old-refresh",
        expires: Date.now() - 60_000,
      }),
    ).resolves.toMatchObject({
      type: "oauth",
      provider: "openai",
      access: "new-access",
      refresh: "new-refresh",
    });
  });
});
