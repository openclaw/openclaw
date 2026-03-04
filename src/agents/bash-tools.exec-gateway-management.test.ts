import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listFinishedSessions,
  listRunningSessions,
  resetProcessRegistryForTests,
} from "./bash-process-registry.js";
import type { ProcessGatewayAllowlistResult } from "./bash-tools.exec-host-gateway.js";

const isRestartEnabledMock = vi.fn(() => true);
const loadConfigMock = vi.fn(() => ({ commands: { restart: true } }));
const extractDeliveryInfoMock = vi.fn(() => ({
  deliveryContext: { channel: "telegram", to: "123" },
  threadId: "thread-1",
}));
const writeRestartSentinelMock = vi.fn(async () => {});
const scheduleGatewaySigusr1RestartMock = vi.fn(() => ({
  ok: true,
  pid: process.pid,
  signal: "SIGUSR1" as const,
  delayMs: 2000,
  mode: "emit" as const,
  coalesced: false,
  cooldownMsApplied: 0,
}));
const processGatewayAllowlistMock = vi.fn(
  async (): Promise<ProcessGatewayAllowlistResult> => ({
    pendingResult: undefined,
    execCommandOverride: undefined,
  }),
);

vi.mock("../config/commands.js", () => ({
  isRestartEnabled: (...args: Parameters<typeof isRestartEnabledMock>) =>
    isRestartEnabledMock(...args),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => loadConfigMock(),
}));

vi.mock("../config/sessions/delivery-info.js", () => ({
  extractDeliveryInfo: (...args: Parameters<typeof extractDeliveryInfoMock>) =>
    extractDeliveryInfoMock(...args),
}));

vi.mock("../infra/restart-sentinel.js", () => ({
  formatDoctorNonInteractiveHint: () => "Run: openclaw doctor --non-interactive",
  writeRestartSentinel: (...args: Parameters<typeof writeRestartSentinelMock>) =>
    writeRestartSentinelMock(...args),
}));

vi.mock("../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: (...args: Parameters<typeof scheduleGatewaySigusr1RestartMock>) =>
    scheduleGatewaySigusr1RestartMock(...args),
}));

vi.mock("./bash-tools.exec-host-gateway.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./bash-tools.exec-host-gateway.js")>();
  return {
    ...mod,
    processGatewayAllowlist: (...args: Parameters<typeof processGatewayAllowlistMock>) =>
      processGatewayAllowlistMock(...args),
  };
});

let createExecTool: typeof import("./bash-tools.exec.js").createExecTool;
let detectGatewayManagementExecCommand: typeof import("./bash-tools.exec-gateway-management.js").detectGatewayManagementExecCommand;

beforeAll(async () => {
  ({ createExecTool } = await import("./bash-tools.exec.js"));
  ({ detectGatewayManagementExecCommand } =
    await import("./bash-tools.exec-gateway-management.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  isRestartEnabledMock.mockReturnValue(true);
  loadConfigMock.mockReturnValue({ commands: { restart: true } });
  extractDeliveryInfoMock.mockReturnValue({
    deliveryContext: { channel: "telegram", to: "123" },
    threadId: "thread-1",
  });
  scheduleGatewaySigusr1RestartMock.mockReturnValue({
    ok: true,
    pid: process.pid,
    signal: "SIGUSR1",
    delayMs: 2000,
    mode: "emit",
    coalesced: false,
    cooldownMsApplied: 0,
  });
  processGatewayAllowlistMock.mockResolvedValue({
    pendingResult: undefined,
    execCommandOverride: undefined,
  });
  resetProcessRegistryForTests();
});

afterEach(() => {
  resetProcessRegistryForTests();
});

describe("detectGatewayManagementExecCommand", () => {
  it("detects direct gateway restart commands", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "openclaw gateway restart",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: false,
    });
  });

  it("detects gateway restart commands with supported flags", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "openclaw gateway restart --json",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: false,
      json: true,
    });
  });

  it("detects gateway restart commands with supported root flags", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "openclaw --profile dev gateway restart",
      cwd: process.cwd(),
      env: { ...process.env, OPENCLAW_PROFILE: "dev" },
    });

    expect(detected).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: false,
    });
  });

  it("does not detect profile-scoped restart commands targeting another profile", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "openclaw --profile dev gateway restart",
      cwd: process.cwd(),
      env: { ...process.env, OPENCLAW_PROFILE: "prod" },
    });

    expect(detected).toBeNull();
  });

  it("uses runtime identity env for profile-scoped command matching", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "openclaw --profile dev gateway restart",
      cwd: process.cwd(),
      env: { ...process.env, OPENCLAW_PROFILE: "dev" },
      identityEnv: { ...process.env, OPENCLAW_PROFILE: "prod" },
    });

    expect(detected).toBeNull();
  });

  it("detects package-manager wrapped restart commands", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "pnpm openclaw gateway restart",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: false,
    });
  });

  it("detects npx wrapped restart commands", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "npx openclaw gateway restart",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: false,
    });
  });

  it("detects npx wrapped restart commands with package spec", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "npx openclaw@latest gateway restart",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: false,
    });
  });

  it("detects pnpm exec wrapped restart commands", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "pnpm exec openclaw gateway restart",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: false,
    });
  });

  it("detects pnpm recursive exec wrapped restart commands", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "pnpm -r exec openclaw gateway restart",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: false,
    });
  });

  it("detects pnpm recursive exec wrapped restart commands with workspace concurrency", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "pnpm -r --workspace-concurrency 6 exec openclaw gateway restart",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: false,
    });
  });

  it("detects pnpm exec wrapped restart commands with boolean flags", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "pnpm exec --stream openclaw gateway restart",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: false,
    });
  });

  it("detects pnpm exec wrapped restart commands with parallel flag", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "pnpm exec --parallel openclaw gateway restart",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: false,
    });
  });

  it("detects pnpm -C exec wrapped restart commands", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "pnpm -C /tmp/openclaw exec openclaw gateway restart",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: false,
    });
  });

  it("detects npm exec wrapped restart commands with package option", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "npm exec --package=openclaw -- openclaw gateway restart",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: false,
    });
  });

  it("detects npm exec wrapped restart commands with call option", () => {
    const detected = detectGatewayManagementExecCommand({
      command: 'npm exec -c "openclaw gateway restart"',
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: false,
    });
  });

  it("detects npx wrapped restart commands with call option", () => {
    const detected = detectGatewayManagementExecCommand({
      command: 'npx -c "openclaw gateway restart"',
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: false,
    });
  });

  it("detects bunx wrapped restart commands with --bun flag", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "bunx --bun openclaw gateway restart",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: false,
    });
  });

  it("detects bunx wrapped restart commands with package spec", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "bunx openclaw@latest gateway restart",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: false,
    });
  });

  it("detects bunx wrapped restart commands with package option", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "bunx -p openclaw openclaw gateway restart",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: false,
    });
  });

  it("does not detect bunx-wrapped commands with unknown bunx flags", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "bunx --bogus openclaw gateway restart",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toBeNull();
  });

  it("marks npm exec -c gateway restart command chains as complex", () => {
    const detected = detectGatewayManagementExecCommand({
      command: 'npm exec -c "openclaw gateway restart && echo ok"',
      cwd: process.cwd(),
      env: process.env,
      platform: "linux",
    });

    expect(detected).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: true,
    });
  });

  it("marks unsupported shell tokens around gateway restart as complex", () => {
    const withAmp = detectGatewayManagementExecCommand({
      command: "openclaw gateway restart & echo ok",
      cwd: process.cwd(),
      env: process.env,
      platform: "linux",
    });
    const withRedirect = detectGatewayManagementExecCommand({
      command: "openclaw gateway restart > /tmp/out",
      cwd: process.cwd(),
      env: process.env,
      platform: "linux",
    });
    const withUnspacedRedirect = detectGatewayManagementExecCommand({
      command: "openclaw gateway restart>/tmp/out",
      cwd: process.cwd(),
      env: process.env,
      platform: "linux",
    });

    expect(withAmp).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: true,
    });
    expect(withRedirect).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: true,
    });
    expect(withUnspacedRedirect).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: true,
    });
  });

  it("marks systemctl gateway restart commands with unsupported shell tokens as complex", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl restart openclaw-gateway.service > /tmp/out",
      cwd: process.cwd(),
      env: process.env,
      platform: "linux",
    });

    expect(detected).toEqual({
      action: "restart",
      source: "systemctl",
      hard: false,
      complex: true,
    });
  });

  it("marks chained restart commands as complex", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "openclaw gateway restart && echo ok",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toEqual({
      action: "restart",
      source: "openclaw-cli",
      hard: false,
      complex: true,
    });
  });

  it("does not detect gateway restart help commands", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "openclaw gateway restart --help",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toBeNull();
  });

  it("does not detect root help command paths that contain gateway restart tokens", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "openclaw help gateway restart",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toBeNull();
  });

  it("does not detect root help flag invocations that contain gateway restart tokens", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "openclaw --help gateway restart",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toBeNull();
  });

  it("does not detect root invocations with unknown flags", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "openclaw --bogus gateway restart",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toBeNull();
  });

  it("does not detect gateway restart commands with unsupported flags", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "openclaw gateway restart --bogus",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toBeNull();
  });

  it("does not detect pnpm-wrapped commands with unknown pnpm flags", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "pnpm --bogus openclaw gateway restart",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toBeNull();
  });

  it("does not detect pnpm-wrapped commands when option values are missing", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "pnpm --dir --recursive exec openclaw gateway restart",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toBeNull();
  });

  it("does not detect npx-wrapped commands with unknown npx flags", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "npx --bogus openclaw gateway restart",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toBeNull();
  });

  it("does not detect npm exec wrapped commands with unknown npm flags", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "npm exec --bogus openclaw gateway restart",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toBeNull();
  });

  it("does not detect gateway restart commands with unexpected operands", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "openclaw gateway restart now",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toBeNull();
  });

  it("detects systemctl restart commands for gateway units", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl restart openclaw-gateway.service",
      cwd: process.cwd(),
      env: process.env,
      platform: "linux",
    });

    expect(detected).toEqual({
      action: "restart",
      source: "systemctl",
      hard: false,
      complex: false,
    });
  });

  it("detects systemctl --no-block restart commands for gateway units", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl restart --no-block openclaw-gateway.service",
      cwd: process.cwd(),
      env: process.env,
      platform: "linux",
    });

    expect(detected).toEqual({
      action: "restart",
      source: "systemctl",
      hard: false,
      complex: false,
    });
  });

  it("does not detect systemctl default unit when current profile is non-default", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl restart openclaw-gateway.service",
      cwd: process.cwd(),
      env: { ...process.env, OPENCLAW_PROFILE: "dev" },
      platform: "linux",
    });

    expect(detected).toBeNull();
  });

  it("detects systemctl unit for the active profile", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl restart openclaw-gateway-dev.service",
      cwd: process.cwd(),
      env: { ...process.env, OPENCLAW_PROFILE: "dev" },
      platform: "linux",
    });

    expect(detected).toEqual({
      action: "restart",
      source: "systemctl",
      hard: false,
      complex: false,
    });
  });

  it("does not detect explicit user-scope systemctl commands", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl --user restart openclaw-gateway.service",
      cwd: process.cwd(),
      env: process.env,
      platform: "linux",
    });

    expect(detected).toBeNull();
  });

  it("does not detect explicit system-scope systemctl commands", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl --system restart openclaw-gateway.service",
      cwd: process.cwd(),
      env: process.env,
      platform: "linux",
    });

    expect(detected).toBeNull();
  });

  it("detects launchctl kickstart commands for gateway labels", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "launchctl kickstart -k gui/501/ai.openclaw.gateway",
      cwd: process.cwd(),
      env: process.env,
      platform: "darwin",
    });

    expect(detected).toEqual({
      action: "restart",
      source: "launchctl",
      hard: false,
      complex: false,
    });
  });

  it("does not detect launchctl default label when current profile is non-default", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "launchctl kickstart -k gui/501/ai.openclaw.gateway",
      cwd: process.cwd(),
      env: { ...process.env, OPENCLAW_PROFILE: "dev" },
      platform: "darwin",
    });

    expect(detected).toBeNull();
  });

  it("detects launchctl label for the active profile", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "launchctl kickstart -k gui/501/ai.openclaw.dev",
      cwd: process.cwd(),
      env: { ...process.env, OPENCLAW_PROFILE: "dev" },
      platform: "darwin",
    });

    expect(detected).toEqual({
      action: "restart",
      source: "launchctl",
      hard: false,
      complex: false,
    });
  });

  it("does not detect default launchctl label when OPENCLAW_LAUNCHD_LABEL override is set", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "launchctl kickstart -k gui/501/ai.openclaw.gateway",
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.custom",
      },
      platform: "darwin",
    });

    expect(detected).toBeNull();
  });

  it("does not detect launchctl commands on non-darwin platforms", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "launchctl kickstart -k gui/501/ai.openclaw.gateway",
      cwd: process.cwd(),
      env: process.env,
      platform: "linux",
    });

    expect(detected).toBeNull();
  });

  it("detects schtasks commands for gateway task names", () => {
    const detected = detectGatewayManagementExecCommand({
      command: 'schtasks /Run /TN "OpenClaw Gateway"',
      cwd: process.cwd(),
      env: process.env,
      platform: "win32",
    });

    expect(detected).toEqual({
      action: "restart",
      source: "schtasks",
      hard: false,
      complex: false,
    });
  });

  it("does not detect schtasks default task when current profile is non-default", () => {
    const detected = detectGatewayManagementExecCommand({
      command: 'schtasks /Run /TN "OpenClaw Gateway"',
      cwd: process.cwd(),
      env: { ...process.env, OPENCLAW_PROFILE: "dev" },
      platform: "win32",
    });

    expect(detected).toBeNull();
  });

  it("matches configured OPENCLAW_WINDOWS_TASK_NAME exactly", () => {
    const detected = detectGatewayManagementExecCommand({
      command: 'schtasks /Run /TN "OpenClaw Gateway Dev"',
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAW_PROFILE: "dev",
        OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway Dev",
      },
      platform: "win32",
    });

    expect(detected).toEqual({
      action: "restart",
      source: "schtasks",
      hard: false,
      complex: false,
    });
  });

  it("does not detect default schtasks task name when OPENCLAW_WINDOWS_TASK_NAME override is set", () => {
    const detected = detectGatewayManagementExecCommand({
      command: 'schtasks /Run /TN "OpenClaw Gateway"',
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Gateway Dev",
      },
      platform: "win32",
    });

    expect(detected).toBeNull();
  });

  it("detects schtasks task name for the active profile on windows", () => {
    const detected = detectGatewayManagementExecCommand({
      command: 'schtasks /Run /TN "OpenClaw Gateway (dev)"',
      cwd: process.cwd(),
      env: { ...process.env, OPENCLAW_PROFILE: "dev" },
      platform: "win32",
    });

    expect(detected).toEqual({
      action: "restart",
      source: "schtasks",
      hard: false,
      complex: false,
    });
  });

  it("does not detect prefixed schtasks task names", () => {
    const detected = detectGatewayManagementExecCommand({
      command: 'schtasks /Run /TN "OpenClaw Gateway Backup"',
      cwd: process.cwd(),
      env: process.env,
      platform: "win32",
    });

    expect(detected).toBeNull();
  });

  it("does not detect chained schtasks commands in windows fallback parsing", () => {
    const detected = detectGatewayManagementExecCommand({
      command: 'schtasks /Run /TN "OpenClaw Gateway (dev)" && echo done',
      cwd: process.cwd(),
      env: { ...process.env, OPENCLAW_PROFILE: "dev" },
      platform: "win32",
    });

    expect(detected).toBeNull();
  });

  it("does not detect chained schtasks commands with single ampersand in windows fallback parsing", () => {
    const detected = detectGatewayManagementExecCommand({
      command: 'schtasks /Run /TN "OpenClaw Gateway (dev)" & echo done',
      cwd: process.cwd(),
      env: { ...process.env, OPENCLAW_PROFILE: "dev" },
      platform: "win32",
    });

    expect(detected).toBeNull();
  });

  it("does not detect unspaced chained schtasks commands in windows fallback parsing", () => {
    const detected = detectGatewayManagementExecCommand({
      command: 'schtasks /Run /TN "OpenClaw Gateway (dev)"& echo done',
      cwd: process.cwd(),
      env: { ...process.env, OPENCLAW_PROFILE: "dev" },
      platform: "win32",
    });

    expect(detected).toBeNull();
  });

  it("does not throw for invalid quoting in windows fallback parsing", () => {
    expect(() =>
      detectGatewayManagementExecCommand({
        command: 'schtasks /Run /TN "OpenClaw Gateway (dev)',
        cwd: process.cwd(),
        env: { ...process.env, OPENCLAW_PROFILE: "dev" },
        platform: "win32",
      }),
    ).not.toThrow();
  });

  it("does not detect non-gateway systemctl commands", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl restart ssh.service",
      cwd: process.cwd(),
      env: process.env,
      platform: "linux",
    });

    expect(detected).toBeNull();
  });

  it("does not detect mixed-unit systemctl commands", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl restart openclaw-gateway.service nginx.service",
      cwd: process.cwd(),
      env: process.env,
      platform: "linux",
    });

    expect(detected).toBeNull();
  });

  it("does not detect remote-scope systemctl commands", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl --host remote.example restart openclaw-gateway.service",
      cwd: process.cwd(),
      env: process.env,
      platform: "linux",
    });

    expect(detected).toBeNull();
  });

  it("does not detect short remote-scope systemctl commands", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl -Hremote.example restart openclaw-gateway.service",
      cwd: process.cwd(),
      env: process.env,
      platform: "linux",
    });

    expect(detected).toBeNull();
  });

  it("does not detect systemctl help/version forms", () => {
    const withHelp = detectGatewayManagementExecCommand({
      command: "systemctl restart --help openclaw-gateway.service",
      cwd: process.cwd(),
      env: process.env,
      platform: "linux",
    });
    const withVersion = detectGatewayManagementExecCommand({
      command: "systemctl --version restart openclaw-gateway.service",
      cwd: process.cwd(),
      env: process.env,
      platform: "linux",
    });

    expect(withHelp).toBeNull();
    expect(withVersion).toBeNull();
  });

  it("does not detect systemctl commands with unknown flags", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl --bogus restart openclaw-gateway.service",
      cwd: process.cwd(),
      env: process.env,
      platform: "linux",
    });

    expect(detected).toBeNull();
  });

  it("does not match prefixed systemctl units unless explicitly configured", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl restart openclaw-gateway-prod.service",
      cwd: process.cwd(),
      env: process.env,
      platform: "linux",
    });

    expect(detected).toBeNull();
  });

  it("matches configured OPENCLAW_SYSTEMD_UNIT exactly", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl restart openclaw-gateway-prod.service",
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-prod.service",
      },
      platform: "linux",
    });

    expect(detected).toEqual({
      action: "restart",
      source: "systemctl",
      hard: false,
      complex: false,
    });
  });

  it("does not detect default systemctl unit when OPENCLAW_SYSTEMD_UNIT override is set", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl restart openclaw-gateway.service",
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-prod.service",
      },
      platform: "linux",
    });

    expect(detected).toBeNull();
  });

  it("does not detect systemctl commands on non-linux platforms", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl restart openclaw-gateway.service",
      cwd: process.cwd(),
      env: process.env,
      platform: "darwin",
    });

    expect(detected).toBeNull();
  });

  it("does not detect schtasks commands on non-windows platforms", () => {
    const detected = detectGatewayManagementExecCommand({
      command: 'schtasks /Run /TN "OpenClaw Gateway"',
      cwd: process.cwd(),
      env: process.env,
      platform: "linux",
    });

    expect(detected).toBeNull();
  });

  it("does not detect systemctl commands when option values are missing", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl --lines --quiet restart openclaw-gateway.service",
      cwd: process.cwd(),
      env: process.env,
      platform: "linux",
    });

    expect(detected).toBeNull();
  });
});

describe("exec gateway management interception", () => {
  it("intercepts gateway restart and schedules SIGUSR1 restart without spawning a process", async () => {
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      sessionKey: "agent:main:telegram:123:thread:9",
    });

    const result = await tool.execute("call1", {
      command: "openclaw gateway restart",
    });

    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    expect(result.details).toMatchObject({
      status: "completed",
      exitCode: 0,
    });
    expect(text).toContain("Gateway restart scheduled safely");
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "exec:gateway-restart" }),
    );
    expect(writeRestartSentinelMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "restart",
        sessionKey: "agent:main:telegram:123:thread:9",
      }),
    );
    expect(listRunningSessions()).toHaveLength(0);
    expect(listFinishedSessions()).toHaveLength(0);
  });

  it("does not bypass gateway approval policy for restart interception", async () => {
    processGatewayAllowlistMock.mockResolvedValueOnce({
      pendingResult: {
        content: [{ type: "text", text: "Approval required" }],
        details: {
          status: "approval-pending",
          approvalId: "approval-1",
          approvalSlug: "approval-1",
          expiresAtMs: Date.now() + 60_000,
          host: "gateway",
          command: "openclaw gateway restart",
          cwd: process.cwd(),
        },
      },
      execCommandOverride: undefined,
    });

    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "always",
      sessionKey: "agent:main:telegram:123:thread:9",
    });

    const result = await tool.execute("call1-approval", {
      command: "openclaw gateway restart",
    });

    expect(result.details).toMatchObject({
      status: "approval-pending",
      host: "gateway",
    });
    expect(processGatewayAllowlistMock).toHaveBeenCalledOnce();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
  });

  it("does not intercept when request env retargets gateway profile identity", async () => {
    processGatewayAllowlistMock.mockResolvedValueOnce({
      pendingResult: {
        content: [{ type: "text", text: "allowlist fallback" }],
        details: {
          status: "completed",
          exitCode: 0,
          durationMs: 0,
          aggregated: "allowlist fallback",
          cwd: process.cwd(),
        },
      },
      execCommandOverride: undefined,
    });
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    const runtimeProfile = process.env.OPENCLAW_PROFILE?.trim() || "";
    const retargetProfile = runtimeProfile === "dev" ? "prod" : "dev";
    const result = await tool.execute("call1-retarget-profile", {
      command: "openclaw gateway restart",
      env: { OPENCLAW_PROFILE: retargetProfile },
    });

    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    expect(text).toContain("allowlist fallback");
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(processGatewayAllowlistMock).toHaveBeenCalledOnce();
  });

  it("intercepts gateway restart --json and preserves json output shape", async () => {
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      sessionKey: "agent:main:telegram:123:thread:9",
    });

    const result = await tool.execute("call1-json", {
      command: "openclaw gateway restart --json",
    });

    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    expect(result.details).toMatchObject({
      status: "completed",
      exitCode: 0,
    });
    const payload = JSON.parse(text) as {
      ok: boolean;
      action: string;
      result: string;
      service?: { loaded?: boolean };
    };
    expect(payload).toMatchObject({
      ok: true,
      action: "restart",
      result: "restarted",
      service: { loaded: true },
    });
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "exec:gateway-restart" }),
    );
  });

  it("keeps intercepted gateway restart --json parseable when warnings are present", async () => {
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      allowBackground: false,
    });

    const result = await tool.execute("call1-json-warnings", {
      command: "openclaw gateway restart --json",
      background: true,
    });

    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    const payload = JSON.parse(text) as { warnings?: unknown };
    expect(payload.warnings).toEqual([
      "Warning: background execution is disabled; running synchronously.",
    ]);
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "exec:gateway-restart" }),
    );
  });

  it("blocks gateway restart --hard via exec", async () => {
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call2", {
        command: "openclaw gateway restart --hard",
      }),
    ).rejects.toThrow(/--hard/);

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === "linux")(
    "intercepts systemctl gateway restart commands",
    async () => {
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      const result = await tool.execute("call3-systemctl", {
        command: "systemctl restart openclaw-gateway.service",
      });

      const text = result.content.find((part) => part.type === "text")?.text ?? "";
      expect(result.details).toMatchObject({
        status: "completed",
        exitCode: 0,
      });
      expect(text).toContain("Gateway restart scheduled safely");
      expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
    },
  );

  it.runIf(process.platform === "win32")(
    "intercepts schtasks run commands as restart",
    async () => {
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      const result = await tool.execute("call3-schtasks", {
        command: 'schtasks /Run /TN "OpenClaw Gateway"',
      });

      const text = result.content.find((part) => part.type === "text")?.text ?? "";
      expect(result.details).toMatchObject({
        status: "completed",
        exitCode: 0,
      });
      expect(text).toContain("Gateway restart scheduled safely");
      expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
    },
  );

  it.runIf(process.platform === "darwin")(
    "blocks launchctl stop commands for gateway labels",
    async () => {
      const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

      await expect(
        tool.execute("call3-launchctl-stop", {
          command: "launchctl bootout gui/$UID/ai.openclaw.gateway",
        }),
      ).rejects.toThrow(/openclaw gateway stop/);

      expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    },
  );

  it("blocks gateway stop/start via exec", async () => {
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call3", {
        command: "openclaw gateway stop",
      }),
    ).rejects.toThrow(/openclaw gateway start/);

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
  });

  it("rejects restart when commands.restart is disabled", async () => {
    isRestartEnabledMock.mockReturnValue(false);
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call4", {
        command: "openclaw gateway restart",
      }),
    ).rejects.toThrow(/commands\.restart=false/);

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
  });

  it("does not intercept ordinary gateway-host exec commands", async () => {
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
    const command = process.platform === "win32" ? "Write-Output ok" : "echo ok";

    const result = await tool.execute("call5", { command });

    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    expect(text).toContain("ok");
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
  });
});
