import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createPreparedAccountCatalogAccess } from "./prepared-model-runtime.catalog-auth.js";

describe("prepared account catalog access", () => {
  afterEach(() => vi.useRealTimers());

  it("retains account discovery across request projections until explicit refresh or identity replacement", async () => {
    const retirement = new AbortController();
    const owner = createPreparedAccountCatalogAccess(() => true, retirement.signal);
    const credential = {
      type: "token",
      provider: "openai",
      token: "synthetic-account-token",
    } as const;
    const load = vi.fn(async () => [
      { provider: "openai", profileId: "account", status: "ready" as const },
    ]);
    const request = { profileId: "account", credential, load, allowDiscovery: true };
    expect((await owner.acquire({ ...request, allowDiscovery: false })).outcomes).toEqual([]);
    expect(load).not.toHaveBeenCalled();
    const first = await owner.acquire(request);
    await owner.acquire({ ...request, credential: { ...credential } });
    await owner.acquire({ ...request, allowDiscovery: false });
    expect(load).toHaveBeenCalledOnce();
    const refreshed = await owner.acquire({ ...request, refresh: true });
    expect(load).toHaveBeenCalledTimes(2);
    expect(first.isCurrent()).toBe(false);
    const failure = new Error("Discovery unavailable");
    load.mockRejectedValueOnce(failure);
    await expect(owner.acquire({ ...request, refresh: true })).rejects.toBe(failure);
    expect((await owner.acquire(request)).outcomes).toEqual(refreshed.outcomes);
    expect(refreshed.isCurrent()).toBe(true);
    expect(load).toHaveBeenCalledTimes(3);
    const entered = createDeferred();
    const release = createDeferred();
    load.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return [];
    });
    const superseded = owner.acquire({ ...request, refresh: true });
    await entered.promise;
    const replacement = await owner.acquire({
      ...request,
      credential: { ...credential, token: "synthetic-replacement-token" },
    });
    expect(refreshed.isCurrent()).toBe(false);
    release.resolve();
    await expect(superseded).rejects.toThrow("changed");
    expect(replacement.isCurrent()).toBe(true);
    expect(load).toHaveBeenCalledTimes(5);
    retirement.abort();
    await expect(owner.acquire(request)).rejects.toThrow("changed");
    expect(load).toHaveBeenCalledTimes(5);
  });

  it.for(["during discovery", "after publication"] as const)(
    "retires response observers when explicit refresh arrives %s",
    async (timing) => {
      const owner = createPreparedAccountCatalogAccess(() => true);
      const credential = { type: "api_key", provider: "openai", key: "synthetic-key" } as const;
      const record = owner.prepareServiceTierObserver({
        credential,
        selectedCredential: {
          source: "profile",
          profileId: "account",
          identityKey: "profile:account",
        },
      });
      const observation = {
        modelId: "fixture-model",
        runtimeId: "openclaw",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        requestedTier: "ultrafast",
        responseTier: "priority",
      };
      record(observation);
      const entered = createDeferred();
      const release = createDeferred<[]>();
      const load = vi.fn(() => {
        entered.resolve();
        return release.promise;
      });
      const request = { profileId: "account", credential, load, allowDiscovery: true };
      const cold = owner.acquire(request);
      await entered.promise;
      if (timing === "after publication") {
        release.resolve([]);
        await release.promise;
      }
      const refresh = owner.acquire({ ...request, refresh: true });
      release.resolve([]);
      await Promise.all([
        timing === "after publication"
          ? expect(cold).rejects.toThrow("Selected account catalog changed")
          : expect(cold).resolves.toMatchObject({ outcomes: [] }),
        expect(refresh).resolves.toMatchObject({ outcomes: [] }),
      ]);
      expect(load).toHaveBeenCalledTimes(timing === "during discovery" ? 1 : 2);
      expect(
        owner.readServiceTierObservation({ ...observation, identityKey: "profile:account" }),
      ).toBeUndefined();
      expect(record(observation)).toBe(false);
    },
  );

  it("keeps response tier observations account-bound without completing discovery and revokes stale observers", async () => {
    const retirement = new AbortController();
    const onChanged = vi.fn();
    const owner = createPreparedAccountCatalogAccess(() => true, retirement.signal, {}, onChanged);
    const credential = { type: "api_key", provider: "openai", key: "synthetic-key" } as const;
    const account = {
      profileId: "openai:account",
      credential,
      selectedCredential: {
        source: "profile" as const,
        profileId: "openai:account",
        identityKey: "profile:openai:account",
      },
    };
    const observation = {
      modelId: "fixture-model",
      runtimeId: "openclaw",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1/",
      requestedTier: "ultrafast",
      responseTier: "priority",
    };
    const route = { ...observation, identityKey: account.selectedCredential.identityKey };
    const record = owner.prepareServiceTierObserver(account);
    expect(record(observation)).toBe(true);
    expect(record({ ...observation, baseUrl: "https://api.openai.com/v1" })).toBe(false);
    expect(owner.readServiceTierObservation(route)).toEqual({
      requestedTier: "ultrafast",
      responseTier: "priority",
    });
    for (const mismatch of [
      { identityKey: "profile:openai:other" },
      { modelId: "other-model" },
      { runtimeId: "codex" },
      { api: "openai-chatgpt-responses" },
      { baseUrl: "https://other.example/v1" },
    ]) {
      expect(owner.readServiceTierObservation({ ...route, ...mismatch })).toBeUndefined();
    }
    const outcomes = [
      { provider: "openai", profileId: account.profileId, status: "ready" as const },
    ];
    const load = vi.fn(async () => outcomes);
    const request = { ...account, load, allowDiscovery: true };
    expect((await owner.acquire({ ...request, allowDiscovery: false })).outcomes).toEqual([]);
    expect(load).not.toHaveBeenCalled();
    const catalogFailure = new Error("catalog unavailable");
    await expect(
      owner.acquire({
        ...request,
        load: async () => {
          throw catalogFailure;
        },
      }),
    ).rejects.toBe(catalogFailure);
    expect(owner.readServiceTierObservation(route)?.responseTier).toBe("priority");
    expect((await owner.acquire(request)).outcomes).toEqual(outcomes);
    expect(owner.readServiceTierObservation(route)?.responseTier).toBe("priority");
    expect(load).toHaveBeenCalledOnce();

    onChanged.mockClear();
    await owner.acquire({ ...request, refresh: true });
    expect(owner.readServiceTierObservation(route)).toBeUndefined();
    expect(onChanged).toHaveBeenCalledOnce();
    expect(record(observation)).toBe(false);
    const refreshed = owner.prepareServiceTierObserver(account);
    expect(refreshed(observation)).toBe(true);
    onChanged.mockClear();
    const replaced = owner.prepareServiceTierObserver({
      ...account,
      credential: { ...credential, key: "synthetic-replacement-key" },
    });
    expect(owner.readServiceTierObservation(route)).toBeUndefined();
    expect(refreshed(observation)).toBe(false);
    expect(onChanged).toHaveBeenCalledOnce();
    expect(replaced(observation)).toBe(true);
    retirement.abort();
    expect(owner.readServiceTierObservation(route)).toBeUndefined();
    expect(replaced(observation)).toBe(false);
    expect(owner.prepareServiceTierObserver(account)(observation)).toBe(false);
  });

  it("notifies downgrade, recovery, and expiry while refreshing repeats and canceling retired timers", () => {
    vi.useFakeTimers({ now: 1_000 });
    const onChanged = vi.fn();
    const retirement = new AbortController();
    const owner = createPreparedAccountCatalogAccess(() => true, retirement.signal, {}, onChanged);
    const record = owner.prepareServiceTierObserver({
      selectedCredential: {
        source: "profile",
        profileId: "openai:account",
        identityKey: "profile:openai:account",
      },
      credential: { type: "api_key", provider: "openai", key: "synthetic-key" },
    });
    const route = {
      identityKey: "profile:openai:account",
      modelId: "fixture-model",
      runtimeId: "openclaw",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    };
    const observation = { ...route, requestedTier: "ultrafast", responseTier: "priority" };
    expect(record(observation)).toBe(true);
    record({ ...observation, modelId: "other-model" });
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(240_000);
    expect(record(observation)).toBe(false);
    expect(onChanged).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    expect(onChanged).toHaveBeenCalledTimes(3);
    expect(owner.readServiceTierObservation({ ...route, modelId: "other-model" })).toBeUndefined();
    vi.advanceTimersByTime(239_999);
    expect(owner.readServiceTierObservation(route)?.responseTier).toBe("priority");
    expect(onChanged).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1);
    expect(owner.readServiceTierObservation(route)).toBeUndefined();
    expect(onChanged).toHaveBeenCalledTimes(4);
    expect(record(observation)).toBe(true);
    expect(record({ ...observation, responseTier: "ultrafast" })).toBe(true);
    expect(owner.readServiceTierObservation(route)).toBeUndefined();
    expect(record({ ...observation, responseTier: "ultrafast" })).toBe(false);
    expect(onChanged).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
    record(observation);
    expect(vi.getTimerCount()).toBe(1);
    retirement.abort();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(300_000);
    expect(onChanged).toHaveBeenCalledTimes(7);
  });

  it("bounds response tier observations per account and rejects a superseded owner", () => {
    let current = true;
    const owner = createPreparedAccountCatalogAccess(() => current);
    const account = {
      profileId: "openai:account",
      selectedCredential: {
        source: "profile" as const,
        profileId: "openai:account",
        identityKey: "profile:openai:account",
      },
      credential: { type: "api_key", provider: "openai", key: "synthetic-key" } as const,
    };
    const route = {
      identityKey: account.selectedCredential.identityKey,
      modelId: "model-0",
      runtimeId: "openclaw",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    };
    const record = owner.prepareServiceTierObserver(account);
    for (let index = 0; index <= 128; index++) {
      record({
        ...route,
        modelId: `model-${index}`,
        requestedTier: "ultrafast",
        responseTier: "priority",
      });
    }
    expect(owner.readServiceTierObservation(route)).toBeUndefined();
    expect(owner.readServiceTierObservation({ ...route, modelId: "model-128" })).toEqual({
      requestedTier: "ultrafast",
      responseTier: "priority",
    });
    current = false;
    expect(owner.readServiceTierObservation({ ...route, modelId: "model-128" })).toBeUndefined();
    expect(record({ ...route, requestedTier: "ultrafast", responseTier: "priority" })).toBe(false);
  });
});
