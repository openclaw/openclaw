import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { createNodeBootstrapFixture } from "./crabbox-worker-node-enrollment.test-support.js";
import {
  commandResult,
  createWarmProvider,
  LEASE_ID,
  OPERATION_ID,
  PROFILE as WARM_PROFILE,
  provisionWarmProfile,
} from "./crabbox-worker-warm-image.test-support.js";

const PROFILE = { ...WARM_PROFILE, warmImage: false };
const HOST_KEY = [["ssh", "ed25519"].join("-"), "AAAA"].join(" ");

function inspectJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: LEASE_ID,
    providerMetadata: { instanceProfileAttached: false },
    state: "running",
    ready: true,
    sshUser: "openclaw",
    ...overrides,
  });
}

describe("Crabbox desktop provisioning", () => {
  it.each(
    (["windows/normal", "macos"] as const).flatMap((target) => [
      { target, osOverride: false },
      { target, osOverride: true },
    ]),
  )(
    "provisions $target with placement override=$osOverride through the enrolled node",
    async ({ target, osOverride }) => {
      let warmed = false;
      const { provider, calls } = createWarmProvider(async ({ argv }) => {
        if (argv[1] === "warmup") {
          warmed = true;
          return commandResult({ stdout: `leased ${LEASE_ID} slug=test\n` });
        }
        if (argv[1] === "inspect") {
          return warmed
            ? commandResult({ stdout: inspectJson() })
            : commandResult({ code: 4, stderr: `lease/server not found: ${LEASE_ID}` });
        }
        return undefined;
      });
      const profile = {
        ...WARM_PROFILE,
        desktop: true,
        ...(osOverride ? {} : { target }),
      };
      const options = osOverride ? { os: target } : undefined;
      expect(provider.supportsProjectPreparation?.(profile, "standard", options?.os)).toBe(false);
      const result = await provisionWarmProfile(
        provider,
        profile,
        OPERATION_ID,
        undefined,
        options,
      );
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
      expect(warmup).not.toContain("--browser");
      expect(warmup).not.toContain("--desktop-env");
      expect(warmup).not.toContain("xfce");
      const browser = result.desktop?.apps?.find((app) => app.id === "browser");
      expect(browser?.executablePath).toMatch(
        target === "macos" ? /^\/var\/db\/crabbox\// : /^C:\\/,
      );
      if (target === "windows/normal") {
        expect(browser?.args).toContain("-File");
      }
      await provider.destroy({ ...result, profile });
      expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(1);
      expect(calls.some(({ argv }) => argv[1] === "checkpoint")).toBe(false);
    },
  );

  it.each([
    {
      name: "direct AWS",
      providerId: "aws",
      config: { aws: { instanceProfile: "" }, coordinator: "", brokerMode: "managed" },
    },
    {
      name: "coordinator-backed AWS",
      providerId: "aws",
      config: {
        aws: { instanceProfile: "" },
        coordinator: "https://coordinator.example.test",
        brokerMode: "managed",
      },
    },
    {
      name: "direct Azure",
      providerId: "azure",
      config: { coordinator: "", brokerMode: "managed" },
    },
    {
      name: "coordinator-backed Azure",
      providerId: "azure",
      config: {
        coordinator: "https://coordinator.example.test",
        brokerMode: "managed",
      },
    },
    {
      name: "coordinator-backed Hetzner",
      providerId: "hetzner",
      config: {
        coordinator: "https://coordinator.example.test",
        brokerMode: "managed",
      },
    },
  ])("provisions a node-carried desktop through $name", async ({ config, providerId }) => {
    const setupOrder: string[] = [];
    const setupStarted = createDeferred<void>();
    const setupComplete = createDeferred<void>();
    const { provider, calls } = createWarmProvider(async ({ argv, options }) => {
      if (argv[1] === "config" && argv[2] === "show") {
        return commandResult({ stdout: JSON.stringify(config) });
      }
      if (argv[1] === "inspect" || argv[1] === "status") {
        return commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
      }
      if (argv[1] === "run" && String(options.input).includes("openclaw-worker-browser")) {
        setupOrder.push("desktop");
        setupStarted.resolve();
        await setupComplete.promise;
      }
      return undefined;
    });

    let completed = false;
    const provision = provisionWarmProfile(
      provider,
      { ...PROFILE, provider: providerId, desktop: true },
      OPERATION_ID,
      undefined,
      {
        beginNodeEnrollment: async () => {
          setupOrder.push("enrollment");
          return {
            mode: "connect" as const,
            setupCode: "secret-setup-value",
            setupId: "setup-id",
            openclawVersion: "2026.8.1",
            nodeBootstrap: createNodeBootstrapFixture(),
            displayName: "Cloud worker test",
            waitForDeviceId: async () => "device-1",
          };
        },
      },
    ).finally(() => {
      completed = true;
    });
    await setupStarted.promise;
    try {
      expect(completed).toBe(false);
      expect(calls.some(({ argv }) => argv[1] === "heartbeat")).toBe(false);
    } finally {
      setupComplete.resolve();
    }
    await expect(provision).resolves.toEqual({
      leaseId: LEASE_ID,
      node: { deviceId: "device-1" },
      sharedHost: false,
      desktop: {
        protocol: "rfb",
        port: 5900,
        passwordFilePath: "/var/lib/crabbox/vnc.password",
        apps: [
          {
            id: "browser",
            executablePath: "/usr/local/bin/openclaw-worker-browser",
            cdpPort: 9222,
          },
          {
            id: "terminal",
            executablePath: "/usr/local/bin/openclaw-worker-terminal",
          },
        ],
      },
    });
    expect(calls.find((call) => call.argv[1] === "warmup")).toEqual(
      expect.objectContaining({
        options: expect.objectContaining({ timeoutMs: 100 * 60_000 }),
      }),
    );
    expect(calls.find((call) => call.argv[1] === "warmup")?.argv.slice(-4)).toEqual([
      "--desktop",
      "--browser",
      "--desktop-env",
      "xfce",
    ]);
    expect(provider.allowsDesktopResize).toBe(true);
    expect(
      provider.resolveProvisionTimeoutMs?.({
        ...PROFILE,
        provider: providerId,
        desktop: true,
      }),
    ).toBe(149 * 60_000 + 15_000);
    expect(calls.filter(({ argv }) => argv[1] === "run")).toHaveLength(1);
    expect(calls.find(({ argv }) => argv[1] === "run")?.options.timeoutMs).toBe(30 * 60_000);
    expect(setupOrder).toEqual(["enrollment", "desktop"]);
    expect(calls.filter(({ argv }) => argv[1] === "inspect")).toHaveLength(1);
  });

  it.each(["desktop setup", "enrollment preparation", "enrollment completion"] as const)(
    "reports confirmed cleanup after %s failure",
    async (failurePoint) => {
      const { provider, calls } = createWarmProvider(async ({ argv, options }) => {
        if (argv[1] === "inspect") {
          return commandResult({ stdout: inspectJson({ sshHostKey: HOST_KEY }) });
        }
        if (
          failurePoint === "desktop setup" &&
          argv[1] === "run" &&
          String(options.input).includes("openclaw-worker-browser")
        ) {
          return commandResult({ code: 9, stderr: "desktop setup failed" });
        }
        return undefined;
      });

      const failure = await provisionWarmProfile(
        provider,
        { ...PROFILE, desktop: true },
        OPERATION_ID,
        undefined,
        {
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
        },
      ).catch((error: unknown) => error);
      expect(WorkerProviderError.isCleanupComplete(failure)).toBe(true);
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
      expect(WorkerProviderError.isCleanupIndeterminate(failure)).toBe(false);
      expect(calls.at(-1)?.argv).toEqual([
        "crabbox",
        "stop",
        "--provider",
        "aws",
        "--id",
        LEASE_ID,
      ]);
      expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(1);
    },
  );

  it.each([
    { name: "missing account", sshUser: undefined, afterSetup: false, stopFails: false },
    { name: "malformed account", sshUser: "bad user", afterSetup: false, stopFails: false },
    { name: "missing account after setup", sshUser: undefined, afterSetup: true, stopFails: false },
    {
      name: "malformed account after setup",
      sshUser: "bad user",
      afterSetup: true,
      stopFails: false,
    },
    {
      name: "malformed account and failed stop",
      sshUser: "bad user",
      afterSetup: false,
      stopFails: true,
    },
  ])("settles macOS desktop cleanup for $name", async ({ sshUser, afterSetup, stopFails }) => {
    let setupCompleted = false;
    const { provider, calls } = createWarmProvider(({ argv, options }) => {
      if (argv[1] === "inspect") {
        return commandResult({
          stdout: inspectJson({ sshUser: afterSetup && !setupCompleted ? "openclaw" : sshUser }),
        });
      }
      if (argv[1] === "run" && options.input === "profile-setup") {
        setupCompleted = true;
      }
      if (argv[1] === "stop" && stopFails) {
        return commandResult({ code: 9, stderr: "lease stop failed" });
      }
      return undefined;
    });
    const beginNodeEnrollment = vi.fn(async () => {
      throw new Error("enrollment must not begin for an invalid desktop account");
    });
    const failure = await provisionWarmProfile(
      provider,
      {
        ...PROFILE,
        target: "macos",
        desktop: true,
        ...(afterSetup ? { setup: "profile-setup" } : {}),
      },
      OPERATION_ID,
      undefined,
      { beginNodeEnrollment },
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: stopFails ? "cleanup_indeterminate" : "cleanup_complete",
      leaseId: LEASE_ID,
      provisionError: { message: expect.stringContaining("account") },
      ...(stopFails
        ? { cleanupError: { message: expect.stringContaining("lease stop failed") } }
        : {}),
    });
    expect(beginNodeEnrollment).not.toHaveBeenCalled();
    expect(calls.filter(({ argv }) => argv[1] === "inspect")).toHaveLength(afterSetup ? 2 : 1);
    expect(
      calls.filter(({ argv }) => argv[1] === "run").map(({ options }) => options.input),
    ).toEqual(afterSetup ? ["profile-setup"] : []);
    expect(calls.filter(({ argv }) => argv[1] === "stop").map(({ argv }) => argv.slice(1))).toEqual(
      [["stop", "--provider", "aws", "--id", LEASE_ID]],
    );
    expect(calls.some(({ argv }) => argv[1] === "heartbeat")).toBe(false);
  });
});
