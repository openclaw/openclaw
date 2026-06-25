import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalsResolved } from "../infra/exec-approvals.js";
import { captureEnv } from "../test-utils/env.js";
import { sanitizeBinaryOutput } from "./shell-utils.js";

const isWin = process.platform === "win32";
const FOREGROUND_TEST_YIELD_MS = 120_000;
const FIXTURE_GH_TOKEN = "REDACTED-FIXTURE-gh-trusted-env";

type GetShellPathFromLoginShell = typeof import("../infra/shell-env.js").getShellPathFromLoginShell;
const shellEnvMocks = vi.hoisted(() => ({
  getShellPathFromLoginShell: vi.fn<GetShellPathFromLoginShell>(() => "/custom/bin:/opt/bin"),
  resolveShellEnvFallbackTimeoutMs: vi.fn(() => 1234),
}));

vi.mock("../infra/shell-env.js", async () => {
  const mod =
    await vi.importActual<typeof import("../infra/shell-env.js")>("../infra/shell-env.js");
  return {
    ...mod,
    getShellPathFromLoginShell: shellEnvMocks.getShellPathFromLoginShell,
    resolveShellEnvFallbackTimeoutMs: shellEnvMocks.resolveShellEnvFallbackTimeoutMs,
  };
});

vi.mock("../infra/exec-approvals.js", async () => {
  const mod = await vi.importActual<typeof import("../infra/exec-approvals.js")>(
    "../infra/exec-approvals.js",
  );
  return { ...mod, resolveExecApprovals: () => createExecApprovals() };
});

// Bypass the gateway allowlist / approval gate so env composition (which
// happens before the gate) reaches supervisor.spawn under every posture
// under test. The wiring we are proving is sanitizeHostExecEnv +
// resolveTrustedExecAllowlist at the exec call site, not the approval flow.
vi.mock("./bash-tools.exec-host-gateway.js", () => ({
  processGatewayAllowlist: async () => ({
    pendingResult: undefined,
    execCommandOverride: undefined,
    allowWithoutEnforcedCommand: false,
  }),
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => ({
    spawn: async (input: {
      argv?: string[];
      env?: NodeJS.ProcessEnv;
      onStdout?: (chunk: string) => void;
    }) => {
      const command = input.argv?.at(-1) ?? "";
      const env = input.env ?? {};
      if (command.includes("GH_TOKEN")) {
        input.onStdout?.(env.GH_TOKEN ?? "");
      }
      return {
        runId: "mock-trusted-env-run",
        startedAtMs: Date.now(),
        stdin: undefined,
        wait: async () => ({
          reason: "exit" as const,
          exitCode: 0,
          exitSignal: null,
          durationMs: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          noOutputTimedOut: false,
        }),
        cancel: vi.fn(),
      };
    },
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    reconcileOrphans: vi.fn(),
    getRecord: vi.fn(),
  }),
}));

let createExecTool: typeof import("./bash-tools.exec.js").createExecTool;

function createExecApprovals(): ExecApprovalsResolved {
  return {
    path: "/tmp/exec-approvals.json",
    socketPath: "/tmp/exec-approvals.sock",
    token: "token",
    defaults: {
      security: "full",
      ask: "off",
      askFallback: "full",
      autoAllowSkills: false,
    },
    agent: {
      security: "full",
      ask: "off",
      askFallback: "full",
      autoAllowSkills: false,
    },
    agentSources: {
      security: "defaults.security",
      ask: "defaults.ask",
      askFallback: "defaults.askFallback",
    },
    allowlist: [],
    file: {
      version: 1,
      socket: { path: "/tmp/exec-approvals.sock", token: "token" },
      defaults: {
        security: "full",
        ask: "off",
        askFallback: "full",
        autoAllowSkills: false,
      },
      agents: {},
    },
  };
}

const normalizeText = (value?: string) =>
  sanitizeBinaryOutput(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();

describe("exec trusted-env wiring (host=gateway)", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeAll(async () => {
    ({ createExecTool } = await import("./bash-tools.exec.js"));
  });

  beforeEach(() => {
    envSnapshot = captureEnv(["GH_TOKEN", "OPENCLAW_SERVICE_MANAGED_ENV_KEYS", "PATH", "SHELL"]);
    process.env.GH_TOKEN = FIXTURE_GH_TOKEN;
    process.env.OPENCLAW_SERVICE_MANAGED_ENV_KEYS = "GH_TOKEN";
    shellEnvMocks.getShellPathFromLoginShell.mockReset();
    shellEnvMocks.getShellPathFromLoginShell.mockReturnValue("/custom/bin:/opt/bin");
    shellEnvMocks.resolveShellEnvFallbackTimeoutMs.mockReset();
    shellEnvMocks.resolveShellEnvFallbackTimeoutMs.mockReturnValue(1234);
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("trusted full/off lets GH_TOKEN reach the exec child", async () => {
    if (isWin) {
      return;
    }

    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
    const result = await tool.execute("call-trusted", {
      command: 'printf "%s" "${GH_TOKEN:-}"',
      yieldMs: FOREGROUND_TEST_YIELD_MS,
    });

    const value = normalizeText(result.content.find((c) => c.type === "text")?.text);
    expect(value).toBe(FIXTURE_GH_TOKEN);
  });

  it("allowlist/off strips GH_TOKEN from the exec child", async () => {
    if (isWin) {
      return;
    }

    const tool = createExecTool({ host: "gateway", security: "allowlist", ask: "off" });
    const result = await tool.execute("call-allowlist", {
      command: 'printf "%s" "${GH_TOKEN:-}"',
      yieldMs: FOREGROUND_TEST_YIELD_MS,
    });

    const value = normalizeText(result.content.find((c) => c.type === "text")?.text);
    expect(value).not.toContain(FIXTURE_GH_TOKEN);
  });

  it("full/always (prompted) strips GH_TOKEN from the exec child", async () => {
    if (isWin) {
      return;
    }

    const tool = createExecTool({ host: "gateway", security: "full", ask: "always" });
    const result = await tool.execute("call-prompted", {
      command: 'printf "%s" "${GH_TOKEN:-}"',
      yieldMs: FOREGROUND_TEST_YIELD_MS,
    });

    const value = normalizeText(result.content.find((c) => c.type === "text")?.text);
    expect(value).not.toContain(FIXTURE_GH_TOKEN);
  });
});
