import { beforeEach, describe, expect, it, vi } from "vitest";
import { FailoverError } from "../../failover-error.js";
import {
  createRunAuthRuntimeFailoverController,
  type AuthProfileCandidate,
} from "./auth-runtime-failover.js";

const mocks = vi.hoisted(() => ({
  createRunAuthResolutionState: vi.fn(),
  getApiKeyForModel: vi.fn(),
  isSystemKeychainProvider: vi.fn(),
  resolveAuthProfileOrder: vi.fn(),
  resolveCopilotApiToken: vi.fn(),
  isProfileInCooldown: vi.fn(),
  resolveProfilesUnavailableReason: vi.fn(),
  saveAuthProfileStore: vi.fn(),
  upsertAuthProfileWithLock: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../../model-auth.js", () => ({
  getApiKeyForModel: mocks.getApiKeyForModel,
  isSystemKeychainProvider: mocks.isSystemKeychainProvider,
  resolveAuthProfileOrder: mocks.resolveAuthProfileOrder,
}));

vi.mock("../../../providers/github-copilot-token.js", () => ({
  resolveCopilotApiToken: mocks.resolveCopilotApiToken,
}));

vi.mock("../../auth-profiles.js", () => ({
  isProfileInCooldown: mocks.isProfileInCooldown,
  resolveProfilesUnavailableReason: mocks.resolveProfilesUnavailableReason,
  saveAuthProfileStore: mocks.saveAuthProfileStore,
  upsertAuthProfileWithLock: mocks.upsertAuthProfileWithLock,
}));

vi.mock("../logger.js", () => ({
  log: {
    debug: vi.fn(),
    warn: mocks.logWarn,
  },
}));

type MutableResolutionState = {
  runtimeOverride: "claude-sdk" | "pi" | undefined;
  authProvider: string;
  claudeSdkProviderOverride?: string;
  lockedProfileId?: string;
  profileCandidates: AuthProfileCandidate[];
  profileIndex: number;
  advanceProfileIndex: () => void;
  fallBackToPiRuntime: () => Promise<boolean>;
};

function makeResolutionState(params: {
  runtimeOverride: "claude-sdk" | "pi" | undefined;
  authProvider: string;
  profileCandidates: AuthProfileCandidate[];
  lockedProfileId?: string;
}): MutableResolutionState {
  const state: MutableResolutionState = {
    runtimeOverride: params.runtimeOverride,
    authProvider: params.authProvider,
    claudeSdkProviderOverride:
      params.runtimeOverride === "claude-sdk" ? params.authProvider : undefined,
    lockedProfileId: params.lockedProfileId,
    profileCandidates: [...params.profileCandidates],
    profileIndex: 0,
    advanceProfileIndex() {
      if (state.lockedProfileId) {
        return;
      }
      state.profileIndex += 1;
    },
    async fallBackToPiRuntime() {
      return false;
    },
  };
  return state;
}

function resolvedAuth(profileId: string, apiKey: string) {
  return {
    apiKey,
    profileId,
    source: `profile:${profileId}`,
    mode: "api-key" as const,
  };
}

function baseParams(
  overrides?: Partial<Parameters<typeof createRunAuthRuntimeFailoverController>[0]>,
) {
  const authStorage = {
    setRuntimeApiKey: vi.fn(),
  };
  return {
    params: {
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      model: { provider: "anthropic" } as never,
      cfg: {},
      agentDir: "/tmp/agent",
      authStore: { profiles: {}, usageStats: {} } as never,
      authStorage: authStorage as never,
      fallbackConfigured: true,
      preferredProfileId: undefined,
      authProfileIdSource: undefined,
      createAuthResolutionState: mocks.createRunAuthResolutionState,
      ...overrides,
    },
    authStorage,
  };
}

describe("createRunAuthRuntimeFailoverController", () => {
  beforeEach(() => {
    mocks.createRunAuthResolutionState.mockReset();
    mocks.getApiKeyForModel.mockReset();
    mocks.isSystemKeychainProvider.mockReset();
    mocks.resolveAuthProfileOrder.mockReset();
    mocks.resolveCopilotApiToken.mockReset();
    mocks.isProfileInCooldown.mockReset();
    mocks.resolveProfilesUnavailableReason.mockReset();
    mocks.saveAuthProfileStore.mockReset();
    mocks.upsertAuthProfileWithLock.mockReset();
    mocks.logWarn.mockReset();
    mocks.isSystemKeychainProvider.mockReturnValue(false);
    mocks.resolveAuthProfileOrder.mockReturnValue([]);
    mocks.isProfileInCooldown.mockReturnValue(false);
    mocks.resolveProfilesUnavailableReason.mockReturnValue("rate_limit");
  });

  it("initializes successfully from the first profile candidate", async () => {
    const state = makeResolutionState({
      runtimeOverride: "pi",
      authProvider: "anthropic",
      profileCandidates: [{ profileId: "anthropic:p1", resolveProfileId: "anthropic:p1" }],
    });
    mocks.createRunAuthResolutionState.mockResolvedValue(state);
    mocks.getApiKeyForModel.mockResolvedValue(resolvedAuth("anthropic:p1", "sk-first"));
    const { params, authStorage } = baseParams();

    const controller = await createRunAuthRuntimeFailoverController(params);

    expect(authStorage.setRuntimeApiKey).toHaveBeenCalledWith("anthropic", "sk-first");
    expect(controller.lastProfileId).toBe("anthropic:p1");
    expect(mocks.getApiKeyForModel).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "anthropic:p1" }),
    );
  });

  it("maps auth lookup model provider to resolved auth provider", async () => {
    const state = makeResolutionState({
      runtimeOverride: "pi",
      authProvider: "custom-bridge",
      profileCandidates: [{ profileId: "custom-bridge:p1", resolveProfileId: "custom-bridge:p1" }],
    });
    mocks.createRunAuthResolutionState.mockResolvedValue(state);
    mocks.getApiKeyForModel.mockResolvedValue(resolvedAuth("custom-bridge:p1", "sk-custom"));
    const { params } = baseParams({ model: { provider: "anthropic" } as never });

    const controller = await createRunAuthRuntimeFailoverController(params);
    const lookupModel = controller.resolveAuthLookupModel();

    expect(lookupModel.provider).toBe("custom-bridge");
  });

  it("accepts aws-sdk auth mode without an API key", async () => {
    const state = makeResolutionState({
      runtimeOverride: "pi",
      authProvider: "amazon-bedrock",
      profileCandidates: [{ profileId: "bedrock:aws-sdk", resolveProfileId: "bedrock:aws-sdk" }],
    });
    mocks.createRunAuthResolutionState.mockResolvedValue(state);
    mocks.getApiKeyForModel.mockResolvedValue({
      apiKey: undefined,
      source: "aws-sdk default chain",
      mode: "aws-sdk",
    });
    const { params, authStorage } = baseParams({
      provider: "amazon-bedrock",
      model: { provider: "amazon-bedrock" } as never,
    });

    const controller = await createRunAuthRuntimeFailoverController(params);

    expect(controller.lastProfileId).toBe("bedrock:aws-sdk");
    expect(authStorage.setRuntimeApiKey).not.toHaveBeenCalled();
  });

  it("exchanges github-copilot github token into a runtime copilot token", async () => {
    const state = makeResolutionState({
      runtimeOverride: "pi",
      authProvider: "github-copilot",
      profileCandidates: [
        { profileId: "github-copilot:p1", resolveProfileId: "github-copilot:p1" },
      ],
    });
    mocks.createRunAuthResolutionState.mockResolvedValue(state);
    mocks.getApiKeyForModel.mockResolvedValue({
      apiKey: "ghu_token",
      profileId: "github-copilot:p1",
      source: "profile:github-copilot:p1",
      mode: "token",
    });
    mocks.resolveCopilotApiToken.mockResolvedValue({
      token: "copilot_runtime_token",
      expiresAt: Date.now() + 60_000,
      source: "fetched",
      baseUrl: "https://api.individual.githubcopilot.com",
    });
    const { params, authStorage } = baseParams({
      provider: "github-copilot",
      model: { provider: "github-copilot" } as never,
    });

    await createRunAuthRuntimeFailoverController(params);

    expect(mocks.resolveCopilotApiToken).toHaveBeenCalledWith({ githubToken: "ghu_token" });
    expect(authStorage.setRuntimeApiKey).toHaveBeenCalledWith(
      "github-copilot",
      "copilot_runtime_token",
    );
  });

  it("reuses freshly exchanged copilot token for run-start sync without re-refreshing", async () => {
    const state = makeResolutionState({
      runtimeOverride: "pi",
      authProvider: "github-copilot",
      profileCandidates: [
        { profileId: "github-copilot:p1", resolveProfileId: "github-copilot:p1" },
      ],
    });
    mocks.createRunAuthResolutionState.mockResolvedValue(state);
    mocks.getApiKeyForModel.mockResolvedValue({
      apiKey: "ghu_token",
      profileId: "github-copilot:p1",
      source: "profile:github-copilot:p1",
      mode: "token",
    });
    mocks.resolveCopilotApiToken.mockResolvedValue({
      token: "copilot_runtime_token",
      expiresAt: Date.now() + 60 * 60 * 1000,
      source: "fetched",
      baseUrl: "https://api.individual.githubcopilot.com",
    });
    const { params } = baseParams({
      provider: "github-copilot",
      model: { provider: "github-copilot" } as never,
    });
    const controller = await createRunAuthRuntimeFailoverController(params);

    const synced = await controller.syncCopilotRefreshForCurrentProfile("run-start");

    expect(synced).toBe(true);
    expect(mocks.resolveCopilotApiToken).toHaveBeenCalledTimes(1);
    controller.stopCopilotRefreshTimer();
  });

  it("forces copilot refresh on auth-error sync even when token is fresh", async () => {
    const state = makeResolutionState({
      runtimeOverride: "pi",
      authProvider: "github-copilot",
      profileCandidates: [
        { profileId: "github-copilot:p1", resolveProfileId: "github-copilot:p1" },
      ],
    });
    mocks.createRunAuthResolutionState.mockResolvedValue(state);
    mocks.getApiKeyForModel.mockResolvedValue({
      apiKey: "ghu_token",
      profileId: "github-copilot:p1",
      source: "profile:github-copilot:p1",
      mode: "token",
    });
    mocks.resolveCopilotApiToken
      .mockResolvedValueOnce({
        token: "copilot_runtime_token",
        expiresAt: Date.now() + 60 * 60 * 1000,
        source: "fetched",
        baseUrl: "https://api.individual.githubcopilot.com",
      })
      .mockResolvedValueOnce({
        token: "copilot_runtime_token_refreshed",
        expiresAt: Date.now() + 60 * 60 * 1000,
        source: "fetched",
        baseUrl: "https://api.individual.githubcopilot.com",
      });
    const { params, authStorage } = baseParams({
      provider: "github-copilot",
      model: { provider: "github-copilot" } as never,
    });
    const controller = await createRunAuthRuntimeFailoverController(params);

    const synced = await controller.syncCopilotRefreshForCurrentProfile("auth-error");

    expect(synced).toBe(true);
    expect(mocks.resolveCopilotApiToken).toHaveBeenCalledTimes(2);
    expect(authStorage.setRuntimeApiKey).toHaveBeenLastCalledWith(
      "github-copilot",
      "copilot_runtime_token_refreshed",
    );
    controller.stopCopilotRefreshTimer();
  });

  it("rotates to the next profile when the current one fails", async () => {
    const state = makeResolutionState({
      runtimeOverride: "pi",
      authProvider: "anthropic",
      profileCandidates: [
        { profileId: "anthropic:p1", resolveProfileId: "anthropic:p1" },
        { profileId: "anthropic:p2", resolveProfileId: "anthropic:p2" },
        { profileId: "anthropic:p3", resolveProfileId: "anthropic:p3" },
      ],
    });
    mocks.createRunAuthResolutionState.mockResolvedValue(state);
    mocks.getApiKeyForModel
      .mockResolvedValueOnce(resolvedAuth("anthropic:p1", "sk-one"))
      .mockRejectedValueOnce(new Error("profile p2 misconfigured"))
      .mockResolvedValueOnce(resolvedAuth("anthropic:p3", "sk-three"));
    const onAuthRotationSuccess = vi.fn();
    const { params, authStorage } = baseParams({ onAuthRotationSuccess });
    const controller = await createRunAuthRuntimeFailoverController(params);

    const rotated = await controller.advanceAuthProfile();

    expect(rotated).toBe(true);
    expect(onAuthRotationSuccess).toHaveBeenCalledTimes(1);
    expect(authStorage.setRuntimeApiKey).toHaveBeenNthCalledWith(1, "anthropic", "sk-one");
    expect(authStorage.setRuntimeApiKey).toHaveBeenNthCalledWith(2, "anthropic", "sk-three");
    expect(controller.lastProfileId).toBe("anthropic:p3");
  });

  it("fails over Claude SDK provider exhaustion to Pi runtime", async () => {
    const state = makeResolutionState({
      runtimeOverride: "claude-sdk",
      authProvider: "claude-personal",
      profileCandidates: [
        { profileId: "claude-personal:system-keychain", resolveProfileId: undefined },
      ],
    });
    state.fallBackToPiRuntime = vi.fn(async () => {
      state.runtimeOverride = "pi";
      state.authProvider = "claude-personal";
      state.claudeSdkProviderOverride = undefined;
      state.profileCandidates = [
        { profileId: "claude-personal:pi", resolveProfileId: "claude-personal:pi" },
      ];
      state.profileIndex = 0;
      return true;
    });
    mocks.createRunAuthResolutionState.mockResolvedValue(state);
    mocks.getApiKeyForModel
      .mockResolvedValueOnce({
        apiKey: undefined,
        source: "Claude Subscription (system keychain)",
        mode: "system-keychain",
      })
      .mockResolvedValueOnce(resolvedAuth("claude-personal:pi", "sk-pi-fallback"));
    const onAuthRotationSuccess = vi.fn();
    const onClaudeSdkToPiFallback = vi.fn();
    const { params, authStorage } = baseParams({
      provider: "claude-personal",
      model: { provider: "claude-personal" } as never,
      onAuthRotationSuccess,
      onClaudeSdkToPiFallback,
    });
    const controller = await createRunAuthRuntimeFailoverController(params);

    const rotated = await controller.advanceAuthProfile();

    expect(rotated).toBe(true);
    expect(onClaudeSdkToPiFallback).toHaveBeenCalledTimes(1);
    expect(onAuthRotationSuccess).toHaveBeenCalledTimes(1);
    expect(controller.authResolution.runtimeOverride).toBe("pi");
    expect(controller.lastProfileId).toBe("claude-personal:pi");
    expect(authStorage.setRuntimeApiKey).toHaveBeenLastCalledWith(
      "claude-personal",
      "sk-pi-fallback",
    );
  });

  it("throws cooldown failover when every candidate is unavailable due to cooldown", async () => {
    const state = makeResolutionState({
      runtimeOverride: "pi",
      authProvider: "anthropic",
      profileCandidates: [
        { profileId: "anthropic:p1", resolveProfileId: "anthropic:p1" },
        { profileId: "anthropic:p2", resolveProfileId: "anthropic:p2" },
      ],
    });
    mocks.createRunAuthResolutionState.mockResolvedValue(state);
    mocks.isProfileInCooldown.mockReturnValue(true);
    const { params } = baseParams();

    await expect(createRunAuthRuntimeFailoverController(params)).rejects.toMatchObject({
      name: "FailoverError",
      reason: "rate_limit",
    });
  });

  it("surfaces the latest real resolution error instead of cooldown-only messaging", async () => {
    const state = makeResolutionState({
      runtimeOverride: "pi",
      authProvider: "anthropic",
      profileCandidates: [
        { profileId: "anthropic:p1", resolveProfileId: "anthropic:p1" },
        { profileId: "anthropic:p2", resolveProfileId: "anthropic:p2" },
      ],
    });
    mocks.createRunAuthResolutionState.mockResolvedValue(state);
    mocks.getApiKeyForModel
      .mockRejectedValueOnce(new Error("profile p1 missing token"))
      .mockRejectedValueOnce(new Error("401 invalid key for profile p2"));
    const { params } = baseParams();

    await expect(createRunAuthRuntimeFailoverController(params)).rejects.toMatchObject({
      name: "FailoverError",
      reason: "auth",
      message: "401 invalid key for profile p2",
    });
  });

  it("warns when Pi fallback succeeds but still cannot initialize a profile", async () => {
    const state = makeResolutionState({
      runtimeOverride: "claude-sdk",
      authProvider: "claude-personal",
      profileCandidates: [
        { profileId: "claude-personal:system-keychain", resolveProfileId: undefined },
      ],
    });
    state.fallBackToPiRuntime = vi.fn(async () => {
      state.runtimeOverride = "pi";
      state.authProvider = "claude-personal";
      state.claudeSdkProviderOverride = undefined;
      state.profileCandidates = [];
      state.profileIndex = 0;
      return true;
    });
    mocks.createRunAuthResolutionState.mockResolvedValue(state);
    mocks.getApiKeyForModel.mockResolvedValue({
      apiKey: undefined,
      source: "Claude Subscription (system keychain)",
      mode: "system-keychain",
    });
    const onClaudeSdkToPiFallback = vi.fn();
    const { params } = baseParams({
      provider: "claude-personal",
      model: { provider: "claude-personal" } as never,
      fallbackConfigured: false,
      onClaudeSdkToPiFallback,
    });
    const controller = await createRunAuthRuntimeFailoverController(params);

    const rotated = await controller.advanceAuthProfile();

    expect(rotated).toBe(false);
    expect(onClaudeSdkToPiFallback).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(
      expect.stringContaining("switched from Claude SDK to Pi runtime"),
    );
  });

  it("returns false when Claude SDK provider exhaustion cannot fall back to Pi runtime", async () => {
    const state = makeResolutionState({
      runtimeOverride: "claude-sdk",
      authProvider: "claude-personal",
      profileCandidates: [
        { profileId: "claude-personal:system-keychain", resolveProfileId: undefined },
      ],
    });
    state.fallBackToPiRuntime = vi.fn(async () => false);
    mocks.createRunAuthResolutionState.mockResolvedValue(state);
    mocks.getApiKeyForModel.mockResolvedValue({
      apiKey: undefined,
      source: "Claude Subscription (system keychain)",
      mode: "system-keychain",
    });
    const onClaudeSdkToPiFallback = vi.fn();
    const { params } = baseParams({
      provider: "claude-personal",
      model: { provider: "claude-personal" } as never,
      fallbackConfigured: false,
      onClaudeSdkToPiFallback,
    });
    const controller = await createRunAuthRuntimeFailoverController(params);

    const rotated = await controller.advanceAuthProfile();

    expect(rotated).toBe(false);
    expect(onClaudeSdkToPiFallback).not.toHaveBeenCalled();
  });

  it("throws through locked-profile initialization errors without advancing", async () => {
    const state = makeResolutionState({
      runtimeOverride: "pi",
      authProvider: "anthropic",
      lockedProfileId: "anthropic:locked",
      profileCandidates: [{ profileId: "anthropic:locked", resolveProfileId: "anthropic:locked" }],
    });
    mocks.createRunAuthResolutionState.mockResolvedValue(state);
    mocks.getApiKeyForModel.mockRejectedValue(new Error("locked profile invalid"));
    const { params } = baseParams({ fallbackConfigured: false });

    await expect(createRunAuthRuntimeFailoverController(params)).rejects.toThrow(
      "locked profile invalid",
    );
    expect(state.profileIndex).toBe(0);
  });

  it("throws a plain error when fallback is disabled and no candidates can initialize", async () => {
    const state = makeResolutionState({
      runtimeOverride: "pi",
      authProvider: "anthropic",
      profileCandidates: [{ profileId: "anthropic:p1", resolveProfileId: "anthropic:p1" }],
    });
    mocks.createRunAuthResolutionState.mockResolvedValue(state);
    mocks.getApiKeyForModel.mockRejectedValue(new Error("profile auth unavailable"));
    const { params } = baseParams({ fallbackConfigured: false });

    try {
      await createRunAuthRuntimeFailoverController(params);
      throw new Error("expected controller creation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(FailoverError);
      expect((error as Error).message).toBe("profile auth unavailable");
    }
  });

  it("keeps FailoverError shape when fallbackConfigured is enabled", async () => {
    const state = makeResolutionState({
      runtimeOverride: "pi",
      authProvider: "anthropic",
      profileCandidates: [{ profileId: "anthropic:p1", resolveProfileId: "anthropic:p1" }],
    });
    mocks.createRunAuthResolutionState.mockResolvedValue(state);
    mocks.getApiKeyForModel.mockRejectedValue(new Error("authentication error"));
    const { params } = baseParams({ fallbackConfigured: true });

    await expect(createRunAuthRuntimeFailoverController(params)).rejects.toBeInstanceOf(
      FailoverError,
    );
  });
});
