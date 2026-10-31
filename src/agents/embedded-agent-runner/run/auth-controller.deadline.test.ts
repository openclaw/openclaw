import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Model } from "../../../llm/types.js";
import type { CommandQueueTaskDeadline } from "../../../process/command-queue.types.js";
import { resolveSecretSentinel } from "../../../secrets/sentinel.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createEmbeddedRunAuthController, type EmbeddedRunAuthState } from "./auth-controller.js";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), exchange: vi.fn() }));
vi.mock("../../model-auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../model-auth.js")>()),
  getApiKeyForModelCore: mocks.lookup,
}));
vi.mock("../../../plugins/provider-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/provider-runtime.js")>()),
  prepareProviderRuntimeAuth: mocks.exchange,
}));

function fixture(
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    getDeadline?: () => CommandQueueTaskDeadline | undefined;
    assertCurrent?: () => void;
    prepareModelForAuthProfile?: Parameters<
      typeof createEmbeddedRunAuthController
    >[0]["prepareModelForAuthProfile"];
    authProfileBinding?: Parameters<
      typeof createEmbeddedRunAuthController
    >[0]["authProfileBinding"];
  } = {},
) {
  const model: Model = {
    id: "synthetic-model",
    name: "Synthetic",
    provider: "synthetic-provider",
    api: "openai-responses",
    baseUrl: "https://provider.example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8000,
    maxTokens: 1024,
  };
  const state: EmbeddedRunAuthState = {
    models: { runtime: model, effective: model },
    apiKeyInfo: null,
    lastProfileId: undefined,
    runtimeAuthState: null,
    runtimeAuthRefreshCancelled: false,
    profileIndex: 0,
    thinkLevel: "off",
  };
  const install = vi.fn();
  const controller = createEmbeddedRunAuthController({
    config: undefined,
    agentDir: "/synthetic/agent",
    workspaceDir: "/synthetic/workspace",
    authStore: { version: 1, profiles: {} },
    authStorage: { setRuntimeApiKey: install },
    profileCandidates: ["first", "second"],
    initialThinkLevel: "off",
    attemptedThinking: new Set(),
    fallbackConfigured: false,
    allowTransientCooldownProbe: false,
    provider: model.provider,
    modelId: model.id,
    state,
    log: { debug() {}, info() {}, warn() {} },
    ...options,
  });
  return { controller, state, install };
}
const credential = {
  apiKey: "synthetic-source",
  mode: "api-key",
  source: "fixture",
  profileId: "first",
};

beforeEach(() => {
  vi.useFakeTimers();
  mocks.lookup.mockReset().mockResolvedValue(credential);
  mocks.exchange.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

it.each(["credential resolution", "runtime auth exchange", "AWS runtime auth exchange"])(
  "bounds hanging %s and refuses late installation",
  async (step) => {
    const late = createDeferredCore<{ apiKey: string; baseUrl?: string }>();
    let signal: AbortSignal | undefined;
    if (step === "credential resolution") {
      mocks.lookup.mockImplementation((input) => {
        signal = input.signal;
        return late.promise;
      });
    } else {
      if (step.startsWith("AWS")) {
        mocks.lookup.mockResolvedValue({ mode: "aws-sdk", source: "fixture" });
      }
      mocks.exchange.mockImplementation(({ context }) => {
        signal = context.signal;
        return late.promise;
      });
    }
    const { controller, install, state } = fixture({ timeoutMs: 100 });
    const result = controller.initializeAuthProfile().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await Promise.race([result, Promise.resolve("pending")])).toMatchObject({
      name: "AbortError",
      message: expect.stringContaining("timed out"),
    });
    expect(signal?.aborted).toBe(true);
    expect(mocks.lookup).toHaveBeenCalledOnce();
    late.resolve({ apiKey: "synthetic-late", baseUrl: "https://late.example.test/v1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(install).not.toHaveBeenCalled();
    expect(state.runtimeAuthState).toBeNull();
    expect(state.models.runtime.baseUrl).toBe("https://provider.example.test/v1");
    expect(state.models.effective.baseUrl).toBe("https://provider.example.test/v1");
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([false, true])(
  "finishes within budget or cancels without installation (cancel=%s)",
  async (cancel) => {
    const abort = new AbortController();
    let signal: AbortSignal | undefined;
    mocks.exchange.mockImplementation(({ context }) => {
      signal = context.signal;
      return new Promise((resolve) => {
        setTimeout(() => resolve({ apiKey: "synthetic-runtime" }), 50);
      });
    });
    const { controller, install } = fixture({ timeoutMs: 100, signal: abort.signal });
    const result = controller.initializeAuthProfile().then(
      () => "ok",
      () => "aborted",
    );
    await vi.advanceTimersByTimeAsync(25);
    if (cancel) {
      abort.abort();
    }
    await vi.advanceTimersByTimeAsync(25);
    expect(await result).toBe(cancel ? "aborted" : "ok");
    if (cancel) {
      expect(signal?.aborted).toBe(true);
      expect(install).not.toHaveBeenCalled();
    } else {
      expect(resolveSecretSentinel(install.mock.calls[0]?.[1])).toBe("synthetic-runtime");
    }
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("uses one startup budget across lookup and exchange", async () => {
  mocks.lookup.mockImplementation(
    () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(credential), 60);
      }),
  );
  mocks.exchange.mockImplementation(
    () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ apiKey: "late" }), 60);
      }),
  );
  const { controller, install } = fixture({ timeoutMs: 100 });
  const result = controller.initializeAuthProfile().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(100);
  expect(await Promise.race([result, Promise.resolve("pending")])).toMatchObject({
    name: "AbortError",
  });
  await vi.advanceTimersByTimeAsync(20);
  expect(install).not.toHaveBeenCalled();
});

it.each(["aws", "profile"])(
  "preserves independent provider AbortError recovery for %s",
  async (mode) => {
    const error = new Error("provider aborted independently");
    error.name = "AbortError";
    mocks.exchange.mockRejectedValueOnce(error).mockResolvedValue(undefined);
    if (mode === "aws") {
      mocks.lookup.mockResolvedValue({ mode: "aws-sdk", source: "fixture" });
    }
    const { controller, install, state } = fixture({ timeoutMs: 100 });
    await controller.initializeAuthProfile();
    expect(install).toHaveBeenLastCalledWith(
      "synthetic-provider",
      mode === "aws" ? "__aws_sdk_auth__" : "synthetic-source",
    );
    expect(state.profileIndex).toBe(mode === "aws" ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("uses the active execution deadline for refresh rather than restarting startup budget", async () => {
  const active: { deadline?: CommandQueueTaskDeadline } = {};
  mocks.exchange.mockResolvedValueOnce({ apiKey: "initial", expiresAt: Date.now() + 60000 });
  const { controller, install } = fixture({ timeoutMs: 100, getDeadline: () => active.deadline });
  await controller.initializeAuthProfile();
  await vi.advanceTimersByTimeAsync(200);
  active.deadline = { kind: "bounded", deadlineAtMs: Date.now() + 30 };
  const late = createDeferredCore<{ apiKey: string }>();
  mocks.exchange.mockReturnValue(late.promise);
  const result = controller
    .maybeRefreshRuntimeAuthForAuthError("401 unauthorized", false)
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(30);
  expect(await Promise.race([result, Promise.resolve("pending")])).toMatchObject({
    name: "AbortError",
  });
  late.resolve({ apiKey: "late" });
  await vi.advanceTimersByTimeAsync(0);
  expect(install).toHaveBeenCalledOnce();
  controller.stopRuntimeAuthRefreshTimer();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not invoke exchange or install after binding revocation during awaited revalidation", async () => {
  let current = true;
  const { controller, install } = fixture({
    timeoutMs: 100,
    assertCurrent: () => {
      if (!current) {
        throw new Error("run revoked");
      }
    },
    authProfileBinding: {
      profileId: "first",
      authRequirement: "api-key",
      assertCurrent() {},
      revalidate: async () => {
        current = false;
      },
    },
  });
  await expect(controller.initializeAuthProfile()).rejects.toThrow("run revoked");
  expect(mocks.exchange).not.toHaveBeenCalled();
  expect(install).not.toHaveBeenCalled();
});

it.each(["startup", "refresh"])(
  "closing the controller cancels pending %s auth and cleans timers",
  async (phase) => {
    const { controller, install, state } = fixture({ timeoutMs: 100 });
    if (phase === "refresh") {
      mocks.exchange.mockResolvedValueOnce({ apiKey: "initial", expiresAt: Date.now() + 60000 });
      await controller.initializeAuthProfile();
    }
    const before = install.mock.calls.length;
    const late = createDeferredCore<{ apiKey: string }>();
    let signal: AbortSignal | undefined;
    mocks.exchange.mockImplementation(({ context }) => {
      signal = context.signal;
      return late.promise;
    });
    const result = (
      phase === "startup"
        ? controller.initializeAuthProfile()
        : controller.maybeRefreshRuntimeAuthForAuthError("401 unauthorized", false)
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.close();
    expect(await result).toMatchObject({ name: "AbortError" });
    expect(signal?.aborted).toBe(true);
    late.resolve({ apiKey: "late" });
    await vi.advanceTimersByTimeAsync(0);
    expect(install).toHaveBeenCalledTimes(before);
    expect(state.runtimeAuthState?.refreshInFlight).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("timer stop permits profile rotation while terminal close prevents new work", async () => {
  mocks.exchange.mockResolvedValue({ apiKey: "runtime", expiresAt: Date.now() + 60000 });
  const { controller, install } = fixture({ timeoutMs: 100 });
  await controller.initializeAuthProfile();
  controller.stopRuntimeAuthRefreshTimer();
  expect(vi.getTimerCount()).toBe(0);
  await controller.applyAuthProfileCandidate("second");
  expect(install).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(1);
  controller.close();
  await expect(controller.applyAuthProfileCandidate("first")).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(mocks.lookup).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not schedule retries after a background refresh exhausts the shared deadline", async () => {
  mocks.exchange.mockResolvedValue({ apiKey: "runtime", expiresAt: Date.now() + 1 });
  const { controller, install } = fixture({ timeoutMs: 100 });
  await controller.initializeAuthProfile();
  await vi.advanceTimersByTimeAsync(5000);
  expect(mocks.exchange).toHaveBeenCalledOnce();
  expect(install).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  controller.close();
});

it("rechecks live run authority after awaited model preparation before credential lookup", async () => {
  let current = true;
  const prepared = createDeferredCore();
  const { controller, install, state } = fixture({
    assertCurrent: () => {
      if (!current) {
        throw new Error("run revoked");
      }
    },
    prepareModelForAuthProfile: async () => {
      await prepared.promise;
      return { runtimeModel: state.models.runtime, commit() {} };
    },
  });
  const result = controller.applyAuthProfileCandidate("first").catch((error: unknown) => error);
  current = false;
  prepared.resolve();
  expect(await result).toMatchObject({ message: "run revoked" });
  expect(mocks.lookup).not.toHaveBeenCalled();
  expect(install).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
