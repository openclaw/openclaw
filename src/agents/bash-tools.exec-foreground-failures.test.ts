import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createExecTool } from "./bash-tools.exec.js";
import { resolveShellFromPath } from "./shell-utils.js";

const isWin = process.platform === "win32";
const defaultShell = isWin
  ? undefined
  : process.env.OPENCLAW_TEST_SHELL || resolveShellFromPath("bash") || process.env.SHELL || "sh";
const longDelayCmd = isWin ? "Start-Sleep -Seconds 5" : "sleep 5";

describe("exec foreground failures", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    vi.useRealTimers();
    envSnapshot = captureEnv(["SHELL"]);
    if (!isWin && defaultShell) {
      process.env.SHELL = defaultShell;
    }
    resetProcessRegistryForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    envSnapshot.restore();
  });

  it("returns a failed text result when the default timeout is exceeded", async () => {
    const tool = createExecTool({
      security: "full",
      ask: "off",
      timeoutSec: 0.05,
      backgroundMs: 10,
      allowBackground: false,
    });

    const result = await tool.execute("call-timeout", {
      command: longDelayCmd,
    });

    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text?: string }).text).toMatch(/timed out/i);
    expect((result.content[0] as { text?: string }).text).toMatch(/re-run with a higher timeout/i);
    expect(result.details).toMatchObject({
      status: "failed",
      exitCode: null,
      aggregated: "",
    });
    expect((result.details as { durationMs?: number }).durationMs).toEqual(expect.any(Number));
  });

  it("ignores operator-only policy fields supplied in tool-call args", async () => {
    const tool = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      allowBackground: false,
    });
    const args = {
      command: "echo policy-ok",
      host: "spark-ff13",
      security: "deny",
      ask: "always",
      elevated: true,
      node: "not-a-real-node",
    } as unknown as Parameters<typeof tool.execute>[1];

    const result = await tool.execute("call-model-policy-fields", args);

    expect(result.details).toMatchObject({
      status: "completed",
      exitCode: 0,
    });
    expect((result.content[0] as { text?: string }).text).toContain("policy-ok");
  });
});
