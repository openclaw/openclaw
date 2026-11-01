import type {
  WorkerResourceReceipt,
  WorkerRetentionOperation,
  WorkerRetentionPolicy,
} from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import {
  createWarmProvider,
  provisionWarmProfile,
  LEASE_ID,
  OPERATION_ID,
  jsonResult,
} from "./crabbox-worker-warm-image.test-support.js";

const profile = {
  provider: "azure-sandbox",
  class: "small",
  warmImage: false,
  ttl: "1h",
  idleTimeout: "60m",
};
const receipt: WorkerResourceReceipt = {
  version: 1,
  leaseId: LEASE_ID,
  identity: {
    provider: "azure-sandbox",
    resourceId: "sandbox-original",
    slug: "session-fixture",
    attempt: "nonce-original",
    fingerprint: "fingerprint-original",
  },
};
function scenario() {
  let resource = "sandbox-original";
  let failure: "offline" | "missing" | undefined;
  let recorded: WorkerResourceReceipt | undefined;
  let deleted = false;
  const setupReceipts: Array<WorkerResourceReceipt | undefined> = [];
  const { provider, calls } = createWarmProvider(({ argv }) => {
    if (argv[1] === "inspect" || argv[1] === "status") {
      if (failure) {
        return commandResult({
          code: 4,
          stderr: failure === "missing" ? "sandbox not found: " + LEASE_ID : "provider unavailable",
        });
      }
      return jsonResult({
        id: LEASE_ID,
        provider: "azure-sandbox",
        state: "Running",
        ready: true,
        serverId: resource,
        slug: "session-fixture",
        labels: {
          crabbox_lease: LEASE_ID,
          crabbox_attempt: "nonce-original",
          crabbox_fingerprint: "fingerprint-original",
        },
      });
    }
    if (argv[1] === "run") {
      setupReceipts.push(recorded);
    }
    if (argv[1] === "stop") {
      const expected = argv.includes("--expected-provider-resource-id")
        ? argv[argv.indexOf("--expected-provider-resource-id") + 1]
        : undefined;
      if ((expected !== undefined && expected !== resource) || failure) {
        return commandResult({ code: 4, stderr: "resource identity or deletion unavailable" });
      }
      deleted = true;
      return commandResult();
    }
    return undefined;
  });
  return {
    provider,
    calls,
    setupReceipts,
    setResource: (value: string) => {
      resource = value;
    },
    setFailure: (value: typeof failure) => {
      failure = value;
    },
    deleted: () => deleted,
    provision: (expected?: WorkerResourceReceipt) =>
      provisionWarmProfile(provider, profile, undefined, undefined, {
        resourceReceipt: expected,
        recordResourceReceipt: async (value) => {
          recorded = value;
        },
      }),
  };
}

it("records observed resource identity before enrollment and deletes only that resource", async () => {
  const s = scenario();
  const lease = await s.provision();
  expect(lease.resourceReceipt).toEqual(receipt);
  expect(s.setupReceipts.length).toBeGreaterThan(0);
  expect(s.setupReceipts.every((value) => value?.identity.resourceId === "sandbox-original")).toBe(
    true,
  );
  await expect(s.provider.inspect({ ...lease, profile })).resolves.toEqual({
    status: "active",
    sharedHost: false,
    resourceReceipt: receipt,
  });
  await s.provider.destroy({ ...lease, profile, assertCurrent() {} });
  expect(s.deleted()).toBe(true);
});

it.each(["replacement", "offline", "missing"] as const)(
  "preserves the original resource on %s during replay and teardown",
  async (failure) => {
    const s = scenario();
    const lease = await s.provision();
    const allocations = s.calls.filter(({ argv }) => argv[1] === "warmup").length;
    if (failure === "replacement") {
      s.setResource("sandbox-replacement");
    } else {
      s.setFailure(failure);
    }
    await expect(s.provision(receipt)).rejects.toThrow();
    expect(s.calls.filter(({ argv }) => argv[1] === "warmup")).toHaveLength(allocations);
    await expect(s.provider.inspect({ ...lease, profile })).rejects.toThrow();
    await expect(s.provider.destroy({ ...lease, profile, assertCurrent() {} })).rejects.toThrow();
    expect(s.deleted()).toBe(false);
  },
);

it("does not allocate without receipt custody or destroy after authority ends", async () => {
  const s = scenario();
  await expect(provisionWarmProfile(s.provider, profile)).rejects.toThrow("receipt persistence");
  expect(s.calls).toEqual([]);
  const lease = await s.provision();
  await expect(
    s.provider.destroy({
      ...lease,
      profile,
      assertCurrent() {
        throw new Error("owner ended");
      },
    }),
  ).rejects.toThrow("owner ended");
  expect(s.deleted()).toBe(false);
});

it("does not run setup or cleanup when receipt persistence is unconfirmed", async () => {
  const s = scenario();
  const entered = Promise.withResolvers<void>();
  const persistence = Promise.withResolvers<void>();
  const pending = provisionWarmProfile(s.provider, profile, undefined, undefined, {
    recordResourceReceipt: async () => {
      entered.resolve();
      await persistence.promise;
    },
  });
  const rejected = expect(pending).rejects.toThrow("persistence outcome unknown");
  await Promise.race([entered.promise, pending]);
  expect(s.calls.some(({ argv }) => ["run", "stop", "heartbeat"].includes(argv[1]!))).toBe(false);
  persistence.reject(new Error("persistence outcome unknown"));
  await rejected;
  expect(s.calls.some(({ argv }) => ["run", "stop", "heartbeat"].includes(argv[1]!))).toBe(false);
});

it("does not delete a replacement when the caller holds the original receipt", async () => {
  const s = scenario();
  s.setResource("sandbox-replacement");
  await expect(
    s.provider.destroy({
      leaseId: LEASE_ID,
      profile,
      resourceReceipt: receipt,
      assertCurrent() {},
    }),
  ).rejects.toThrow();
  expect(s.deleted()).toBe(false);
});

it("preserves an allocation whose observation unexpectedly declares retention", async () => {
  const { provider, calls } = createWarmProvider(({ argv }) =>
    argv[1] === "inspect"
      ? jsonResult({
          id: LEASE_ID,
          provider: "azure-sandbox",
          state: "Running",
          retention: { mode: "session-disk" },
        })
      : undefined,
  );
  await expect(
    provisionWarmProfile(provider, profile, undefined, undefined, {
      recordResourceReceipt: async () => {},
    }),
  ).rejects.toThrow("allocation preserved");
  expect(calls.some(({ argv }) => ["run", "stop", "heartbeat"].includes(argv[1]!))).toBe(false);
});

it("refuses a different resource observed after profile setup without starting enrollment or cleanup", async () => {
  let runs = 0;
  const { provider, calls } = createWarmProvider(({ argv }) => {
    if (argv[1] === "run") {
      runs++;
    }
    if (argv[1] === "inspect") {
      return jsonResult({
        id: LEASE_ID,
        provider: "azure-sandbox",
        state: "Running",
        ready: true,
        serverId: runs ? "replacement" : "sandbox-original",
        slug: "session-fixture",
        labels: {
          crabbox_lease: LEASE_ID,
          crabbox_attempt: "nonce-original",
          crabbox_fingerprint: "fingerprint-original",
        },
      });
    }
    return undefined;
  });
  await expect(
    provisionWarmProfile(
      provider,
      { ...profile, setup: "echo fixture-setup" },
      undefined,
      undefined,
      {
        recordResourceReceipt: async () => {},
      },
    ),
  ).rejects.toThrow("resource identity");
  expect(runs).toBe(1);
  expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(false);
});

// Keep retained command fixtures in the existing database-worker test lane.
describe("retained session disk lifecycle", () => {
  const NOW = 1_800_000_000_000;
  const policy: WorkerRetentionPolicy = {
    version: 1,
    ownerBinding: "a".repeat(64),
    computeWindowSeconds: 600,
  };
  const retainedProfile = {
    provider: "azure-sandbox",
    target: "linux",
    class: "small",
    warmImage: false,
    ttl: "1h",
    idleTimeout: "5m",
    binary: "/fixture/managed-crabbox",
  };
  const retainedReceipt: WorkerResourceReceipt = {
    version: 1,
    leaseId: LEASE_ID,
    identity: {
      provider: "azure-sandbox",
      resourceId: "sandbox-original",
      slug: "session-fixture",
      attempt: "nonce-original",
      fingerprint: "fingerprint-original",
    },
  };
  const catalog = [
    {
      provider: "azure-sandbox",
      targets: ["linux"],
      features: ["session-disk-retention-v1", "pause-resume"],
    },
  ];
  function view() {
    return {
      id: LEASE_ID,
      provider: "azure-sandbox",
      state: "running",
      ready: true,
      serverId: "sandbox-original",
      slug: "session-fixture",
      labels: {
        crabbox_lease: LEASE_ID,
        crabbox_attempt: "nonce-original",
        crabbox_fingerprint: "fingerprint-original",
      },
      retention: {
        schema: "crabbox.session-disk.v1",
        mode: "session-disk",
        ownerBinding: "a".repeat(64),
        computeWindowSeconds: 600,
        claimRevision: "revision-1",
        policyVerified: true,
        observedState: "Running",
        stopPending: false,
        desiredState: "running",
        identity: {
          leaseId: LEASE_ID,
          attemptLeaseId: LEASE_ID,
          slug: "session-fixture",
          resourceId: "sandbox-original",
        },
        computeWindow: {
          id: "initial",
          authorizedAt: new Date(NOW).toISOString(),
          expiresAt: new Date(NOW + 600_000).toISOString(),
          state: "active",
        },
        operation: undefined as
          | (WorkerRetentionOperation & { phase: "pending" | "observed" })
          | undefined,
      },
    };
  }
  function retainedScenario(inspectReady?: () => boolean) {
    const document = view();
    let loseReply = false;
    let deleted = false;
    let optimisticReply = false;
    let windows = 1;
    const fixture = createWarmProvider(({ argv }) => {
      if (argv[1] === "providers") {
        return jsonResult(catalog);
      }
      if (argv[1] === "inspect") {
        if (inspectReady) {
          document.ready = inspectReady();
        }
        return deleted
          ? commandResult({ code: 4, stderr: "Lease " + LEASE_ID + " not found" })
          : jsonResult(document);
      }
      if (argv[1] === "pause" || argv[1] === "resume") {
        const read = (name: string) => argv[argv.indexOf(name) + 1]!;
        const operation: WorkerRetentionOperation = {
          id: read("--operation-id"),
          action: argv[1],
          expectedClaimRevision: read("--expected-claim-revision"),
        };
        if (document.retention.operation?.id !== operation.id) {
          document.retention.operation = { ...operation, phase: "observed" };
          document.retention.claimRevision = "revision-" + operation.id;
          document.retention.desiredState = operation.action === "pause" ? "suspended" : "running";
          document.state = document.retention.desiredState;
          document.retention.observedState = operation.action === "pause" ? "Suspended" : "Running";
          document.ready = operation.action === "resume";
          document.retention.computeWindow.state =
            operation.action === "pause" ? "closed" : "active";
          if (operation.action === "resume") {
            windows++;
            document.retention.computeWindow = {
              id: operation.id,
              authorizedAt: new Date(NOW).toISOString(),
              expiresAt: new Date(NOW + 600_000).toISOString(),
              state: "active",
            };
          }
        }
        if (loseReply) {
          loseReply = false;
          return commandResult({ code: 4, stderr: "readback reply lost" });
        }
        const result = jsonResult(document);
        if (optimisticReply) {
          document.retention.operation!.phase = "pending";
        }
        return result;
      }
      return undefined;
    });
    const lease = {
      leaseId: LEASE_ID,
      profile: retainedProfile,
      retention: policy,
      resourceReceipt: retainedReceipt,
      assertCurrent() {},
    };
    return {
      ...fixture,
      document,
      lease,
      deleted: () => {
        deleted = true;
      },
      loseReply: () => {
        loseReply = true;
      },
      optimisticReply: () => {
        optimisticReply = true;
      },
      windows: () => windows,
      set: (operation: WorkerRetentionOperation) =>
        fixture.provider.setRetainedState!({ ...lease, operation }),
      provision: (retention = policy) =>
        provisionWarmProfile(fixture.provider, retainedProfile, undefined, undefined, {
          retention,
          recordResourceReceipt: async () => {},
        }),
    };
  }
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });

  it.each([false, true])(
    "polls pending readiness without reopening compute on provisioning replay=%s",
    async (replay) => {
      let inspections = 0;
      const s = retainedScenario(() => ++inspections > 1);
      const result = await provisionWarmProfile(s.provider, retainedProfile, undefined, undefined, {
        retention: policy,
        ...(replay ? { resourceReceipt: retainedReceipt } : {}),
        recordResourceReceipt: async () => {},
        assertCurrent: () => {
          if (s.calls.some(({ argv }) => argv[1] === "run")) {
            expect(inspections).toBeGreaterThan(1);
          }
        },
      });
      expect(result.resourceReceipt).toEqual(retainedReceipt);
      expect(inspections).toBeGreaterThan(1);
      expect(
        s.calls.some(({ argv }) => ["resume", "pause", "heartbeat", "stop"].includes(argv[1]!)),
      ).toBe(false);
    },
  );

  it("replays exact retained deletion even when live inspection no longer recognizes the lease", async () => {
    const s = retainedScenario();
    await s.provider.destroy(s.lease);
    s.deleted();
    await s.provider.destroy(s.lease);
    expect(s.calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(2);
    expect(s.calls.filter(({ argv }) => argv[1] === "inspect")).toHaveLength(2);
  });

  it("prepares immutable policy before allocation and sends the released retention flags without renewal", async () => {
    const s = retainedScenario();
    const input = { ...policy };
    const prepared = await s.provider.prepareProvision!(retainedProfile, OPERATION_ID, {
      retention: input,
      assertCurrent() {},
      recordResourceReceipt: async () => {},
    });
    expect(s.calls.map(({ argv }) => argv[1])).toEqual(["providers"]);
    input.ownerBinding = "b".repeat(64);
    input.computeWindowSeconds = 1200;
    // Missing enrollment is intentional: the allocation boundary and exact cleanup still execute.
    await expect(prepared()).rejects.toThrow("enrollment is unavailable");
    const warmup = s.calls.find(({ argv }) => argv[1] === "warmup")!.argv;
    expect(warmup).toContain("/fixture/managed-crabbox");
    expect(
      warmup.slice(
        warmup.indexOf("--azure-sandbox-retention"),
        warmup.indexOf("--azure-sandbox-retention") + 4,
      ),
    ).toEqual([
      "--azure-sandbox-retention",
      "session-disk",
      "--azure-sandbox-owner-binding",
      "a".repeat(64),
    ]);
    expect(warmup[warmup.indexOf("--ttl") + 1]).toBe("600s");
    expect(s.calls.some(({ argv }) => argv[1] === "heartbeat")).toBe(false);
  });

  it.each(["session-disk-retention-v1", "pause-resume"])(
    "refuses missing executable capability %s before allocation",
    async (missing) => {
      const { provider, calls } = createWarmProvider(({ argv }) =>
        argv[1] === "providers"
          ? jsonResult([
              {
                ...catalog[0],
                features: catalog[0]!.features.filter((feature) => feature !== missing),
              },
            ])
          : undefined,
      );
      await expect(
        provisionWarmProfile(provider, retainedProfile, undefined, undefined, {
          retention: policy,
          recordResourceReceipt: async () => {},
        }),
      ).rejects.toThrow("does not advertise");
      expect(calls.map(({ argv }) => argv[1])).toEqual(["providers"]);
    },
  );

  it.each([{ provider: "aws" }, { target: "macos" }, { warmImage: true }])(
    "refuses ineligible acquisition %j before commands",
    async (settings) => {
      const s = retainedScenario();
      await expect(
        provisionWarmProfile(
          s.provider,
          { ...retainedProfile, ...settings },
          undefined,
          undefined,
          {
            retention: policy,
            recordResourceReceipt: async () => {},
          },
        ),
      ).rejects.toThrow("session disk retention requires");
      expect(s.calls).toEqual([]);
    },
  );

  it("pauses and resumes through exact CLI preconditions and independent inspection", async () => {
    const s = retainedScenario();
    const lease = await s.provision();
    expect(lease.resourceReceipt).toEqual(retainedReceipt);
    const paused = await s.set({
      id: "pause-1",
      action: "pause",
      expectedClaimRevision: "revision-1",
    });
    expect(paused.state).toBe("suspended");
    const resumed = await s.set({
      id: "resume-1",
      action: "resume",
      expectedClaimRevision: "revision-pause-1",
    });
    expect(resumed).toEqual({
      claimRevision: "revision-resume-1",
      state: "running",
      computeExpiresAtMs: NOW + 600_000,
      operation: {
        id: "resume-1",
        action: "resume",
        expectedClaimRevision: "revision-pause-1",
        phase: "observed",
      },
    });
    const actions = s.calls.filter(({ argv }) => ["pause", "resume"].includes(argv[1]!));
    expect(actions[1]!.argv).toEqual([
      "/fixture/managed-crabbox",
      "resume",
      "--provider",
      "azure-sandbox",
      "--id",
      LEASE_ID,
      "--operation-id",
      "resume-1",
      "--owner-binding",
      "a".repeat(64),
      "--expected-claim-revision",
      "revision-pause-1",
      "--expected-provider-lease-id",
      LEASE_ID,
      "--expected-provider-attempt-lease-id",
      LEASE_ID,
      "--expected-provider-slug",
      "session-fixture",
      "--expected-provider-resource-id",
      "sandbox-original",
      "--json",
    ]);
    expect(s.calls.slice(-3).map(({ argv }) => argv[1])).toEqual(["inspect", "resume", "inspect"]);
    vi.spyOn(Date, "now").mockReturnValue(NOW + 100_000);
    await expect(s.provider.inspect(s.lease)).resolves.toMatchObject({
      status: "active",
      retention: { computeExpiresAtMs: NOW + 600_000 },
    });
    vi.spyOn(Date, "now").mockReturnValue(NOW + 600_000);
    await expect(s.provider.inspect(s.lease)).resolves.toMatchObject({
      status: "dormant",
      retention: { state: "expired", computeExpiresAtMs: NOW + 600_000 },
    });
    expect(s.calls.some(({ argv }) => argv[1] === "heartbeat")).toBe(false);
    await s.provider.destroy(s.lease);
    const stop = s.calls.find(({ argv }) => argv[1] === "stop")!.argv;
    expect(stop[stop.indexOf("--expected-provider-resource-id") + 1]).toBe("sandbox-original");
  });

  it("keeps the same operation and finite window after a lost resume reply", async () => {
    const s = retainedScenario();
    await s.set({ id: "pause-1", action: "pause", expectedClaimRevision: "revision-1" });
    const operation: WorkerRetentionOperation = {
      id: "resume-1",
      action: "resume",
      expectedClaimRevision: "revision-pause-1",
    };
    s.loseReply();
    await expect(s.set(operation)).rejects.toThrow("reply lost");
    await expect(s.set(operation)).resolves.toMatchObject({
      state: "running",
      operation: { ...operation, phase: "observed" },
    });
    const resumes = s.calls.filter(({ argv }) => argv[1] === "resume");
    expect(resumes).toHaveLength(2);
    expect(resumes[1]!.argv).toEqual(resumes[0]!.argv);
    expect(s.windows()).toBe(2);
  });

  it("does not accept an optimistic command reply over pending independent readback", async () => {
    const s = retainedScenario();
    s.optimisticReply();
    await expect(
      s.set({ id: "pause-1", action: "pause", expectedClaimRevision: "revision-1" }),
    ).rejects.toThrow("readback remains uncertain");
    expect(s.document.retention.operation).toEqual({
      id: "pause-1",
      action: "pause",
      expectedClaimRevision: "revision-1",
      phase: "pending",
    });
    expect(s.calls.some(({ argv }) => argv[1] === "stop")).toBe(false);
  });

  it.each(["replacement", "binding"])("refuses %s before mutation or deletion", async (failure) => {
    const s = retainedScenario();
    if (failure === "replacement") {
      s.document.serverId = "replacement";
    } else {
      s.document.retention.ownerBinding = "b".repeat(64);
    }
    await expect(s.provider.inspect(s.lease)).rejects.toThrow();
    await expect(
      s.set({ id: "pause-1", action: "pause", expectedClaimRevision: "revision-1" }),
    ).rejects.toThrow();
    await expect(s.provider.destroy(s.lease)).rejects.toThrow();
    expect(
      s.calls.some(({ argv }) => ["pause", "resume", "stop", "heartbeat"].includes(argv[1]!)),
    ).toBe(false);
  });

  it.each([
    ["unknown", "unavailable"],
    ["compute-expired", "expired"],
    ["transitioning", "transitioning"],
    ["suspended", "suspended"],
  ])("retains custody for %s without claiming destruction", async (state, normalized) => {
    const s = retainedScenario();
    s.document.state = state!;
    if (state === "suspended") {
      s.document.retention.observedState = "Suspended";
    }
    s.document.ready = false;
    if (state === "unknown") {
      s.document.retention.policyVerified = false;
      s.document.labels = { crabbox_lease: "", crabbox_attempt: "", crabbox_fingerprint: "" };
    }
    const observed = await s.provider.inspect(s.lease);
    expect(observed).toMatchObject({
      status: "dormant",
      resourceReceipt: retainedReceipt,
      retention: { state: normalized, computeExpiresAtMs: NOW + 600_000 },
    });
    expect(s.calls.map(({ argv }) => argv[1])).toEqual(["inspect"]);
  });

  it.each([
    "schema",
    "identity",
    "ownerBinding",
    "computeWindowSeconds",
    "desiredState",
    "computeWindow",
    "claimRevision",
    "policyVerified",
    "observedState",
    "stopPending",
  ])("rejects incomplete retained %s rather than qualifying active compute", async (field) => {
    const s = retainedScenario();
    Reflect.deleteProperty(s.document.retention, field);
    await expect(s.provider.inspect(s.lease)).rejects.toThrow();
    expect(s.calls.map(({ argv }) => argv[1])).toEqual(["inspect"]);
  });

  it("fences an apparently running resource without independent policy verification", async () => {
    const s = retainedScenario();
    s.document.retention.policyVerified = false;
    await expect(s.provider.inspect(s.lease)).resolves.toMatchObject({
      status: "dormant",
      retention: { state: "unavailable" },
      resourceReceipt: retainedReceipt,
    });
    await expect(
      s.set({ id: "pause-1", action: "pause", expectedClaimRevision: "revision-1" }),
    ).rejects.toThrow("ownership is unavailable");
    expect(
      s.calls.some(({ argv }) => ["pause", "resume", "stop", "heartbeat"].includes(argv[1]!)),
    ).toBe(false);
  });
});
