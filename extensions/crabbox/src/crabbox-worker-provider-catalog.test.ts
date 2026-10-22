import path from "node:path";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import { expect, it, vi } from "vitest";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import {
  catalogJson,
  classProfile,
  commandResult,
  createProviderTestHarness,
  mappedCatalog,
  OPENCLAW_ROOT,
} from "./crabbox-worker-provider.test-support.js";
import {
  CRABBOX_LIFECYCLE_TIMEOUT_MS,
  CRABBOX_MACHINE_CATALOG_TIMEOUT_MS,
} from "./crabbox-worker-timeouts.js";

// mock-isolation: Exercise catalog discovery without downloading or executing a managed binary.
vi.mock("./crabbox-managed-binary.js", () => ({ ensureManagedCrabboxBinary: vi.fn() }));

const CLASSLESS_PROFILE = { provider: "aws", ttl: "24h", idleTimeout: "60m" };
const PROFILE = { ...CLASSLESS_PROFILE, class: "standard", warmImage: false };
const { createProvider } = createProviderTestHarness(
  {
    isExecutable: (candidate) =>
      candidate === path.resolve(OPENCLAW_ROOT, "../crabbox/bin/crabbox"),
  },
  "openclaw-crabbox-catalog-",
);

it("projects a large catalog by OS and architecture without inferring resources", async () => {
  const runCommand = vi.fn<CrabboxCommandRunner>(async (_argv, options) =>
    processRuntime.runCommandWithTimeout(
      [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
      {
        ...options,
        input: JSON.stringify([
          {
            provider: "unrelated",
            targets: ["linux"],
            classCatalog: { metadata: "x".repeat(65_536) },
          },
          {
            provider: "aws",
            targets: ["windows/normal", "linux", "windows/wsl2", "macos"],
            classCatalog: mappedCatalog([
              classProfile("standard", { vcpu: 64 }, { architecture: "arm64" }),
              classProfile("memory", { memory: { value: 16, unit: "GB" } }),
              classProfile(
                "standard",
                { vcpu: 8, memory: { value: 32, unit: "GiB" } },
                { fallbacks: [{ vcpu: 99, memory: { value: 99, unit: "GB" } }] },
              ),
              classProfile("unknown", { memory: { value: 16384, unit: "MiB" } }),
              classProfile("standard", { vcpu: 99 }),
              classProfile("standard", { vcpu: 4 }, { target: "windows", windowsMode: "wsl2" }),
              classProfile(
                "standard",
                { vcpu: 16 },
                { target: "windows", windowsMode: "normal", architecture: "arm64" },
              ),
              classProfile("standard", { vcpu: 8 }, { target: "windows", windowsMode: "normal" }),
              classProfile("standard", {}, { target: "macos", architecture: "mixed" }),
            ]),
            classes: [{ class: "standard", vcpu: 128 }],
          },
          {
            provider: "machine0",
            targets: ["linux"],
            classCatalog: { disposition: "unmapped", profiles: [classProfile("standard")] },
          },
        ]),
      },
    ),
  );
  const provider = createProvider({ runCommand });
  expect(await provider.listOperatingSystems?.(PROFILE)).toEqual([
    { id: "linux", label: "Linux", default: true },
    { id: "windows/wsl2", label: "Windows (WSL2)" },
    { id: "windows/normal", label: "Windows" },
    { id: "macos", label: "macOS" },
  ]);
  expect(await provider.listMachineOptions?.(PROFILE)).toEqual([
    { os: "linux", id: "memory", label: "Memory", memoryGb: 16 },
    { os: "linux", id: "standard", label: "Standard", cpu: 8, memoryGb: 32, default: true },
    { os: "linux", id: "unknown", label: "Unknown" },
    { os: "windows/wsl2", id: "standard", label: "Standard", cpu: 4, default: true },
    { os: "windows/normal", id: "standard", label: "Standard", cpu: 8, default: true },
    { os: "macos", id: "standard", label: "Standard", default: true },
  ]);
  expect(await provider.listMachineOptions?.({ ...PROFILE, provider: "machine0" })).toEqual([]);
  expect(await provider.listMachineOptions?.({ ...PROFILE, provider: "missing" })).toEqual([]);
  expect(runCommand).toHaveBeenCalledTimes(1);
});

it("bounds catalogs while reserving the configured class", async () => {
  const configuredClass = "custom";
  const provider = createProvider({
    runCommand: async () =>
      commandResult({
        stdout: catalogJson(
          "aws",
          ["linux", "windows/wsl2"],
          [
            classProfile("x".repeat(129)),
            ...Array.from({ length: 80 }, (_, index) =>
              classProfile(`class-${String(index).padStart(2, "0")}`, {
                vcpu: index === 0 ? 0 : index + 1,
                memory: { value: index === 0 ? 1.5 : (index + 1) * 2, unit: "GB" },
              }),
            ),
            classProfile("standard", {}, { target: "windows", windowsMode: "wsl2" }),
          ],
        ),
      }),
  });
  const options = await provider.listMachineOptions?.({
    ...CLASSLESS_PROFILE,
    class: configuredClass,
  });
  expect(options).toHaveLength(64);
  expect(options?.[0]).toEqual({ os: "linux", id: "class-00", label: "Class-00" });
  expect(options?.at(-1)).toEqual({ os: "linux", id: "custom", label: "custom", default: true });
  expect(options?.filter((option) => option.default).map((option) => option.id)).toEqual([
    "custom",
  ]);
});

it.each([
  ["timeout", commandResult({ code: null, termination: "timeout", killed: true })],
  ["non-array", commandResult({ stdout: "{}" })],
] as const)("retries discovery after %s and caches recovery", async (_name, failure) => {
  const warn = vi.fn();
  const runCommand = vi
    .fn<CrabboxCommandRunner>()
    .mockImplementationOnce(async (_argv, options) => {
      expect(options.timeoutMs).toBe(CRABBOX_MACHINE_CATALOG_TIMEOUT_MS);
      expect(options.timeoutMs).toBeLessThan(CRABBOX_LIFECYCLE_TIMEOUT_MS);
      return failure;
    })
    .mockResolvedValue(
      commandResult({
        stdout: catalogJson("aws", ["linux"], [classProfile("standard", { vcpu: 8 })]),
      }),
    );
  const provider = createProvider({ runCommand, warn });
  expect(await provider.listMachineOptions?.(PROFILE)).toEqual([]);
  const recovered = [{ os: "linux", id: "standard", label: "Standard", cpu: 8, default: true }];
  expect(await provider.listMachineOptions?.(PROFILE)).toEqual(recovered);
  expect(await provider.listMachineOptions?.(PROFILE)).toEqual(recovered);
  expect(runCommand).toHaveBeenCalledTimes(2);
  expect(warn).toHaveBeenCalledTimes(1);
});

it.each([
  { provider: "aws" },
  {
    provider: "aws",
    targets: ["linux"],
    classCatalog: mappedCatalog([null, {}, classProfile(" "), classProfile("x".repeat(129))]),
  },
])("caches unusable catalog %j without warnings", async (entry) => {
  const warn = vi.fn();
  const runCommand = vi.fn(async () => commandResult({ stdout: JSON.stringify([entry]) }));
  const provider = createProvider({ runCommand, warn });
  expect(await provider.listMachineOptions?.(PROFILE)).toEqual([]);
  expect(await provider.listMachineOptions?.(PROFILE)).toEqual([]);
  expect(runCommand).toHaveBeenCalledTimes(1);
  expect(warn).not.toHaveBeenCalled();
});
