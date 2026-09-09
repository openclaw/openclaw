import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  createNodeBootstrapFixture,
  createWorkerArchiveFixture,
} from "./crabbox-worker-node-enrollment.test-support.js";
import { operationLeaseId } from "./crabbox-worker-profile.js";
import { listCrabboxWarmImages } from "./crabbox-worker-warm-image-store.js";
import {
  CHECKPOINT_ID,
  CLASSLESS_PROFILE,
  PROFILE,
  commandResult,
  checkpointResult,
  createWarmProvider,
  openWarmImageStore,
  type CommandCall,
} from "./crabbox-worker-warm-image.test-support.js";

type ProvisionOptions = NonNullable<Parameters<WorkerProvider["provision"]>[2]>;
const PROJECT_KEY = "a".repeat(64);
const BASE_COMMIT = "b".repeat(40);

function notSubmittedReceipt(leaseId: string) {
  return {
    schema: "crabbox.checkpoint.create.failure.v1",
    outcome: "not_submitted",
    provider: "aws",
    leaseId,
    checkpointId: "chk_not_submitted",
    localReservation: "removed",
  };
}

function projectOptions(events: string[], controller = new AbortController()) {
  let enrollmentStarted = false;
  const observe = ({ argv }: CommandCall) => {
    if (argv[1] === "run" && argv.includes("CRABBOX_WORKER_BOOTSTRAP_TOKEN")) {
      events.push(enrollmentStarted ? "enrollment-install" : "runtime-install");
    }
    if (argv[1] === "checkpoint" && argv[2] === "create") {
      events.push("capture");
    }
    return undefined;
  };
  const options = {
    nodeRuntimeIdentity: {
      nodeBootstrapSha256: createNodeBootstrapFixture().sha256,
      executionMode: "worker-turn" as const,
      workerBundleSha256: createWorkerArchiveFixture().sha256,
    },
    project: {
      key: PROJECT_KEY,
      baseCommit: BASE_COMMIT,
      signal: controller.signal,
      assertCurrent: () => controller.signal.throwIfAborted(),
      prepare: vi.fn<NonNullable<ProvisionOptions["project"]>["prepare"]>(async (transport) => {
        await transport.runScript("project-checkout", controller.signal);
        events.push("project-prepared");
        return { seedKey: PROJECT_KEY, cacheHit: false };
      }),
    },
    prepareNodeRuntime: vi.fn(async () => {
      events.push("runtime-granted");
      return {
        nodeBootstrap: createNodeBootstrapFixture(),
        workerBundle: createWorkerArchiveFixture(),
        signal: controller.signal,
      };
    }),
    beginNodeEnrollment: vi.fn(async () => {
      events.push("enrollment-begun");
      enrollmentStarted = true;
      return {
        mode: "connect" as const,
        setupCode: "synthetic-setup-code",
        setupId: "project-setup",
        openclawVersion: "2026.8.1",
        nodeBootstrap: createNodeBootstrapFixture(),
        displayName: "Project worker",
        signal: controller.signal,
        waitForDeviceId: async () => "project-node",
      };
    }),
  } satisfies ProvisionOptions;
  return { options, observe };
}

describe("Crabbox project snapshot provisioning", () => {
  it.each([false, true])(
    "clears only its own rejected capture and still stops the source (replaced=%s)",
    async (replaced) => {
      const events: string[] = [];
      const { options, observe } = projectOptions(events);
      const leaseId = operationLeaseId("not-submitted");
      const { provider, calls } = createWarmProvider((call) => {
        observe(call);
        if (call.argv[2] !== "create") {
          return undefined;
        }
        if (replaced) {
          const store = openWarmImageStore();
          const entry = store.entries()[0]!;
          store.register(entry.key, {
            ...entry.value,
            operation: {
              type: "capture",
              id: "replacement-capture",
              leaseId: "cbx_replacement",
              provider: "aws",
              startedAtMs: Date.now(),
              phase: "creating",
            },
          });
        }
        return commandResult({
          code: 2,
          stdout: JSON.stringify(notSubmittedReceipt(leaseId)),
          stderr: "image submission rejected; source rollback failed",
        });
      });

      await expect(provider.provision(PROFILE, "not-submitted", options)).rejects.toThrow(
        "image submission rejected; source rollback failed",
      );
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(1);
      expect(calls.find(({ argv }) => argv[1] === "stop")?.argv).toContain(leaseId);
      if (replaced) {
        expect(listCrabboxWarmImages()[0]?.capture).toMatchObject({
          selector: "replacement-capture",
          leaseId: "cbx_replacement",
          phase: "creating",
        });
        expect(listCrabboxWarmImages()[0]?.allocations[leaseId]).toBeUndefined();
      } else {
        expect(listCrabboxWarmImages()).toEqual([]);
      }
    },
  );

  it.each(["aws", "azure", "gcp"])(
    "settles a retained %s checkpoint before enrollment without repeating capture",
    async (backend) => {
      const events: string[] = [];
      const { options, observe } = projectOptions(events);
      const entered = createDeferred<void>();
      const available = createDeferred<void>();
      const { provider, calls } = createWarmProvider(async (call) => {
        observe(call);
        if (call.argv[2] !== "create") {
          return undefined;
        }
        entered.resolve();
        // Crabbox only continues an admitted checkpoint_pending response when wait is enabled.
        if (call.argv.includes("--wait=false")) {
          return commandResult({ code: 1, stderr: "http 503: checkpoint_pending" });
        }
        await available.promise;
        return checkpointResult(CHECKPOINT_ID, operationLeaseId("retained-capture"), "available");
      });
      const provision = expect(
        provider.provision({ ...PROFILE, provider: backend }, "retained-capture", options),
      ).resolves.toMatchObject({ node: { deviceId: "project-node" } });
      await entered.promise;
      try {
        expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      } finally {
        available.resolve();
      }
      await provision;
      expect(listCrabboxWarmImages()[0]).toMatchObject({
        checkpointId: CHECKPOINT_ID,
        state: "available",
        allocations: { [operationLeaseId("retained-capture")]: { phase: "enrolled" } },
      });
      expect(calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
      expect(options.beginNodeEnrollment).toHaveBeenCalledOnce();
      expect(listCrabboxWarmImages()[0]?.capture).toBeUndefined();
    },
  );

  it.each(["project transfer", "runtime grant", "runtime setup", "enrollment setup"] as const)(
    "cancels explicit Stop during %s without replacing its narrower grant signal",
    async (phase) => {
      const events: string[] = [];
      const controller = new AbortController();
      const reason = new DOMException("Stop snapshot provisioning", "AbortError");
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const { options, observe } = projectOptions(events);
      const provisionOptions = { ...options, signal: controller.signal };
      let commandSignal: AbortSignal | undefined;
      const { provider, calls } = createWarmProvider(async (call) => {
        observe(call);
        const input = call.options.input?.toString();
        const currentPhase =
          input === "project-checkout"
            ? "project transfer"
            : call.argv[1] === "run" && call.argv.includes("CRABBOX_WORKER_BOOTSTRAP_TOKEN")
              ? events.includes("enrollment-begun")
                ? "enrollment setup"
                : "runtime setup"
              : undefined;
        if (currentPhase !== phase) {
          return undefined;
        }
        commandSignal = call.options.signal;
        entered.resolve();
        await release.promise;
        return commandResult({ code: 7, stderr: "command interrupted" });
      });
      if (phase === "runtime grant") {
        options.prepareNodeRuntime.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return {
            nodeBootstrap: createNodeBootstrapFixture(),
            workerBundle: createWorkerArchiveFixture(),
            signal: options.project.signal,
          };
        });
      }
      let settled = false;
      const operation = provider
        .provision(PROFILE, `stop-${phase}`, provisionOptions)
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await entered.promise;
      const commandCount = calls.length;
      try {
        controller.abort(reason);
        await setImmediate();
        expect(options.project.signal.aborted).toBe(false);
        if (phase !== "runtime grant") {
          expect(commandSignal?.aborted).toBe(true);
        }
        expect(settled).toBe(false);
        expect(calls).toHaveLength(commandCount);
      } finally {
        release.resolve();
        await operation;
      }
      expect(await operation).toBe(reason);
      expect(calls).toHaveLength(commandCount);
      if (phase !== "enrollment setup") {
        expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      }
      expect(calls.some(({ argv }) => argv[1] === "stop" || argv[1] === "heartbeat")).toBe(false);
    },
  );

  it.each(["runtime-install", "enrollment-install"])(
    "completes internal %s without another provider readiness request",
    async (phase) => {
      const events: string[] = [];
      const { options, observe } = projectOptions(events);
      const { provider, calls } = createWarmProvider((call) => {
        observe(call);
        if ((call.argv[1] === "inspect" || call.argv[1] === "status") && events.at(-1) === phase) {
          return commandResult({ termination: "timeout", code: null, killed: true });
        }
        return undefined;
      });

      await expect(
        provider.provision(PROFILE, `internal-${phase}`, options),
      ).resolves.toMatchObject({
        node: { deviceId: "project-node" },
      });
      expect(events).toContain(phase);
      expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(false);
    },
  );

  it.each(["aws", "daytona", "machine0"])(
    "captures the prepared %s project before enrollment and reuses it",
    async (backend) => {
      const profile = { ...PROFILE, provider: backend };
      const events: string[] = [];
      let current = projectOptions(events);
      const { provider, calls } = createWarmProvider((call) => {
        current.observe(call);
        if (
          backend === "daytona" &&
          call.argv[2] === "create" &&
          !call.argv.includes("--no-reboot=false")
        ) {
          return commandResult({
            code: 2,
            stderr:
              "Daytona filesystem snapshots require a stopped source; rerun with --no-reboot=false",
          });
        }
        return undefined;
      });

      await provider.provision(profile, "project-first", current.options);

      expect(events).toEqual([
        "project-prepared",
        "runtime-granted",
        "runtime-install",
        "capture",
        "enrollment-begun",
        "enrollment-install",
      ]);
      expect(listCrabboxWarmImages()[0]).toMatchObject({
        projectKey: PROJECT_KEY,
        checkpointId: CHECKPOINT_ID,
        allocations: {
          [operationLeaseId("project-first")]: { phase: "enrolled", baseCommit: BASE_COMMIT },
        },
      });
      // The first worker is still running: a new session can already use its clean image.
      calls.length = 0;
      events.length = 0;
      current = projectOptions(events);
      await provider.provision(profile, "project-second", current.options);
      expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(CHECKPOINT_ID);
      expect(calls.some(({ argv }) => argv[1] === "warmup" || argv[2] === "create")).toBe(false);
      // Waited capture already established readiness; reuse does not repeat the inspection.
      expect(calls.filter(({ argv }) => argv[2] === "inspect")).toHaveLength(0);
      expect(events).toEqual(["project-prepared", "enrollment-begun", "enrollment-install"]);
      expect(current.options.prepareNodeRuntime).not.toHaveBeenCalled();
      // A cache hit does not restart the machine; only allocation needs provider readiness.
      expect(
        calls.filter(({ argv }) => argv[1] === "inspect" || argv[1] === "status"),
      ).toHaveLength(1);
    },
  );

  it.each(["grant", "setup", "readiness"] as const)(
    "preserves preparation %s failure ownership without enrollment",
    async (failure) => {
      const events: string[] = [];
      const { options, observe } = projectOptions(events);
      if (failure === "grant") {
        options.prepareNodeRuntime.mockRejectedValueOnce(new Error("runtime grant failed"));
      }
      let captured = false;
      const { provider, calls } = createWarmProvider((call) => {
        observe(call);
        if (call.argv[1] === "run" && call.argv.includes("CRABBOX_WORKER_BOOTSTRAP_TOKEN")) {
          if (failure === "setup") {
            return commandResult({ code: 7, stderr: "runtime setup failed" });
          }
        }
        captured ||= call.argv[2] === "create";
        if (captured && failure === "readiness" && call.argv[1] === "inspect") {
          return commandResult({ termination: "timeout", code: null, killed: true });
        }
        return undefined;
      });
      await expect(provider.provision(PROFILE, `runtime-${failure}`, options)).rejects.toThrow();
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      expect(calls.some(({ argv }) => argv[2] === "create")).toBe(failure === "readiness");
      expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(
        failure === "readiness" ? 0 : 1,
      );
      expect(listCrabboxWarmImages().every((image) => !image.capture)).toBe(true);
      if (failure === "readiness") {
        expect(
          listCrabboxWarmImages()[0]?.allocations[operationLeaseId(`runtime-${failure}`)],
        ).toMatchObject({ phase: "prepared", choice: { kind: "cold" } });
      }
    },
  );

  it.each(["resolve", "reject"] as const)(
    "fences a runtime grant that will %s after project ownership changes",
    async (outcome) => {
      const events: string[] = [];
      const controller = new AbortController();
      const { options, observe } = projectOptions(events, controller);
      const { provider, calls } = createWarmProvider(observe);
      let current = true;
      const closed = new DOMException("Project owner changed", "AbortError");
      options.project.assertCurrent = () => {
        if (!current) {
          controller.abort(closed);
        }
        controller.signal.throwIfAborted();
      };
      options.prepareNodeRuntime.mockImplementationOnce(async () => {
        current = false;
        expect(controller.signal.aborted).toBe(false);
        if (outcome === "reject") {
          throw closed;
        }
        return {
          nodeBootstrap: createNodeBootstrapFixture(),
          workerBundle: createWorkerArchiveFixture(),
          signal: new AbortController().signal,
        };
      });

      await expect(
        provider.provision(PROFILE, `stale-grant-${outcome}`, options),
      ).rejects.toMatchObject({
        name: "AbortError",
      });

      expect(events).not.toContain("runtime-install");
      expect(calls.some(({ argv }) => argv[1] === "stop" || argv[2] === "create")).toBe(false);
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      expect(listCrabboxWarmImages()[0]).toMatchObject({
        allocations: {
          [operationLeaseId(`stale-grant-${outcome}`)]: {
            phase: "prepared",
            choice: { kind: "cold" },
          },
        },
      });
      expect(listCrabboxWarmImages()[0]?.capture).toBeUndefined();
    },
  );

  it.each<{
    failure: string;
    result?: Partial<SpawnResult>;
    receipt?: Partial<ReturnType<typeof notSubmittedReceipt>>;
  }>([
    { failure: "aborted" },
    { failure: "response lost", result: { stdout: "" } },
    { failure: "timed out", result: { code: null, killed: true, termination: "timeout" } },
    { failure: "different lease", receipt: { leaseId: "cbx_other" } },
    { failure: "different provider", receipt: { provider: "machine0" } },
    { failure: "retained reservation", receipt: { localReservation: "retained" } },
    { failure: "unknown schema", receipt: { schema: "crabbox.checkpoint.create.failure.v2" } },
    { failure: "malformed output", result: { stdout: '{"schema":' } },
    { failure: "truncated output", result: { stdoutTruncatedBytes: 1 } },
    { failure: "output limit", result: { outputLimitExceeded: true } },
    { failure: "failed process cleanup", result: { cleanup: "uncertain" } },
  ])(
    "retains uncertainty and prevents enrollment after native capture: $failure",
    async ({ failure, result, receipt }) => {
      const events: string[] = [];
      const controller = new AbortController();
      const { options, observe } = projectOptions(events, controller);
      const { provider, calls } = createWarmProvider((call) => {
        observe(call);
        if (call.argv[2] !== "create") {
          return undefined;
        }
        if (failure === "aborted") {
          controller.abort();
        }
        expect(call.options.signal).toBe(controller.signal);
        return commandResult({
          code: 7,
          stderr: "capture failed",
          stdout: JSON.stringify({
            ...notSubmittedReceipt(operationLeaseId(`project-${failure}`)),
            ...receipt,
          }),
          ...result,
        });
      });

      await expect(provider.provision(PROFILE, `project-${failure}`, options)).rejects.toThrow();

      expect(events).toContain("capture");
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      expect(events).not.toContain("enrollment-install");
      expect(listCrabboxWarmImages()[0]?.capture?.phase).toBe("uncertain");
      expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(failure !== "aborted");
    },
  );

  it("preserves the lease when enrollment's owning operation has closed", async () => {
    const { provider, calls } = createWarmProvider();
    const beginNodeEnrollment = vi.fn(async () => {
      throw new DOMException("Worker provisioning operation is closed", "AbortError");
    });
    await expect(
      provider.provision({ ...PROFILE, warmImage: false }, "closed-enrollment", {
        beginNodeEnrollment,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(beginNodeEnrollment).toHaveBeenCalledOnce();
    expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(false);
  });

  it.each([
    { ...PROFILE, warmImage: false },
    { ...CLASSLESS_PROFILE, class: "standard", setup: "true", setupEnv: ["PROJECT_SETUP_VALUE"] },
  ])(
    "keeps explicitly or implicitly opted-out profiles on their existing enrollment path: %j",
    async (profile) => {
      vi.stubEnv("PROJECT_SETUP_VALUE", "synthetic");
      const events: string[] = [];
      const { options, observe } = projectOptions(events);
      const { provider, calls } = createWarmProvider((call) => observe(call));
      expect(provider.supportsProjectPreparation?.(profile)).toBe(false);
      await provider.provision(profile, "project-optout", options);
      expect(options.project.prepare).not.toHaveBeenCalled();
      expect(options.prepareNodeRuntime).not.toHaveBeenCalled();
      expect(options.beginNodeEnrollment).toHaveBeenCalledOnce();
      expect(calls.some(({ argv }) => argv[1] === "checkpoint")).toBe(false);
      expect(listCrabboxWarmImages()).toEqual([]);
    },
  );
});
