import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import type { WorkerProfile, WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it, vi } from "vitest";
import { createNodeBootstrapFixture } from "./crabbox-worker-node-enrollment.test-support.js";
import { commandResult, nodeEnrollmentFixture } from "./crabbox-worker-provider.test-support.js";
import {
  createWarmProvider,
  LEASE_ID,
  OPERATION_ID,
  PROFILE as WARM_PROFILE,
  provisionWarmProfile,
  type CommandCall,
  jsonResult,
} from "./crabbox-worker-warm-image.test-support.js";

const PROFILE = { ...WARM_PROFILE, warmImage: false };
const HOST_KEY = [["ssh", "ed25519"].join("-"), "AAAA"].join(" ");

function inspectResult(overrides: Record<string, unknown> = {}) {
  return jsonResult({
    id: LEASE_ID,
    providerMetadata: { instanceProfileAttached: false },
    state: "running",
    ready: true,
    sshUser: "openclaw",
    ...overrides,
  });
}

const commands = (calls: CommandCall[], command: string) =>
  calls.filter(({ argv }) => argv[1] === command);

function desktopFixture(
  command?: Parameters<typeof createWarmProvider>[0],
  profile: WorkerProfile = PROFILE,
) {
  const desktop = { ...profile, desktop: true };
  const fixture = createWarmProvider(
    async (call) =>
      (await command?.(call)) ??
      (call.argv[1] === "inspect" ? inspectResult({ sshHostKey: HOST_KEY }) : undefined),
  );
  return {
    ...fixture,
    provision: (options?: Parameters<WorkerProvider["provision"]>[2]) =>
      provisionWarmProfile(fixture.provider, desktop, OPERATION_ID, undefined, options),
  };
}

it.each([
  { target: "windows/normal", osOverride: false },
  { target: "macos", osOverride: true },
] as const)(
  "provisions $target with placement override=$osOverride through the enrolled node",
  async ({ target, osOverride }) => {
    let warmed = false;
    const profile = { ...WARM_PROFILE, desktop: true, ...(osOverride ? {} : { target }) };
    const { provider, calls, provision } = desktopFixture(async ({ argv }) => {
      if (argv[1] === "warmup") {
        warmed = true;
        return commandResult({ stdout: `leased ${LEASE_ID} slug=test\n` });
      }
      if (argv[1] === "inspect") {
        return warmed
          ? inspectResult()
          : commandResult({ code: 4, stderr: `lease/server not found: ${LEASE_ID}` });
      }
      return undefined;
    }, profile);
    const options = osOverride ? { os: target } : undefined;
    expect(provider.supportsProjectPreparation?.(profile, "standard", options?.os)).toBe(false);
    const result = await provision(options);
    expect(result.node).toEqual({ deviceId: "device-1" });
    expect(result.desktop).toMatchObject({
      protocol: "rfb",
      port: 5900,
      allowsResize: false,
      ...(target === "macos"
        ? {
            username: "openclaw",
            passwordFilePath: `/var/db/crabbox/openclaw-workers/${LEASE_ID}/vnc.password`,
          }
        : { passwordFilePath: String.raw`C:\ProgramData\crabbox\vnc.password` }),
      apps: [{ id: "browser", cdpPort: 9222 }, { id: "terminal" }],
    });
    const warmup = calls.find(({ argv }) => argv[1] === "warmup")!.argv;
    expect(warmup).toContain("--desktop");
    for (const flag of ["--browser", "--desktop-env", "xfce"]) {
      expect(warmup).not.toContain(flag);
    }
    const browser = result.desktop?.apps?.find((app) => app.id === "browser");
    expect(browser?.executablePath).toMatch(target === "macos" ? /^\/var\/db\/crabbox\// : /^C:\\/);
    if (target === "windows/normal") {
      expect(browser?.args).toContain("-File");
    }
    await provider.destroy({ ...result, profile });
    expect(commands(calls, "stop")).toHaveLength(1);
    expect(commands(calls, "checkpoint")).toEqual([]);
  },
);

it.each([
  ["aws", { aws: { instanceProfile: "" }, coordinator: "", brokerMode: "managed" }],
  ["hetzner", { coordinator: "https://coordinator.example.test", brokerMode: "managed" }],
] as const)("provisions a node-carried desktop through %s", async (providerId, config) => {
  const setupOrder: string[] = [];
  const setupStarted = createDeferred<void>();
  const setupComplete = createDeferred<void>();
  const { provider, calls, provision } = desktopFixture(
    async ({ argv, options }) => {
      if (argv[1] === "status") {
        return inspectResult({ sshHostKey: HOST_KEY });
      }
      if (argv[1] === "config" && argv[2] === "show") {
        return commandResult({ stdout: JSON.stringify(config) });
      }
      if (argv[1] === "run" && String(options.input).includes("openclaw-worker-browser")) {
        setupOrder.push("desktop");
        setupStarted.resolve();
        await setupComplete.promise;
      }
      return undefined;
    },
    { ...PROFILE, provider: providerId },
  );

  const completed = vi.fn();
  const operation = provision({
    beginNodeEnrollment: async () => {
      setupOrder.push("enrollment");
      return nodeEnrollmentFixture("secret-setup-value", "Cloud worker test");
    },
  }).finally(completed);
  await setupStarted.promise;
  try {
    expect(completed).not.toHaveBeenCalled();
  } finally {
    setupComplete.resolve();
    await operation;
  }
  await expect(operation).resolves.toEqual({
    leaseId: LEASE_ID,
    node: { deviceId: "device-1" },
    sharedHost: false,
    desktop: {
      protocol: "rfb",
      port: 5900,
      passwordFilePath: "/var/lib/crabbox/vnc.password",
      apps: [
        { id: "browser", executablePath: "/usr/local/bin/openclaw-worker-browser", cdpPort: 9222 },
        { id: "terminal", executablePath: "/usr/local/bin/openclaw-worker-terminal" },
      ],
    },
  });
  const [warmup] = commands(calls, "warmup");
  expect(warmup).toMatchObject({ options: { timeoutMs: 100 * 60_000 } });
  expect(warmup?.argv.slice(-4)).toEqual(["--desktop", "--browser", "--desktop-env", "xfce"]);
  expect(provider.allowsDesktopResize).toBe(true);
  expect(commands(calls, "run")).toMatchObject([{ options: { timeoutMs: 30 * 60_000 } }]);
  expect(setupOrder).toEqual(["enrollment", "desktop"]);
  expect(commands(calls, "inspect")).toHaveLength(1);
});

it.each(["desktop setup", "enrollment preparation", "enrollment completion"] as const)(
  "reports confirmed cleanup after %s failure",
  async (failurePoint) => {
    const { calls, provision } = desktopFixture(async ({ argv, options }) => {
      if (
        failurePoint === "desktop setup" &&
        argv[1] === "run" &&
        String(options.input).includes("openclaw-worker-browser")
      ) {
        return commandResult({ code: 9, stderr: "desktop setup failed" });
      }
      return undefined;
    });

    const failure = await provision({
      beginNodeEnrollment: async () => {
        if (failurePoint === "enrollment preparation") {
          throw new Error("enrollment preparation failed");
        }
        return {
          mode: "resume" as const,
          deviceId: "device-bound",
          openclawVersion: "2026.8.1",
          nodeBootstrap: createNodeBootstrapFixture(),
          displayName: "Bound worker",
          waitForDeviceId: async () => {
            if (failurePoint === "enrollment completion") {
              throw new Error("enrollment completion failed");
            }
            return "device-bound";
          },
        };
      },
    }).catch((error: unknown) => error);
    if (!WorkerProviderError.isCleanupComplete(failure)) {
      throw new Error("expected confirmed worker cleanup");
    }
    expect(failure).toMatchObject({
      code: "cleanup_complete",
      leaseId: LEASE_ID,
      message: expect.stringContaining(
        failurePoint === "desktop setup" ? "setup failed" : failurePoint,
      ),
    });
    expect(failure.cause).toBe(failure.provisionError);
    expect(calls.at(-1)?.argv).toEqual(["crabbox", "stop", "--provider", "aws", "--id", LEASE_ID]);
    expect(commands(calls, "stop")).toHaveLength(1);
  },
);

it.each([
  ["missing account", undefined, false, false],
  ["malformed account after setup", "bad user", true, false],
  ["malformed account and failed stop", "bad user", false, true],
] as const)(
  "settles macOS desktop cleanup for %s",
  async (_name, sshUser, afterSetup, stopFails) => {
    let setupCompleted = false;
    const { calls, provision } = desktopFixture(
      ({ argv, options }) => {
        if (argv[1] === "inspect") {
          return inspectResult({ sshUser: afterSetup && !setupCompleted ? "openclaw" : sshUser });
        }
        if (argv[1] === "run" && options.input === "profile-setup") {
          setupCompleted = true;
        }
        if (argv[1] === "stop" && stopFails) {
          return commandResult({ code: 9, stderr: "lease stop failed" });
        }
        return undefined;
      },
      { ...PROFILE, target: "macos", ...(afterSetup ? { setup: "profile-setup" } : {}) },
    );
    const beginNodeEnrollment = vi.fn(async () => {
      throw new Error("enrollment must not begin for an invalid desktop account");
    });
    const failure = await provision({ beginNodeEnrollment }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: stopFails ? "cleanup_indeterminate" : "cleanup_complete",
      leaseId: LEASE_ID,
      provisionError: { message: expect.stringContaining("account") },
      ...(stopFails
        ? { cleanupError: { message: expect.stringContaining("lease stop failed") } }
        : {}),
    });
    expect(beginNodeEnrollment).not.toHaveBeenCalled();
    expect(commands(calls, "inspect")).toHaveLength(afterSetup ? 2 : 1);
    expect(commands(calls, "run").map(({ options }) => options.input)).toEqual(
      afterSetup ? ["profile-setup"] : [],
    );
    expect(commands(calls, "stop").map(({ argv }) => argv.slice(1))).toEqual([
      ["stop", "--provider", "aws", "--id", LEASE_ID],
    ]);
    expect(commands(calls, "heartbeat")).toEqual([]);
  },
);
