import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveAuthProfileOrder: vi.fn(),
  upsertAuthProfileWithLock: vi.fn(),
  saveAuthProfileStore: vi.fn(),
}));

vi.mock("../model-auth.js", () => ({
  SYSTEM_KEYCHAIN_PROVIDERS: new Set(["claude-personal"]),
  resolveAuthProfileOrder: mocks.resolveAuthProfileOrder,
}));

vi.mock("../auth-profiles.js", () => ({
  upsertAuthProfileWithLock: mocks.upsertAuthProfileWithLock,
  saveAuthProfileStore: mocks.saveAuthProfileStore,
}));

import { createClaudeSdkAuthResolutionState } from "./auth-resolution.js";

describe("createClaudeSdkAuthResolutionState", () => {
  beforeEach(() => {
    mocks.resolveAuthProfileOrder.mockReset();
    mocks.upsertAuthProfileWithLock.mockReset();
    mocks.saveAuthProfileStore.mockReset();
    mocks.resolveAuthProfileOrder.mockReturnValue([]);
    mocks.upsertAuthProfileWithLock.mockResolvedValue({
      profiles: {
        "claude-personal:system-keychain": {
          type: "token",
          provider: "claude-personal",
          token: "system-keychain",
        },
      },
    });
  });

  it("creates and persists a synthetic keychain profile for claude-personal", async () => {
    const authStore = { profiles: {} } as never;
    const state = await createClaudeSdkAuthResolutionState({
      provider: "claude-personal",
      cfg: {},
      claudeSdkConfig: undefined,
      authStore,
      agentDir: "/tmp/agent",
      preferredProfileId: undefined,
      authProfileIdSource: undefined,
    });

    expect(state.runtimeOverride).toBe("claude-sdk");
    expect(state.authProvider).toBe("claude-personal");
    expect(state.profileCandidates[0]?.profileId).toBe("claude-personal:system-keychain");
    expect(mocks.upsertAuthProfileWithLock).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "claude-personal:system-keychain" }),
    );
  });

  it("keeps runtime unset for non-system-keychain providers", async () => {
    const authStore = { profiles: {} } as never;
    const state = await createClaudeSdkAuthResolutionState({
      provider: "anthropic",
      cfg: {},
      claudeSdkConfig: undefined,
      authStore,
      agentDir: "/tmp/agent",
      preferredProfileId: undefined,
      authProfileIdSource: undefined,
    });

    expect(state.runtimeOverride).toBeUndefined();
    expect(state.authProvider).toBe("anthropic");
  });

  it("fallBackToPiRuntime switches runtime to pi and restores original provider", async () => {
    const authStore = { profiles: {} } as never;
    const state = await createClaudeSdkAuthResolutionState({
      provider: "claude-personal",
      cfg: {},
      claudeSdkConfig: undefined,
      authStore,
      agentDir: "/tmp/agent",
      preferredProfileId: undefined,
      authProfileIdSource: undefined,
    });

    expect(state.runtimeOverride).toBe("claude-sdk");
    const fell = await state.fallBackToPiRuntime();
    expect(fell).toBe(true);
    expect(state.runtimeOverride).toBe("pi");
    expect(state.authProvider).toBe("claude-personal");
  });

  it("fallBackToPiRuntime returns false when runtime is not claude-sdk", async () => {
    const authStore = { profiles: {} } as never;
    const state = await createClaudeSdkAuthResolutionState({
      provider: "anthropic",
      cfg: {},
      claudeSdkConfig: undefined,
      authStore,
      agentDir: "/tmp/agent",
      preferredProfileId: undefined,
      authProfileIdSource: undefined,
    });

    expect(state.runtimeOverride).toBeUndefined();
    expect(await state.fallBackToPiRuntime()).toBe(false);
  });

  it("fallBackToPiRuntime preserves claude-personal as authProvider", async () => {
    const authStore = { profiles: {} } as never;
    const state = await createClaudeSdkAuthResolutionState({
      provider: "claude-personal",
      cfg: {},
      claudeSdkConfig: undefined,
      authStore,
      agentDir: "/tmp/agent",
      preferredProfileId: undefined,
      authProfileIdSource: undefined,
    });

    expect(state.runtimeOverride).toBe("claude-sdk");
    const fell = await state.fallBackToPiRuntime();
    expect(fell).toBe(true);
    expect(state.runtimeOverride).toBe("pi");
    // authProvider must remain "claude-personal" — must NOT cross into anthropic API-key credentials
    expect(state.authProvider).toBe("claude-personal");
    expect(state.authProvider).not.toBe("anthropic");
  });

  it("advanceProfileIndex increments for unlocked profiles", async () => {
    mocks.resolveAuthProfileOrder.mockReturnValue(["claude-personal:p1", "claude-personal:p2"]);
    const authStore = {
      profiles: {
        "claude-personal:p1": { type: "token", provider: "claude-personal", token: "one" },
        "claude-personal:p2": { type: "token", provider: "claude-personal", token: "two" },
      },
    } as never;
    const state = await createClaudeSdkAuthResolutionState({
      provider: "claude-personal",
      cfg: {},
      claudeSdkConfig: undefined,
      authStore,
      agentDir: "/tmp/agent",
      preferredProfileId: undefined,
      authProfileIdSource: undefined,
    });

    expect(state.profileIndex).toBe(0);
    state.advanceProfileIndex();
    expect(state.profileIndex).toBe(1);
    state.advanceProfileIndex();
    expect(state.profileIndex).toBe(2);
  });

  it("surfaces synthetic keychain profile creation failure", async () => {
    mocks.upsertAuthProfileWithLock.mockRejectedValueOnce(new Error("lock failed"));
    const authStore = { profiles: {} } as never;

    await expect(
      createClaudeSdkAuthResolutionState({
        provider: "claude-personal",
        cfg: {},
        claudeSdkConfig: undefined,
        authStore,
        agentDir: "/tmp/agent",
        preferredProfileId: undefined,
        authProfileIdSource: undefined,
      }),
    ).rejects.toThrow("lock failed");
  });
});
