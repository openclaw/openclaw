import { describe, expect, it, vi } from "vitest";
import { resolveFaceTimeConfig } from "../src/config.js";
import type { FaceTimePreflightResult } from "../src/preflight.js";
import type { FaceTimeRuntimeStatus } from "../src/runtime.js";
import { runFaceTimeSetup } from "../src/setup.js";

const readyPreflight: FaceTimePreflightResult = {
  ok: true,
  helperConnected: true,
  checks: [
    {
      id: "helper-connected",
      label: "FaceTime helper socket",
      ok: true,
      required: true,
      message: "helper connected",
    },
    {
      id: "process-tap",
      label: "FaceTime app-audio process tap",
      ok: true,
      required: true,
      message: "capture ready",
    },
    {
      id: "realtime-provider",
      label: "Realtime provider readiness",
      ok: true,
      required: true,
      message: "openai:gpt-realtime-2.1",
    },
  ],
};

const readyRuntime: FaceTimeRuntimeStatus = {
  enabled: true,
  helperConnected: true,
  helperProtocol: {
    version: 1,
    authentication: "mutual-hmac-sha256-v1",
    eventIntegrity: "epoch-sequence-hmac-v1",
    statusClassifier: "explicit-ended-tu-call-status-v1",
    transportClassifier: "tu-provider-v1",
  },
  helperTargets: (["FaceTime", "Phone"] as const).map((target) => ({
    target,
    connected: true,
    attempts: 0,
    injecting: false,
    queued: false,
    retryScheduled: false,
    stale: false,
  })),
  driverInstallPending: false,
  driverInstall: { phase: "idle" },
  processOutputSuppressed: false,
  calls: [],
};

function readyCommandRunner() {
  return vi.fn(async (argv: string[]) => {
    if (argv[0] === "/bin/test" && (argv[1] === "-x" || argv[1] === "-d")) {
      return { code: 0, stdout: "", stderr: "" };
    }
    if (argv[0] === "/usr/sbin/DevToolsSecurity") {
      return { code: 0, stdout: "Developer mode is currently enabled.\n", stderr: "" };
    }
    if (argv[0] === "/usr/bin/csrutil") {
      return {
        code: 0,
        stdout: "System Integrity Protection status: disabled.\n",
        stderr: "",
      };
    }
    if (argv[0] === "/bin/sh" && argv.at(-1) === "--status") {
      return { code: 0, stdout: "current\n", stderr: "" };
    }
    if (argv[0] === "/bin/bash") {
      return { code: 0, stdout: "true\n", stderr: "" };
    }
    throw new Error(`unexpected command: ${argv.join(" ")}`);
  });
}

function runSetup(overrides: Partial<Parameters<typeof runFaceTimeSetup>[0]> = {}) {
  return runFaceTimeSetup({
    config: resolveFaceTimeConfig({ ownerHandles: ["owner@example.com"] }),
    nativePackageReady: true,
    pluginRoot: "/plugin",
    runCommandWithTimeout: readyCommandRunner() as never,
    runtimeStatus: readyRuntime,
    preflight: readyPreflight,
    readAssertionsFile: async () => JSON.stringify({ data: [{ storeInvalidationRecords: [{}] }] }),
    ...overrides,
  });
}

describe("FaceTime guided setup", () => {
  it.each([
    ["failed", "System Integrity Protection status: disabled.\n", 1, "verify-sip-status"],
    [
      "unrelated substring",
      "Could not read System Integrity Protection status: disabled.\n",
      0,
      "verify-sip-status",
    ],
  ])(
    "reports SIP %s without recommending unnecessary protection changes",
    async (_name, stdout, code, actionId) => {
      const readyRunner = readyCommandRunner();
      const report = await runSetup({
        runCommandWithTimeout: vi.fn(async (argv: string[]) =>
          argv[0] === "/usr/bin/csrutil" ? { code, stdout, stderr: "" } : readyRunner(argv),
        ) as never,
      });
      const check = report.checks.find((entry) => entry.id === "system-integrity-protection");
      expect(check?.status).toBe(actionId ? "action-required" : "ready");
      expect(check?.actionId).toBe(actionId);
      expect(report.readyForTest).toBe(!actionId);
      if (actionId === "verify-sip-status") {
        expect(report.actions.find((entry) => entry.id === actionId)).toMatchObject({
          kind: "command",
          command: "/usr/bin/csrutil status",
        });
        expect(report.actions.some((entry) => entry.id === "disable-sip-debugging")).toBe(false);
      }
    },
  );

  it("turns protected prerequisites into explicit operator actions", async () => {
    const runCommandWithTimeout = vi.fn(async (argv: string[]) => {
      if (argv[0] === "/bin/test" && (argv[1] === "-x" || argv[1] === "-d")) {
        return { code: 1, stdout: "", stderr: "" };
      }
      if (argv[0] === "/usr/bin/xcode-select") {
        return { code: 0, stdout: "/Library/Developer/CommandLineTools\n", stderr: "" };
      }
      if (argv[0] === "/usr/sbin/DevToolsSecurity") {
        return { code: 0, stdout: "Developer mode is currently disabled.\n", stderr: "" };
      }
      if (argv[0] === "/usr/bin/csrutil") {
        return {
          code: 0,
          stdout: "System Integrity Protection status: enabled.\n",
          stderr: "",
        };
      }
      if (argv[0] === "/bin/sh" && argv.at(-1) === "--status") {
        return { code: 0, stdout: "missing\n", stderr: "" };
      }
      if (argv[0] === "/bin/bash") {
        return { code: 0, stdout: "false\n", stderr: "" };
      }
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    });

    const report = await runSetup({
      runCommandWithTimeout: runCommandWithTimeout as never,
      runtimeStatus: undefined,
      preflight: undefined,
      runtimeError: "listen EADDRINUSE: address already in use 127.0.0.1:45670",
      readAssertionsFile: async () =>
        JSON.stringify({ data: [{ storeAssertionRecords: [{ assertionUUID: "active" }] }] }),
    });

    expect(report.ok).toBe(false);
    expect(report.readyForTest).toBe(false);
    expect(runCommandWithTimeout).not.toHaveBeenCalledWith(
      ["/usr/bin/xcode-select", "-p"],
      expect.anything(),
    );
    expect(
      report.checks.filter((check) => check.status === "action-required").map((check) => check.id),
    ).toEqual([
      "xcode-tools",
      "developer-tools-access",
      "system-integrity-protection",
      "runtime",
      "audio-driver",
      "notifications-while-sharing",
    ]);
    expect(report.actions).toEqual(
      expect.arrayContaining(
        [
          ["install-xcode-tools", "command"],
          ["enable-developer-tools", "command"],
          ["disable-sip-debugging", "recovery"],
          ["restart-gateway", "command"],
          ["verify-focus", "system-settings"],
          ["allow-sharing-notifications", "system-settings"],
        ].map(([id, kind]) => expect.objectContaining({ id, kind })),
      ),
    );
    expect(report.actions).toContainEqual(
      expect.objectContaining({ id: "install-driver", gatewayMethod: "facetime.installDriver" }),
    );
    expect(report.actions.find((action) => action.id === "disable-sip-debugging")).toMatchObject({
      command: "csrutil enable --without debug",
    });
  });

  it("shows automatic helper repair without declaring the machine ready", async () => {
    const report = await runSetup({
      runtimeStatus: {
        ...readyRuntime,
        helperConnected: false,
        helperTargets: [
          {
            ...readyRuntime.helperTargets[0]!,
            connected: false,
            attempts: 1,
            retryScheduled: true,
            lastError: "helper did not authenticate",
          },
          readyRuntime.helperTargets[1]!,
        ],
      },
    });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "helper-facetime")).toMatchObject({
      status: "repairing",
      actionId: "wait-for-helper",
      message: "Automatic retry scheduled after: helper did not authenticate",
    });
    expect(report.actions).toContainEqual(
      expect.objectContaining({ id: "wait-for-helper", kind: "automatic" }),
    );
  });

  it("allows manual Focus verification when macOS state cannot be read", async () => {
    const report = await runSetup({
      readAssertionsFile: async () => {
        throw new Error("operation not permitted");
      },
    });

    expect(report.ok).toBe(true);
    expect(report.readyForTest).toBe(true);
    expect(report.liveCallProofRequired).toBe(true);
    expect(report.checks.find((check) => check.id === "focus-mode")).toMatchObject({
      status: "verify-on-call",
      required: false,
      actionId: "verify-focus",
    });
    expect(report.actions).toContainEqual(
      expect.objectContaining({
        id: "verify-focus",
        kind: "system-settings",
      }),
    );
  });

  it("requires a real app restart after stale helper detection", async () => {
    const report = await runSetup({
      runtimeStatus: {
        ...readyRuntime,
        helperTargets: [
          {
            ...readyRuntime.helperTargets[0]!,
            connected: false,
            stale: true,
            staleProcessId: 1234,
            lastError: "Restart FaceTime to load the updated OpenClaw helper",
          },
          readyRuntime.helperTargets[1]!,
        ],
      },
    });

    expect(report.readyForTest).toBe(false);
    expect(report.actions).toContainEqual({
      id: "restart-call-apps",
      kind: "manual-test",
      label: "Quit and reopen FaceTime and Phone, then let OpenClaw reinject the helper",
    });
  });

  it("preserves the aggregate helper failure when no target can be supervised", async () => {
    const report = await runSetup({
      runtimeStatus: {
        ...readyRuntime,
        helperConnected: false,
        helperTargets: [],
      },
      preflight: {
        ...readyPreflight,
        ok: false,
        helperConnected: false,
        checks: readyPreflight.checks.map((check) =>
          check.id === "helper-connected"
            ? Object.assign({}, check, { ok: false, message: "no helper connected" })
            : check,
        ),
      },
    });

    expect(report.readyForTest).toBe(false);
    expect(report.checks.find((check) => check.id === "helper-connected")).toMatchObject({
      status: "action-required",
      required: true,
      message: "no helper connected",
    });
  });

  it("requires Homebrew native repair before runtime activation or driver setup", async () => {
    const runCommandWithTimeout = readyCommandRunner();
    const report = await runSetup({
      nativePackageReady: false,
      runtimeStatus: undefined,
      preflight: undefined,
      runCommandWithTimeout: runCommandWithTimeout as never,
      runtimeError:
        "Compatible FaceTime native helpers are not installed. Run: brew install openclaw/tap/openclaw-facetime",
    });

    expect(report.readyForTest).toBe(false);
    expect(report.checks.find((check) => check.id === "native-package")).toMatchObject({
      status: "action-required",
      actionId: "install-native-package",
    });
    expect(report.checks.find((check) => check.id === "runtime")).toMatchObject({
      status: "action-required",
      actionId: "install-native-package",
    });
    expect(report.checks.find((check) => check.id === "audio-driver")).toMatchObject({
      status: "action-required",
      actionId: "install-native-package",
    });
    expect(report.actions).toContainEqual(
      expect.objectContaining({
        id: "install-native-package",
        kind: "command",
        command:
          "if brew list --versions openclaw-facetime >/dev/null 2>&1; then brew reinstall openclaw/tap/openclaw-facetime; else brew install openclaw/tap/openclaw-facetime; fi",
      }),
    );
    expect(report.actions.map((action) => action.id)).not.toContain("restart-gateway");
    expect(report.actions.map((action) => action.id)).not.toContain("install-driver");
    expect(runCommandWithTimeout).not.toHaveBeenCalledWith(
      ["/bin/sh", "/plugin/scripts/install-driver.sh", "--status"],
      expect.anything(),
    );
  });
});
