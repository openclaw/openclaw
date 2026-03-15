import { describe, expect, it } from "vitest";
import {
  applyExecRestartNotifyEnv,
  isOpenClawGatewayRestartCommand,
  RESTART_NOTIFY_MESSAGE,
} from "./bash-tools.exec-restart-notify.js";

describe("bash-tools exec restart notify", () => {
  it("detects direct openclaw gateway restart commands", () => {
    expect(isOpenClawGatewayRestartCommand("openclaw gateway restart")).toBe(true);
    expect(isOpenClawGatewayRestartCommand("openclaw --profile prod gateway restart")).toBe(true);
    expect(isOpenClawGatewayRestartCommand("openclaw gateway status")).toBe(false);
    expect(isOpenClawGatewayRestartCommand("echo hi && openclaw gateway restart")).toBe(false);
  });

  it("injects restart notify env for matching commands", () => {
    const env: Record<string, string> = {};
    const applied = applyExecRestartNotifyEnv({
      command: "openclaw gateway restart",
      env,
      sessionKey: "agent:main:feishu:direct:ou_123",
    });

    expect(applied).toBe(true);
    expect(env.OPENCLAW_RESTART_NOTIFY_SESSION_KEY).toBe("agent:main:feishu:direct:ou_123");
    expect(env.OPENCLAW_RESTART_NOTIFY_CHANNEL).toBe("feishu");
    expect(env.OPENCLAW_RESTART_NOTIFY_TO).toBe("ou_123");
    expect(env.OPENCLAW_RESTART_NOTIFY_MESSAGE).toBe(RESTART_NOTIFY_MESSAGE);
  });

  it("falls back to the session key account id when delivery context is unavailable", () => {
    const env: Record<string, string> = {};

    applyExecRestartNotifyEnv({
      command: "openclaw gateway restart",
      env,
      sessionKey: "agent:main:slack:workspace-1:direct:U123",
    });

    expect(env.OPENCLAW_RESTART_NOTIFY_CHANNEL).toBe("slack");
    expect(env.OPENCLAW_RESTART_NOTIFY_TO).toBe("user:U123");
    expect(env.OPENCLAW_RESTART_NOTIFY_ACCOUNT_ID).toBe("workspace-1");
  });
});
