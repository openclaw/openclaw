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
const loginOpenAICodexOAuthMock = vi.hoisted(() => vi.fn());

vi.mock("./openai-chatgpt-provider.runtime.js", () => ({
  refreshOpenAICodexToken: refreshOpenAICodexTokenMock,
}));

vi.mock("./openai-chatgpt-device-code.js", () => ({
  loginOpenAICodexDeviceCode: loginOpenAICodexDeviceCodeMock,
}));

vi.mock("./openai-chatgpt-oauth.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openai-chatgpt-oauth.runtime.js")>()),
  loginOpenAICodexOAuth: loginOpenAICodexOAuthMock,
}));

let buildOpenAIProvider: typeof import("./openai-provider.js").buildOpenAIProvider;
const CODEX_PROVIDER_CONFIG = {
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
} as const;
const tokens = { access: "access-token", refresh: "refresh-token", expires: 1_700_000_000_000 };
function runLogin(
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
    .auth?.find((method) => method.id === "oauth")
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
    loginOpenAICodexOAuthMock.mockReset();
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
      ["siwc", "openai-token-sharing", [OPENAI_DEFAULT_MODEL]],
      ["api-key", "openai-api-key", []],
    ]);
    expect(provider.oauthProfileIdRepairs).toBeUndefined();
  });

  it("Codex login uses device code when the server offers it", async () => {
    const controller = new AbortController();
    loginOpenAICodexDeviceCodeMock.mockResolvedValueOnce(tokens);

    const result = await runLogin({ signal: controller.signal });

    expect(loginOpenAICodexDeviceCodeMock).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(loginOpenAICodexOAuthMock).not.toHaveBeenCalled();

    expect(result).toMatchObject({
      profiles: [
        {
          profileId: "openai:default",
          credential: { type: "oauth", provider: "openai", ...tokens },
        },
      ],
      defaultModel: "openai/gpt-6-astra",
    });
    expect(result?.configPatch?.agents?.defaults?.models).toEqual({ "openai/gpt-6-astra": {} });
  });

  it("keeps same-email workspaces separate across Codex logins", async () => {
    const access = (accountId: string) =>
      `header.${Buffer.from(
        JSON.stringify({
          "https://api.openai.com/auth": {
            chatgpt_account_id: accountId,
            chatgpt_user_id: "user-one",
          },
          "https://api.openai.com/profile": { email: "dev@example.com", email_verified: true },
        }),
      ).toString("base64url")}.signature`;
    const login = async (
      accountId: string,
      existingProfiles?: ProviderAuthContext["existingProfiles"],
    ) => {
      loginOpenAICodexDeviceCodeMock.mockResolvedValueOnce({
        ...tokens,
        access: access(accountId),
      });
      const result = await runLogin({ existingProfiles });
      return result!.profiles;
    };

    const personal = await login("acct-personal");
    const business = await login("acct-business", personal);
    const existing = [...personal, ...business];
    const personalAgain = await login("acct-personal", existing);
    const businessAgain = await login("acct-business", existing);

    expect(personal[0]?.profileId).toBe("openai:dev@example.com");
    expect(business[0]).toMatchObject({
      profileId: "openai:dev@example.com:acct-business",
      credential: { email: "dev@example.com", accountId: "acct-business" },
    });
    expect(personalAgain[0]?.profileId).toBe("openai:dev@example.com");
    expect(businessAgain[0]?.profileId).toBe("openai:dev@example.com:acct-business");
    const method = buildOpenAIProvider().auth.find((candidate) => candidate.id === "oauth")!;
    const matcher = method.matchesPersonalAccount!;
    const canReplace = method.canReplaceGeneratedProfile!;
    const personalCredential = personal[0]!.credential;
    if (personalCredential.type !== "oauth") {
      throw new Error("Expected OAuth credential");
    }
    const imported = {
      ...personal[0]!,
      credential: { ...personalCredential, access: "import-without-workspace-claim" },
    };
    expect((await login("acct-business", [imported]))[0]?.profileId).toBe(business[0]?.profileId);
    expect(canReplace(business[0]!.credential, personalCredential)).toBe(false);
    expect(canReplace(personalCredential, imported.credential)).toBe(false);

    // A failed refresh retains metadata, not the original access-token claims.
    const fence = "openclaw-oauth-refresh-fence:v1:" + "a".repeat(32) + ":failed:";
    const failed = {
      ...personalCredential,
      access: fence + "access:" + "b".repeat(64),
      refresh: fence + "refresh:" + "c".repeat(64),
      expires: 1,
    };
    expect(matcher(personalAgain[0]!.credential, failed)).toBe(false);
    expect(canReplace(personalCredential, failed)).toBe(true);
    expect(canReplace(personalCredential, { ...failed, email: "other@example.com" })).toBe(false);
    expect(canReplace(businessAgain[0]!.credential, failed)).toBe(false);
    for (const [incoming] of [personalAgain, businessAgain]) {
      expect(
        existing
          .filter((profile) => matcher(incoming!.credential, profile.credential))
          .map((profile) => profile.profileId),
      ).toEqual([incoming!.profileId]);
    }
  });

  it("matches stable Codex imports only for the same shared account", () => {
    const token = (claims: Record<string, string>) =>
      [
        "fixture",
        Buffer.from(JSON.stringify({ "https://api.openai.com/auth": claims })).toString(
          "base64url",
        ),
        "fixture",
      ].join(".");
    const incoming = {
      ...tokens,
      type: "oauth" as const,
      provider: "openai",
      access: token({ chatgpt_account_id: "workspace-a", chatgpt_user_id: "same-user" }),
    };
    const saved = {
      ...incoming,
      access: token({}),
      accountId: "workspace-a",
      idToken: token({ chatgpt_user_id: "same-user" }),
    };
    const method = buildOpenAIProvider().auth.find((candidate) => candidate.id === "oauth")!;
    const matchesShared = method.matchesSharedAccount!;
    expect(matchesShared(incoming, saved)).toBe(true);
    expect(method.matchesPersonalAccount!(incoming, saved)).toBe(false);
    expect(method.canReplaceGeneratedProfile!(incoming, saved)).toBe(true);
    for (const unverified of [
      { ...saved, idToken: undefined },
      { ...saved, idToken: token({ chatgpt_user_id: "other-user" }) },
      { ...saved, accountId: "workspace-b" },
      { ...saved, access: token({ chatgpt_user_id: "other-user" }) },
      {
        ...saved,
        idToken: token({ chatgpt_user_id: "same-user", chatgpt_account_id: "workspace-b" }),
      },
    ]) {
      expect(matchesShared(incoming, unverified)).toBe(false);
      expect(method.canReplaceGeneratedProfile!(incoming, unverified)).toBe(false);
    }
  });

  it("Codex login falls back to browser sign-in only when device code is not enabled", async () => {
    loginOpenAICodexDeviceCodeMock.mockResolvedValueOnce(null);
    loginOpenAICodexOAuthMock.mockResolvedValueOnce(tokens);

    const result = await runLogin();

    expect(loginOpenAICodexDeviceCodeMock).toHaveBeenCalledOnce();
    expect(loginOpenAICodexOAuthMock).toHaveBeenCalledOnce();
    expect(result?.profiles[0]?.credential).toMatchObject({ type: "oauth", ...tokens });
  });

  it("Codex login surfaces other device-code failures without browser fallback", async () => {
    const error = new Error("The sign-in code expired before it was approved.");
    loginOpenAICodexDeviceCodeMock.mockRejectedValueOnce(error);
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    await expect(runLogin({ runtime })).rejects.toBe(error);

    // Core prints the failure once; the provider neither echoes it nor adds a help note.
    expect(runtime.error).not.toHaveBeenCalled();
    expect(loginOpenAICodexOAuthMock).not.toHaveBeenCalled();
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

      await runLogin(
        { isRemote: true, openUrl },
        { ...(surface === "structured" ? { deviceCode } : {}), note },
      );

      expect(openUrl).toHaveBeenCalledWith("https://auth.openai.com/codex/device");
      if (surface === "note") {
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
      () => catalogModel("gpt-5.6-luna", { input: ["text"], thinkingLevelMap }),
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
    const refreshed = { ...tokens, access: "new-access", refresh: "new-refresh" };
    refreshOpenAICodexTokenMock.mockResolvedValueOnce(refreshed);

    await expect(
      provider.refreshOAuth?.({
        ...tokens,
        type: "oauth",
        provider: "openai",
        expires: Date.now() - 60_000,
      }),
    ).resolves.toMatchObject({
      type: "oauth",
      provider: "openai",
      ...refreshed,
    });
  });
});
