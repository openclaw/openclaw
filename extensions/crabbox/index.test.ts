import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginApi, WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import plugin from "./index.js";
import * as managedBinary from "./src/crabbox-managed-binary.js";
import { crabboxState, openWarmImageStore } from "./src/crabbox-state.test-support.js";
import {
  commandResult,
  nodeEnrollmentFixture,
  active,
} from "./src/crabbox-worker-provider.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const CLASSLESS = {
  binary: "/mock/crabbox",
  idleTimeout: "12s",
  provider: "aws",
  ttl: "24h",
};
const PROFILE = { ...CLASSLESS, class: "standard" };
const jsonResult = (value: unknown) => commandResult({ stdout: JSON.stringify(value) });

function inspectResult(leaseId: string): SpawnResult {
  return jsonResult({
    id: leaseId,
    ready: true,
    providerMetadata: { instanceProfileAttached: false },
    sshUser: "openclaw",
    state: "running",
  });
}

function registerCrabboxGeneration() {
  const providers: WorkerProvider[] = [];
  const services: Parameters<OpenClawPluginApi["registerService"]>[0][] = [];
  const registrars: Parameters<OpenClawPluginApi["registerCli"]>[0][] = [];
  const api = createTestPluginApi({
    runtime: { state: crabboxState } as OpenClawPluginApi["runtime"],
    id: "crabbox",
    rootDir: fileURLToPath(new URL(".", import.meta.url)),
    registerCli: (registrar) => registrars.push(registrar),
    registerService: (service) => services.push(service),
    registerWorkerProvider: (provider) => providers.push(provider),
  });
  plugin.register(api);
  const generation = {
    provider: providers[0]!,
    services,
    registrars,
    api,
    inspect: (id: string) => providers[0]!.inspect({ leaseId: id, profile: PROFILE }),
    stopped: false,
    async stop(this: void) {
      const scheduler = createTestPluginServiceScheduler();
      scheduler.beginClose();
      try {
        await services[0]?.stop?.({ config: {}, stateDir: ".", logger: console, scheduler });
      } finally {
        await scheduler.stop();
      }
      generation.stopped = true;
    },
  };
  return generation;
}

const commandMock = () => vi.spyOn(processRuntime, "runCommandWithTimeout");
const leaseId = (argv: string[]) => argv[argv.indexOf("--id") + 1]!;
const commands = (mock: ReturnType<typeof commandMock>, name: string) =>
  mock.mock.calls.filter(([argv]) => argv[1] === name);

beforeEach(() => {
  vi.spyOn(managedBinary, "ensureManagedCrabboxBinary").mockImplementation(async (params) => ({
    binary: params?.binary ?? "crabbox",
    version: "999.0.0",
  }));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
});

it("lazily exposes warm-image inspection and acknowledged recovery through the plugin CLI", async () => {
  const { registrars, api } = registerCrabboxGeneration();
  const program = new Command().exitOverride();
  let help = "";
  program.configureOutput({
    writeOut(text) {
      help += text;
    },
  });
  expect(registrars).toHaveLength(1);
  await registrars[0]!({ program, parentPath: [], config: {}, logger: api.logger });
  await expect(
    program.parseAsync(["crabbox", "warm-images", "--help"], { from: "user" }),
  ).rejects.toMatchObject({ code: "commander.helpDisplayed" });
  const flags = ["--json", "--recover <selector>", "--acknowledge-provider-cleanup"];
  flags.forEach((flag) => expect(help).toContain(flag));
});

it.each([
  { backend: "aws", executionMode: "worker-turn" },
  { backend: "hetzner", executionMode: "remote-exec" },
] as const)("classless $backend/$executionMode lifecycle", async ({ backend, executionMode }) => {
  vi.spyOn(performance, "now").mockReturnValue(0);
  const runCommand = commandMock().mockImplementation(async (argv) => {
    if (argv[1] === "config") {
      return jsonResult({ aws: { instanceProfile: "" } });
    }
    if (argv[1] === "providers") {
      return jsonResult([{ provider: backend, classCatalog: { disposition: "unmapped" } }]);
    }
    return argv[1] === "inspect" ? inspectResult(leaseId(argv)) : commandResult();
  });
  const { provider, stop } = registerCrabboxGeneration();
  const profile = { ...CLASSLESS, provider: backend };
  try {
    expect(provider.resolveProvisionTimeoutMs?.(profile)).toBe(248 * 60_000 + 25_000);
    expect(provider.resolveDestroyTimeoutMs?.(profile)).toBe(105 * 60_000 + 15_000);
    expect(await provider.listMachineOptions?.(profile)).toEqual([]);
    const wait = vi.fn(async () => "device-classless");
    const lease = await provider.provision(profile, "classless-operation", {
      assertCurrent: () => {},
      executionMode,
      beginNodeEnrollment: async () => {
        const fixture = nodeEnrollmentFixture("fixture-setup-code", "Classless worker", wait);
        const { mode, setupCode, setupId: _id, ...common } = fixture;
        return {
          ...common,
          ...(executionMode === "worker-turn"
            ? { mode, setupCode, setupId: "fixture-setup-id" }
            : { mode: "resume" as const, deviceId: "device-classless" }),
        };
      },
    });
    const id = lease.leaseId;
    expect(lease.node).toEqual({ deviceId: "device-classless" });
    expect(wait).toHaveBeenCalledOnce();
    await expect(provider.inspect({ leaseId: id, profile })).resolves.toEqual(active);
    await expect(provider.destroy({ leaseId: id, profile })).resolves.toBeUndefined();
    const calls = runCommand.mock.calls.map(([argv]) => argv);
    expect(calls.filter((argv) => argv[1] !== "heartbeat").map((argv) => argv[1])).toEqual([
      "providers",
      ...(backend === "aws" ? ["config"] : []),
      "warmup",
      "inspect",
      "run",
      "inspect",
      "stop",
    ]);
    expect(calls.flat()).not.toContain("--class");
    expect(calls.at(-1)).toEqual([PROFILE.binary, "stop", "--provider", backend, "--id", id]);
    expect(runCommand.mock.lastCall?.[1]).toMatchObject({
      timeoutMs: 1_005_000,
      killProcessTree: true,
    });
  } finally {
    await stop();
  }
});

it.each([0, 2])("fences shutdown with %i heartbeats in flight", async (inFlight) => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  const finishHeartbeats: Array<() => void> = [];
  const runCommand = commandMock().mockImplementation(async (argv, options) => {
    if (!inFlight || argv[1] !== "heartbeat") {
      return inspectResult(leaseId(argv));
    }
    if (typeof options === "number" || !options.signal) {
      throw new Error("heartbeat is missing its abort signal");
    }
    signals.push(options.signal);
    return await new Promise<SpawnResult>((resolve) => {
      finishHeartbeats.push(() => resolve(commandResult()));
    });
  });
  const generation = registerCrabboxGeneration();
  let stopping: Promise<void> | undefined;
  try {
    expect(generation.services).toHaveLength(1);
    for (const id of ["cbx_first", "cbx_second"].slice(0, inFlight || 1)) {
      await generation.inspect(id);
    }
    if (inFlight) {
      await vi.advanceTimersByTimeAsync(0);
      expect(signals).toHaveLength(2);
    }
    stopping = generation.stop();
    if (inFlight) {
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      for (const finish of finishHeartbeats) {
        await vi.advanceTimersByTimeAsync(0);
        expect(generation.stopped).toBe(false);
        finish();
      }
    }
    await stopping;
    expect(generation.stopped).toBe(true);
    await generation.inspect(inFlight ? "cbx_late" : "cbx_first");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(commands(runCommand, "heartbeat")).toHaveLength(inFlight);
  } finally {
    for (const finish of finishHeartbeats) {
      finish();
    }
    await stopping;
    await generation.stop();
  }
});

it("keeps a replacement provider generation independently usable", async () => {
  vi.useFakeTimers();
  const runCommand = commandMock().mockImplementation(async (argv) =>
    argv[1] === "inspect" ? inspectResult(leaseId(argv)) : commandResult(),
  );
  const retiring = registerCrabboxGeneration();
  const replacement = registerCrabboxGeneration();

  await retiring.inspect("cbx_retiring");
  await replacement.inspect("cbx_replacement");
  await retiring.stop();
  await vi.advanceTimersByTimeAsync(5_000);
  const heartbeatLeaseIds = commands(runCommand, "heartbeat").map(([argv]) => leaseId(argv));
  expect(heartbeatLeaseIds).toEqual(["cbx_replacement", "cbx_replacement"]);
  await replacement.stop();
});

it.each(["binary acquisition", "image deletion"])("joins aborted %s on stop", async (stage) => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-crabbox-maintenance-generation-"));
  const store = openWarmImageStore();
  const old = Date.now() - 14 * 24 * 60 * 60 * 1_000;
  store.register("expired", {
    version: 3,
    allocations: {},
    image: {
      checkpointId: "chk_expired",
      kind: "aws-ebs-snapshot",
      state: "available",
      createdAtMs: old,
      preparationKey: null,
      cacheKey: null,
      purpose: null,
      lastDemandAtMs: old,
    },
  });
  const started = createDeferred<AbortSignal>();
  const finish = createDeferred<void>();
  async function pause(signal?: AbortSignal) {
    if (!signal) {
      throw new Error("maintenance needs a lifecycle signal");
    }
    started.resolve(signal);
    await finish.promise;
    return signal;
  }
  commandMock().mockImplementation(async (_argv, options) => {
    await pause(typeof options === "number" ? undefined : options.signal);
    return commandResult();
  });
  if (stage === "binary acquisition") {
    vi.spyOn(managedBinary, "ensureManagedCrabboxBinary").mockImplementation(async (params) => {
      (await pause(params?.signal)).throwIfAborted();
      return { binary: params?.binary ?? "crabbox", version: "999.0.0" };
    });
  }
  const generation = registerCrabboxGeneration();
  const maintenance = generation.provider.maintain!({
    profiles: [PROFILE],
    signal: new AbortController().signal,
    assertCurrent() {},
  });
  const rejected = expect(maintenance).rejects.toThrow();
  let stopping: Promise<void> | undefined;
  try {
    const signal = await started.promise;
    stopping = generation.stop();
    expect(signal.aborted).toBe(true);
    await Promise.resolve();
    expect(generation.stopped).toBe(false);
  } finally {
    finish.resolve();
    await rejected;
    await stopping;
  }
  expect(generation.stopped).toBe(true);
  expect(store.lookup("expired")?.operation).toEqual(
    stage === "image deletion" ? { type: "retire", checkpointId: "chk_expired" } : undefined,
  );
  expect(store.lookup("expired")?.image?.checkpointId).toBe("chk_expired");
});
