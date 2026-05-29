import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.js";
import { __testing, createExecTool } from "./bash-tools.exec.js";
import { resolveShellFromPath } from "./shell-utils.js";

const isWin = process.platform === "win32";
const defaultShell = isWin
  ? undefined
  : process.env.OPENCLAW_TEST_SHELL || resolveShellFromPath("bash") || process.env.SHELL || "sh";
const longDelayCmd = isWin ? "Start-Sleep -Seconds 5" : "sleep 5";
const fakeSecretOutput = "OPENAI_API_KEY=sk-proj-redaction-canary-1234567890";

describe("exec foreground failures", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempRoot: string | undefined;

  beforeEach(() => {
    vi.useRealTimers();
    envSnapshot = captureEnv(["HOME", "USERPROFILE", "OPENCLAW_HOME", "SHELL"]);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-exec-foreground-failures-"));
    process.env.HOME = tempRoot;
    process.env.USERPROFILE = tempRoot;
    process.env.OPENCLAW_HOME = tempRoot;
    if (!isWin && defaultShell) {
      process.env.SHELL = defaultShell;
    }
    resetProcessRegistryForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    const dir = tempRoot;
    tempRoot = undefined;
    envSnapshot.restore();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

    expect(result.content[0]?.type).toBe("text");
    expect((result.content[0] as { text?: string }).text).toMatch(/timed out/i);
    expect((result.content[0] as { text?: string }).text).toMatch(/re-run with a higher timeout/i);
    const details = result.details as {
      status?: string;
      exitCode?: number | null;
      aggregated?: string;
      durationMs?: number;
    };
    expect(details.status).toBe("failed");
    expect(details.exitCode).toBeNull();
    expect(details.aggregated).toBe("");
    expect(details.durationMs).toBeTypeOf("number");
    expect(details.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("redacts secret-shaped stdout before returning foreground results", () => {
    const result = __testing.buildExecForegroundResult({
      outcome: {
        status: "completed",
        exitCode: 0,
        exitSignal: null,
        durationMs: 1,
        aggregated: `${fakeSecretOutput}\n`,
        timedOut: false,
      },
    });

    const text = (result.content[0] as { text?: string }).text ?? "";
    const details = result.details as { aggregated?: string };
    expect(text).not.toContain(fakeSecretOutput);
    expect(details.aggregated).not.toContain(fakeSecretOutput);
    expect(text).toContain("OPENAI_API_KEY=sk-pro…7890");
    expect(details.aggregated).toContain("OPENAI_API_KEY=sk-pro…7890");
  });

  it("redacts secret-shaped warning text before returning foreground results", () => {
    const result = __testing.buildExecForegroundResult({
      warningText: `Warning: ${fakeSecretOutput}`,
      outcome: {
        status: "completed",
        exitCode: 0,
        exitSignal: null,
        durationMs: 1,
        aggregated: "ok\n",
        timedOut: false,
      },
    });

    const text = (result.content[0] as { text?: string }).text ?? "";
    expect(text).not.toContain(fakeSecretOutput);
    expect(text).toContain("OPENAI_API_KEY=sk-pro…7890");
  });

  it("redacts secret-shaped output from background exec details tail", () => {
    const result = __testing.buildExecRunningResult({
      sessionId: "sess-redact-background",
      pid: 12345,
      startedAt: Date.now(),
      cwd: "/tmp",
      tail: `${fakeSecretOutput}\n`,
    });

    const details = result.details as { status?: string; tail?: string };
    expect(details.status).toBe("running");
    expect(details.tail).not.toContain(fakeSecretOutput);
    expect(details.tail).toContain("OPENAI_API_KEY=***");
  });

  it("redacts secret-shaped warning text before returning background exec results", () => {
    const result = __testing.buildExecRunningResult({
      warningText: `Warning: ${fakeSecretOutput}\n\n`,
      sessionId: "sess-redact-background-warning",
      pid: 12345,
      startedAt: Date.now(),
      cwd: "/tmp",
      tail: "still running\n",
    });

    const text = (result.content[0] as { text?: string }).text ?? "";
    expect(text).not.toContain(fakeSecretOutput);
    expect(text).toContain("OPENAI_API_KEY=sk-pro…7890");
    expect(text).toContain("7890\n\nCommand still running");
    expect(text).toContain("Command still running");
  });

  it("rejects invalid host values before launching a command", async () => {
    const tool = createExecTool({
      security: "full",
      ask: "off",
      allowBackground: false,
    });
    for (const testCase of [
      {
        host: "spark-ff13",
        message: 'Invalid exec host "spark-ff13". Allowed values: auto, sandbox, gateway, node.',
      },
      {
        host: 42,
        message:
          "Invalid exec host value type number. Allowed values: auto, sandbox, gateway, node.",
      },
    ]) {
      const malformedArgs = {
        command: "echo should-not-run",
        host: testCase.host,
      } as unknown as Parameters<typeof tool.execute>[1];

      await expect(tool.execute("call-invalid-host", malformedArgs)).rejects.toThrow(
        testCase.message,
      );
    }
  });
});
