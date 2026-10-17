import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordCodexThreadForkSettings,
  recordCodexTurnForkSettings,
  requireCodexThreadForkSettings,
} from "./client-fork-settings.js";
import type { CodexAppServerClient } from "./client.js";
import { createClientHarness } from "./test-support.js";

const EXPECTED_LIVE_THREAD_IDLE_TIMEOUT_MS = 30 * 60_000;
const EXPECTED_MAX_IDLE_LIVE_THREADS = 64;

const mocks = vi.hoisted(() => ({
  refreshAuth: vi.fn(async (_params?: { authProfileStore?: unknown }) => ({
    accessToken: "refreshed",
    chatgptAccountId: "account",
  })),
  mergeRateLimitUpdate: vi.fn(),
}));

vi.mock("./auth-bridge.js", () => ({
  refreshCodexAppServerAuthTokens: mocks.refreshAuth,
}));

vi.mock("./rate-limit-cache.js", () => ({
  mergeCodexRateLimitsUpdate: mocks.mergeRateLimitUpdate,
}));

const {
  claimCodexAppServerLiveThread,
  consumeCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  hasCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
  protectCodexAppServerLiveThread,
  releaseCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
  unsubscribeCodexAppServerLiveThread,
} = await import("./client-runtime.js");

describe("Codex app-server client runtime", () => {
  const clients: CodexAppServerClient[] = [];

  function createHarness() {
    const harness = createClientHarness();
    clients.push(harness.client);
    return harness;
  }

  function createRuntimeHarness() {
    const harness = createHarness();
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: "/tmp/agent" });
    return harness;
  }

  afterEach(() => {
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
    mocks.refreshAuth.mockClear();
    mocks.mergeRateLimitUpdate.mockClear();
  });

  it("keeps native creation instructions and latest turn settings only for the live parent", () => {
    const { client } = createRuntimeHarness();
    expect(() => requireCodexThreadForkSettings(client, "parent")).toThrow("normal message first");
    recordCodexThreadForkSettings(client, "parent", {
      model: "parent-model",
      developerInstructions: "creation policy",
      config: { web_search: "disabled", "features.computer_use": true },
    });
    recordCodexTurnForkSettings(client, {
      threadId: "parent",
      input: [],
      effort: "high",
      environments: [{ environmentId: "parent-env", cwd: "/workspace" }],
    });
    recordCodexThreadForkSettings(client, "parent", {
      threadId: "parent",
      developerInstructions: "ignored warm resume override",
    });
    recordCodexTurnForkSettings(client, {
      threadId: "parent",
      input: [],
      effort: "xhigh",
      serviceTier: "priority",
    });
    expect(requireCodexThreadForkSettings(client, "parent")).toMatchObject({
      thread: {
        model: "parent-model",
        developerInstructions: "creation policy",
        config: { web_search: "disabled", "features.computer_use": true },
      },
      turn: { effort: "xhigh", serviceTier: "priority" },
    });
    client.close();
    expect(() => requireCodexThreadForkSettings(client, "parent")).toThrow("normal message first");
  });

  it("retains ephemeral policy and history beyond persistent idle and capacity limits", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const { client } = createClientHarness();
    clients.push(client);
    ensureCodexAppServerClientRuntime(client, { agentDir: "/tmp/agent" });
    const release = vi.fn(async (_threadId: string) => undefined);
    const ephemeralPolicy = { developerInstructions: "" };
    await retainCodexAppServerLiveThread(
      client,
      "ephemeral",
      release,
      "creation-config",
      null,
      ephemeralPolicy,
    );
    for (let i = 0; i <= EXPECTED_MAX_IDLE_LIVE_THREADS; i++) {
      await retainCodexAppServerLiveThread(client, `persistent-${i}`, release);
    }
    await vi.advanceTimersByTimeAsync(EXPECTED_LIVE_THREAD_IDLE_TIMEOUT_MS + 1);
    const ownership = await consumeCodexAppServerLiveThread(client, "ephemeral");
    expect(ownership).toMatchObject({ configFingerprint: "creation-config", ephemeralPolicy });
    expect(release.mock.calls.some(([threadId]) => threadId === "ephemeral")).toBe(false);
    await ownership?.release("ephemeral");
    expect(hasCodexAppServerLiveThread(client, "ephemeral")).toBe(false);
  });

  it("installs shared handlers once per physical client", async () => {
    const { client, send, writes } = createHarness();
    const context = {
      agentDir: "/tmp/agent",
      authProfileId: "openai:default",
      authProfileStore: { version: 1 as const, profiles: {} },
      config: {},
    };
    const updatedContext = {
      ...context,
      authProfileStore: { version: 1 as const, profiles: {} },
      config: { models: { mode: "merge" as const } },
    };
    const addNotificationHandler = vi.spyOn(client, "addNotificationHandler");
    const addRequestHandler = vi.spyOn(client, "addRequestHandler");
    const addCloseHandler = vi.spyOn(client, "addCloseHandler");

    ensureCodexAppServerClientRuntime(client, context);
    ensureCodexAppServerClientRuntime(client, updatedContext);

    expect(addNotificationHandler).toHaveBeenCalledTimes(1);
    expect(addRequestHandler).toHaveBeenCalledTimes(1);
    expect(addCloseHandler).toHaveBeenCalledTimes(1);
    send({
      method: "account/rateLimits/updated",
      params: { rateLimits: { primary: { usedPercent: 12 } } },
    });
    send({
      id: "refresh-1",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "expired" },
    });

    await vi.waitFor(() => expect(mocks.mergeRateLimitUpdate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(mocks.refreshAuth).toHaveBeenCalledTimes(1));
    expect(mocks.refreshAuth).toHaveBeenCalledWith({
      ...context,
      config: updatedContext.config,
    });
    expect(mocks.refreshAuth.mock.calls[0]?.[0]?.authProfileStore).toBe(context.authProfileStore);
    expect(mocks.mergeRateLimitUpdate).toHaveBeenCalledWith(client, {
      rateLimits: { primary: { usedPercent: 12 } },
    });
    await vi.waitFor(() =>
      expect(writes.map((line) => JSON.parse(line) as unknown)).toContainEqual({
        id: "refresh-1",
        result: { accessToken: "refreshed", chatgptAccountId: "account" },
      }),
    );
  });

  it("rejects ChatGPT refresh on a prepared API-key client", async () => {
    const { client, send, writes } = createHarness();
    ensureCodexAppServerClientRuntime(client, {
      agentDir: "/tmp/agent",
      authMode: "prepared-api-key",
    });

    send({
      id: "refresh-api-key",
      method: "account/chatgptAuthTokens/refresh",
      params: { reason: "expired" },
    });

    await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0));
    expect(mocks.refreshAuth).not.toHaveBeenCalled();
    expect(JSON.parse(writes.at(-1) ?? "{}")).toMatchObject({
      id: "refresh-api-key",
      error: {
        message: "ChatGPT token refresh is unavailable for prepared Codex API-key auth.",
      },
    });
  });

  it("requests retirement when its auth owner rejects a workspace change", async () => {
    vi.useFakeTimers();
    mocks.refreshAuth.mockRejectedValueOnce(new Error("ChatGPT workspace changed"));
    const { client, send, writes } = createHarness();
    const onAuthRefreshFailure = vi.fn();
    ensureCodexAppServerClientRuntime(client, {
      agentDir: "/tmp/agent",
      authProfileId: "openai:default",
      onAuthRefreshFailure,
    });

    send({
      id: "refresh-other-workspace",
      method: "account/chatgptAuthTokens/refresh",
      params: {
        reason: "unauthorized",
        previousAccountId: "original-workspace",
      },
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(onAuthRefreshFailure).toHaveBeenCalledOnce();
    expect(JSON.parse(writes.at(-1) ?? "{}")).toMatchObject({
      id: "refresh-other-workspace",
      error: { message: expect.stringContaining("ChatGPT workspace changed") },
    });
  });

  it("retains independently subscribed conversations on the same physical client", async () => {
    const { client } = createHarness();

    await expect(retainCodexAppServerLiveThread(client, "thread-before-runtime")).resolves.toBe(
      false,
    );
    ensureCodexAppServerClientRuntime(client, { agentDir: "/tmp/agent" });

    await expect(retainCodexAppServerLiveThread(client, "thread-a")).resolves.toBe(true);
    await expect(retainCodexAppServerLiveThread(client, "thread-b")).resolves.toBe(true);
    await expect(consumeCodexAppServerLiveThread(client, "thread-a")).resolves.toEqual(
      expect.objectContaining({ release: expect.any(Function) }),
    );
    await expect(consumeCodexAppServerLiveThread(client, "thread-b")).resolves.toEqual(
      expect.objectContaining({ release: expect.any(Function) }),
    );
    await expect(consumeCodexAppServerLiveThread(client, "thread-a")).resolves.toBeUndefined();
  });

  it("claims a fresh auto-subscribed child without exposing or evicting an idle owner", async () => {
    const request = vi.fn(async () => ({}));
    const client = {
      request,
      addCloseHandler: vi.fn(),
      addNotificationHandler: vi.fn(),
      addRequestHandler: vi.fn(),
    } as unknown as CodexAppServerClient;
    ensureCodexAppServerClientRuntime(client, { agentDir: "/tmp/agent" });
    const idleRelease = vi.fn(async () => undefined);
    for (let index = 0; index < EXPECTED_MAX_IDLE_LIVE_THREADS; index += 1) {
      await retainCodexAppServerLiveThread(client, `thread-idle-${index}`, idleRelease);
    }

    const ownership = await claimCodexAppServerLiveThread(client, "thread-fresh-child");

    expect(ownership).toEqual(expect.objectContaining({ release: expect.any(Function) }));
    expect(isCodexAppServerLiveThreadClaimed(client, "thread-fresh-child")).toBe(true);
    expect(idleRelease).not.toHaveBeenCalled();
    await expect(
      claimCodexAppServerLiveThread(client, "thread-fresh-child"),
    ).resolves.toBeUndefined();
    await expect(retainCodexAppServerLiveThread(client, "thread-fresh-child")).resolves.toBe(false);
    await expect(
      consumeCodexAppServerLiveThread(client, "thread-fresh-child"),
    ).resolves.toBeUndefined();
    await ownership?.release("thread-fresh-child");

    expect(request).toHaveBeenCalledExactlyOnceWith(
      "thread/unsubscribe",
      { threadId: "thread-fresh-child" },
      { timeoutMs: 5_000 },
    );
    expect(isCodexAppServerLiveThreadClaimed(client, "thread-fresh-child")).toBe(false);
    expect(idleRelease).not.toHaveBeenCalled();
  });

  it("keeps claimed ownership until physical release succeeds", async () => {
    const { client } = createRuntimeHarness();
    const release = vi
      .fn<(threadId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("unsubscribe unavailable"))
      .mockResolvedValueOnce(undefined);
    await retainCodexAppServerLiveThread(client, "thread-claimed", release);
    const invalidated = vi.fn();
    const ownership = await claimCodexAppServerLiveThread(client, "thread-claimed", invalidated);
    expect(ownership).toBeDefined();

    expect(invalidated).not.toHaveBeenCalled();
    expect(isCodexAppServerLiveThreadClaimed(client, "thread-claimed")).toBe(true);
    await expect(ownership?.release("thread-claimed")).rejects.toThrow("unsubscribe unavailable");
    expect(invalidated).not.toHaveBeenCalled();
    expect(isCodexAppServerLiveThreadClaimed(client, "thread-claimed")).toBe(true);
    expect(hasCodexAppServerLiveThread(client, "thread-claimed")).toBe(true);
    await expect(ownership?.release("thread-claimed")).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledTimes(2);
    expect(hasCodexAppServerLiveThread(client, "thread-claimed")).toBe(false);
    expect(invalidated).toHaveBeenCalledOnce();
    await ownership?.release("thread-claimed");
    client.close();
    expect(invalidated).toHaveBeenCalledOnce();
  });

  it("rejects unproven or stale ownership before transferring an active claim", async () => {
    const { client } = createRuntimeHarness();
    await retainCodexAppServerLiveThread(client, "thread-owned");
    const current = await consumeCodexAppServerLiveThread(client, "thread-owned");

    await expect(retainCodexAppServerLiveThread(client, "thread-owned")).resolves.toBe(false);
    await expect(
      retainCodexAppServerLiveThread(client, "thread-owned", async () => undefined),
    ).resolves.toBe(false);
    expect(isCodexAppServerLiveThreadClaimed(client, "thread-owned")).toBe(true);
    await expect(consumeCodexAppServerLiveThread(client, "thread-owned")).resolves.toBeUndefined();
    await expect(
      retainCodexAppServerLiveThread(client, "thread-owned", current?.release),
    ).resolves.toBe(true);
    const successor = await consumeCodexAppServerLiveThread(client, "thread-owned");

    await expect(
      retainCodexAppServerLiveThread(client, "thread-owned", current?.release),
    ).resolves.toBe(false);
    expect(isCodexAppServerLiveThreadClaimed(client, "thread-owned")).toBe(true);
    await expect(
      retainCodexAppServerLiveThread(client, "thread-owned", successor?.release),
    ).resolves.toBe(true);
  });

  it("preserves a retained successor from obsolete forget, release, and republish after independent-retain", async () => {
    vi.useFakeTimers();
    const { client } = createRuntimeHarness();
    const originalRelease = vi.fn(async (_threadId: string) => undefined);
    const replacementRelease = vi.fn(async (_threadId: string) => undefined);
    await retainCodexAppServerLiveThread(client, "thread-reused", originalRelease);
    const invalidated = vi.fn();
    const original = await claimCodexAppServerLiveThread(client, "thread-reused", invalidated);
    expect(original).toBeDefined();
    await expect(
      retainCodexAppServerLiveThread(client, "thread-reused", original?.release),
    ).resolves.toBe(true);
    expect(invalidated).not.toHaveBeenCalled();
    await expect(
      retainCodexAppServerLiveThread(
        client,
        "thread-reused",
        replacementRelease,
        "successor-config",
      ),
    ).resolves.toBe(true);
    expect(invalidated).toHaveBeenCalledOnce();

    original?.forget();
    await original?.release("thread-reused");
    await expect(
      retainCodexAppServerLiveThread(client, "thread-reused", original?.release),
    ).resolves.toBe(false);

    expect(originalRelease).toHaveBeenCalledTimes(0);
    expect(replacementRelease).not.toHaveBeenCalled();
    expect(isCodexAppServerLiveThreadClaimed(client, "thread-reused")).toBe(false);
    const successor = await consumeCodexAppServerLiveThread(client, "thread-reused");
    expect(successor).toMatchObject({ configFingerprint: "successor-config" });
    successor?.assertCurrent();
    await successor?.release("thread-reused");
    expect(replacementRelease).toHaveBeenCalledExactlyOnceWith(
      "thread-reused",
      undefined,
      undefined,
    );
    expect(hasCodexAppServerLiveThread(client, "thread-reused")).toBe(false);
    client.close();
    expect(invalidated).toHaveBeenCalledOnce();
  });

  it.each([
    { claimed: true, retainedHandle: false, unpinDuringRelease: false },
    { claimed: false, retainedHandle: true, unpinDuringRelease: false },
    { claimed: false, retainedHandle: false, unpinDuringRelease: true },
  ])(
    "blocks same-thread replacement until unsubscribe is acknowledged (claimed: $claimed, retained handle: $retainedHandle, unpin: $unpinDuringRelease)",
    async ({ claimed, retainedHandle, unpinDuringRelease }) => {
      const unsubscribeAcknowledged = createDeferred<void>();
      const request = vi.fn(async (method: string) => {
        if (method === "thread/unsubscribe") {
          await unsubscribeAcknowledged.promise;
        }
        return {};
      });
      const client = {
        request,
        addCloseHandler: vi.fn(),
        addNotificationHandler: vi.fn(),
        addRequestHandler: vi.fn(),
      } as unknown as CodexAppServerClient;
      ensureCodexAppServerClientRuntime(client, { agentDir: "/tmp/agent" });
      const unprotect = unpinDuringRelease
        ? protectCodexAppServerLiveThread(client, "thread-transition")
        : undefined;
      await retainCodexAppServerLiveThread(client, "thread-transition");
      const previous =
        claimed || retainedHandle
          ? await consumeCodexAppServerLiveThread(client, "thread-transition")
          : undefined;
      if (retainedHandle) {
        expect(previous).toBeDefined();
        await expect(
          retainCodexAppServerLiveThread(client, "thread-transition", previous?.release),
        ).resolves.toBe(true);
      }
      const release = () =>
        previous
          ? previous.release("thread-transition")
          : unsubscribeCodexAppServerLiveThread(client, "thread-transition", 5_000);
      const releasing = release();
      const duplicateRelease = release();
      let duplicateSettled = false;
      void duplicateRelease.then(() => {
        duplicateSettled = true;
      });
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      expect(duplicateSettled).toBe(false);
      unprotect?.();
      const overlappingPhysicalRelease = unsubscribeCodexAppServerLiveThread(
        client,
        "thread-transition",
        5_000,
      );
      await Promise.resolve();
      expect(request).toHaveBeenCalledOnce();
      const replacement = retainCodexAppServerLiveThread(
        client,
        "thread-transition",
        claimed ? previous?.release : undefined,
      );
      const blockedClaim = consumeCodexAppServerLiveThread(client, "thread-transition");
      let replacementPublished = false;
      void replacement.then(() => {
        replacementPublished = true;
      });
      await Promise.resolve();

      expect(replacementPublished).toBe(false);
      expect(isCodexAppServerLiveThreadClaimed(client, "thread-transition")).toBe(claimed);
      unsubscribeAcknowledged.resolve();

      await expect(releasing).resolves.toBeUndefined();
      await expect(duplicateRelease).resolves.toBeUndefined();
      await expect(overlappingPhysicalRelease).resolves.toBeUndefined();
      await expect(replacement).resolves.toBe(false);
      await expect(blockedClaim).resolves.toBeUndefined();
      await client.request(
        "thread/resume",
        { threadId: "thread-transition" },
        { timeoutMs: 5_000 },
      );
      const resumed = await claimCodexAppServerLiveThread(client, "thread-transition");
      expect(resumed).toBeDefined();
      await expect(
        retainCodexAppServerLiveThread(client, "thread-transition", resumed?.release),
      ).resolves.toBe(true);
      const successor = await consumeCodexAppServerLiveThread(client, "thread-transition");
      await successor?.release("thread-transition");
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "thread/unsubscribe",
        "thread/resume",
        "thread/unsubscribe",
      ]);
    },
  );

  it("blocks only the exact thread whose subscription is being released", async () => {
    const { client } = createRuntimeHarness();

    const releaseGate = createDeferred<void>();
    await retainCodexAppServerLiveThread(client, "thread-a", async () => releaseGate.promise);
    await retainCodexAppServerLiveThread(client, "thread-b");
    const release = releaseCodexAppServerLiveThread(client, "thread-a");
    const sameThreadAcquisition = consumeCodexAppServerLiveThread(client, "thread-a");

    await expect(consumeCodexAppServerLiveThread(client, "thread-b")).resolves.toEqual(
      expect.objectContaining({ release: expect.any(Function) }),
    );
    releaseGate.resolve();
    await expect(release).resolves.toBe(true);
    await expect(sameThreadAcquisition).resolves.toBeUndefined();
  });

  it("rechecks deletion authority before sending the physical unsubscribe", async () => {
    const { client } = createRuntimeHarness();
    await retainCodexAppServerLiveThread(client, "thread-deleted");
    const request = vi.spyOn(client, "request");
    let current = true;
    const release = releaseCodexAppServerLiveThread(client, "thread-deleted", () => {
      if (!current) {
        throw new Error("deletion owner closed");
      }
    });
    current = false;
    await expect(release).rejects.toThrow("deletion owner closed");
    expect(request).not.toHaveBeenCalled();
    await expect(consumeCodexAppServerLiveThread(client, "thread-deleted")).resolves.toEqual(
      expect.objectContaining({ release: expect.any(Function) }),
    );
  });

  it("transfers ownership only for the exact immutable thread fingerprint", async () => {
    const { client } = createRuntimeHarness();

    await expect(
      retainCodexAppServerLiveThread(client, "thread-1", undefined, "config-before"),
    ).resolves.toBe(true);
    await expect(
      consumeCodexAppServerLiveThread(client, "thread-1", "config-after"),
    ).resolves.toBeUndefined();
    await expect(
      consumeCodexAppServerLiveThread(client, "thread-1", "config-before"),
    ).resolves.toEqual(
      expect.objectContaining({
        configFingerprint: "config-before",
        release: expect.any(Function),
      }),
    );
  });

  it("rolls back the new owner when capacity eviction cannot release its oldest thread", async () => {
    const { client } = createRuntimeHarness();
    const failingRelease = vi
      .fn<(threadId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("oldest unsubscribe failed"))
      .mockResolvedValueOnce(undefined);
    const overflowRelease = vi.fn(async (_threadId: string) => undefined);
    const invalidated = vi.fn();
    await retainCodexAppServerLiveThread(client, "thread-overflow", overflowRelease);
    const overflow = await claimCodexAppServerLiveThread(client, "thread-overflow", invalidated);
    expect(overflow).toBeDefined();
    await retainCodexAppServerLiveThread(client, "thread-oldest", failingRelease);
    for (let index = 1; index < EXPECTED_MAX_IDLE_LIVE_THREADS; index += 1) {
      await retainCodexAppServerLiveThread(client, `thread-${index}`);
    }

    await expect(
      retainCodexAppServerLiveThread(client, "thread-overflow", overflow?.release),
    ).resolves.toBe(false);
    expect(failingRelease).toHaveBeenCalledOnce();
    expect(invalidated).not.toHaveBeenCalled();
    expect(isCodexAppServerLiveThreadClaimed(client, "thread-overflow")).toBe(true);
    overflow?.assertCurrent();
    await expect(
      consumeCodexAppServerLiveThread(client, "thread-overflow"),
    ).resolves.toBeUndefined();
    await overflow?.release("thread-overflow");
    expect(overflowRelease).toHaveBeenCalledExactlyOnceWith(
      "thread-overflow",
      undefined,
      undefined,
    );
    expect(invalidated).toHaveBeenCalledOnce();
    await expect(consumeCodexAppServerLiveThread(client, "thread-1")).resolves.toEqual(
      expect.objectContaining({ release: expect.any(Function) }),
    );
    await expect(releaseCodexAppServerLiveThread(client, "thread-oldest")).resolves.toBe(true);
    expect(failingRelease).toHaveBeenCalledTimes(2);
    expect(invalidated).toHaveBeenCalledOnce();
  });

  it("cannot resurrect an overflow owner after the physical client closes during eviction", async () => {
    const { client } = createRuntimeHarness();
    const pendingRelease = createDeferred<void>();
    await retainCodexAppServerLiveThread(
      client,
      "thread-oldest",
      async () => pendingRelease.promise,
    );
    for (let index = 1; index < EXPECTED_MAX_IDLE_LIVE_THREADS; index += 1) {
      await retainCodexAppServerLiveThread(client, `thread-${index}`);
    }
    const retain = retainCodexAppServerLiveThread(client, "thread-overflow");

    client.close();
    pendingRelease.resolve();

    await expect(retain).resolves.toBe(false);
    await expect(
      consumeCodexAppServerLiveThread(client, "thread-overflow"),
    ).resolves.toBeUndefined();
  });

  it("renews a failed expiry instead of spinning and retries the same native owner", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const { client } = createRuntimeHarness();
    const release = vi
      .fn<(threadId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary unsubscribe failure"))
      .mockResolvedValueOnce(undefined);
    await retainCodexAppServerLiveThread(client, "thread-expiry-retry", release);
    const invalidated = vi.fn();
    const ownership = await claimCodexAppServerLiveThread(
      client,
      "thread-expiry-retry",
      invalidated,
    );
    expect(ownership).toBeDefined();
    await retainCodexAppServerLiveThread(client, "thread-expiry-retry", ownership?.release);

    await vi.advanceTimersByTimeAsync(EXPECTED_LIVE_THREAD_IDLE_TIMEOUT_MS - 1);
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(release).toHaveBeenCalledExactlyOnceWith("thread-expiry-retry", undefined, undefined);
    expect(invalidated).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(EXPECTED_LIVE_THREAD_IDLE_TIMEOUT_MS - 1);
    expect(release).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);

    expect(release).toHaveBeenCalledTimes(2);
    expect(invalidated).toHaveBeenCalledOnce();
    await expect(
      consumeCodexAppServerLiveThread(client, "thread-expiry-retry"),
    ).resolves.toBeUndefined();
  });

  it.each(["thread/closed", "client-close", "forget"] as const)(
    "invalidates a pending retained release once on %s without restoring failed work",
    async (terminal) => {
      const { client, send, writes } = createRuntimeHarness();
      const failedUnsubscribe = createDeferred<void>();
      const release = vi.fn(async () => await failedUnsubscribe.promise);
      await retainCodexAppServerLiveThread(client, "thread-terminal", release);
      const invalidated = vi.fn();
      const ownership = await claimCodexAppServerLiveThread(client, "thread-terminal", invalidated);
      expect(ownership).toBeDefined();
      await retainCodexAppServerLiveThread(client, "thread-terminal", ownership?.release);
      const releasing = releaseCodexAppServerLiveThread(client, "thread-terminal");
      try {
        await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
        expect(invalidated).not.toHaveBeenCalled();
        for (let attempt = 0; attempt < 2; attempt++) {
          if (terminal === "client-close") {
            client.close();
          } else if (terminal === "forget") {
            ownership?.forget();
          } else {
            const observed = createDeferred<void>();
            const removeObserver = client.addNotificationHandler((notification) => {
              if (notification.method === terminal) {
                observed.resolve();
              }
            });
            send({ method: terminal, params: { threadId: "thread-terminal" } });
            await observed.promise;
            removeObserver();
          }
          expect(invalidated).toHaveBeenCalledOnce();
        }
        expect(release).toHaveBeenCalledOnce();
        expect(writes).toEqual([]);
      } finally {
        failedUnsubscribe.reject(new Error("unsubscribe failed after ownership ended"));
        await expect(releasing).rejects.toThrow("unsubscribe failed after ownership ended");
      }
      await expect(
        consumeCodexAppServerLiveThread(client, "thread-terminal"),
      ).resolves.toBeUndefined();
      expect(invalidated).toHaveBeenCalledOnce();
    },
  );

  it("protects native-child parents and renews their idle clock after the final child", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    const { client } = createRuntimeHarness();
    const release = vi.fn(async (_threadId: string) => undefined);
    const unprotect = protectCodexAppServerLiveThread(client, "thread-parent");
    await retainCodexAppServerLiveThread(client, "thread-parent", release);

    await vi.advanceTimersByTimeAsync(EXPECTED_LIVE_THREAD_IDLE_TIMEOUT_MS * 2);
    expect(release).not.toHaveBeenCalled();
    unprotect();
    await vi.advanceTimersByTimeAsync(EXPECTED_LIVE_THREAD_IDLE_TIMEOUT_MS - 1);
    expect(release).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(release).toHaveBeenCalledExactlyOnceWith("thread-parent", undefined, undefined);
  });

  it("keeps a failed unpin eviction owned until its original subscription can be retried", async () => {
    const { client } = createRuntimeHarness();
    const release = vi
      .fn<(threadId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("temporary unpin unsubscribe failure"))
      .mockResolvedValueOnce(undefined);
    await retainCodexAppServerLiveThread(client, "thread-oldest", release);
    for (let index = 1; index < EXPECTED_MAX_IDLE_LIVE_THREADS; index += 1) {
      await retainCodexAppServerLiveThread(client, `thread-sibling-${index}`);
    }
    const unprotect = protectCodexAppServerLiveThread(client, "thread-parent");
    await retainCodexAppServerLiveThread(client, "thread-parent");

    unprotect();

    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    await vi.waitFor(async () => {
      await expect(releaseCodexAppServerLiveThread(client, "thread-oldest")).resolves.toBe(true);
    });
    expect(release).toHaveBeenCalledTimes(2);
    await expect(consumeCodexAppServerLiveThread(client, "thread-parent")).resolves.toEqual(
      expect.objectContaining({ release: expect.any(Function) }),
    );
    await expect(consumeCodexAppServerLiveThread(client, "thread-sibling-1")).resolves.toEqual(
      expect.objectContaining({ release: expect.any(Function) }),
    );
  });

  it("discards only the exact thread after thread/closed", async () => {
    const method = "thread/closed";
    const { client, send } = createRuntimeHarness();
    await retainCodexAppServerLiveThread(client, "thread-a");
    await retainCodexAppServerLiveThread(client, "thread-b");
    const invalidated = vi.fn();
    const ownership = await claimCodexAppServerLiveThread(client, "thread-a", invalidated);
    expect(ownership).toBeDefined();
    await retainCodexAppServerLiveThread(client, "thread-a", ownership?.release);
    let notifications = 0;
    const notificationObserved = new Promise<void>((resolve) => {
      client.addNotificationHandler((notification) => {
        if (notification.method === method && ++notifications === 2) {
          resolve();
        }
      });
    });

    send({ method, params: { threadId: "thread-a" } });
    send({ method, params: { threadId: "thread-a" } });
    await notificationObserved;
    expect(invalidated).toHaveBeenCalledOnce();
    await expect(consumeCodexAppServerLiveThread(client, "thread-a")).resolves.toBeUndefined();
    await expect(consumeCodexAppServerLiveThread(client, "thread-b")).resolves.toEqual(
      expect.objectContaining({ release: expect.any(Function) }),
    );
  });

  it("cannot resurrect thread ownership when its client closes during release", async () => {
    const { client } = createRuntimeHarness();
    const pendingRelease = createDeferred<void>();
    await retainCodexAppServerLiveThread(
      client,
      "thread-stale",
      async () => pendingRelease.promise,
    );
    const release = releaseCodexAppServerLiveThread(client, "thread-stale");
    const retain = retainCodexAppServerLiveThread(client, "thread-stale");

    client.close();
    pendingRelease.resolve();

    await expect(release).resolves.toBe(true);
    await expect(retain).resolves.toBe(false);
    await expect(consumeCodexAppServerLiveThread(client, "thread-stale")).resolves.toBeUndefined();
  });

  it("keeps the exact retained owner when a same-build plugin module copy resumes the client", async () => {
    const { client } = createClientHarness();
    clients.push(client);
    const addCloseHandler = vi.spyOn(client, "addCloseHandler");
    ensureCodexAppServerClientRuntime(client, { agentDir: "/tmp/agent" });
    const release = vi.fn(async () => undefined);
    await retainCodexAppServerLiveThread(client, "copy-retained", release);
    expect(hasCodexAppServerLiveThread(client, "copy-retained")).toBe(true);

    vi.resetModules();
    const nextCopy = await import("./client-runtime.js");
    nextCopy.ensureCodexAppServerClientRuntime(client, { agentDir: "/tmp/agent" });
    expect(addCloseHandler).toHaveBeenCalledTimes(1);
    expect(nextCopy.isCodexAppServerClientRuntimeLive(client)).toBe(true);
    expect(nextCopy.hasCodexAppServerLiveThread(client, "copy-retained")).toBe(true);
    const claimed = await nextCopy.claimCodexAppServerLiveThread(client, "copy-retained");
    expect(claimed).toBeDefined();
    await expect(
      retainCodexAppServerLiveThread(client, "copy-retained", claimed?.release),
    ).resolves.toBe(true);
    await expect(nextCopy.releaseCodexAppServerLiveThread(client, "copy-retained")).resolves.toBe(
      true,
    );
    expect(release).toHaveBeenCalledExactlyOnceWith("copy-retained", undefined, undefined);
  });
});
