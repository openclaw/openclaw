import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as manifestRegistry from "../plugins/manifest-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { runIsolatedAgentRuntimeCompletion } from "../plugins/runtime/runtime-llm-isolated.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  isolatedAssistant,
  isolatedCompletionMocks as mocks,
  isolatedRequest,
  nativeAuthPlan,
  preparedModelRuntime,
  registerIsolatedHarness,
  releaseRuntimeLease,
  resetIsolatedCompletionTestState,
  runIsolatedCompletion,
} from "./isolated-completion.test-support.js";

const timedOut = {
  name: "IsolatedCompletionError",
  code: "runtime-unavailable",
  message: "Isolated completion timed out.",
};
let clock: number;
let work: AsyncWorkScope;

beforeEach(() => {
  resetIsolatedCompletionTestState();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  clock = 0;
  work = new AsyncWorkScope();
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});

afterEach(async () => {
  await work.drain();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function assistantResult() {
  return { assistant: isolatedAssistant([{ type: "text", text: "done" }]) };
}

function runCompletion(entry: "core" | "plugin", abortSignal?: AbortSignal) {
  const request = isolatedRequest();
  return entry === "core"
    ? runIsolatedCompletion({ ...request, abortSignal })
    : runIsolatedAgentRuntimeCompletion({
        request: {
          messages: [{ role: "user", content: request.prompt }],
          systemPrompt: request.systemPrompt,
          execution: { mode: "isolated-agent-runtime", timeoutMs: request.timeoutMs },
          signal: abortSignal,
        },
        cfg: request.config,
        agentId: "main",
        provider: request.provider,
        model: request.model,
      });
}

it.each(["cli", "v1", "v2"] as const)(
  "deducts acquisition and auth preparation from the %s dispatch budget",
  async (runtime) => {
    const acquire = mocks.acquireAgentRunPreparedModelRuntime.getMockImplementation()!;
    mocks.acquireAgentRunPreparedModelRuntime.mockImplementation(async () => {
      clock += 200;
      return await acquire();
    });
    const dispatch = vi.fn(async () => assistantResult());
    if (runtime === "cli") {
      mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
      mocks.cliBackendAcceptsAuthProfileForwarding.mockReturnValue(true);
      mocks.resolveCliExecutionAuthProfileId.mockImplementation(async () => {
        clock += 300;
        return undefined;
      });
      mocks.runCliAgent.mockResolvedValue({ payloads: [{ text: "done" }] });
    } else {
      const prepare = mocks.prepareSimpleCompletionModel.getMockImplementation()!;
      mocks.prepareSimpleCompletionModel.mockImplementation(async () => {
        clock += 300;
        return await prepare();
      });
      registerIsolatedHarness(
        runtime === "v1"
          ? { runIsolatedCompletion: dispatch }
          : { runIsolatedCompletionV2: dispatch },
      );
    }
    await expect(work.run(() => runIsolatedCompletion(isolatedRequest()))).resolves.toMatchObject({
      text: "done",
    });
    expect(runtime === "cli" ? mocks.runCliAgent : dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 500 }),
    );
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([
  { entry: "core", settlement: "lease" },
  { entry: "core", settlement: "error" },
  { entry: "plugin", settlement: "lease" },
] as const)(
  "retains blocked $entry acquisition until its late $settlement settles after timeout",
  async ({ entry, settlement }) => {
    const started = createDeferredCore<AbortSignal>();
    const finish = createDeferredCore();
    let finished = false;
    mocks.acquireAgentRunPreparedModelRuntime.mockImplementation(async (_input, options) => {
      started.resolve(options.abortSignal);
      await finish.promise;
      finished = true;
      if (settlement === "error") {
        throw new Error("late acquisition failed");
      }
      return { snapshot: preparedModelRuntime, [Symbol.asyncDispose]: releaseRuntimeLease };
    });
    const reason =
      entry === "core"
        ? timedOut
        : { name: "Error", message: "Isolated completion timed out after 1000ms." };
    const pending = work.run(() => runCompletion(entry));
    const outcome = expect(pending).rejects.toMatchObject(
      entry === "core"
        ? timedOut
        : {
            name: "LlmCompleteError",
            code: "LLM_COMPLETION_TIMEOUT",
            message: "Plugin LLM completion timed out after 1000ms.",
            cause: reason,
          },
    );
    try {
      const signal = await started.promise;
      clock = 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      await outcome;
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toMatchObject(reason);
      expect(finished).toBe(false);
      expect(work.hasPendingWork).toBe(true);
      expect(releaseRuntimeLease).not.toHaveBeenCalled();
      expect(mocks.ensureSelectedAgentHarnessPlugin).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finish.resolve();
      await work.drain();
    }
    expect(finished).toBe(true);
    expect(mocks.ensureSelectedAgentHarnessPlugin).not.toHaveBeenCalled();
    expect(releaseRuntimeLease).toHaveBeenCalledTimes(settlement === "lease" ? 1 : 0);
  },
);

it.each(["cli", "v1", "v2", "v2-native"] as const)(
  "bounds stalled %s auth without releasing its runtime or dispatching late",
  async (runtime) => {
    const started = createDeferredCore();
    const finish = createDeferredCore();
    const dispatch = vi.fn(async () => assistantResult());
    const block = async () => {
      started.resolve();
      await finish.promise;
    };
    if (runtime === "cli") {
      mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
      mocks.cliBackendAcceptsAuthProfileForwarding.mockReturnValue(true);
      mocks.resolveCliExecutionAuthProfileId.mockImplementation(async () => {
        await block();
        return undefined;
      });
    } else {
      const prepare =
        runtime === "v2-native" ? mocks.resolveModelAsync : mocks.prepareSimpleCompletionModel;
      const original = prepare.getMockImplementation()!;
      prepare.mockImplementation(async () => {
        await block();
        return await original();
      });
      registerIsolatedHarness(
        runtime === "v1"
          ? { runIsolatedCompletion: dispatch }
          : {
              runIsolatedCompletionV2: dispatch,
              ...(runtime === "v2-native" ? { authBootstrap: "harness" as const } : {}),
            },
      );
    }
    const pending = work.run(() => runIsolatedCompletion(isolatedRequest()));
    const outcome = expect(pending).rejects.toMatchObject(timedOut);
    try {
      await started.promise;
      clock = 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      await outcome;
      expect(work.hasPendingWork).toBe(true);
      expect(releaseRuntimeLease).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(mocks.runCliAgent).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await work.drain();
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(mocks.runCliAgent).not.toHaveBeenCalled();
    expect(releaseRuntimeLease).toHaveBeenCalledOnce();
  },
);

it.each(["cli", "v1", "v2"] as const)(
  "ends the %s wait at the deadline while retaining its unfinished dispatch",
  async (runtime) => {
    const started = createDeferredCore<AbortSignal | undefined>();
    const finish = createDeferredCore();
    const dispatch = async ({ abortSignal }: { abortSignal?: AbortSignal }) => {
      started.resolve(abortSignal);
      await finish.promise;
      return assistantResult();
    };
    if (runtime === "cli") {
      mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
      mocks.runCliAgent.mockImplementation(async (params) => {
        await dispatch(params);
        return { payloads: [{ text: "late" }] };
      });
    } else {
      registerIsolatedHarness(
        runtime === "v1"
          ? { runIsolatedCompletion: dispatch }
          : { runIsolatedCompletionV2: dispatch },
      );
    }
    const pending = work.run(() => runIsolatedCompletion(isolatedRequest()));
    const outcome = expect(pending).rejects.toMatchObject(timedOut);
    try {
      const signal = await started.promise;
      clock = 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
      await outcome;
      expect(signal?.aborted).toBe(true);
      expect(signal?.reason).toMatchObject(timedOut);
      expect(work.hasPendingWork).toBe(true);
      expect(releaseRuntimeLease).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      finish.resolve();
      await work.drain();
    }
    expect(releaseRuntimeLease).toHaveBeenCalledOnce();
  },
);

it.each(["preparation", "dispatch"] as const)(
  "rejects expired %s before a delayed timer can fire",
  async (phase) => {
    const prepare = mocks.prepareSimpleCompletionModel.getMockImplementation()!;
    mocks.prepareSimpleCompletionModel.mockImplementation(async () => {
      if (phase === "preparation") {
        clock = 1_000;
      }
      return await prepare();
    });
    const dispatch = vi.fn(async () => {
      clock = 1_000;
      return assistantResult();
    });
    registerIsolatedHarness({ runIsolatedCompletionV2: dispatch });
    await expect(work.run(() => runIsolatedCompletion(isolatedRequest()))).rejects.toMatchObject(
      timedOut,
    );
    await work.drain();
    expect(dispatch).toHaveBeenCalledTimes(phase === "dispatch" ? 1 : 0);
    expect(releaseRuntimeLease).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each([-60_000, 60_000])("ignores a wall-clock step of %s ms", async (wallClock) => {
  const prepare = mocks.prepareSimpleCompletionModel.getMockImplementation()!;
  mocks.prepareSimpleCompletionModel.mockImplementation(async () => {
    vi.spyOn(Date, "now").mockReturnValue(wallClock);
    clock = 250;
    return await prepare();
  });
  const dispatch = vi.fn(async () => assistantResult());
  registerIsolatedHarness({ runIsolatedCompletionV2: dispatch });
  await work.run(() => runIsolatedCompletion(isolatedRequest()));
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 750 }));
});

it.each([0.25, 999.75])(
  "supplies an integer runtime timeout after %s ms of preparation",
  async (elapsed) => {
    const prepare = mocks.prepareSimpleCompletionModel.getMockImplementation()!;
    mocks.prepareSimpleCompletionModel.mockImplementation(async () => {
      clock = elapsed;
      return await prepare();
    });
    const dispatch = vi.fn(async () => assistantResult());
    registerIsolatedHarness({ runIsolatedCompletionV2: dispatch });
    await work.run(() => runIsolatedCompletion(isolatedRequest()));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: Math.ceil(1_000 - elapsed) }),
    );
  },
);

it("charges native auth preparation before rotating profiles within the remaining budget", async () => {
  const profileIds = ["openai:first", "openai:backup"];
  mocks.ensureAuthProfileStore.mockImplementation(() => {
    clock += 200;
    return {
      version: 1,
      profiles: Object.fromEntries(
        profileIds.map((id) => [id, { type: "token", provider: "openai", token: id }]),
      ),
    };
  });
  mocks.prepareAgentRuntimeAuth.mockReturnValue({
    plan: nativeAuthPlan,
    attempts: profileIds.map((profileId) => ({
      kind: "profile",
      profileId,
      plan: { ...nativeAuthPlan, forwardedAuthProfileId: profileId },
    })),
  });
  const dispatch = vi
    .fn()
    .mockImplementationOnce(async () => {
      clock += 400;
      return {
        assistant: { ...isolatedAssistant([], "error"), errorMessage: "429 Too many requests" },
      };
    })
    .mockResolvedValueOnce(assistantResult());
  registerIsolatedHarness({ authBootstrap: "harness", runIsolatedCompletionV2: dispatch });
  await work.run(() => runIsolatedCompletion(isolatedRequest()));
  expect(dispatch.mock.calls.map(([params]) => params.timeoutMs)).toEqual([800, 400]);
});

it.each(["core", "plugin"] as const)(
  "preserves %s caller cancellation while blocked preparation drains",
  async (entry) => {
    const started = createDeferredCore();
    const finish = createDeferredCore();
    const controller = new AbortController();
    const reason = new Error("caller canceled");
    const prepare = mocks.prepareSimpleCompletionModel.getMockImplementation()!;
    mocks.prepareSimpleCompletionModel.mockImplementation(async () => {
      started.resolve();
      await finish.promise;
      return await prepare();
    });
    const dispatch = vi.fn(async () => assistantResult());
    registerIsolatedHarness({ runIsolatedCompletionV2: dispatch });
    const pending = work.run(() => runCompletion(entry, controller.signal));
    const rejection = expect(pending).rejects;
    const outcome =
      entry === "core"
        ? rejection.toBe(reason)
        : rejection.toMatchObject({
            name: "LlmCompleteError",
            code: "LLM_COMPLETION_ABORTED",
            message: "Plugin LLM completion was aborted.",
            cause: reason,
          });
    try {
      await started.promise;
      controller.abort(reason);
      await outcome;
      expect(vi.getTimerCount()).toBe(0);
      expect(releaseRuntimeLease).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await work.drain();
    }
    expect(dispatch).not.toHaveBeenCalled();
    expect(releaseRuntimeLease).toHaveBeenCalledOnce();
  },
);

it("does not acquire a runtime after an already-expired deadline", async () => {
  await expect(
    work.run(() => runIsolatedCompletion({ ...isolatedRequest(), timeoutMs: 0 })),
  ).rejects.toMatchObject(timedOut);
  expect(mocks.acquireAgentRunPreparedModelRuntime).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("clears the deadline after success without canceling retained cleanup", async () => {
  clearPluginMetadataLifecycleCaches();
  const loadRegistry = vi.spyOn(manifestRegistry, "loadPluginManifestRegistryCore");
  const finish = createDeferredCore();
  let signal: AbortSignal | undefined;
  registerIsolatedHarness({
    runIsolatedCompletionV2: async (params) => {
      signal = params.abortSignal;
      void trackAsyncWork(() => finish.promise);
      return assistantResult();
    },
  });
  try {
    await work.run(() => runIsolatedCompletion(isolatedRequest()));
    expect(loadRegistry).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    clock = 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(signal?.aborted).toBe(false);
    expect(releaseRuntimeLease).not.toHaveBeenCalled();
  } finally {
    finish.resolve();
    await work.drain();
  }
  expect(releaseRuntimeLease).toHaveBeenCalledOnce();
});
