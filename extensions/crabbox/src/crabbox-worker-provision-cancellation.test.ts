import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import { openWarmImageStore } from "./crabbox-state.test-support.js";
import { commandResult, nodeEnrollmentFixture } from "./crabbox-worker-provider.test-support.js";
import {
  captureWarmImage,
  createProjectOptions,
  createWarmProvider,
  jsonResult,
  provisionWarmProfile,
  LEASE_ID,
  OPERATION_ID,
  PROFILE,
} from "./crabbox-worker-warm-image.test-support.js";

afterEach(() => vi.useRealTimers());

it.each([
  "config",
  "warmup",
  "inspect",
  "profile setup",
  "desktop setup",
  "node enrollment setup",
  "enrollment diagnostics",
  "checkpoint inspect",
  "checkpoint fork",
])("cancels %s without releasing its command or launching later work", async (phase) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const controller = new AbortController();
  const reason = new Error("worker stop requested");
  const started = createDeferred<void>();
  const closed = createDeferred<void>();
  let armed = false;
  let commandSignal: AbortSignal | undefined;
  const warm = phase.startsWith("checkpoint");
  const profile = {
    ...PROFILE,
    warmImage: warm || phase === "desktop setup",
    setup: "profile-setup",
    desktop: true,
  };
  const { provider, calls, warn } = createWarmProvider(async ({ argv, options }) => {
    const command = argv[1] === "checkpoint" ? `checkpoint ${argv[2]}` : argv[1];
    const setup = options.input?.toString();
    const actual =
      command === "run"
        ? setup === "profile-setup"
          ? "profile setup"
          : setup?.includes("CRABBOX_NODE_ENROLLMENT_SCRIPT")
            ? "node enrollment setup"
            : setup?.includes("node.log tail:")
              ? "enrollment diagnostics"
              : "desktop setup"
        : command;
    if (!armed || actual !== phase) {
      return undefined;
    }
    commandSignal = options.signal;
    started.resolve();
    await closed.promise;
    return commandResult({ code: 2, stderr: "command interrupted" });
  });
  if (warm) {
    await captureWarmImage(provider, profile);
    if (phase === "checkpoint inspect") {
      // Completed captures skip inspection; exercise a persisted pending checkpoint.
      const store = openWarmImageStore();
      const image = store.entries()[0]!;
      store.register(image.key, {
        ...image.value,
        image: { ...image.value.image!, state: "pending" },
      });
    }
    calls.length = 0;
  }
  armed = true;
  const settled = vi.fn();
  const operation = provisionWarmProfile(provider, profile, OPERATION_ID, undefined, {
    ...(phase === "desktop setup" ? createProjectOptions([], controller).options : {}),
    signal: controller.signal,
    ...(phase === "enrollment diagnostics"
      ? {
          beginNodeEnrollment: async () =>
            nodeEnrollmentFixture("setup-code", "Cancelled worker", async () => {
              throw new Error("enrollment expired");
            }),
        }
      : {}),
  })
    .catch((error: unknown) => error)
    .finally(settled);
  await started.promise;
  const provisioningCalls = calls.filter(({ argv }) => argv[1] !== "heartbeat");
  try {
    controller.abort(reason);
    // Keepalive owns its timer until the held command settles; it is not later setup work.
    await vi.advanceTimersByTimeAsync(0);
    await setImmediate();
    expect(commandSignal?.aborted).toBe(true);
    expect(settled).not.toHaveBeenCalled();
    expect(calls.filter(({ argv }) => argv[1] !== "heartbeat")).toEqual(provisioningCalls);
  } finally {
    closed.resolve();
    await operation;
  }
  expect(await operation).toBe(reason);
  expect(calls.filter(({ argv }) => argv[1] !== "heartbeat")).toEqual(provisioningCalls);
  const heartbeats = calls.filter(({ argv }) => argv[1] === "heartbeat");
  await vi.advanceTimersByTimeAsync(60 * 60_000);
  expect(calls.filter(({ argv }) => argv[1] === "heartbeat")).toEqual(heartbeats);
  expect(warn).not.toHaveBeenCalled();
  await provider.destroy({ leaseId: LEASE_ID, profile: { ...profile, warmImage: false } });
  expect(calls.at(-1)?.argv[1]).toBe("stop");
  expect(calls.at(-1)?.options.signal).toBeUndefined();
});

it("interrupts the real readiness delay before another probe or enrollment", async () => {
  const inspected = createDeferred<void>();
  const controller = new AbortController();
  const profile = { ...PROFILE, warmImage: false };
  let ready = false;
  const { provider, calls } = createWarmProvider(
    ({ argv }) => {
      if (argv[1] === "inspect") {
        inspected.resolve();
        return jsonResult({
          id: LEASE_ID,
          state: "starting",
          ready,
          providerMetadata: { instanceProfileAttached: false },
        });
      }
      return undefined;
    },
    undefined,
    { sleep: undefined },
  );
  const settled = vi.fn();
  const operation = provisionWarmProfile(provider, profile, OPERATION_ID, undefined, {
    signal: controller.signal,
  })
    .catch((error: unknown) => error)
    .finally(settled);
  await inspected.promise;
  // Let the resolved inspection enter the production timer; no fake timer or injected delay.
  await setImmediate();
  // Let a broken non-canceling path finish at its next probe instead of leaking a poller.
  ready = true;
  controller.abort();
  try {
    await setImmediate();
    expect(settled).toHaveBeenCalledOnce();
  } finally {
    await operation;
  }
  expect(await operation).toMatchObject({ name: "AbortError" });
  expect(calls.filter(({ argv }) => argv[1] === "inspect")).toHaveLength(1);
  expect(calls.some(({ argv }) => argv[1] === "run")).toBe(false);
});

it("stops preparation keepalive without warm capture after a late enrollment result", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const waiting = createDeferred<void>();
  const enrolled = createDeferred<string>();
  const controller = new AbortController();
  const { provider, calls } = createWarmProvider();
  const operation = provisionWarmProfile(provider, PROFILE, OPERATION_ID, undefined, {
    signal: controller.signal,
    beginNodeEnrollment: async () =>
      nodeEnrollmentFixture("setup-code", "Cancelled worker", async () => {
        waiting.resolve();
        return await enrolled.promise;
      }),
  }).catch((error: unknown) => error);
  try {
    await waiting.promise;
    await vi.advanceTimersByTimeAsync(0);
    const heartbeatsBeforeCancellation = calls.filter(({ argv }) => argv[1] === "heartbeat");
    controller.abort();
    enrolled.resolve("late-device");
    expect(await operation).toMatchObject({ name: "AbortError" });
    expect(heartbeatsBeforeCancellation).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(calls.filter(({ argv }) => argv[1] === "heartbeat")).toHaveLength(1);
    calls.length = 0;
    await provider.destroy({ leaseId: LEASE_ID, profile: PROFILE });
    expect(calls.map(({ argv }) => argv[1])).toEqual(["stop"]);
  } finally {
    await provider.dispose();
    vi.useRealTimers();
  }
});
