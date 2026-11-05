import fs from "node:fs";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  type WorkerProfile,
  type WorkerProvider,
  WorkerProviderError,
} from "openclaw/plugin-sdk/plugin-entry";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import * as secretEgressRuntime from "openclaw/plugin-sdk/secret-egress-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { ensureManagedCrabboxBinary, type CrabboxBinary } from "./crabbox-managed-binary.js";
import { crabboxState } from "./crabbox-state.test-support.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import { createNodeBootstrapFixture } from "./crabbox-worker-node-enrollment.test-support.js";
import { createCrabboxWorkerProvider } from "./crabbox-worker-provider.js";
import {
  active,
  catalogJson,
  classProfile,
  commandResult,
  createProviderTestHarness,
  nodeEnrollmentFixture,
  OPENCLAW_ROOT,
  WORKER_WALLPAPER_PATH,
  mappedCatalog,
} from "./crabbox-worker-provider.test-support.js";
import {
  CRABBOX_WARMUP_TIMEOUT_MS,
  CRABBOX_LIFECYCLE_TIMEOUT_MS,
  CRABBOX_MACHINE_CATALOG_TIMEOUT_MS,
  CRABBOX_STOP_TIMEOUT_MS,
  resolveCrabboxProvisionBaseTimeoutMs,
} from "./crabbox-worker-timeouts.js";

// mock-isolation: Exercise provider lifecycle without downloading or executing a managed binary.
vi.mock("./crabbox-managed-binary.js", () => ({ ensureManagedCrabboxBinary: vi.fn() }));

vi.mock("openclaw/plugin-sdk/secret-egress-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/secret-egress-runtime")>()),
  withSetupSecretEgress: vi.fn(),
}));

const SETUP_SECRETS = {
  ARTIFACT_TOKEN: { source: "store", provider: "default", id: "ARTIFACT_TOKEN" },
} as const;
const SETUP_SENTINEL = "openclaw-secret-sentinel:fixture-artifact-token";
const HOST_PROXY = "http://fixture-proxy-grant@127.0.0.1:4321";
const CA_BUNDLE = "-----BEGIN CERTIFICATE-----\npublic-ca-fixture\n-----END CERTIFICATE-----";
const revokeSetupGrant = vi.fn();

const OPERATION_ID = `provision:v2:${"0".repeat(64)}`;
const LEASE_ID = "cbx_6071fc2062a6";
const SIBLING_BINARY = path.resolve(OPENCLAW_ROOT, "../crabbox/bin/crabbox");

const CLASSLESS_PROFILE = { provider: "aws", ttl: "24h", idleTimeout: "60m" };
const PROFILE = { ...CLASSLESS_PROFILE, class: "standard", warmImage: false };
const SETUP_PROFILE = { ...PROFILE, setup: "install-node", setupSecrets: SETUP_SECRETS };
type ProvisionOptions = Parameters<WorkerProvider["provision"]>[2];
const { createProvider, tempDirs } = createProviderTestHarness(
  { isExecutable: (candidate) => candidate === SIBLING_BINARY },
  "openclaw-crabbox-provider-",
);
beforeEach(() => {
  revokeSetupGrant.mockReset();
  vi.mocked(secretEgressRuntime.withSetupSecretEgress)
    .mockReset()
    .mockImplementation(async (_options, run) =>
      run({
        remoteEnv: { ARTIFACT_TOKEN: SETUP_SENTINEL },
        hostEnv: { HTTPS_PROXY: HOST_PROXY },
        caBundle: CA_BUNDLE,
        revoke: revokeSetupGrant,
      }),
    );
});

function inspectJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: LEASE_ID,
    providerMetadata: { instanceProfileAttached: false },
    state: "running",
    sshUser: "openclaw",
    ready: true,
    ...overrides,
  });
}

function readyResult(argv: string[], overrides: Record<string, unknown> = {}) {
  return commandResult({ stdout: argv[1] === "inspect" ? inspectJson(overrides) : "" });
}

function lifecycleLease(leaseId = LEASE_ID, profile: WorkerProfile = PROFILE) {
  return { leaseId, profile };
}

function expectActions(calls: string[][], actions: string) {
  expect(calls.map((argv) => argv[1])).toEqual(actions.split(" "));
}

function expectText(text: unknown, present: string[], absent: string[] = []) {
  for (const value of present) {
    expect(text).toContain(value);
  }
  for (const value of absent) {
    expect(text).not.toContain(value);
  }
}

function providerWithRawRunner(
  runCommand: CrabboxCommandRunner,
  warn?: (message: string) => void,
  sleep: (milliseconds: number) => Promise<void> = async () => {},
) {
  const provider = createProvider({ runCommand, sleep, ...(warn ? { warn } : {}) });
  return {
    ...provider,
    provision: (
      profile: WorkerProfile = PROFILE,
      operationId = OPERATION_ID,
      options?: ProvisionOptions,
    ) =>
      provider.provision(profile, operationId, {
        assertCurrent: () => {},
        nodeRuntimeIdentity: {
          nodeBootstrapSha256: createNodeBootstrapFixture().sha256,
          executionMode: options?.executionMode ?? "worker-turn",
        },
        ...options,
        beginNodeEnrollment:
          options?.beginNodeEnrollment ??
          (async () => nodeEnrollmentFixture("secret-setup-value", "Cloud worker test")),
      }),
  };
}

function providerWithRunner(
  runCommand: CrabboxCommandRunner,
  warn?: (message: string) => void,
  sleep?: (milliseconds: number) => Promise<void>,
) {
  return providerWithRawRunner(
    async (argv, options) => {
      if (argv[1] === "config" && argv[2] === "show") {
        return commandResult({ stdout: JSON.stringify({ aws: { instanceProfile: "" } }) });
      }
      if (argv[1] === "egress" && argv.includes("--help")) {
        return commandResult({
          stdout: "  --allow-public-destinations\n  --upstream-proxy-env string",
        });
      }
      return runCommand(argv, options);
    },
    warn,
    sleep,
  );
}

function failedNodeEnrollment(error: Error): ProvisionOptions {
  return {
    beginNodeEnrollment: async () =>
      nodeEnrollmentFixture("secret-setup-value", "Cloud worker test", async () => {
        throw error;
      }),
  };
}

function delayedBinary() {
  const started = createDeferred<void>();
  const result = createDeferred<CrabboxBinary>();
  vi.mocked(ensureManagedCrabboxBinary).mockImplementationOnce(() => {
    started.resolve();
    return result.promise;
  });
  return { started: started.promise, ...result };
}

function recordedProvider(
  script: CrabboxCommandRunner | Record<string, SpawnResult | CrabboxCommandRunner> = {},
  warn?: (message: string) => void,
) {
  const calls: string[][] = [];
  const commands: Array<{ argv: string[]; options: Parameters<CrabboxCommandRunner>[1] }> = [];
  const provider = providerWithRunner(async (argv, options) => {
    calls.push(argv);
    commands.push({ argv, options });
    const run = typeof script === "function" ? script : script[argv[1]!];
    return typeof run === "function" ? run(argv, options) : (run ?? readyResult(argv));
  }, warn);
  return { provider, calls, commands };
}

function heartbeatFixture(run: CrabboxCommandRunner) {
  vi.useFakeTimers();
  const heartbeat = vi.fn(run);
  const warnings: string[] = [];
  const { provider } = recordedProvider({ heartbeat }, (message) => warnings.push(message));
  return { provider, heartbeat, warnings };
}

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

it("bounds catalogs while reserving the configured class", async () => {
  const configuredClass = "custom";
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

it.each([false, true])("rejects invalid wallpaper (PNG=%s)", (png) => {
  const bytes = png ? fs.readFileSync(WORKER_WALLPAPER_PATH) : Buffer.from("not a PNG");
  if (png) {
    bytes.writeUInt32BE(1023, 16);
  }
  const tempDir = tempDirs.make("openclaw-crabbox-wallpaper-");
  const wallpaperPath = path.join(tempDir, "wallpaper.png");
  fs.writeFileSync(wallpaperPath, bytes);
  expect(() => createCrabboxWorkerProvider({ state: crabboxState, wallpaperPath })).toThrow(
    png ? "must be 1024x576; got 1023x576" : "is not a PNG",
  );
});

it("runs profile setup with sentinels while keeping the proxy and enrollment credentials separate", async () => {
  vi.stubEnv("ARTIFACT_TOKEN", "unforwarded-host-value");
  vi.stubEnv("CRABBOX_ENV_ALLOW", "OPENCLAW_UNSELECTED_SECRET");
  vi.stubEnv("OPENCLAW_UNSELECTED_SECRET", "unselected-secret");
  let enrollmentProfile: string | undefined;
  const enrollmentEnv = {
    CRABBOX_WORKER_BOOTSTRAP_TOKEN: JSON.stringify({
      nodeBootstrap: createNodeBootstrapFixture().token,
    }),
    CRABBOX_WORKER_SETUP_CODE: "secret-setup-value",
  };
  const setup = "command -v node || install-node";
  const { provider, commands: calls } = recordedProvider(async (argv) => {
    if (argv[1] === "run") {
      enrollmentProfile = argv[argv.indexOf("--env-from-profile") + 1];
      if (!enrollmentProfile) {
        throw new Error("missing enrollment environment profile");
      }
      const lines = fs.readFileSync(enrollmentProfile, "utf8").split("\n");
      expect(fs.statSync(path.dirname(enrollmentProfile)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(enrollmentProfile).mode & 0o777).toBe(0o600);
      for (const [name, value] of Object.entries(enrollmentEnv)) {
        expect(lines).toContain(
          `${name}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
        );
      }
      expect(lines.join("\n")).not.toContain(SETUP_SENTINEL);
    }
    return readyResult(argv);
  });

  await expect(
    provider.provision({ ...PROFILE, setup, setupSecrets: SETUP_SECRETS }, OPERATION_ID, {
      executionMode: "remote-exec",
    }),
  ).resolves.toEqual({ leaseId: LEASE_ID, node: { deviceId: "device-1" }, sharedHost: false });
  const setupCall = calls.find((call) => call.argv[1] === "egress");
  const enrollmentCall = calls.find((call) => call.argv[1] === "run");
  expectText(
    enrollmentCall?.options.input,
    ["--ephemeral"],
    ["secret-setup-value", "synthetic-bootstrap-token", SETUP_SENTINEL],
  );
  expect(enrollmentCall?.argv).toContain("CRABBOX_WORKER_BOOTSTRAP_TOKEN");
  const argumentsUsed = calls.flatMap(({ argv }) => argv);
  for (const forbidden of ["remote-exec", "worker-turn", "ssh", "scp", "rsync"]) {
    expect(argumentsUsed).not.toContain(forbidden);
  }
  expect(setupCall?.argv).toEqual([
    SIBLING_BINARY,
    ...`egress run --id ${LEASE_ID} --provider aws --allow-public-destinations --upstream-proxy-env CRABBOX_SETUP_PROXY --no-sync --no-hydrate --script-stdin`.split(
      " ",
    ),
  ]);
  expect(setupCall?.options.env).toEqual({
    CRABBOX_ENV_ALLOW: ",",
    CRABBOX_SETUP_PROXY: HOST_PROXY,
  });
  expect(setupCall?.options.input).not.toMatch(/^export (?:HTTP_PROXY|http_proxy)=/mu);
  expectText(setupCall?.options.input, [
    `export ARTIFACT_TOKEN='${SETUP_SENTINEL}'`,
    CA_BUNDLE,
    "unset HTTP_PROXY http_proxy ALL_PROXY all_proxy",
    "export HTTPS_PROXY='http://127.0.0.1:3128'",
    "export https_proxy='http://127.0.0.1:3128'",
    "export NO_PROXY='localhost,127.0.0.1,::1'",
    "export no_proxy='localhost,127.0.0.1,::1'",
    "export NODE_USE_ENV_PROXY='1'",
    "trap 'rm -rf --",
    "export CURL_CA_BUNDLE='/tmp/openclaw-setup-egress.",
    setup,
  ]);
  const secrets = [HOST_PROXY, "unforwarded-host-value", "unselected-secret", "secret-setup-value"];
  expectText(setupCall?.options.input, [], secrets);
  expectText(setupCall?.argv.join(" "), [], secrets);
  expect(enrollmentCall?.options.env).toEqual({
    CRABBOX_ENV_ALLOW: ",",
    CRABBOX_WORKER_BOOTSTRAP_TOKEN: undefined,
    CRABBOX_WORKER_SETUP_CODE: undefined,
  });
  expect(enrollmentCall?.options.env).not.toHaveProperty("CRABBOX_SETUP_PROXY");
  for (const value of Object.values(enrollmentEnv)) {
    expect(enrollmentCall?.argv.join(" ")).not.toContain(value);
    expect(Object.values(enrollmentCall?.options.env ?? {})).not.toContain(value);
  }
  expect(fs.existsSync(enrollmentProfile!)).toBe(false);
  expect(fs.existsSync(path.dirname(enrollmentProfile!))).toBe(false);
  expect(revokeSetupGrant).toHaveBeenCalledOnce();
});

it("stops the owned lease without launching setup when its protected secret is unavailable", async () => {
  vi.mocked(secretEgressRuntime.withSetupSecretEgress).mockRejectedValue(
    new Error(
      'Setup egress secret "ARTIFACT_TOKEN" was not found as a protected shared-store entry',
    ),
  );
  const { provider, calls } = recordedProvider();
  await expect(provider.provision(SETUP_PROFILE, OPERATION_ID)).rejects.toMatchObject({
    code: "cleanup_complete",
    message: expect.stringContaining("protected shared-store entry"),
  });
  expectActions(calls, "warmup inspect stop");
});

it("rejects a CLI without native public setup egress before allocation", async () => {
  const runCommand = vi.fn<CrabboxCommandRunner>(async () =>
    commandResult({ stdout: "--upstream-proxy-env" }),
  );
  await expect(
    providerWithRawRunner(runCommand).provision(SETUP_PROFILE, OPERATION_ID),
  ).rejects.toThrow("update Crabbox to 0.79.2 or newer");
  expect(runCommand).toHaveBeenCalledOnce();
  expect(secretEgressRuntime.withSetupSecretEgress).not.toHaveBeenCalled();
});

it("rejects setup secrets on non-Linux targets before invoking Crabbox", async () => {
  const runCommand = vi.fn<CrabboxCommandRunner>();
  await expect(
    providerWithRawRunner(runCommand).provision(
      { ...PROFILE, setupSecrets: SETUP_SECRETS },
      OPERATION_ID,
      { os: "macos" },
    ),
  ).rejects.toThrow("select Linux");
  expect(runCommand).not.toHaveBeenCalled();
  expect(secretEgressRuntime.withSetupSecretEgress).not.toHaveBeenCalled();
});

it("leaves a lease live when it disappears from post-setup inspection", async () => {
  let inspections = 0;
  const { provider, calls } = recordedProvider({
    inspect: async (argv) =>
      ++inspections === 1
        ? readyResult(argv)
        : commandResult({ code: 4, stderr: `lease/server not found: ${LEASE_ID}` }),
  });

  await expect(provider.provision({ ...PROFILE, setup: "install-node" })).rejects.toThrow(
    "disappeared while waiting for SSH readiness",
  );
  expectActions(calls, "warmup inspect run inspect");
});

it("revokes the setup grant and stops the lease after a setup timeout", async () => {
  const { provider, calls } = recordedProvider({
    egress: async (_argv, options) => {
      expect(options.input).toContain("trap 'rm -rf --");
      return commandResult({ code: null, killed: true, termination: "timeout" });
    },
    stop: async () => {
      expect(revokeSetupGrant).toHaveBeenCalledOnce();
      return commandResult();
    },
  });
  await expect(provider.provision(SETUP_PROFILE, OPERATION_ID)).rejects.toMatchObject({
    code: "cleanup_complete",
    message: expect.stringContaining("Crabbox profile setup did not exit normally (timeout)"),
  });
  expectActions(calls.slice(-1), "stop");
});

it("revokes setup access before signalling process termination on cancellation", async () => {
  const controller = new AbortController();
  const setupStarted = createDeferred<void>();
  const processSettled = createDeferred<SpawnResult>();
  const { provider } = recordedProvider({
    egress: async (_argv, options) => {
      options.signal!.addEventListener(
        "abort",
        () => {
          expect(revokeSetupGrant).toHaveBeenCalledOnce();
          processSettled.resolve(
            commandResult({ code: null, killed: true, termination: "timeout" }),
          );
        },
        { once: true },
      );
      setupStarted.resolve();
      return processSettled.promise;
    },
  });
  const reason = new Error("setup cancelled");
  const provisioning = provider.provision(SETUP_PROFILE, OPERATION_ID, {
    signal: controller.signal,
  });
  await Promise.race([setupStarted.promise, provisioning]);
  const rejection = expect(provisioning).rejects.toThrow(reason);
  controller.abort(reason);
  await rejection;
  expect(revokeSetupGrant).toHaveBeenCalledTimes(2);
});

it("rejects an effective AWS instance profile during allocation-free preparation", async () => {
  const calls: string[][] = [];
  const provider = providerWithRawRunner(async (argv) => {
    calls.push(argv);
    return commandResult({ stdout: JSON.stringify({ aws: { instanceProfile: "worker-role" } }) });
  });
  await expect(
    provider.prepareProvision!({ ...PROFILE, provider: "AWS" }, OPERATION_ID, {
      assertCurrent: () => {},
    }),
  ).rejects.toMatchObject({
    code: "invalid_profile",
    message: "Crabbox AWS instance profile must be empty for cloud workers",
  });
  expectActions(calls, "config");
});

it("waits for AWS metadata before enrollment", async () => {
  const calls: string[] = [];
  let inspections = 0;
  const provider = providerWithRunner(async (argv) => {
    calls.push(argv[1]!);
    if (argv[1] === "inspect" && inspections === 1) {
      // Keep the background lease timer independent of filesystem scheduling.
      await vi.advanceTimersByTimeAsync(0);
    }
    return readyResult(
      argv,
      argv[1] === "inspect" && ++inspections === 1
        ? { providerMetadata: undefined, ready: false }
        : {},
    );
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  await expect(provider.provision()).resolves.toMatchObject({ leaseId: LEASE_ID });
  expect(calls).toEqual(["warmup", "inspect", "inspect", "heartbeat", "run"]);
});

const noInstanceProfile = "Crabbox AWS inspect must attest that no instance profile is attached";
it.each([
  [{ providerMetadata: undefined }, noInstanceProfile],
  [
    { providerMetadata: { instanceProfileAttached: "no" } },
    "invalid AWS instance profile metadata",
  ],
  [{ tailscale: null }, "invalid Tailscale state"],
  [{ id: "cbx_ffffffffffff" }, "different lease id"],
  [{ tailscale: { enabled: true } }, "must not have Tailscale enabled"],
  [
    { providerMetadata: { instanceProfileAttached: true }, ready: false },
    noInstanceProfile,
    "install-node",
  ],
] as const)(
  "stops the fixed lease on invalid inspection %j",
  async (patch, message, setup?: string) => {
    let inspections = 0;
    const { provider, calls } = recordedProvider(async (argv) =>
      readyResult(argv, argv[1] === "inspect" && setup && inspections++ === 0 ? {} : patch),
    );
    await expect(
      provider.provision({ ...PROFILE, ...(setup ? { setup } : {}) }),
    ).rejects.toMatchObject({
      code: "cleanup_complete",
      message: expect.stringContaining(message),
    });
    expectActions(calls, setup ? "warmup inspect run inspect stop" : "warmup inspect stop");
    expect(calls.at(-1)).toEqual([SIBLING_BINARY, "stop", "--provider", "aws", "--id", LEASE_ID]);
  },
);

it("rejects a registered Hetzner desktop profile before allocation", async () => {
  const config = { coordinator: "https://coordinator.example.test", brokerMode: "registered" };
  const runCommand = vi.fn<CrabboxCommandRunner>(async () =>
    commandResult({ stdout: JSON.stringify(config) }),
  );
  const provider = providerWithRawRunner(runCommand);

  await expect(
    provider.provision({ ...PROFILE, provider: "hetzner", desktop: true }),
  ).rejects.toMatchObject({
    message: expect.stringContaining("require a managed coordinator"),
  });
  expect(runCommand.mock.calls.map(([argv]) => argv[1])).toEqual(["config"]);
});

it("collects node evidence before stopping an unenrolled lease", async () => {
  const { provider, commands: calls } = recordedProvider({
    status: commandResult({ stdout: inspectJson() }),
    run: async (_argv, options) =>
      commandResult({
        stdout: String(options.input).includes("node.log tail:")
          ? "node-runtime=installed-source-artifact node-pid=alive node.log tail: proxy_attribution_required"
          : "",
      }),
  });

  const originalError = new Error("Worker node did not connect before the enrollment deadline");
  const error = await provider
    .provision(undefined, undefined, failedNodeEnrollment(originalError))
    .catch((cause: unknown) => cause);

  expect(error).toMatchObject({
    provisionError: { cause: originalError },
    message: expect.stringContaining(
      "Worker node did not connect before the enrollment deadline; box evidence: node-runtime=installed-source-artifact node-pid=alive node.log tail:",
    ),
  });
  const diagnosticCall = calls.find(
    ({ argv, options }) => argv[1] === "run" && String(options.input).includes("node.log tail:"),
  );
  expect(diagnosticCall?.options.env).toBeUndefined();
  expectText(diagnosticCall?.options.input, [`cloud-workers/${LEASE_ID}`], ["setup-code"]);
  expect(calls.slice(-2).map(({ argv }) => argv[1])).toEqual(["run", "stop"]);
});

it.each(["preparation", "setup", "completion", "diagnostics"] as const)(
  "preserves its fixed lease when the Gateway aborts enrollment %s",
  async (phase) => {
    const controller = new AbortController();
    const waitForDeviceId = vi.fn(async () => {
      if (phase === "diagnostics") {
        throw new Error("Worker node did not connect before the enrollment deadline");
      }
      controller.abort();
      controller.signal.throwIfAborted();
      return "device-bound";
    });
    const { provider, calls } = recordedProvider(async (argv, options) => {
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
      return readyResult(argv);
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

it.each([false, true])("preserves readiness budgets with wall clock rewind=%s", async (rewind) => {
  let elapsedMs = 0;
  const inspectTimeouts: number[] = [];
  vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
  if (rewind) {
    let wallClockReads = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (++wallClockReads === 1 ? 0 : -90_000));
  }
  const provider = providerWithRunner(async (argv, options) => {
    if (argv[1] === "warmup") {
      elapsedMs = rewind ? CRABBOX_WARMUP_TIMEOUT_MS + 60_000 : 50 * 60_000;
      return commandResult();
    }
    if (argv[1] === "inspect" || argv[1] === "status") {
      inspectTimeouts.push(options.timeoutMs);
      if (!rewind && inspectTimeouts.length <= 2) {
        elapsedMs += 4 * 60_000;
      }
      return commandResult({
        stdout: inspectJson({ ready: rewind || inspectTimeouts.length > 1 }),
      });
    }
    return commandResult();
  });

  await expect(
    provider.provision({ ...PROFILE, provider: rewind ? "aws" : "machine0" }),
  ).resolves.toMatchObject({
    leaseId: LEASE_ID,
  });
  if (rewind) {
    expect(inspectTimeouts.length).toBeGreaterThan(0);
    for (const timeoutMs of inspectTimeouts) {
      expect(timeoutMs).toBe(CRABBOX_LIFECYCLE_TIMEOUT_MS - 60_000);
    }
  } else {
    expect(inspectTimeouts.slice(0, 2)).toEqual([5 * 60_000, 5 * 60_000]);
  }
});

it("reserves the granted window, diagnostics, and full AWS cleanup after late enrollment failure", async () => {
  const budget = { nodeBootstrapTimeoutMs: 105 * 60_000 };
  let elapsedMs = 0;
  const commandTimeouts: number[] = [];
  vi.spyOn(performance, "now").mockImplementation(() => elapsedMs);
  const provider = providerWithRunner(async (argv, options) => {
    if (argv[1] === "inspect" || argv[1] === "status") {
      return commandResult({ stdout: inspectJson() });
    }
    if (argv[1] === "run" || argv[1] === "stop") {
      commandTimeouts.push(options.timeoutMs);
      elapsedMs += options.timeoutMs + 10_000;
    }
    return argv[1] === "stop"
      ? commandResult({ code: null, killed: true, termination: "timeout" })
      : commandResult();
  });

  const pending = provider.provision(PROFILE, OPERATION_ID, {
    ...budget,
    beginNodeEnrollment: async () => {
      elapsedMs = resolveCrabboxProvisionBaseTimeoutMs(PROFILE);
      return {
        ...nodeEnrollmentFixture("synthetic-setup", "Bound worker", async () => {
          elapsedMs += 10 * 60_000;
          throw new Error("node enrollment expired");
        }),
        bootstrapTimeoutMs: undefined,
      };
    },
  });
  const error = await pending.catch((cause: unknown) => cause);
  expect(error).toMatchObject({
    code: "cleanup_indeterminate",
    leaseId: LEASE_ID,
    provisionError: { message: expect.stringContaining("node enrollment expired") },
    cleanupError: {
      message: expect.stringContaining("stop did not exit normally (timeout)"),
    },
  });
  expect(commandTimeouts).toEqual([15 * 60_000, 60_000, CRABBOX_STOP_TIMEOUT_MS]);
  expect(provider.resolveProvisionTimeoutMs?.(PROFILE, budget)).toBeGreaterThanOrEqual(elapsedMs);
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
      if (!["warmup", "inspect", "heartbeat", "run", "stop"].includes(argv[1]!)) {
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
    await expect(providerWithRunner(runCommand).provision(profile)).rejects.toThrow(
      "did not exit normally (timeout)",
    );
    expectActions(calls, failure === "warmup" ? "warmup" : "warmup inspect");
    expect(live).toEqual(new Set([LEASE_ID]));
    const restarted = providerWithRunner(runCommand);
    const lease = await restarted.provision(profile);
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
    expect(calls.filter((argv) => argv[1] !== "heartbeat").map((argv) => argv[1])).toEqual([
      "warmup",
      ...(failure === "inspect" ? ["inspect"] : []),
      "warmup",
      "inspect",
      "run",
      "stop",
    ]);
  },
);

it("keeps authoritative absence after warmup retryable and un-stopped", async () => {
  const { provider, calls } = recordedProvider({
    inspect: commandResult({ code: 4, stderr: `lease/server not found: ${LEASE_ID}` }),
    stop: async () => {
      throw new Error("authoritative absence must not tombstone the fixed ID");
    },
  });

  const error = await provider.provision().catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({
    message: "Crabbox warmup lease was not found during inspection",
  });
  expect(error).not.toMatchObject({ code: "invalid_profile" });
  expectActions(calls, "warmup inspect");
});

it.each(["terminal", "different lease"] as const)(
  "reports the recorded failure after warmup exits (%s)",
  async (inspection) => {
    const stderr = 'coordinator PUT: http 409: {"error":"fixed_lease_terminal"}';
    const diagnosis = "No available EC2 Mac Dedicated Host; allocate a host or set CRABBOX_HOST_ID";
    const secret = `sk-${"privatecredential".repeat(80)}`;
    const { provider, calls } = recordedProvider({
      warmup: commandResult({ code: 1, stderr }),
      inspect: commandResult({
        stdout: inspectJson({
          id: inspection === "different lease" ? "cbx_012345abcdef" : LEASE_ID,
          state: "failed",
          failureError: `${diagnosis}\nAuthorization: Bearer ${secret}\n${"fallback failed; ".repeat(80)}`,
        }),
      }),
    });

    const error: unknown = await provider.provision().catch((cause: unknown) => cause);
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
    expectActions(calls, "warmup inspect");
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
  expect(error).toMatchObject({ message: expect.stringContaining("cannot be replayed safely") });
  expect(runCommand).not.toHaveBeenCalled();
});

it("expires readiness at its own deadline before setup starts", async () => {
  const calls: string[] = [];
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const provider = providerWithRunner(
    async (argv) => {
      calls.push(argv[1]!);
      return readyResult(argv, { ready: false });
    },
    undefined,
    async () => {
      elapsed += resolveCrabboxProvisionBaseTimeoutMs(PROFILE) + 1;
    },
  );

  await expect(provider.provision({ ...PROFILE, setup: "install-node" })).rejects.toThrow(
    "exceeded its provider deadline",
  );

  expect(calls).toEqual(["warmup", "inspect"]);
});

it.each<[WorkerProfile, string, Parameters<WorkerProvider["provision"]>[2]?]>([
  [{}, "execution mode is unsupported", { executionMode: "unsupported" as never }],
  [{}, "target must be", { os: "windows/unknown" }],
  [{}, "machine class must be", { machineClass: "x".repeat(129) }],
  [{ provider: " " }, "provider"],
  [{ class: null }, "class"],
  [{ warmImage: "yes" }, "warmImage must be a boolean"],
  [{ ttl: "garbage" }, "positive Go duration"],
  [{ ttl: "0.1ns" }, "positive Go duration"],
  [{ ttl: "999999999999999999999h" }, "positive Go duration"],
  [{ binary: " " }, "binary"],
  [{ binary: "crabbox" }, "absolute path"],
  [{ setupSecrets: "TOKEN" }, "map of store SecretRefs"],
  [{ typo: true }, "unknown"],
  [{ setup: "  " }, "Crabbox profile setup must be a non-empty command string"],
  [{ desktop: "yes" }, "Crabbox profile desktop must be a boolean"],
  [{ provider: "gcp", desktop: true }, "desktop profiles support only"],
])("rejects invalid provision input %j (%s, options %j)", async (patch, message, options) => {
  const runCommand = vi.fn<CrabboxCommandRunner>();
  const provider = providerWithRunner(runCommand);
  await expect(
    provider.provision({ ...PROFILE, ...patch }, OPERATION_ID, options),
  ).rejects.toMatchObject({
    code: "invalid_profile",
    message: expect.stringContaining(message),
  });
  expect(runCommand).not.toHaveBeenCalled();
});

it("renews before idle expiry", async () => {
  const { provider, heartbeat } = heartbeatFixture(async () => commandResult());
  const profile = { ...PROFILE, idleTimeout: "1s" };

  await expect(provider.provision(profile)).resolves.toMatchObject({ leaseId: LEASE_ID });
  await vi.advanceTimersByTimeAsync(0);
  expect(heartbeat).toHaveBeenCalledExactlyOnceWith(
    [
      SIBLING_BINARY,
      ...`heartbeat --provider aws --id ${LEASE_ID} --idle-timeout 1s --json`.split(" "),
    ],
    expect.objectContaining({ timeoutMs: 500 }),
  );
  await vi.advanceTimersByTimeAsync(499);
  expect(heartbeat).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(heartbeat).toHaveBeenCalledTimes(2);
});

it("fences heartbeat before a delayed or failed teardown binary acquisition", async () => {
  vi.useFakeTimers();
  const heartbeatStarted = createDeferred<AbortSignal>();
  let heartbeatCount = 0;
  const { provider } = recordedProvider({
    heartbeat: async (_argv, options) => {
      heartbeatCount += 1;
      heartbeatStarted.resolve(options.signal!);
      return await new Promise<SpawnResult>((resolve) => {
        options.signal!.addEventListener("abort", () => resolve(commandResult()), { once: true });
      });
    },
  });
  await provider.inspect(lifecycleLease());
  await vi.advanceTimersByTimeAsync(0);
  const signal = await heartbeatStarted.promise;
  const acquisition = delayedBinary();
  const destroy = provider.destroy(
    lifecycleLease(LEASE_ID, {
      ...PROFILE,
      binary: path.resolve(path.sep, "unavailable", "crabbox"),
    }),
  );
  const rejected = expect(destroy).rejects.toThrow("fixture acquisition failed");
  try {
    await acquisition.started;
    expect(signal.aborted).toBe(true);
  } finally {
    acquisition.reject(new Error("fixture acquisition failed"));
    await rejected;
    vi.useRealTimers();
  }
  expect(heartbeatCount).toBe(1);
});

it.each([
  ["unsupported", `Crabbox provider aws does not support heartbeat for worker lease ${LEASE_ID}`],
  ["transport", "Crabbox heartbeat execution failed: transport unavailable"],
  ["conflict", `Crabbox heartbeat failed with exit code 2: lease ${LEASE_ID} claim changed; retry`],
] as const)("settles heartbeat %s failures", async (failure, warning) => {
  let attempts = 0;
  const { provider, heartbeat, warnings } = heartbeatFixture(async () => {
    if (attempts++ > 0) {
      return commandResult();
    }
    if (failure === "transport") {
      throw new Error("transport unavailable");
    }
    return commandResult({
      code: 2,
      stderr:
        failure === "unsupported"
          ? "provider=aws does not support lease heartbeat"
          : `lease ${LEASE_ID} claim changed; retry\n`,
    });
  });
  await expect(provider.inspect(lifecycleLease())).resolves.toEqual(active);
  await vi.advanceTimersByTimeAsync(0);
  expect(warnings).toEqual([
    `${warning}; cloud worker machines may be reaped after 60m of coordinator-idle time`,
  ]);
  await provider.inspect(lifecycleLease());
  await vi.advanceTimersByTimeAsync(59_999);
  expect(heartbeat).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(failure === "unsupported" ? 120_001 : 1);
  expect(heartbeat).toHaveBeenCalledTimes(failure === "unsupported" ? 1 : 2);
  expect(warnings).toHaveLength(1);
});

it("keeps inspection and teardown available for persisted setupEnv leases without capturing them", async () => {
  vi.useFakeTimers();
  const { provider, calls } = recordedProvider();
  const profile = {
    ...PROFILE,
    warmImage: true,
    setup: "install-node",
    setupEnv: ["ARTIFACT_TOKEN"],
  };

  expect(provider.resolveDestroyTimeoutMs?.(profile)).toBe(CRABBOX_STOP_TIMEOUT_MS + 20_000);
  await expect(provider.inspect(lifecycleLease(LEASE_ID, profile))).resolves.toEqual(active);
  await provider.destroy(lifecycleLease(LEASE_ID, profile));
  expectActions(calls, "inspect stop");
  expect(secretEgressRuntime.withSetupSecretEgress).not.toHaveBeenCalled();
});

it("maps deleted leases to unknown without renewing them", async () => {
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

  await expect(provider.inspect(lease)).resolves.toEqual(active);
  await vi.advanceTimersByTimeAsync(0);
  expect(heartbeats).toHaveBeenCalledTimes(1);
  inspection = inspectJson({ state: "deleted", ready: false });
  await expect(provider.inspect(lease)).resolves.toStrictEqual({ status: "unknown" });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(heartbeats).toHaveBeenCalledTimes(1);
});

it("rejects deleted leases during provision even if SSH is ready", async () => {
  const { provider, calls } = recordedProvider({
    inspect: commandResult({ stdout: inspectJson({ state: "deleted", ready: true }) }),
  });
  await expect(provider.provision(CLASSLESS_PROFILE)).rejects.toMatchObject({
    code: "cleanup_complete",
    message: "Crabbox warmup lease entered a terminal state",
  });
  expectActions(calls, "warmup inspect stop");
});

it("maps lease recognition failures to unknown while observation failures still throw", async () => {
  const lease = lifecycleLease();
  for (const [stderr, unknown] of [
    [`lease/droplet not found: ${LEASE_ID}`, true],
    [`unikraftcloud lease ${LEASE_ID} no longer exists`, true],
    [`credential profile not found while inspecting lease ${LEASE_ID}`, false],
    [`nomad job for lease ${LEASE_ID} is missing or inaccessible`, false],
  ] as const) {
    const provider = providerWithRunner(async () => commandResult({ code: 4, stderr }));
    const result = expect(provider.inspect(lease));
    if (unknown) {
      await result.resolves.toStrictEqual({ status: "unknown" });
    } else {
      await result.rejects.toThrow("inspect failed with exit code 4");
    }
  }
  const cliMissing = providerWithRunner(async () => {
    throw new Error("spawn ENOENT");
  });
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
        ? provider.provision({ ...PROFILE, provider: "machine0" })
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
