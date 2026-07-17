import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readStateDirDotEnvFromStateDir } from "../config/state-dir-dotenv.js";
import {
  formatTrustedGithubEnvKeys,
  TRUSTED_GITHUB_ENV_KEYS_VAR,
} from "../daemon/service-managed-env.js";
import type { ExecApprovalsResolved } from "../infra/exec-approvals.js";
import { captureEnv } from "../test-utils/env.js";
import { sanitizeBinaryOutput } from "./shell-utils.js";

const isWin = process.platform === "win32";
const FOREGROUND_TEST_YIELD_MS = 120_000;

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
      if (command.includes("GITHUB_TOKEN")) {
        input.onStdout?.(env.GITHUB_TOKEN ?? "");
      } else if (command.includes("GH_TOKEN")) {
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
    token: "test-auth-token",
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
      socket: { path: "/tmp/exec-approvals.sock", token: "test-auth-token" },
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
    envSnapshot = captureEnv([
      "GH_TOKEN",
      "GITHUB_TOKEN",
      TRUSTED_GITHUB_ENV_KEYS_VAR,
      "PATH",
      "SHELL",
    ]);
    process.env.GH_TOKEN = "test-token-placeholder";
    process.env[TRUSTED_GITHUB_ENV_KEYS_VAR] = "GH_TOKEN";
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
    expect(value).toBe("test-token-placeholder");
  });

  it("carries case-normalized state-dir GitHub provenance through to the exec child", async () => {
    if (isWin) {
      return;
    }
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gh-env-"));
    try {
      await fs.writeFile(
        path.join(stateDir, ".env"),
        "github_token=test-token-placeholder\nAWS_ACCESS_KEY_ID=blocked\n",
      );
      const stateDirEnv = readStateDirDotEnvFromStateDir(stateDir).entries;
      Object.assign(process.env, stateDirEnv);
      process.env[TRUSTED_GITHUB_ENV_KEYS_VAR] = formatTrustedGithubEnvKeys(stateDirEnv);

      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
      const result = await tool.execute("call-state-dir", {
        command: 'printf "%s" "${GITHUB_TOKEN:-}"',
        yieldMs: FOREGROUND_TEST_YIELD_MS,
      });

      const value = normalizeText(result.content.find((c) => c.type === "text")?.text);
      expect(value).toBe("test-token-placeholder");
      expect(process.env[TRUSTED_GITHUB_ENV_KEYS_VAR]).toBe("GITHUB_TOKEN");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
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
    expect(value).not.toContain("test-token-placeholder");
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
    expect(value).not.toContain("test-token-placeholder");
  });
});
