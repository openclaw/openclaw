import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listFinishedSessions,
  listRunningSessions,
  resetProcessRegistryForTests,
} from "./bash-process-registry.js";

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

  it("detects systemctl restart commands for gateway units", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl --user restart openclaw-gateway.service",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toEqual({
      action: "restart",
      source: "systemctl",
      hard: false,
      complex: false,
    });
  });

  it("detects launchctl kickstart commands for gateway labels", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "launchctl kickstart -k gui/501/ai.openclaw.gateway",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toEqual({
      action: "restart",
      source: "launchctl",
      hard: false,
      complex: false,
    });
  });

  it("detects schtasks commands for gateway task names", () => {
    const detected = detectGatewayManagementExecCommand({
      command: 'schtasks /Run /TN "OpenClaw Gateway"',
      cwd: process.cwd(),
      env: process.env,
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
    });

    expect(detected).toBeNull();
  });

  it("does not detect non-gateway systemctl commands", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl --user restart ssh.service",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toBeNull();
  });

  it("does not detect mixed-unit systemctl commands", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl --user restart openclaw-gateway.service nginx.service",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toBeNull();
  });

  it("does not detect remote-scope systemctl commands", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl --host remote.example restart openclaw-gateway.service",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toBeNull();
  });

  it("does not detect short remote-scope systemctl commands", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl -Hremote.example restart openclaw-gateway.service",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toBeNull();
  });

  it("does not match prefixed systemctl units unless explicitly configured", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl --user restart openclaw-gateway-prod.service",
      cwd: process.cwd(),
      env: process.env,
    });

    expect(detected).toBeNull();
  });

  it("matches configured OPENCLAW_SYSTEMD_UNIT exactly", () => {
    const detected = detectGatewayManagementExecCommand({
      command: "systemctl --user restart openclaw-gateway-prod.service",
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCLAW_SYSTEMD_UNIT: "openclaw-gateway-prod.service",
      },
    });

    expect(detected).toEqual({
      action: "restart",
      source: "systemctl",
      hard: false,
      complex: false,
    });
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

  it("blocks gateway restart --hard via exec", async () => {
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call2", {
        command: "openclaw gateway restart --hard",
      }),
    ).rejects.toThrow(/--hard/);

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
  });

  it("intercepts systemctl gateway restart commands", async () => {
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    const result = await tool.execute("call3-systemctl", {
      command: "systemctl --user restart openclaw-gateway.service",
    });

    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    expect(result.details).toMatchObject({
      status: "completed",
      exitCode: 0,
    });
    expect(text).toContain("Gateway restart scheduled safely");
    expect(scheduleGatewaySigusr1RestartMock).toHaveBeenCalledTimes(1);
  });

  it("intercepts schtasks run commands as restart", async () => {
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
  });

  it("blocks launchctl stop commands for gateway labels", async () => {
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call3-launchctl-stop", {
        command: "launchctl bootout gui/$UID/ai.openclaw.gateway",
      }),
    ).rejects.toThrow(/start\/stop/);

    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
  });

  it("blocks gateway stop/start via exec", async () => {
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });

    await expect(
      tool.execute("call3", {
        command: "openclaw gateway stop",
      }),
    ).rejects.toThrow(/start\/stop/);

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
