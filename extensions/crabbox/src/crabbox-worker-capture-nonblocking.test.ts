import { afterEach, describe, expect, it, vi } from "vitest";
import { openWarmImageStore } from "./crabbox-state.test-support.js";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import { parseCreatedCheckpoint } from "./crabbox-worker-warm-image-checkpoint.js";
import {
  BASE_COMMIT,
  CHECKPOINT_ID,
  PROFILE,
  PROJECT_KEY,
  createProjectOptions,
  createWarmProvider,
  managedBinary,
  type CommandCall,
} from "./crabbox-worker-warm-image.test-support.js";

afterEach(() => vi.useRealTimers());

function receipt(leaseId: string, state: string, captureEstablished?: boolean) {
  return {
    id: CHECKPOINT_ID,
    kind: "aws-ami",
    leaseId,
    native: { state },
    ...(captureEstablished === undefined ? {} : { captureEstablished }),
  };
}

function captureResult(argv: string[], state: string, established?: boolean) {
  return commandResult({
    stdout: JSON.stringify(receipt(argv[argv.indexOf("--id") + 1]!, state, established)),
  });
}

function availability(available = false) {
  return commandResult({
    stdout: JSON.stringify({
      localState: "metadata_available",
      providerState: available ? "available" : "pending",
      nextAction: available ? "fork_or_delete" : "wait_or_delete",
    }),
  });
}

function useCliVersion(version = "0.79.0") {
  vi.mocked(managedBinary.ensureManagedCrabboxBinary).mockResolvedValue({
    binary: "crabbox",
    version,
  });
}

function preparation(purpose: "session" | "reserve" = "session") {
  return { key: "c".repeat(64), cacheKey: "d".repeat(64), purpose, demandAtMs: Date.now() };
}

function current() {
  return openWarmImageStore().entries()[0]!.value;
}

const checkpoints = (calls: CommandCall[], action: string) =>
  calls.filter(({ argv }) => argv[2] === action);

function pendingCapture(
  inspect: (argv: string[]) => ReturnType<typeof commandResult>,
  established?: boolean,
) {
  const fixture = createWarmProvider(({ argv }) => {
    if (argv[2] === "create") {
      return captureResult(argv, "pending", established);
    }
    if (argv[2] === "inspect") {
      return inspect(argv);
    }
    return undefined;
  });
  useCliVersion();
  return fixture;
}

function provision(
  provider: ReturnType<typeof createWarmProvider>["provider"],
  name: string,
  prepared: ReturnType<typeof preparation>,
) {
  return provider.provision(PROFILE, name, createProjectOptions([], undefined, prepared).options);
}

it.each([
  ["pending", "pending"],
  ["creating", "pending"],
  ["available", "available"],
  ["completed", "available"],
  ["Succeeded", "available"],
  ["ready", "available"],
  ["ACTIVE", "pending"],
])("parses native %s as %s without inventing availability", (native, state) => {
  expect(parseCreatedCheckpoint(JSON.stringify(receipt("source", native)), "source")).toEqual({
    checkpointId: CHECKPOINT_ID,
    kind: "aws-ami",
    captureEstablished: false,
    state,
  });
});

describe("Crabbox first capture without upload wait", () => {
  it.each([
    { version: "0.78.1", nonBlocking: false },
    { version: "0.79.0-rc.1", nonBlocking: false },
    { version: "0.79.0", nonBlocking: true },
    { version: "1.0.0", nonBlocking: true },
  ])(
    "enrolls safely with CLI $version (non-blocking=$nonBlocking)",
    async ({ version, nonBlocking }) => {
      const prepared = preparation();
      const { options, observe } = createProjectOptions([], undefined, prepared);
      const statuses: { phase?: string }[] = [];
      const { provider, calls } = createWarmProvider((call) => {
        observe(call);
        if (call.argv[2] === "create") {
          return captureResult(call.argv, nonBlocking ? "pending" : "available", true);
        }
        return undefined;
      });
      useCliVersion(version);
      const enroll = options.beginNodeEnrollment.getMockImplementation()!;
      options.beginNodeEnrollment.mockImplementation(async () => {
        const record = current();
        expect(record.operation).toBeUndefined();
        expect(record.image).toMatchObject({
          checkpointId: CHECKPOINT_ID,
          state: nonBlocking ? "pending" : "available",
          baseCommit: BASE_COMMIT,
          runtimeIdentity: options.nodeRuntimeIdentity,
          preparationKey: prepared.key,
          cacheKey: prepared.cacheKey,
          purpose: "session",
        });
        expect(statuses.some((status) => status.phase === "saving")).toBe(true);
        expect(statuses.at(-1)?.phase).not.toBe("saving");
        return enroll();
      });
      await provider.provision(PROFILE, "first-capture", {
        ...options,
        reportStartStatus: (status) => statuses.push(status),
      });
      expect(options.beginNodeEnrollment).toHaveBeenCalledOnce();
      const argv = checkpoints(calls, "create")[0]!.argv;
      if (nonBlocking) {
        expect(argv).toContain("--wait=false");
        expect(argv).not.toContain("--wait");
        expect(argv).not.toContain("--wait-timeout");
      } else {
        expect(argv).toEqual(expect.arrayContaining(["--wait", "--wait-timeout", "2700000ms"]));
      }
      const captureCallIndex = calls.findIndex((call) => call.argv[2] === "create");
      expect(
        calls.slice(captureCallIndex + 1).filter((call) => call.argv[1] === "inspect"),
      ).toHaveLength(nonBlocking ? 0 : 1);
      expect(managedBinary.ensureManagedCrabboxBinary).toHaveBeenCalledOnce();
      expect(Object.values(current().allocations)[0]?.phase).toBe("enrolled");
    },
  );

  it.each([undefined, false])(
    "waits for the exact checkpoint before enrollment without attestation (%s)",
    async (established) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const entered = Promise.withResolvers<void>();
      let available = false;
      const { options } = createProjectOptions([]);
      const { provider, calls, warn } = pendingCapture((argv) => {
        expect(argv[3]).toBe(CHECKPOINT_ID);
        entered.resolve();
        return availability(available);
      }, established);
      const enroll = options.beginNodeEnrollment.getMockImplementation()!;
      options.beginNodeEnrollment.mockImplementation(async () => {
        const record = current();
        expect(record.operation).toBeUndefined();
        expect(record.image).toMatchObject({ checkpointId: CHECKPOINT_ID, state: "available" });
        return enroll();
      });
      const provisioning = provider.provision(PROFILE, "unattested-capture", options);
      await Promise.race([entered.promise, provisioning]);
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      expect(current().image).toBeUndefined();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(checkpoints(calls, "inspect")).toHaveLength(1);
      available = true;
      await vi.advanceTimersByTimeAsync(1);
      await provisioning;
      expect(options.beginNodeEnrollment).toHaveBeenCalledOnce();
      const captureIndex = calls.findIndex((call) => call.argv[2] === "create");
      expect(calls[captureIndex]!.argv).toContain("--wait=false");
      expect(calls.slice(captureIndex + 1).some((call) => call.argv[1] === "inspect")).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each(["timeout", "cancel", "stale"])(
    "blocks enrollment and retains uncertainty on unattested capture %s",
    async (outcome) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const entered = Promise.withResolvers<void>();
      const controller = new AbortController();
      let monotonicMs = 0;
      vi.spyOn(performance, "now").mockImplementation(() => monotonicMs);
      const { options } = createProjectOptions([], controller);
      const { provider, calls } = pendingCapture(() => {
        entered.resolve();
        if (monotonicMs > 0) {
          // Fail promptly if the expired budget still permits another provider read.
          throw new Error("checkpoint polled past capture deadline");
        }
        return availability();
      });
      const provisioning = provider.provision(PROFILE, "interrupted-capture", options);
      const rejected = expect(provisioning).rejects.toThrow(
        outcome === "timeout" ? "Crabbox waited checkpoint is not available" : `${outcome} capture`,
      );
      await Promise.race([entered.promise, provisioning]);
      await vi.advanceTimersByTimeAsync(0);
      if (outcome === "timeout") {
        monotonicMs = 45 * 60_000 + 1;
      } else if (outcome === "cancel") {
        controller.abort(new Error("cancel capture"));
      } else {
        options.project.assertCurrent = () => {
          throw new Error("stale capture");
        };
      }
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      expect(current().operation).toMatchObject({ type: "capture", phase: "uncertain" });
      expect(current().image).toBeUndefined();
      expect(checkpoints(calls, "create")).toHaveLength(1);
    },
  );

  it("goes cold while upload is pending, then verifies and forks the exact available checkpoint", async () => {
    let available = false;
    const prepared = preparation();
    const { provider, calls } = pendingCapture(() => availability(available), true);
    const first = await provision(provider, "upload-source", prepared);
    await provider.notePreparedDemand!(
      { leaseId: first.leaseId, profile: PROFILE },
      { preparationKey: prepared.key, demandAtMs: prepared.demandAtMs },
    );
    const whileUploading = await provision(provider, "upload-pending", prepared);
    expect(whileUploading.node).toBeDefined();
    expect(checkpoints(calls, "fork")).toHaveLength(0);
    expect(checkpoints(calls, "create")).toHaveLength(1);
    expect(current().image?.state).toBe("pending");
    available = true;
    await provision(provider, "upload-ready", prepared);
    expect(checkpoints(calls, "fork")[0]?.argv[3]).toBe(CHECKPOINT_ID);
    expect(current().image?.state).toBe("available");
  });

  it("keeps refresh blocking and retains its predecessor until the replacement is available", async () => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let captures = 0;
    const { provider, calls } = createWarmProvider(async ({ argv }) => {
      if (argv[2] !== "create") {
        return undefined;
      }
      if (++captures === 2) {
        entered.resolve();
        await finish.promise;
      }
      return commandResult({
        stdout: JSON.stringify({
          ...receipt(argv[argv.indexOf("--id") + 1]!, "available", true),
          id: captures === 1 ? CHECKPOINT_ID : "chk_replacement",
        }),
      });
    });
    useCliVersion();
    const prepared = preparation("reserve");
    await provision(provider, "refresh-source", prepared);
    const next = createProjectOptions([], undefined, prepared).options;
    next.project.prepare.mockResolvedValue({
      seedKey: PROJECT_KEY,
      cacheHit: false,
      captureRequired: true,
    });
    const refresh = provider.provision(PROFILE, "refresh-replacement", next);
    try {
      await entered.promise;
      expect(checkpoints(calls, "create").every(({ argv }) => argv.includes("--wait"))).toBe(true);
      expect(current().image?.checkpointId).toBe(CHECKPOINT_ID);
      expect(checkpoints(calls, "delete")).toHaveLength(0);
      expect(next.beginNodeEnrollment).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await refresh;
    }
    expect(current().image).toMatchObject({
      checkpointId: "chk_replacement",
      state: "available",
    });
  });
});
