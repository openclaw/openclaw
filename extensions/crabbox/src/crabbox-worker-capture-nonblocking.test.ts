import { describe, expect, it, vi } from "vitest";
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
} from "./crabbox-worker-warm-image.test-support.js";

function receipt(leaseId: string, state: string, captureEstablished?: boolean) {
  return {
    id: CHECKPOINT_ID,
    kind: "aws-ami",
    leaseId,
    native: { state },
    ...(captureEstablished === undefined ? {} : { captureEstablished }),
  };
}

describe("Crabbox capture receipt", () => {
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
      state,
    });
  });
});

describe("Crabbox first capture without upload wait", () => {
  it.each([
    { version: "0.77.0", nonBlocking: false },
    { version: "0.78.0-rc.1", nonBlocking: false },
    { version: "0.78.0", nonBlocking: true },
    { version: "0.78.0+build-1", nonBlocking: true },
    { version: "0.78.1", nonBlocking: true },
    { version: "0.78.1-rc.1", nonBlocking: true },
    { version: "0.79.0", nonBlocking: true },
    { version: "1.0.0", nonBlocking: true },
  ])(
    "enrolls safely with CLI $version (non-blocking=$nonBlocking)",
    async ({ version, nonBlocking }) => {
      const preparation = {
        key: "c".repeat(64),
        cacheKey: "d".repeat(64),
        purpose: "session" as const,
        demandAtMs: Date.now(),
      };
      const { options, observe } = createProjectOptions([], undefined, preparation);
      const statuses: { phase?: string }[] = [];
      const { provider, calls } = createWarmProvider((call) => {
        observe(call);
        if (call.argv[2] === "create") {
          return commandResult({
            stdout: JSON.stringify(
              receipt(
                call.argv[call.argv.indexOf("--id") + 1]!,
                nonBlocking ? "pending" : "available",
                true,
              ),
            ),
          });
        }
        return undefined;
      });
      vi.mocked(managedBinary.ensureManagedCrabboxBinary).mockResolvedValue({
        binary: "crabbox",
        version,
      });
      const enroll = options.beginNodeEnrollment.getMockImplementation()!;
      options.beginNodeEnrollment.mockImplementation(async () => {
        const record = openWarmImageStore().entries()[0]!.value;
        expect(record.operation).toBeUndefined();
        expect(record.image).toMatchObject({
          checkpointId: CHECKPOINT_ID,
          state: nonBlocking ? "pending" : "available",
          baseCommit: BASE_COMMIT,
          runtimeIdentity: options.nodeRuntimeIdentity,
          preparationKey: preparation.key,
          cacheKey: preparation.cacheKey,
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
      const argv = calls.find((call) => call.argv[2] === "create")!.argv;
      if (nonBlocking) {
        expect(argv).toContain("--wait=false");
        expect(argv).not.toContain("--wait");
        expect(argv).not.toContain("--wait-timeout");
      } else {
        expect(argv).toEqual(expect.arrayContaining(["--wait", "--wait-timeout", "2700000ms"]));
      }
      expect(calls.filter((call) => call.argv[1] === "inspect")).toHaveLength(nonBlocking ? 1 : 2);
      expect(managedBinary.ensureManagedCrabboxBinary).toHaveBeenCalledOnce();
      expect(Object.values(openWarmImageStore().entries()[0]!.value.allocations)[0]?.phase).toBe(
        "enrolled",
      );
    },
  );

  it.each([undefined, false])(
    "retains uncertainty without a true established receipt (%s)",
    async (established) => {
      const { options } = createProjectOptions([]);
      const { provider, calls } = createWarmProvider(({ argv }) =>
        argv[2] === "create"
          ? commandResult({
              stdout: JSON.stringify(
                receipt(argv[argv.indexOf("--id") + 1]!, "pending", established),
              ),
            })
          : undefined,
      );
      vi.mocked(managedBinary.ensureManagedCrabboxBinary).mockResolvedValue({
        binary: "crabbox",
        version: "0.78.0",
      });
      await expect(provider.provision(PROFILE, "uncertain-capture", options)).rejects.toThrow(
        "capture is unresolved",
      );
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      expect(openWarmImageStore().entries()[0]!.value.operation).toMatchObject({
        type: "capture",
        phase: "uncertain",
      });
      expect(openWarmImageStore().entries()[0]!.value.image).toBeUndefined();
      expect(calls.filter((call) => call.argv[2] === "create")).toHaveLength(1);
    },
  );

  it("goes cold while upload is pending, then verifies and forks the exact available checkpoint", async () => {
    let available = false;
    const preparation = {
      key: "c".repeat(64),
      cacheKey: "d".repeat(64),
      purpose: "session" as const,
      demandAtMs: Date.now(),
    };
    const { provider, calls } = createWarmProvider(({ argv }) => {
      if (argv[2] === "create") {
        return commandResult({
          stdout: JSON.stringify(receipt(argv[argv.indexOf("--id") + 1]!, "pending", true)),
        });
      }
      if (argv[2] === "inspect") {
        return commandResult({
          stdout: JSON.stringify({
            localState: "metadata_available",
            providerState: available ? "available" : "pending",
            nextAction: available ? "fork_or_delete" : "wait_or_delete",
          }),
        });
      }
      return undefined;
    });
    vi.mocked(managedBinary.ensureManagedCrabboxBinary).mockResolvedValue({
      binary: "crabbox",
      version: "0.78.0",
    });
    const first = await provider.provision(
      PROFILE,
      "upload-source",
      createProjectOptions([], undefined, preparation).options,
    );
    await provider.notePreparedDemand!(
      { leaseId: first.leaseId, profile: PROFILE },
      { preparationKey: preparation.key, demandAtMs: preparation.demandAtMs },
    );
    const whileUploading = await provider.provision(
      PROFILE,
      "upload-pending",
      createProjectOptions([], undefined, preparation).options,
    );
    expect(whileUploading.node).toBeDefined();
    expect(calls.some((call) => call.argv[2] === "fork")).toBe(false);
    expect(calls.filter((call) => call.argv[2] === "create")).toHaveLength(1);
    expect(openWarmImageStore().entries()[0]!.value.image?.state).toBe("pending");
    available = true;
    await provider.provision(
      PROFILE,
      "upload-ready",
      createProjectOptions([], undefined, preparation).options,
    );
    expect(calls.find((call) => call.argv[2] === "fork")?.argv[3]).toBe(CHECKPOINT_ID);
    expect(openWarmImageStore().entries()[0]!.value.image?.state).toBe("available");
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
    vi.mocked(managedBinary.ensureManagedCrabboxBinary).mockResolvedValue({
      binary: "crabbox",
      version: "0.78.0",
    });
    const preparation = {
      key: "c".repeat(64),
      cacheKey: "d".repeat(64),
      purpose: "reserve" as const,
      demandAtMs: Date.now(),
    };
    await provider.provision(
      PROFILE,
      "refresh-source",
      createProjectOptions([], undefined, preparation).options,
    );
    const next = createProjectOptions([], undefined, preparation).options;
    next.project.prepare.mockResolvedValue({
      seedKey: PROJECT_KEY,
      cacheHit: false,
      captureRequired: true,
    });
    const refresh = provider.provision(PROFILE, "refresh-replacement", next);
    try {
      await entered.promise;
      expect(
        calls
          .filter((call) => call.argv[2] === "create")
          .every((call) => call.argv.includes("--wait")),
      ).toBe(true);
      expect(openWarmImageStore().entries()[0]!.value.image?.checkpointId).toBe(CHECKPOINT_ID);
      expect(calls.some((call) => call.argv[2] === "delete")).toBe(false);
      expect(next.beginNodeEnrollment).not.toHaveBeenCalled();
    } finally {
      finish.resolve();
      await refresh;
    }
    expect(openWarmImageStore().entries()[0]!.value.image).toMatchObject({
      checkpointId: "chk_replacement",
      state: "available",
    });
  });
});
