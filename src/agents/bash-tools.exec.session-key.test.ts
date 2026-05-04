import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalsResolved } from "../infra/exec-approvals.js";
import { captureEnv } from "../test-utils/env.js";
import { sanitizeBinaryOutput } from "./shell-utils.js";

const isWin = process.platform === "win32";
const FOREGROUND_TEST_YIELD_MS = 120_000;
type GetShellPathFromLoginShell = typeof import("../infra/shell-env.js").getShellPathFromLoginShell;
const shellEnvMocks = vi.hoisted(() => ({
  getShellPathFromLoginShell: vi.fn<GetShellPathFromLoginShell>(() => "/usr/bin:/bin"),
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

describe("exec OPENCLAW_SESSION_KEY env injection", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeAll(async () => {
    ({ createExecTool } = await import("./bash-tools.exec.js"));
  });

  beforeEach(() => {
    envSnapshot = captureEnv(["PATH", "SHELL", "OPENCLAW_SESSION_KEY"]);
    shellEnvMocks.getShellPathFromLoginShell.mockReset();
    shellEnvMocks.getShellPathFromLoginShell.mockReturnValue("/usr/bin:/bin");
    shellEnvMocks.resolveShellEnvFallbackTimeoutMs.mockReset();
    shellEnvMocks.resolveShellEnvFallbackTimeoutMs.mockReturnValue(1234);
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("exposes defaults.sessionKey as $OPENCLAW_SESSION_KEY for host=gateway commands", async () => {
    if (isWin) {
      return;
    }

    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      sessionKey: "agent:eva:msteams:direct:test-session",
    });
    const result = await tool.execute("call-session-key", {
      command: 'printf "%s" "${OPENCLAW_SESSION_KEY:-MISSING}"',
      yieldMs: FOREGROUND_TEST_YIELD_MS,
    });
    const value = normalizeText(result.content.find((c) => c.type === "text")?.text);

    expect(value).toBe("agent:eva:msteams:direct:test-session");
  });

  it("does not set $OPENCLAW_SESSION_KEY when defaults.sessionKey is absent", async () => {
    if (isWin) {
      return;
    }
    delete process.env.OPENCLAW_SESSION_KEY;

    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
    const result = await tool.execute("call-no-session-key", {
      command: 'printf "%s" "${OPENCLAW_SESSION_KEY:-NOT_SET}"',
      yieldMs: FOREGROUND_TEST_YIELD_MS,
    });
    const value = normalizeText(result.content.find((c) => c.type === "text")?.text);

    expect(value).toBe("NOT_SET");
  });

  it("does not overwrite a caller-supplied OPENCLAW_SESSION_KEY in params.env", async () => {
    if (isWin) {
      return;
    }

    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      sessionKey: "agent:eva:msteams:direct:from-defaults",
    });
    const result = await tool.execute("call-caller-wins", {
      command: 'printf "%s" "${OPENCLAW_SESSION_KEY:-MISSING}"',
      env: { OPENCLAW_SESSION_KEY: "caller-wins" },
      yieldMs: FOREGROUND_TEST_YIELD_MS,
    });
    const value = normalizeText(result.content.find((c) => c.type === "text")?.text);

    expect(value).toBe("caller-wins");
  });
});
