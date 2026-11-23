import { expect, it, vi } from "vitest";
import { createNodeBootstrapFixture } from "./crabbox-worker-node-enrollment.test-support.js";
import { operationLeaseId } from "./crabbox-worker-profile.js";
import {
  catalogJson,
  classProfile,
  commandResult,
  createProviderTestHarness,
  nodeEnrollmentFixture,
} from "./crabbox-worker-provider.test-support.js";

// mock-isolation: Exercise provider sizing without downloading or allocating a worker.
vi.mock("./crabbox-managed-binary.js", () => ({ ensureManagedCrabboxBinary: vi.fn() }));
const { createProvider } = createProviderTestHarness({}, "crabbox-sizing-");

it("advertises and allocates Sandbox native types without changing generic class sizes", async () => {
  const calls: string[][] = [];
  const operationId = `provision:v2:${"0".repeat(64)}`;
  const leaseId = operationLeaseId(operationId);
  const provider = createProvider({
    runCommand: async (argv) => {
      calls.push(argv);
      if (argv[1] === "providers") {
        return commandResult({
          stdout: catalogJson(
            "azure-sandbox",
            ["linux"],
            [classProfile("small", { vcpu: 2, memory: { value: 4, unit: "GiB" } })],
          ),
        });
      }
      if (argv[1] === "config") {
        return commandResult({ stdout: "{}" });
      }
      if (argv[1] === "inspect") {
        return commandResult({
          stdout: JSON.stringify({
            id: leaseId,
            provider: "azure-sandbox",
            state: "running",
            ready: true,
            serverId: "sizing-sandbox",
            slug: "sizing-fixture",
            labels: {
              crabbox_lease: leaseId,
              crabbox_attempt: "sizing-attempt",
              crabbox_fingerprint: "sizing-fingerprint",
            },
          }),
        });
      }
      return commandResult();
    },
  });
  const profile = {
    ttl: "24h",
    idleTimeout: "60m",
    provider: "azure-sandbox",
    type: "4cpu-8gib",
    warmImage: false,
  };
  expect(await provider.listMachineOptions?.(profile)).toEqual([
    { id: "0.25cpu-0.5gib", os: "linux", label: "XS · 0.25 CPU / 0.5 GiB / 5 GiB disk" },
    { id: "0.5cpu-1gib", os: "linux", label: "S · 0.5 CPU / 10 GiB disk", memoryGb: 1 },
    { id: "1cpu-2gib", os: "linux", label: "M · 20 GiB disk", cpu: 1, memoryGb: 2 },
    { id: "2cpu-4gib", os: "linux", label: "L · 40 GiB disk", cpu: 2, memoryGb: 4 },
    {
      id: "4cpu-8gib",
      os: "linux",
      label: "XL · 80 GiB disk",
      cpu: 4,
      memoryGb: 8,
      default: true,
    },
    {
      id: "8cpu-16gib",
      os: "linux",
      label: "2XL · 160 GiB disk",
      cpu: 8,
      memoryGb: 16,
    },
    {
      id: "16cpu-32gib",
      os: "linux",
      label: "3XL · 320 GiB disk",
      cpu: 16,
      memoryGb: 32,
    },
  ]);
  const { type: _type, ...generic } = profile;
  const legacy = await provider.listMachineOptions?.({
    ...generic,
    class: "small",
  });
  expect(legacy?.map(({ id }) => id)).toEqual([
    "0.25cpu-0.5gib",
    "0.5cpu-1gib",
    "1cpu-2gib",
    "2cpu-4gib",
    "4cpu-8gib",
    "8cpu-16gib",
    "16cpu-32gib",
  ]);
  expect(legacy?.find((option) => option.default)?.id).toBe("2cpu-4gib");
  await provider.provision(profile, operationId, {
    recordResourceReceipt: async () => {},
    assertCurrent: () => {},
    nodeRuntimeIdentity: {
      nodeBootstrapSha256: createNodeBootstrapFixture().sha256,
      executionMode: "worker-turn",
    },
    beginNodeEnrollment: async () => nodeEnrollmentFixture("fixture-setup", "Sizing worker"),
  });
  const warmup = calls.find((argv) => argv[1] === "warmup")!;
  expect(warmup.slice(warmup.indexOf("--type"), warmup.indexOf("--type") + 2)).toEqual([
    "--type",
    "4cpu-8gib",
  ]);
  expect(warmup).not.toContain("--class");
  expect(provider.resolveExecMemoryBoundary?.(profile)).toBe("sandbox");
  expect(
    provider.resolveExecMemoryBoundary?.({ provider: "aws", ttl: "24h", idleTimeout: "60m" }),
  ).toBeUndefined();
});
