import fs from "node:fs";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { type WorkerProfile, WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it, vi } from "vitest";
import { ensureManagedCrabboxBinary, type CrabboxBinary } from "./crabbox-managed-binary.js";
import { crabboxState } from "./crabbox-state.test-support.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import { createNodeBootstrapFixture } from "./crabbox-worker-node-enrollment.test-support.js";
import {
  OPERATION_ID,
  LEASE_ID,
  SIBLING_BINARY,
  INSPECT_FAILURE_PREFIX,
  CLASSLESS_PROFILE,
  PROFILE,
  NON_RUNNABLE_STATES,
  tempDirs,
  inspectJson,
  lifecycleLease,
  providerWithRawRunner,
  providerWithRunner,
  failedNodeEnrollment,
  heartbeatFixture,
} from "./crabbox-worker-provider-fixture.test-support.js";
import { createCrabboxWorkerProvider } from "./crabbox-worker-provider.js";
import {
  active,
  catalogJson,
  classProfile,
  commandResult,
  nodeEnrollmentFixture,
  WORKER_WALLPAPER_PATH,
  inspectCases,
  mappedCatalog,
} from "./crabbox-worker-provider.test-support.js";
import {
  CRABBOX_COMMAND_SETTLEMENT_TIMEOUT_MS,
  CRABBOX_LIFECYCLE_TIMEOUT_MS,
  CRABBOX_MACHINE_CATALOG_TIMEOUT_MS,
  CRABBOX_STOP_TIMEOUT_MS,
  resolveCrabboxProvisionBaseTimeoutMs,
} from "./crabbox-worker-timeouts.js";

vi.mock("./crabbox-managed-binary.js", () => ({
  ensureManagedCrabboxBinary: vi.fn(),
}));

describe("failed lease recovery hold", () => {
  it.each(["exact", "wrong operation", "authority lost"] as const)(
    "binds the legacy allocation operation to nondestructive held custody: %s",
    async (variant) => {
      const operationId =
        "provision:v2:009ef1cb84ac69801cf2a2b56bbd57008b418a2e0049b047dacbf1699f7c5366";
      const leaseId = "cbx_b409decfbde2";
      let current = true;
      const run = vi.fn<CrabboxCommandRunner>(async () => {
        if (variant === "authority lost") {
          current = false;
        }
        return commandResult({
          stdout: JSON.stringify({
            schema: "crabbox.lease-hold.v1",
            provider: "azure",
            status: "held",
            leaseId,
            unacceptedChanges: "unknown",
            resources: ["vm", "nic", "public-ip", "disk", "nsg"].map((kind) => ({
              kind,
              id: `/subscriptions/synthetic-fixture/resources/${kind}`,
              immutableId: `${kind}-observed`,
              state: kind === "vm" ? "absent" : "retained",
            })),
          }),
        });
      });
      const provider = providerWithRawRunner(run);
      const result = provider.holdFailedLease!(
        {
          leaseId,
          profile: { ...PROFILE, provider: "azure" },
          operationId: variant === "wrong operation" ? `${operationId}-other` : operationId,
        },
        {
          assertCurrent: () => {
            if (!current) {
              throw new Error("Original hold authority closed");
            }
          },
        },
      );
      if (variant === "exact") {
        await expect(result).resolves.toMatchObject({ status: "held", leaseId });
      } else {
        await expect(result).rejects.toThrow(
          variant === "wrong operation" ? "original fixed lease" : "authority closed",
        );
      }
      if (variant === "wrong operation") {
        expect(run).not.toHaveBeenCalled();
      } else {
        expect(run.mock.calls[0]?.[0]).toEqual([
          SIBLING_BINARY,
          "hold",
          "--provider",
          "azure",
          "--id",
          leaseId,
          "--slug",
          "openclaw-65b6a7f68571da432882f0015d600457",
          "--json",
        ]);
      }
    },
  );
  it.each([
    "settled",
    "wrong-lease",
    "unsupported",
    "duplicate",
    "truncated",
    "cancelled",
    "lost",
    "wrong-attempt",
    "pending",
    "malformed",
    "wrong-schema",
    "wrong-provider",
    "duplicate-property",
    "stdout-duplicate",
    "timeout",
    "unsettled-companions",
  ] as const)(
    "projects only an exact settled CLI shortage into provider capacity (%s)",
    async (change) => {
      // Synthetic process transport carrying the qualified fixed-allocation v1 wire.
      const wire = JSON.stringify({
        schema: change === "wrong-schema" ? "future-schema" : "crabbox.fixed-allocation-result.v1",
        capability: change === "unsupported" ? "future-capability" : "azure-fixed-vm-capacity-v1",
        provider: change === "wrong-provider" ? "aws" : "azure",
        leaseId: change === "wrong-lease" ? "cbx_other" : LEASE_ID,
        attemptName: change === "wrong-attempt" ? "" : "crabbox-fixture-01234567",
        attemptNonce: "ABCD1234",
        category: "capacity_shortage",
        providerCode: "AllocationFailed",
        allocation: change === "pending" ? "pending" : "settled_nonallocation",
        companions: change === "unsettled-companions" ? "unknown" : "settled",
      });
      const encoded =
        change === "duplicate-property"
          ? wire.replace('"provider":"azure"', '"provider":"aws","provider":"azure"')
          : wire;
      const frame = `crabbox-allocation-result ${change === "malformed" ? "{" : encoded}\n`;
      const runCommand = vi.fn<CrabboxCommandRunner>(async () =>
        commandResult({
          code: 1,
          stderr:
            change === "lost" ? "AllocationFailed" : change === "duplicate" ? frame + frame : frame,
          ...(change === "truncated" ? { stderrTruncatedBytes: 1 } : {}),
          ...(change === "cancelled" ? { killIssuedByAbort: true } : {}),
          ...(change === "stdout-duplicate" ? { stdout: frame } : {}),
          ...(change === "timeout" ? { termination: "timeout", code: null } : {}),
        }),
      );
      const provider = providerWithRawRunner(runCommand);
      const failure = await provider
        .provision({ ...PROFILE, provider: "azure" }, OPERATION_ID)
        .catch((error: unknown) => error);
      expect(WorkerProviderError.isCapacityShortage(failure)).toBe(change === "settled");
      if (WorkerProviderError.isCapacityShortage(failure)) {
        expect(failure.receipt).toEqual({
          operationId: OPERATION_ID,
          leaseId: LEASE_ID,
          attemptName: "crabbox-fixture-01234567",
          attemptNonce: "ABCD1234",
          providerCode: "AllocationFailed",
        });
        expect(runCommand).toHaveBeenCalledOnce();
      }
    },
  );
  it.each(["exact", "wrong-lease", "live-vm"] as const)(
    "accepts only an exact durable absent-VM receipt: %s",
    async (variant) => {
      const profile = { ...PROFILE, provider: "azure" };
      const resources = ["vm", "nic", "public-ip", "disk", "nsg"].map((kind) => ({
        kind,
        id: `/subscriptions/synthetic-fixture/resources/${kind}`,
        immutableId: `${kind}-original`,
        state: kind === "vm" && variant !== "live-vm" ? "absent" : "retained",
      }));
      const runCommand = vi.fn<CrabboxCommandRunner>(async () =>
        commandResult({
          stdout: JSON.stringify({
            schema: "crabbox.lease-hold.v1",
            provider: "azure",
            status: "held",
            leaseId: variant === "wrong-lease" ? "cbx_other" : LEASE_ID,
            unacceptedChanges: "unknown",
            resources,
          }),
        }),
      );
      const provider = providerWithRawRunner(runCommand);
      const result = provider.holdFailedLease!(lifecycleLease(LEASE_ID, profile), {
        assertCurrent: () => {},
      });
      if (variant === "exact") {
        await expect(result).resolves.toMatchObject({
          status: "held",
          leaseId: LEASE_ID,
          resources,
        });
      } else {
        await expect(result).rejects.toThrow(
          /exact failed-lease hold receipt|retained-resource identity/u,
        );
      }
      expect(runCommand).toHaveBeenCalledOnce();
      expect(runCommand.mock.calls[0]?.[0]).toEqual([
        SIBLING_BINARY,
        "hold",
        "--provider",
        "azure",
        "--id",
        LEASE_ID,
        "--json",
      ]);
    },
  );
});

describe("Crabbox worker provider", () => {
  it("uses the managed binary for discovery and the complete worker lifecycle", async () => {
    const managedBinary = path.resolve(path.sep, "managed", "crabbox");
    vi.mocked(ensureManagedCrabboxBinary).mockResolvedValue({
      binary: managedBinary,
      version: "999.0.0",
    });
    const runCommand = vi.fn<CrabboxCommandRunner>(async (argv) => {
      if (argv[1] === "providers") {
        return commandResult({
          stdout: catalogJson(
            "aws",
            ["linux", "windows/wsl2", "macos"],
            [classProfile("standard", { vcpu: 8 })],
          ),
        });
      }
      if (argv[1] === "config") {
        return commandResult({ stdout: JSON.stringify({ aws: { instanceProfile: "" } }) });
      }
      return commandResult({ stdout: argv[1] === "inspect" ? inspectJson() : "" });
    });
    const provider = providerWithRawRunner(runCommand);
    const profile = { ...PROFILE, binary: "/opt/old-crabbox" };

    expect(await provider.listOperatingSystems?.(profile)).toEqual([
      { id: "linux", label: "Linux", default: true },
      { id: "windows/wsl2", label: "Windows (WSL2)" },
      { id: "macos", label: "macOS" },
    ]);
    expect(await provider.listMachineOptions?.(profile)).toEqual([
      { id: "standard", label: "Standard", os: "linux", cpu: 8, default: true },
    ]);
    const lease = { ...(await provider.provision(profile, OPERATION_ID)), profile };
    expect(await provider.inspect(lease)).toEqual(active);
    await provider.destroy(lease);

    expect(runCommand.mock.calls.map(([argv]) => argv[1])).toEqual(
      expect.arrayContaining(["providers", "config", "warmup", "inspect", "run", "stop"]),
    );
    expect(runCommand.mock.calls.every(([argv]) => argv[0] === managedBinary)).toBe(true);
  });

  it("fails before allocation when managed acquisition fails and permits recovery", async () => {
    const acquisitionError = new Error("Crabbox release download failed");
    vi.mocked(ensureManagedCrabboxBinary).mockRejectedValueOnce(acquisitionError);
    const runCommand = vi.fn<CrabboxCommandRunner>(async (argv) =>
      commandResult({ stdout: argv[1] === "inspect" ? inspectJson() : "" }),
    );
    const provider = providerWithRunner(runCommand);
    const beginNodeEnrollment = vi.fn();

    await expect(provider.provision(PROFILE, OPERATION_ID, { beginNodeEnrollment })).rejects.toBe(
      acquisitionError,
    );
    expect(runCommand).not.toHaveBeenCalled();
    expect(beginNodeEnrollment).not.toHaveBeenCalled();

    const lease = await provider.provision(PROFILE, OPERATION_ID);
    expect(lease.leaseId).toBe(LEASE_ID);
    await provider.destroy({ ...lease, profile: PROFILE });
  });

  it("does not allocate after cancellation during managed binary acquisition", async () => {
    const acquisitionStarted = createDeferred<void>();
    const acquisition = createDeferred<CrabboxBinary>();
    vi.mocked(ensureManagedCrabboxBinary).mockImplementation(() => {
      acquisitionStarted.resolve();
      return acquisition.promise;
    });
    const runCommand = vi.fn<CrabboxCommandRunner>(async () => commandResult());
    const provider = providerWithRawRunner(runCommand);
    const controller = new AbortController();
    const beginNodeEnrollment = vi.fn();
    const provision = provider.provision(PROFILE, OPERATION_ID, {
      beginNodeEnrollment,
      signal: controller.signal,
    });
    const rejected = expect(provision).rejects.toMatchObject({ name: "AbortError" });

    await acquisitionStarted.promise;
    controller.abort();
    acquisition.resolve({
      binary: path.resolve(path.sep, "managed", "crabbox"),
      version: "999.0.0",
    });
    await rejected;

    expect(runCommand).not.toHaveBeenCalled();
    expect(beginNodeEnrollment).not.toHaveBeenCalled();
  });

  it.each([
    { configured: "windows/wsl2", requested: "linux" },
    { configured: undefined, requested: "windows/wsl2" },
    { configured: "windows/normal", requested: undefined },
    { configured: undefined, requested: "macos" },
  ])(
    "allocates the resolved OS (configured=$configured, requested=$requested)",
    async ({ configured, requested }) => {
      const calls: string[][] = [];
      const provider = providerWithRunner(async (argv) => {
        calls.push(argv);
        return commandResult({
          stdout: argv[1] === "inspect" ? inspectJson() : "",
        });
      });
      const profile = { ...PROFILE, ...(configured ? { target: configured } : {}) };
      const lease = await provider.provision(profile, OPERATION_ID, { os: requested });
      await provider.destroy({ ...lease, profile });
      const warmup = calls.find((argv) => argv[1] === "warmup")!;
      const resolved = requested ?? configured;
      if (resolved === "windows/wsl2" || resolved === "windows/normal") {
        expect(warmup.slice(warmup.indexOf("--target"), warmup.indexOf("--target") + 4)).toEqual([
          "--target",
          "windows",
          "--windows-mode",
          resolved === "windows/wsl2" ? "wsl2" : "normal",
        ]);
      } else if ((requested ?? configured) === "macos") {
        expect(warmup.slice(warmup.indexOf("--target"), warmup.indexOf("--target") + 4)).toEqual([
          "--target",
          "macos",
          "--market",
          "on-demand",
        ]);
        expect(warmup).not.toContain("--windows-mode");
      } else {
        expect(warmup.join(" ")).toContain("--target linux");
        expect(warmup).not.toContain("--windows-mode");
      }
    },
  );

  it.each(["windows/wsl2"])("keeps %s cold with Linux warm images enabled", async (target) => {
    const runCommand = vi.fn(async () => commandResult());
    const provider = providerWithRunner(runCommand);
    for (const [profile, options] of [
      [{ ...PROFILE, warmImage: true, target }, undefined],
      [{ ...PROFILE, warmImage: true }, { os: target }],
    ] as const) {
      expect(provider.supportsProjectPreparation?.(profile, "standard", options?.os)).toBe(false);
    }
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("explains the upstream WSL2 desktop limitation before allocating", async () => {
    const runCommand = vi.fn(async () => commandResult());
    const provider = providerWithRunner(runCommand);
    for (const [profile, options] of [
      [{ ...PROFILE, desktop: true, target: "windows/wsl2" }, undefined],
      [{ ...PROFILE, desktop: true }, { os: "windows/wsl2" }],
    ] as const) {
      await expect(provider.provision(profile, OPERATION_ID, options)).rejects.toThrow(
        "select native Windows for a desktop viewer",
      );
    }
    expect(runCommand).not.toHaveBeenCalled();
  });

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
                  {
                    fallbacks: [{ vcpu: 99, memory: { value: 99, unit: "GB" } }],
                  },
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
    const provider = providerWithRunner(runCommand);
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

  it.each(["custom", undefined])(
    "bounds catalogs while reserving configured class %s",
    async (configuredClass) => {
      const provider = providerWithRunner(async () =>
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
      );
      const options = await provider.listMachineOptions?.({
        ...CLASSLESS_PROFILE,
        ...(configuredClass ? { class: configuredClass } : {}),
      });
      expect(options).toHaveLength(64);
      expect(options?.[0]).toEqual({ os: "linux", id: "class-00", label: "Class-00" });
      expect(options?.at(-1)).toEqual(
        configuredClass
          ? { os: "linux", id: "custom", label: "custom", default: true }
          : { os: "linux", id: "class-63", label: "Class-63", cpu: 64, memoryGb: 128 },
      );
      expect(options?.filter((option) => option.default).map((option) => option.id)).toEqual(
        configuredClass ? ["custom"] : [],
      );
    },
  );

  it.each([
    {
      name: "throw",
      fail: () => {
        throw new Error("missing binary");
      },
    },
    { name: "exit", fail: () => commandResult({ code: 2 }) },
    {
      name: "timeout",
      fail: () => commandResult({ code: null, termination: "timeout", killed: true }),
    },
    { name: "non-array", fail: () => commandResult({ stdout: "{}" }) },
  ])("retries discovery after $name and caches recovery", async ({ fail }) => {
    const warn = vi.fn();
    const runCommand = vi
      .fn<CrabboxCommandRunner>()
      .mockImplementationOnce(async (_argv, options) => {
        expect(options.timeoutMs).toBe(CRABBOX_MACHINE_CATALOG_TIMEOUT_MS);
        expect(options.timeoutMs).toBeLessThan(CRABBOX_LIFECYCLE_TIMEOUT_MS);
        return fail();
      })
      .mockResolvedValue(
        commandResult({
          stdout: catalogJson("aws", ["linux"], [classProfile("standard", { vcpu: 8 })]),
        }),
      );
    const provider = providerWithRawRunner(runCommand, warn);
    expect(await provider.listMachineOptions?.(PROFILE)).toEqual([]);
    const recovered = [{ os: "linux", id: "standard", label: "Standard", cpu: 8, default: true }];
    expect(await provider.listMachineOptions?.(PROFILE)).toEqual(recovered);
    expect(await provider.listMachineOptions?.(PROFILE)).toEqual(recovered);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { provider: "aws" },
    { provider: "aws", targets: ["linux"], classCatalog: { disposition: "mapped" } },
    {
      provider: "aws",
      targets: ["linux"],
      classCatalog: mappedCatalog([null, {}, classProfile(" "), classProfile("x".repeat(129))]),
    },
  ])("caches unusable catalog %j without warnings", async (entry) => {
    const warn = vi.fn();
    const runCommand = vi.fn(async () => commandResult({ stdout: JSON.stringify([entry]) }));
    const provider = providerWithRunner(runCommand, warn);
    expect(await provider.listMachineOptions?.(PROFILE)).toEqual([]);
    expect(await provider.listMachineOptions?.(PROFILE)).toEqual([]);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "non-PNG bytes",
      bytes: Buffer.from("not a PNG"),
      message: "Crabbox worker wallpaper is not a PNG",
    },
    {
      name: "wrong PNG dimensions",
      bytes: (() => {
        const bytes = fs.readFileSync(WORKER_WALLPAPER_PATH);
        bytes.writeUInt32BE(1023, 16);
        return bytes;
      })(),
      message: "Crabbox worker wallpaper must be 1024x576; got 1023x576",
    },
  ])("rejects $name during provider registration", ({ bytes, message }) => {
    const tempDir = tempDirs.make("openclaw-crabbox-wallpaper-");
    const wallpaperPath = path.join(tempDir, "wallpaper.png");
    fs.writeFileSync(wallpaperPath, bytes);
    expect(() => createCrabboxWorkerProvider({ state: crabboxState, wallpaperPath })).toThrow(
      message,
    );
  });

  it("returns an enrolled node transport without command-line credentials", async () => {
    const calls: Array<{ argv: string[]; options: Parameters<CrabboxCommandRunner>[1] }> = [];
    const provider = providerWithRunner(async (argv, options) => {
      calls.push({ argv, options });
      return commandResult({ stdout: argv[1] === "inspect" ? inspectJson() : "" });
    });
    await expect(
      provider.provision(PROFILE, OPERATION_ID, { executionMode: "remote-exec" }),
    ).resolves.toEqual({ leaseId: LEASE_ID, node: { deviceId: "device-1" }, sharedHost: false });
    const enrollment = calls.find(({ argv }) => argv[1] === "run")!;
    expect(enrollment).toBeDefined();
    expect(String(enrollment.options.input)).toContain("--ephemeral");
    expect(String(enrollment.options.input)).not.toContain("secret-setup-value");
    expect(String(enrollment.options.input)).not.toContain("synthetic-bootstrap-token");
    expect(enrollment.argv).toContain("CRABBOX_WORKER_BOOTSTRAP_TOKEN");
    const argumentsUsed = calls.flatMap(({ argv }) => argv);
    for (const forbidden of ["remote-exec", "worker-turn", "ssh", "scp", "rsync"]) {
      expect(argumentsUsed).not.toContain(forbidden);
    }
  });

  it.each([
    {
      options: { executionMode: "unsupported" as never },
      message: "Crabbox execution mode is unsupported",
    },
    {
      options: { os: "windows/unknown" },
      message: "Crabbox target must be linux or windows/wsl2 or windows/normal or macos",
    },
    {
      options: { machineClass: "" },
      message: "Crabbox machine class must be a non-empty string of at most 128 characters",
    },
    {
      options: { machineClass: "x".repeat(129) },
      message: "Crabbox machine class must be a non-empty string of at most 128 characters",
    },
  ])("rejects invalid provision options %j before allocation", async ({ options, message }) => {
    const runCommand = vi.fn<CrabboxCommandRunner>();
    const provider = providerWithRunner(runCommand);
    await expect(provider.provision(PROFILE, OPERATION_ID, options)).rejects.toMatchObject({
      code: "invalid_profile",
      message,
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("forwards profile setup environment without widening node enrollment", async () => {
    const forwardedEnv = {
      OPENCLAW_WORKER_ARTIFACT_TOKEN: "fixture artifact #tag \"quoted\" \\path 'single'",
      CRABBOX_EMPTY_VALUE: "",
    };
    const enrollmentEnv = {
      CRABBOX_WORKER_BOOTSTRAP_TOKEN: JSON.stringify({
        nodeBootstrap: createNodeBootstrapFixture().token,
      }),
      CRABBOX_WORKER_SETUP_CODE: "secret-setup-value",
    };
    const setupEnv = Object.keys(forwardedEnv);
    vi.stubEnv("CRABBOX_ENV_ALLOW", "OPENCLAW_UNSELECTED_SECRET");
    vi.stubEnv("OPENCLAW_UNSELECTED_SECRET", "unselected-secret");
    for (const [name, value] of Object.entries(forwardedEnv)) {
      vi.stubEnv(name, value);
    }
    const calls: Array<{ argv: string[]; options: Parameters<CrabboxCommandRunner>[1] }> = [];
    const profileObservations = new Map<
      string,
      { directoryMode: number; fileMode: number; valuesMatch: boolean }
    >();
    const setup = "command -v node || install-node";
    const provider = providerWithRunner(async (argv, options) => {
      calls.push({ argv, options });
      if (argv[1] === "run") {
        const expectedEnv = options.input === setup ? forwardedEnv : enrollmentEnv;
        const profileFlagIndex = argv.indexOf("--env-from-profile");
        const profilePath = profileFlagIndex < 0 ? undefined : argv[profileFlagIndex + 1];
        if (profilePath) {
          const lines = fs.readFileSync(profilePath, "utf8").split("\n");
          profileObservations.set(profilePath, {
            directoryMode: fs.statSync(path.dirname(profilePath)).mode & 0o777,
            fileMode: fs.statSync(profilePath).mode & 0o777,
            valuesMatch: Object.entries(expectedEnv).every(([name, value]) =>
              lines.includes(`${name}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`),
            ),
          });
        }
        return commandResult();
      }
      return commandResult({ stdout: argv[1] === "inspect" ? inspectJson() : "" });
    });

    const profile = { ...PROFILE, setup, setupEnv };
    await expect(provider.provision(profile, OPERATION_ID)).resolves.toMatchObject({
      leaseId: LEASE_ID,
    });
    const [setupCall, enrollmentCall] = calls.filter((call) => call.argv[1] === "run");
    for (const [call, expectedEnv] of [
      [setupCall, forwardedEnv],
      [enrollmentCall, enrollmentEnv],
    ] as const) {
      if (!call) {
        throw new Error("missing setup command");
      }
      const profileFlagIndex = call.argv.indexOf("--env-from-profile");
      expect(profileFlagIndex).toBeGreaterThanOrEqual(0);
      const profilePath = call.argv[profileFlagIndex + 1];
      if (!profilePath) {
        throw new Error("missing private environment profile");
      }
      expect(profileObservations.get(profilePath)).toEqual({
        directoryMode: 0o700,
        fileMode: 0o600,
        valuesMatch: true,
      });
      expect(fs.existsSync(profilePath)).toBe(false);
      expect(fs.existsSync(path.dirname(profilePath))).toBe(false);
      for (const value of Object.values(expectedEnv).filter(Boolean)) {
        expect(call.argv.some((argument) => argument.includes(value))).toBe(false);
        expect(Object.values(call.options.env ?? {}).includes(value)).toBe(false);
      }
      expect(
        call.argv.filter((argument, index, argv) => argv[index - 1] === "--allow-env"),
      ).toEqual(Object.keys(expectedEnv));
      expect(call.options.env).toStrictEqual({
        ...Object.fromEntries(Object.keys(expectedEnv).map((name) => [name, undefined])),
        CRABBOX_ENV_ALLOW: ",",
      });
    }
    expect(setupCall?.argv).toEqual(
      expect.arrayContaining([
        "--network",
        "public",
        "--tailscale=false",
        "--id",
        LEASE_ID,
        "--keep=true",
        "--no-sync",
        "--script-stdin",
      ]),
    );
    expect(setupCall?.options.input).toBe(setup);
    expect(calls.filter((call) => call.argv[1] !== "run").every((call) => !call.options.env)).toBe(
      true,
    );
  });

  it("rejects a missing profile setup environment variable before invoking Crabbox", async () => {
    const missingName = "OPENCLAW_MISSING_WORKER_ARTIFACT_TOKEN";
    vi.stubEnv(missingName, undefined);
    const runCommand = vi.fn<CrabboxCommandRunner>();
    const provider = providerWithRawRunner(runCommand);

    await expect(
      provider.provision(
        { ...PROFILE, setup: "install-node", setupEnv: [missingName] },
        OPERATION_ID,
      ),
    ).rejects.toMatchObject({
      name: "Error",
      message: expect.stringContaining(missingName),
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a newline", value: "fixture\nvalue" },
    { name: "command substitution", value: "fixture$(value)" },
  ])(
    "rejects profile setup environment containing $name without exposing its value",
    async ({ value }) => {
      const envName = "OPENCLAW_WORKER_ARTIFACT_TOKEN";
      vi.stubEnv(envName, value);
      const calls: string[][] = [];
      const provider = providerWithRunner(async (argv) => {
        calls.push(argv);
        return argv[1] === "inspect" ? commandResult({ stdout: inspectJson() }) : commandResult();
      });

      const error = await provider
        .provision({ ...PROFILE, setup: "install-node", setupEnv: [envName] }, OPERATION_ID)
        .catch((cause: unknown) => cause);

      expect(error).toMatchObject({
        code: "cleanup_complete",
        message: `Crabbox setup environment value cannot be represented safely: ${envName}`,
      });
      expect(error instanceof Error && error.message.includes(value)).toBe(false);
      expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "stop"]);
    },
  );

  it("leaves a lease live when it disappears from post-setup inspection", async () => {
    const calls: string[][] = [];
    let inspections = 0;
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "warmup") {
        return commandResult();
      }
      if (argv[1] === "run" || argv[1] === "stop") {
        return commandResult();
      }
      inspections += 1;
      return inspections === 1
        ? commandResult({ stdout: inspectJson() })
        : commandResult({ code: 4, stderr: `lease/server not found: ${LEASE_ID}` });
    });

    await expect(
      provider.provision({ ...PROFILE, setup: "install-node" }, OPERATION_ID),
    ).rejects.toThrow("disappeared while waiting for SSH readiness");
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "run", "inspect"]);
  });

  it.each([
    {
      name: "fails",
      result: commandResult({ code: 7, stderr: "apt exploded" }),
      message: "Crabbox profile setup failed with exit code 7",
    },
    {
      name: "times out",
      result: commandResult({ code: null, killed: true, termination: "timeout" }),
      message: "Crabbox profile setup did not exit normally (timeout)",
    },
    {
      name: "cannot start",
      result: undefined,
      message: "Crabbox profile setup execution failed",
    },
  ])(
    "stops the lease and removes its private env profile when setup $name",
    async ({ result, message }) => {
      const envName = "OPENCLAW_WORKER_ARTIFACT_TOKEN";
      vi.stubEnv(envName, "fixture-artifact-token");
      const calls: string[][] = [];
      let profilePath: string | undefined;
      const provider = providerWithRunner(async (argv) => {
        calls.push(argv);
        if (argv[1] === "run") {
          const candidateProfilePath = argv[argv.indexOf("--env-from-profile") + 1];
          expect(candidateProfilePath).toBeDefined();
          if (!candidateProfilePath) {
            throw new Error("missing Crabbox environment profile path");
          }
          profilePath = candidateProfilePath;
          expect(fs.existsSync(profilePath)).toBe(true);
          if (!result) {
            throw new Error("spawn unavailable");
          }
          return result;
        }
        if (argv[1] === "stop") {
          return commandResult();
        }
        return commandResult({ stdout: argv[1] === "inspect" ? inspectJson() : "" });
      });

      const provisioning = provider.provision(
        { ...PROFILE, setup: "install-node", setupEnv: [envName] },
        OPERATION_ID,
      );
      if (result) {
        await expect(provisioning).rejects.toMatchObject({
          code: "cleanup_complete",
          message: expect.stringContaining(message),
        });
      } else {
        await expect(provisioning).rejects.toThrow(message);
      }
      expect(profilePath).toBeDefined();
      if (profilePath) {
        expect(fs.existsSync(profilePath)).toBe(false);
        expect(fs.existsSync(path.dirname(profilePath))).toBe(false);
      }
      expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
    },
  );

  it.each(["AWS"])(
    "rejects an effective %s instance profile during allocation-free preparation",
    async (backend) => {
      const calls: string[][] = [];
      const provider = providerWithRawRunner(async (argv) => {
        calls.push(argv);
        return commandResult({
          stdout: JSON.stringify({ aws: { instanceProfile: "worker-role" } }),
        });
      });
      await expect(
        provider.prepareProvision!({ ...PROFILE, provider: backend }, OPERATION_ID, {
          assertCurrent: () => {},
        }),
      ).rejects.toMatchObject({
        code: "invalid_profile",
        message: "Crabbox AWS instance profile must be empty for cloud workers",
      });
      expect(calls.map((argv) => argv[1])).toEqual(["config"]);
    },
  );

  it("waits for AWS metadata before enrollment", async () => {
    const calls: string[] = [];
    let inspections = 0;
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv[1]!);
      return commandResult({
        stdout:
          argv[1] === "inspect"
            ? inspectJson(++inspections === 1 ? { providerMetadata: undefined, ready: false } : {})
            : "",
      });
    });
    await expect(provider.provision(PROFILE, OPERATION_ID)).resolves.toMatchObject({
      leaseId: LEASE_ID,
    });
    expect(calls).toEqual(["warmup", "inspect", "inspect", "run"]);
  });

  it.each([
    {
      name: "pending forbidden AWS profile",
      inspect: inspectJson({ providerMetadata: { instanceProfileAttached: true }, ready: false }),
      message: "Crabbox AWS inspect must attest that no instance profile is attached",
    },
    {
      name: "ready AWS metadata absent",
      inspect: inspectJson({ providerMetadata: undefined }),
      message: "Crabbox AWS inspect must attest that no instance profile is attached",
    },
    {
      name: "malformed AWS metadata",
      inspect: inspectJson({ providerMetadata: { instanceProfileAttached: "no" } }),
      message: "Crabbox inspect returned invalid AWS instance profile metadata",
    },
    {
      name: "malformed Tailscale state",
      inspect: inspectJson({ tailscale: null }),
      message: "Crabbox inspect returned invalid Tailscale state",
    },
    { name: "invalid JSON", inspect: "{", message: "Crabbox inspect returned invalid JSON" },
    {
      name: "different lease",
      inspect: inspectJson({ id: "cbx_ffffffffffff" }),
      message: "Crabbox inspect returned a different lease id",
    },
    {
      name: "Tailscale enabled",
      inspect: inspectJson({ tailscale: { enabled: true } }),
      message: "Crabbox cloud worker lease must not have Tailscale enabled",
    },
    {
      name: "fresh post-setup AWS profile",
      inspect: inspectJson({ providerMetadata: { instanceProfileAttached: true }, ready: false }),
      message: "Crabbox AWS inspect must attest that no instance profile is attached",
      setup: "install-node",
    },
  ])("stops the fixed lease on $name", async ({ inspect, message, setup }) => {
    const calls: string[][] = [];
    let inspections = 0;
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      return commandResult({
        stdout:
          argv[1] === "inspect" ? (setup && inspections++ === 0 ? inspectJson() : inspect) : "",
      });
    });
    await expect(
      provider.provision({ ...PROFILE, ...(setup ? { setup } : {}) }, OPERATION_ID),
    ).rejects.toMatchObject({ code: "cleanup_complete", message });
    expect(calls.map((argv) => argv[1])).toEqual(
      setup ? ["warmup", "inspect", "run", "inspect", "stop"] : ["warmup", "inspect", "stop"],
    );
    expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  });

  it.each([
    {
      name: "direct",
      config: { coordinator: "", brokerMode: "managed" },
    },
    {
      name: "registered",
      config: {
        coordinator: "https://coordinator.example.test",
        brokerMode: "registered",
      },
    },
  ])("rejects a $name Hetzner desktop profile before allocation", async ({ config }) => {
    const calls: string[][] = [];
    const provider = providerWithRawRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "config" && argv[2] === "show") {
        return commandResult({ stdout: JSON.stringify(config) });
      }
      return commandResult();
    });

    await expect(
      provider.provision({ ...PROFILE, provider: "hetzner", desktop: true }, OPERATION_ID),
    ).rejects.toMatchObject({
      name: "Error",
      message: "Crabbox Hetzner desktop profiles require a managed coordinator",
    });
    expect(calls.map((argv) => argv[1])).toEqual(["config"]);
  });

  it("collects redacted node evidence before stopping an unenrolled lease", async () => {
    const calls: Array<{ argv: string[]; options: Parameters<CrabboxCommandRunner>[1] }> = [];
    const pairingSecret = "pairing-secret-value-0123456789";
    const provider = providerWithRunner(async (argv, options) => {
      calls.push({ argv, options });
      if (argv[1] === "inspect" || argv[1] === "status") {
        return commandResult({ stdout: inspectJson() });
      }
      if (argv[1] === "run" && String(options.input).includes("node.log tail:")) {
        return commandResult({
          stdout: [
            "node-runtime=installed-source-artifact node-pid=alive node.log tail:",
            "😀".repeat(800),
            `gateway rejected websocket upgrade (HTTP 403): proxy_attribution_required token=${pairingSecret}`,
          ].join(" "),
        });
      }
      return commandResult();
    });

    const originalError = new Error("Worker node did not connect before the enrollment deadline");
    const error = await provider
      .provision(PROFILE, OPERATION_ID, failedNodeEnrollment(originalError))
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      provisionError: { cause: originalError },
      message: expect.stringContaining(
        "Worker node did not connect before the enrollment deadline; box evidence: node-runtime=installed-source-artifact node-pid=alive node.log tail:",
      ),
    });
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("proxy_attribution_required");
    expect(message).not.toContain(pairingSecret);
    expect(Buffer.byteLength(message.split("; ")[1] ?? "", "utf8")).toBeLessThanOrEqual(2_048);
    expect(message).not.toMatch(/[\uD800-\uDFFF]/u);

    const diagnosticCall = calls.find(
      ({ argv, options }) => argv[1] === "run" && String(options.input).includes("node.log tail:"),
    );
    expect(diagnosticCall?.options.timeoutMs).toBe(60_000);
    expect(diagnosticCall?.options.env).toBeUndefined();
    expect(String(diagnosticCall?.options.input)).toContain(`cloud-workers/${LEASE_ID}`);
    expect(String(diagnosticCall?.options.input)).not.toContain("setup-code");
    expect(calls.slice(-2).map(({ argv }) => argv[1])).toEqual(["run", "stop"]);
  });

  it("preserves enrollment failure when diagnostic collection fails", async () => {
    const calls: string[] = [];
    const provider = providerWithRunner(async (argv, options) => {
      calls.push(argv[1]!);
      if (argv[1] === "run" && String(options.input).includes("node.log tail:")) {
        throw new Error("spawn failed token=diagnostic-secret-value-0123456789");
      }
      return commandResult({ stdout: argv[1] === "inspect" ? inspectJson() : "" });
    });
    const cause = new Error("Worker node did not connect before the enrollment deadline");
    await expect(
      provider.provision(PROFILE, OPERATION_ID, failedNodeEnrollment(cause)),
    ).rejects.toMatchObject({
      provisionError: { cause },
      message: expect.stringContaining(
        `${cause.message}; box evidence unavailable: Crabbox enrollment diagnostics execution failed: spawn failed token=`,
      ),
    });
    expect(calls.slice(-2)).toEqual(["run", "stop"]);
  });

  it.each(["preparation", "setup", "completion", "diagnostics"] as const)(
    "preserves its fixed lease when the Gateway aborts enrollment %s",
    async (phase) => {
      const calls: string[][] = [];
      const controller = new AbortController();
      const waitForDeviceId = vi.fn(async () => {
        if (phase === "diagnostics") {
          throw new Error("Worker node did not connect before the enrollment deadline");
        }
        controller.abort();
        controller.signal.throwIfAborted();
        return "device-bound";
      });
      const provider = providerWithRunner(async (argv, options) => {
        calls.push(argv);
        if (phase === "setup" && argv[1] === "run") {
          controller.abort();
          return commandResult();
        }
        if (
          phase === "diagnostics" &&
          argv[1] === "run" &&
          String(options.input).includes("node.log tail:")
        ) {
          controller.abort();
          return commandResult({ stdout: "node-runtime=absent node-pid=dead-or-absent" });
        }
        return argv[1] === "inspect" ? commandResult({ stdout: inspectJson() }) : commandResult();
      });

      await expect(
        provider.provision(PROFILE, OPERATION_ID, {
          beginNodeEnrollment: async () => {
            if (phase === "preparation") {
              controller.abort();
              controller.signal.throwIfAborted();
            }
            return {
              mode: "resume" as const,
              deviceId: "device-bound",
              openclawVersion: "2026.8.1",
              nodeBootstrap: createNodeBootstrapFixture(),
              displayName: "Bound worker",
              signal: controller.signal,
              waitForDeviceId,
            };
          },
        }),
      ).rejects.toMatchObject({ name: "AbortError" });

      expect(calls.some((argv) => argv[1] === "stop")).toBe(false);
      if (phase === "setup") {
        expect(waitForDeviceId).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { providerId: "aws", expectedIntervalMs: 2_000 },
    { providerId: "machine0", expectedIntervalMs: 60_000 },
  ])(
    "paces $providerId readiness re-inspection at $expectedIntervalMs ms",
    async ({ providerId, expectedIntervalMs }) => {
      let inspections = 0;
      const delays: number[] = [];
      const provider = providerWithRunner(
        async (argv, options) => {
          if (argv[1] === "inspect" || argv[1] === "status") {
            expect(options.timeoutMs).toBeGreaterThan(60_000);
            inspections += 1;
            return commandResult({
              stdout: inspectJson({ ready: inspections > 1 }),
            });
          }
          return commandResult();
        },
        undefined,
        async (milliseconds) => {
          delays.push(milliseconds);
        },
      );

      await expect(
        provider.provision({ ...PROFILE, provider: providerId }, OPERATION_ID),
      ).resolves.toMatchObject({ leaseId: LEASE_ID });
      expect(delays).toEqual([expectedIntervalMs]);
    },
  );

  it("reserves separate Machine0 inspection and readiness windows after a near-max warmup", async () => {
    const profile = { ...PROFILE, provider: "machine0" };
    let elapsedMs = 0;
    const inspectTimeouts: number[] = [];
    const now = vi.spyOn(Date, "now").mockImplementation(() => elapsedMs);
    const provider = providerWithRunner(async (argv, options) => {
      if (argv[1] === "warmup") {
        elapsedMs = 50 * 60_000;
        return commandResult();
      }
      if (argv[1] === "inspect" || argv[1] === "status") {
        inspectTimeouts.push(options.timeoutMs);
        if (inspectTimeouts.length <= 2) {
          elapsedMs += 4 * 60_000;
        }
        return commandResult({
          stdout: inspectJson({ ready: inspectTimeouts.length > 1 }),
        });
      }
      return commandResult();
    });

    try {
      await expect(provider.provision(profile, OPERATION_ID)).resolves.toMatchObject({
        leaseId: LEASE_ID,
      });
      expect(inspectTimeouts.slice(0, 2)).toEqual([5 * 60_000, 5 * 60_000]);
    } finally {
      now.mockRestore();
    }
  });

  it.each([
    { providerId: "aws", bootstrapTimeoutMs: undefined, commandMs: 15 * 60_000 },
    { providerId: "hetzner", bootstrapTimeoutMs: 5 * 60_000, commandMs: 15 * 60_000 },
    { providerId: "machine0", bootstrapTimeoutMs: 95 * 60_000, commandMs: 95 * 60_000 },
  ])(
    "reserves the granted window, diagnostics, and full $providerId cleanup after late enrollment failure",
    async ({ providerId, bootstrapTimeoutMs, commandMs }) => {
      const profile = { ...PROFILE, provider: providerId };
      const budget = { nodeBootstrapTimeoutMs: 105 * 60_000 };
      let elapsedMs = 0;
      const commandTimeouts: number[] = [];
      const now = vi.spyOn(Date, "now").mockImplementation(() => elapsedMs);
      const provider = providerWithRunner(async (argv, options) => {
        if (argv[1] === "inspect" || argv[1] === "status") {
          return commandResult({ stdout: inspectJson() });
        }
        if (argv[1] === "run" || argv[1] === "stop") {
          commandTimeouts.push(options.timeoutMs);
          elapsedMs += options.timeoutMs + CRABBOX_COMMAND_SETTLEMENT_TIMEOUT_MS;
        }
        return argv[1] === "stop"
          ? commandResult({ code: null, killed: true, termination: "timeout" })
          : commandResult();
      });

      try {
        const pending = provider.provision(profile, OPERATION_ID, {
          ...budget,
          beginNodeEnrollment: async () => {
            elapsedMs = resolveCrabboxProvisionBaseTimeoutMs(profile);
            return {
              ...nodeEnrollmentFixture("synthetic-setup", "Bound worker", async () => {
                elapsedMs += 10 * 60_000;
                throw new Error("node enrollment expired");
              }),
              bootstrapTimeoutMs,
            };
          },
        });
        const error = await pending.catch((cause: unknown) => cause);
        expect(WorkerProviderError.isCleanupIndeterminate(error)).toBe(true);
        expect(error).toMatchObject({
          code: "cleanup_indeterminate",
          leaseId: LEASE_ID,
          provisionError: { message: expect.stringContaining("node enrollment expired") },
          cleanupError: {
            message: expect.stringContaining("stop did not exit normally (timeout)"),
          },
        });
        if (!WorkerProviderError.isCleanupIndeterminate(error)) {
          throw new Error("expected indeterminate cleanup");
        }
        expect(error.errors).toEqual([error.provisionError, error.cleanupError]);

        expect(commandTimeouts).toEqual([commandMs, 60_000, CRABBOX_STOP_TIMEOUT_MS]);
        expect(provider.resolveProvisionTimeoutMs?.(profile, budget)).toBeGreaterThanOrEqual(
          elapsedMs,
        );
      } finally {
        now.mockRestore();
      }
    },
  );

  it("overrides the configured machine class for one provision", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      return commandResult({ stdout: argv[1] === "inspect" ? inspectJson() : "" });
    });
    await provider.provision({ ...CLASSLESS_PROFILE, class: "standard" }, OPERATION_ID, {
      machineClass: "c7a.24xlarge",
    });
    const warmup = calls.find((argv) => argv[1] === "warmup")!;
    expect(warmup.slice(warmup.indexOf("--class"), warmup.indexOf("--class") + 2)).toEqual([
      "--class",
      "c7a.24xlarge",
    ]);
  });

  it.each(["warmup", "inspect"])(
    "adopts the committed lease after a lost %s reply across provider restart",
    async (failure) => {
      const calls: string[][] = [];
      const live = new Set<string>();
      let creates = 0;
      let lost = false;
      const runCommand: CrabboxCommandRunner = async (argv) => {
        calls.push(argv);
        if (!["warmup", "inspect", "run", "stop"].includes(argv[1]!)) {
          throw new Error("unexpected Crabbox command");
        }
        const flag = argv.includes("--id") ? "--id" : "--lease-id";
        const id = argv[argv.indexOf(flag) + 1]!;
        if (argv[1] === "warmup" && !live.has(id)) {
          creates += 1;
          live.add(id);
        }
        if (argv[1] === failure && !lost) {
          lost = true;
          return commandResult({ code: null, killed: true, termination: "timeout" });
        }
        if (argv[1] === "inspect") {
          return commandResult({ stdout: inspectJson({ id }) });
        }
        if (argv[1] === "stop") {
          live.delete(id);
        }
        return commandResult();
      };
      const profile = { ...PROFILE, desktop: failure === "warmup" };
      await expect(providerWithRunner(runCommand).provision(profile, OPERATION_ID)).rejects.toThrow(
        "did not exit normally (timeout)",
      );
      expect(calls.map((argv) => argv[1])).toEqual(
        failure === "warmup" ? ["warmup"] : ["warmup", "inspect"],
      );
      expect(live).toEqual(new Set([LEASE_ID]));
      const restarted = providerWithRunner(runCommand);
      const lease = await restarted.provision(profile, OPERATION_ID);
      expect(lease.leaseId).toBe(LEASE_ID);
      expect(creates).toBe(1);
      expect(live).toEqual(new Set([LEASE_ID]));
      if (profile.desktop) {
        expect(lease.desktop).toMatchObject({
          protocol: "rfb",
          port: 5900,
          apps: [{ id: "browser" }, { id: "terminal" }],
        });
      }
      await restarted.destroy({ ...lease, profile });
      expect(live.size).toBe(0);
      expect(calls.map((argv) => argv[1])).toEqual([
        "warmup",
        ...(failure === "inspect" ? ["inspect"] : []),
        "warmup",
        "inspect",
        "run",
        "stop",
      ]);
      expect(
        calls.filter((argv) => argv[1] === "inspect").map((argv) => argv[argv.indexOf("--id") + 1]),
      ).toEqual(failure === "warmup" ? [LEASE_ID] : [LEASE_ID, LEASE_ID]);
      expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
    },
  );

  it("keeps authoritative absence after warmup retryable and un-stopped", async () => {
    const calls: string[][] = [];
    const provider = providerWithRunner(async (argv) => {
      calls.push(argv);
      if (argv[1] === "inspect") {
        return commandResult({ code: 4, stderr: `lease/server not found: ${LEASE_ID}` });
      }
      if (argv[1] === "stop") {
        throw new Error("authoritative absence must not tombstone the fixed ID");
      }
      return commandResult();
    });

    const error = await provider.provision(PROFILE, OPERATION_ID).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message: "Crabbox warmup lease was not found during inspection",
    });
    expect(error).not.toMatchObject({ code: "invalid_profile" });
    expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect"]);
  });

  it.each(["terminal", "unavailable", "different lease"] as const)(
    "reports the recorded failure after warmup exits (%s)",
    async (inspection) => {
      const stderr = 'coordinator PUT: http 409: {"error":"fixed_lease_terminal"}';
      const diagnosis =
        "No available EC2 Mac Dedicated Host; allocate a host or set CRABBOX_HOST_ID";
      const secret = `sk-${"privatecredential".repeat(80)}`;
      const calls: string[][] = [];
      const provider = providerWithRunner(async (argv) => {
        calls.push(argv);
        if (argv[1] === "warmup") {
          return commandResult({ code: 1, stderr });
        }
        return inspection === "unavailable"
          ? commandResult({ code: 1, stderr: "inspection unavailable" })
          : commandResult({
              stdout: inspectJson({
                id: inspection === "different lease" ? "cbx_012345abcdef" : LEASE_ID,
                state: "failed",
                failureError: `${diagnosis}\nAuthorization: Bearer ${secret}\n${"fallback failed; ".repeat(80)}`,
              }),
            });
      });

      const error: unknown = await provider
        .provision(PROFILE, OPERATION_ID)
        .catch((cause: unknown) => cause);
      const originalMessage = `Crabbox warmup failed with exit code 1: ${stderr}`;
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(WorkerProviderError);
      const message = error instanceof Error ? error.message : "";
      if (inspection === "terminal") {
        expect(message).toContain(diagnosis);
        expect(message).toContain(originalMessage);
        expect(message).not.toContain("privatecredential");
        expect(message.length).toBeLessThanOrEqual(
          originalMessage.length + "; lease failure: ".length + 512,
        );
      } else {
        expect(message).toBe(originalMessage);
      }
      expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect"]);
      expect(calls[1]).toEqual(expect.arrayContaining(["--id", LEASE_ID]));
    },
  );

  it("rejects legacy unleased provision state before invoking Crabbox", async () => {
    const runCommand = vi.fn<CrabboxCommandRunner>();
    const provider = providerWithRunner(runCommand);

    const error = await provider
      .provision(PROFILE, `provision:${"0".repeat(64)}`)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(WorkerProviderError);
    expect(error).toMatchObject({
      message: expect.stringContaining("cannot be replayed safely"),
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("expires readiness at its own deadline before setup starts", async () => {
    const calls: string[] = [];
    let elapsed = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => elapsed);
    const provider = providerWithRunner(
      async (argv) => {
        calls.push(argv[1]!);
        return commandResult({
          stdout: argv[1] === "inspect" ? inspectJson({ ready: false }) : "",
        });
      },
      undefined,
      async () => {
        elapsed += resolveCrabboxProvisionBaseTimeoutMs(PROFILE) + 1;
      },
    );
    try {
      await expect(
        provider.provision({ ...PROFILE, setup: "install-node" }, OPERATION_ID),
      ).rejects.toThrow("exceeded its provider deadline");
    } finally {
      now.mockRestore();
    }
    expect(calls).toEqual(["warmup", "inspect"]);
  });

  it.each<[WorkerProfile, string]>([
    [{ provider: " " }, "provider"],
    [{ class: null }, "class"],
    [{ warmImage: "yes" }, "warmImage must be a boolean"],
    [{ ttl: "garbage" }, "positive Go duration"],
    [{ ttl: "0.1ns" }, "positive Go duration"],
    [{ ttl: "999999999999999999999h" }, "positive Go duration"],
    [{ binary: " " }, "binary"],
    [{ binary: "crabbox" }, "absolute path"],
    [{ setupEnv: "TOKEN" }, "array"],
    [{ setupEnv: [4] }, "valid"],
    [{ setupEnv: ["BAD-NAME"] }, "valid"],
    [{ setupEnv: ["CRABBOX_ENV_ALLOW"] }, "CRABBOX_ENV_ALLOW is reserved"],
    [{ setupEnv: ["TOKEN", "TOKEN"] }, "duplicate"],
    [{ setupEnv: Array.from({ length: 17 }, (_, index) => "TOKEN_" + index) }, "at most 16"],
    [{ setupEnv: ["TOKEN"] }, "requires setup"],
    [{ typo: true }, "unknown"],
    [{ setup: "  " }, "Crabbox profile setup must be a non-empty command string"],
    [{ desktop: "yes" }, "Crabbox profile desktop must be a boolean"],
    [
      { provider: "gcp", desktop: true },
      "Crabbox desktop profiles support only AWS, Azure, and coordinator-backed Hetzner",
    ],
  ])("rejects invalid profile %j", async (patch, message) => {
    const runCommand = vi.fn<CrabboxCommandRunner>();
    const provider = providerWithRunner(runCommand);
    await expect(provider.provision({ ...PROFILE, ...patch }, OPERATION_ID)).rejects.toMatchObject({
      code: "invalid_profile",
      message: expect.stringContaining(message),
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("fences heartbeat before a delayed or failed teardown binary acquisition", async () => {
    vi.useFakeTimers();
    const heartbeatStarted = createDeferred<AbortSignal>();
    const acquisitionStarted = createDeferred<void>();
    const acquisition = createDeferred<CrabboxBinary>();
    let heartbeatCount = 0;
    const provider = providerWithRunner(async (argv, options) => {
      if (argv[1] === "inspect") {
        return commandResult({ stdout: inspectJson() });
      }
      if (argv[1] === "heartbeat") {
        heartbeatCount += 1;
        heartbeatStarted.resolve(options.signal!);
        return await new Promise<SpawnResult>((resolve) => {
          options.signal!.addEventListener("abort", () => resolve(commandResult()), { once: true });
        });
      }
      return commandResult();
    });
    await provider.inspect(lifecycleLease());
    await vi.advanceTimersByTimeAsync(0);
    const signal = await heartbeatStarted.promise;
    vi.mocked(ensureManagedCrabboxBinary).mockImplementationOnce(async () => {
      acquisitionStarted.resolve();
      return await acquisition.promise;
    });
    const destroy = provider.destroy(
      lifecycleLease(LEASE_ID, {
        ...PROFILE,
        binary: path.resolve(path.sep, "unavailable", "crabbox"),
      }),
    );
    const rejected = expect(destroy).rejects.toThrow("fixture acquisition failed");
    try {
      await acquisitionStarted.promise;
      expect(signal.aborted).toBe(true);
    } finally {
      acquisition.reject(new Error("fixture acquisition failed"));
      await rejected;
      vi.useRealTimers();
    }
    expect(heartbeatCount).toBe(1);
  });

  it("warns once and disables unsupported heartbeat", async () => {
    const { provider, heartbeat, warnings } = heartbeatFixture(async () =>
      commandResult({ code: 2, stderr: "provider=aws does not support lease heartbeat" }),
    );
    try {
      await expect(provider.inspect(lifecycleLease())).resolves.toEqual(active);
      await vi.advanceTimersByTimeAsync(0);
      await provider.inspect(lifecycleLease());
      await vi.advanceTimersByTimeAsync(180_000);
      expect(heartbeat).toHaveBeenCalledTimes(1);
      expect(warnings).toEqual([
        `Crabbox provider aws does not support heartbeat for worker lease ${LEASE_ID}; cloud worker machines may be reaped after 60m of coordinator-idle time`,
      ]);
    } finally {
      await provider.destroy(lifecycleLease());
      vi.useRealTimers();
    }
  });

  it("reports elapsed heartbeat timeout duration", async () => {
    const { provider, warnings } = heartbeatFixture(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 60_012);
      });
      return commandResult({ code: null, killed: true, termination: "timeout" });
    });
    try {
      await provider.inspect(lifecycleLease());
      await vi.advanceTimersByTimeAsync(60_012);
      expect(warnings).toEqual([
        "Crabbox heartbeat did not exit normally (timeout after 60012 ms); cloud worker machines may be reaped after 60m of coordinator-idle time",
      ]);
    } finally {
      await provider.destroy(lifecycleLease());
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: "transport failure",
      fail: () => {
        throw new Error("transport unavailable");
      },
      warning: "Crabbox heartbeat execution failed: transport unavailable",
    },
    {
      name: "claim conflict",
      fail: () => commandResult({ code: 2, stderr: `lease ${LEASE_ID} claim changed; retry\n` }),
      warning: `Crabbox heartbeat failed with exit code 2: lease ${LEASE_ID} claim changed; retry`,
    },
  ])("preserves heartbeat scheduling after $name", async ({ fail, warning }) => {
    let attempts = 0;
    const { provider, heartbeat, warnings } = heartbeatFixture(async () =>
      attempts++ === 0 ? fail() : commandResult(),
    );
    try {
      await expect(provider.inspect(lifecycleLease())).resolves.toEqual(active);
      await vi.advanceTimersByTimeAsync(0);
      expect(heartbeat).toHaveBeenCalledTimes(1);
      expect(warnings).toEqual([
        `${warning}; cloud worker machines may be reaped after 60m of coordinator-idle time`,
      ]);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(heartbeat).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(heartbeat).toHaveBeenCalledTimes(2);
      expect(warnings).toHaveLength(1);
    } finally {
      await provider.destroy(lifecycleLease());
      vi.useRealTimers();
    }
  });

  it("rejects non-Crabbox lifecycle lease ids before invoking the CLI", async () => {
    const runCommand = vi.fn<CrabboxCommandRunner>();
    const provider = providerWithRunner(runCommand);
    const lease = lifecycleLease("lease:not-crabbox");

    await expect(provider.inspect(lease)).rejects.toThrow("lease id is invalid");
    await expect(provider.destroy(lease)).rejects.toThrow("lease id is invalid");
    expect(runCommand).not.toHaveBeenCalled();
  });

  it.each(inspectCases(NON_RUNNABLE_STATES))(
    "maps inspect state $state ready=$ready to $expected.status without renewing lost leases",
    async ({ state, ready, expected }) => {
      vi.useFakeTimers();
      let inspection = inspectJson();
      const heartbeats = vi.fn();
      const provider = providerWithRunner(async (argv) => {
        if (argv[1] === "heartbeat") {
          heartbeats();
          return commandResult();
        }
        return commandResult({ stdout: inspection });
      });
      const lease = lifecycleLease();
      try {
        await expect(provider.inspect(lease)).resolves.toEqual(active);
        await vi.advanceTimersByTimeAsync(0);
        expect(heartbeats).toHaveBeenCalledTimes(1);
        inspection = inspectJson({ state, ready });
        await expect(provider.inspect(lease)).resolves.toStrictEqual(expected);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(heartbeats).toHaveBeenCalledTimes(expected.status === "active" ? 2 : 1);
      } finally {
        await provider.destroy(lease);
        vi.useRealTimers();
      }
    },
  );

  it.each(["deleted"])(
    "rejects non-runnable %s during provision even if SSH is ready",
    async (state) => {
      const calls: string[][] = [];
      const provider = providerWithRunner(async (argv) => {
        calls.push(argv);
        return argv[1] === "inspect"
          ? commandResult({ stdout: inspectJson({ state, ready: true }) })
          : commandResult();
      });
      await expect(provider.provision(CLASSLESS_PROFILE, OPERATION_ID)).rejects.toMatchObject({
        code: "cleanup_complete",
        message: "Crabbox warmup lease entered a terminal state",
      });
      expect(calls.map((argv) => argv[1])).toEqual(["warmup", "inspect", "stop"]);
    },
  );

  it("maps lease recognition failures to unknown while observation failures still throw", async () => {
    const missing = providerWithRunner(async () =>
      commandResult({ code: 4, stderr: `lease/droplet not found: ${LEASE_ID}` }),
    );
    const authFailure = providerWithRunner(async () =>
      commandResult({
        code: 4,
        stderr: `credential profile not found while inspecting lease ${LEASE_ID}`,
      }),
    );
    const noLongerExists = providerWithRunner(async () =>
      commandResult({ code: 4, stderr: `unikraftcloud lease ${LEASE_ID} no longer exists` }),
    );
    const ambiguousVisibility = providerWithRunner(async () =>
      commandResult({
        code: 4,
        stderr: `nomad job for lease ${LEASE_ID} is missing or inaccessible`,
      }),
    );
    const cliMissing = providerWithRunner(async () => {
      throw new Error("spawn ENOENT");
    });

    const lease = lifecycleLease();
    await expect(missing.inspect(lease)).resolves.toStrictEqual({ status: "unknown" });
    await expect(noLongerExists.inspect(lease)).resolves.toStrictEqual({ status: "unknown" });
    await expect(authFailure.inspect(lease)).rejects.toThrow("inspect failed with exit code 4");
    await expect(ambiguousVisibility.inspect(lease)).rejects.toThrow(
      "inspect failed with exit code 4",
    );
    await expect(cliMissing.inspect(lease)).rejects.toThrow("execution failed: spawn ENOENT");
  });

  it.each([
    { action: "warmup", termination: "exit", code: 5 },
    { action: "inspect", termination: "timeout", code: null },
  ] as const)(
    "preserves bounded, redacted terminal diagnostics for $action $termination failures",
    async ({ action, termination, code }) => {
      const secret = ["sk", "abcdefghijklmnop"].join("-");
      const terminalStderr = "Machine0 terminal stderr: provider quota exhausted";
      const terminalStdout = "Machine0 terminal stdout: quota window has not reset";
      const provider = providerWithRunner(async () =>
        commandResult({
          code,
          termination,
          killed: termination !== "exit",
          stderr: `provider warning ${secret}\n${terminalStderr}`,
          stdout: `${"provider progress ".repeat(90)}\n${terminalStdout}`,
        }),
      );
      const operation =
        action === "warmup"
          ? provider.provision({ ...PROFILE, provider: "machine0" }, OPERATION_ID)
          : provider.inspect(lifecycleLease());

      const error = await operation.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      const message = error instanceof Error ? error.message : "";
      const failurePrefix =
        action === "warmup"
          ? "Crabbox warmup failed with exit code 5: "
          : "Crabbox inspect did not exit normally (timeout): ";
      expect(message.startsWith(`${failurePrefix}... `)).toBe(true);
      expect(message).toContain(terminalStderr);
      expect(message).toContain(terminalStdout);
      expect(message).not.toContain(secret);
      expect(message).not.toMatch(/\s{2,}/u);
      expect(message.length).toBeLessThanOrEqual(failurePrefix.length + 512);
      expect(message).not.toMatch(/[\uD800-\uDFFF]/u);
    },
  );

  it("preserves UTF-16 boundaries and terminal detail from stderr", async () => {
    const terminalDetail = "😀 terminal failure";
    const provider = providerWithRunner(async () =>
      commandResult({
        code: 2,
        stderr: `${"x".repeat(600)}😀${"y".repeat(507 - terminalDetail.length)}${terminalDetail}`,
      }),
    );

    const error = await provider.inspect(lifecycleLease()).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : "";
    expect(message).toContain("😀 terminal failure");
    expect(message.length).toBeLessThanOrEqual(INSPECT_FAILURE_PREFIX.length + 512);
    expect(message).not.toMatch(/[\uD800-\uDFFF]/u);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
