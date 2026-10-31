import type { WorkerResourceReceipt } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it } from "vitest";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import {
  createWarmProvider,
  provisionWarmProfile,
  LEASE_ID,
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
