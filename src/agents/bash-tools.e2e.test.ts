import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import { captureEnv } from "../test-utils/env.js";
import { getFinishedSession, resetProcessRegistryForTests } from "./bash-process-registry.js";
import { createExecTool, createProcessTool } from "./bash-tools.js";
import { resolveShellFromPath, sanitizeBinaryOutput } from "./shell-utils.js";

const isWin = process.platform === "win32";
const defaultShell = isWin
  ? undefined
  : process.env.OPENCLAW_TEST_SHELL || resolveShellFromPath("bash") || process.env.SHELL || "sh";
// PowerShell: Start-Sleep for delays, ; for command separation, $null for null device
const shortDelayCmd = isWin ? "Start-Sleep -Milliseconds 15" : "sleep 0.015";
const yieldDelayCmd = isWin ? "Start-Sleep -Milliseconds 70" : "sleep 0.07";
const longDelayCmd = isWin ? "Start-Sleep -Milliseconds 500" : "sleep 0.5";
const POLL_INTERVAL_MS = 15;
const TEST_EXEC_DEFAULTS = { security: "full" as const, ask: "off" as const };
const createTestExecTool = (
  defaults?: Parameters<typeof createExecTool>[0],
): ReturnType<typeof createExecTool> => createExecTool({ ...TEST_EXEC_DEFAULTS, ...defaults });
const execTool = createTestExecTool();
const processTool = createProcessTool();
// Both PowerShell and bash use ; for command separation
const joinCommands = (commands: string[]) => commands.join("; ");
const echoAfterDelay = (message: string) => joinCommands([shortDelayCmd, `echo ${message}`]);
const echoLines = (lines: string[]) => joinCommands(lines.map((line) => `echo ${line}`));
const normalizeText = (value?: string) =>
  sanitizeBinaryOutput(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n")
    .trim();

async function waitForCompletion(sessionId: string) {
  let status = "running";
  await expect
    .poll(
      async () => {
        const poll = await processTool.execute("call-wait", {
          action: "poll",
          sessionId,
        });
        status = (poll.details as { status: string }).status;
        return status;
      },
      { timeout: process.platform === "win32" ? 8000 : 1200, interval: POLL_INTERVAL_MS },
    )
    .not.toBe("running");
  return status;
}

async function runBackgroundEchoLines(lines: string[]) {
  const result = await execTool.execute("call1", {
    command: echoLines(lines),
    background: true,
  });
  const sessionId = (result.details as { sessionId: string }).sessionId;
  await waitForCompletion(sessionId);
  return sessionId;
}

beforeEach(() => {
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
});

describe("exec tool backgrounding", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["SHELL"]);
    if (!isWin && defaultShell) {
      process.env.SHELL = defaultShell;
    }
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it(
    "backgrounds after yield and can be polled",
    async () => {
      const result = await execTool.execute("call1", {
        command: joinCommands([yieldDelayCmd, "echo done"]),
        yieldMs: 10,
      });

      expect(result.details.status).toBe("running");
      const sessionId = (result.details as { sessionId: string }).sessionId;

      let output = "";
      await expect
        .poll(
          async () => {
            const poll = await processTool.execute("call2", {
              action: "poll",
              sessionId,
            });
            const status = (poll.details as { status: string }).status;
            const textBlock = poll.content.find((c) => c.type === "text");
            output = textBlock?.text ?? "";
            return status;
          },
          { timeout: process.platform === "win32" ? 8000 : 1200, interval: POLL_INTERVAL_MS },
        )
        .toBe("completed");

      expect(output).toContain("done");
    },
    isWin ? 15_000 : 5_000,
  );

  it("supports explicit background", async () => {
    const result = await execTool.execute("call1", {
      command: echoAfterDelay("later"),
      background: true,
    });

    expect(result.details.status).toBe("running");
    const sessionId = (result.details as { sessionId: string }).sessionId;

    const list = await processTool.execute("call2", { action: "list" });
    const sessions = (list.details as { sessions: Array<{ sessionId: string }> }).sessions;
    expect(sessions.some((s) => s.sessionId === sessionId)).toBe(true);
  });

  it("derives a session name from the command", async () => {
    const result = await execTool.execute("call1", {
      command: "echo hello",
      background: true,
    });
    const sessionId = (result.details as { sessionId: string }).sessionId;
    await expect
      .poll(
        async () => {
          const list = await processTool.execute("call2", { action: "list" });
          const sessions = (
            list.details as { sessions: Array<{ sessionId: string; name?: string }> }
          ).sessions;
          return sessions.find((s) => s.sessionId === sessionId)?.name;
        },
        { timeout: process.platform === "win32" ? 8000 : 1200, interval: POLL_INTERVAL_MS },
      )
      .toBe("echo hello");
  });

  it("uses default timeout when timeout is omitted", async () => {
    const customBash = createTestExecTool({ timeoutSec: 0.1, backgroundMs: 10 });
    const customProcess = createProcessTool();

    const result = await customBash.execute("call1", {
      command: longDelayCmd,
      background: true,
    });

    const sessionId = (result.details as { sessionId: string }).sessionId;
    await expect
      .poll(
        async () => {
          const poll = await customProcess.execute("call2", {
            action: "poll",
            sessionId,
          });
          return (poll.details as { status: string }).status;
        },
        { timeout: 3000, interval: POLL_INTERVAL_MS },
      )
      .toBe("failed");
  });

  it("rejects elevated requests when not allowed", async () => {
    const customBash = createTestExecTool({
      elevated: { enabled: true, allowed: false, defaultLevel: "off" },
      messageProvider: "telegram",
      sessionKey: "agent:main:main",
    });

    await expect(
      customBash.execute("call1", {
        command: "echo hi",
        elevated: true,
      }),
    ).rejects.toThrow("Context: provider=telegram session=agent:main:main");
  });

  it("does not default to elevated when not allowed", async () => {
    const customBash = createTestExecTool({
      elevated: { enabled: true, allowed: false, defaultLevel: "on" },
      backgroundMs: 1000,
      timeoutSec: 5,
    });

    const result = await customBash.execute("call1", {
      command: "echo hi",
    });
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("hi");
  });

  it("logs line-based slices and defaults to last lines", async () => {
    const result = await execTool.execute("call1", {
      command: echoLines(["one", "two", "three"]),
      background: true,
    });
    const sessionId = (result.details as { sessionId: string }).sessionId;

    const status = await waitForCompletion(sessionId);

    const log = await processTool.execute("call3", {
      action: "log",
      sessionId,
      limit: 2,
    });
    const textBlock = log.content.find((c) => c.type === "text");
    expect(normalizeText(textBlock?.text)).toBe("two\nthree");
    expect((log.details as { totalLines?: number }).totalLines).toBe(3);
    expect(status).toBe("completed");
  });

  it("defaults process log to a bounded tail when no window is provided", async () => {
    const lines = Array.from({ length: 201 }, (_value, index) => `line-${index + 1}`);
    const sessionId = await runBackgroundEchoLines(lines);

    const log = await processTool.execute("call2", {
      action: "log",
      sessionId,
    });
    const textBlock = log.content.find((c) => c.type === "text")?.text ?? "";
    const firstLine = textBlock.split("\n")[0]?.trim();
    expect(textBlock).toContain("showing last 200 of 201 lines");
    expect(firstLine).toBe("line-2");
    expect(textBlock).toContain("line-2");
    expect(textBlock).toContain("line-201");
    expect((log.details as { totalLines?: number }).totalLines).toBe(201);
  });

  it("supports line offsets for log slices", async () => {
    const result = await execTool.execute("call1", {
      command: echoLines(["alpha", "beta", "gamma"]),
      background: true,
    });
    const sessionId = (result.details as { sessionId: string }).sessionId;
    await waitForCompletion(sessionId);

    const log = await processTool.execute("call2", {
      action: "log",
      sessionId,
      offset: 1,
      limit: 1,
    });
    const textBlock = log.content.find((c) => c.type === "text");
    expect(normalizeText(textBlock?.text)).toBe("beta");
  });

  it("keeps offset-only log requests unbounded by default tail mode", async () => {
    const lines = Array.from({ length: 201 }, (_value, index) => `line-${index + 1}`);
    const sessionId = await runBackgroundEchoLines(lines);

    const log = await processTool.execute("call2", {
      action: "log",
      sessionId,
      offset: 30,
    });

    const textBlock = log.content.find((c) => c.type === "text")?.text ?? "";
    const renderedLines = textBlock.split("\n");
    expect(renderedLines[0]?.trim()).toBe("line-31");
    expect(renderedLines[renderedLines.length - 1]?.trim()).toBe("line-201");
    expect(textBlock).not.toContain("showing last 200");
    expect((log.details as { totalLines?: number }).totalLines).toBe(201);
  });

  it("scopes process sessions by scopeKey", async () => {
    const bashA = createTestExecTool({ backgroundMs: 10, scopeKey: "agent:alpha" });
    const processA = createProcessTool({ scopeKey: "agent:alpha" });
    const bashB = createTestExecTool({ backgroundMs: 10, scopeKey: "agent:beta" });
    const processB = createProcessTool({ scopeKey: "agent:beta" });

    const resultA = await bashA.execute("call1", {
      command: shortDelayCmd,
      background: true,
    });
    const resultB = await bashB.execute("call2", {
      command: shortDelayCmd,
      background: true,
    });

    const sessionA = (resultA.details as { sessionId: string }).sessionId;
    const sessionB = (resultB.details as { sessionId: string }).sessionId;

    const listA = await processA.execute("call3", { action: "list" });
    const sessionsA = (listA.details as { sessions: Array<{ sessionId: string }> }).sessions;
    expect(sessionsA.some((s) => s.sessionId === sessionA)).toBe(true);
    expect(sessionsA.some((s) => s.sessionId === sessionB)).toBe(false);

    const pollB = await processB.execute("call4", {
      action: "poll",
      sessionId: sessionA,
    });
    const pollBDetails = pollB.details as { status?: string };
    expect(pollBDetails.status).toBe("failed");
  });
});

describe("exec exit codes", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["SHELL"]);
    if (!isWin && defaultShell) {
      process.env.SHELL = defaultShell;
    }
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("treats non-zero exits as completed and appends exit code", async () => {
    const command = isWin
      ? joinCommands(["Write-Output nope", "exit 1"])
      : joinCommands(["echo nope", "exit 1"]);
    const result = await execTool.execute("call1", { command });
    const resultDetails = result.details as { status?: string; exitCode?: number | null };
    expect(resultDetails.status).toBe("completed");
    expect(resultDetails.exitCode).toBe(1);

    const text = normalizeText(result.content.find((c) => c.type === "text")?.text);
    expect(text).toContain("nope");
    expect(text).toContain("Command exited with code 1");
  });
});

describe("exec notifyOnExit", () => {
  it("enqueues a system event when a backgrounded exec exits", async () => {
    const tool = createTestExecTool({
      allowBackground: true,
      backgroundMs: 0,
      notifyOnExit: true,
      sessionKey: "agent:main:main",
    });

    const result = await tool.execute("call1", {
      command: echoAfterDelay("notify"),
      background: true,
    });

    expect(result.details.status).toBe("running");
    const sessionId = (result.details as { sessionId: string }).sessionId;

    const prefix = sessionId.slice(0, 8);
    let finished = getFinishedSession(sessionId);
    let hasEvent = peekSystemEvents("agent:main:main").some((event) => event.includes(prefix));
    await expect
      .poll(
        () => {
          finished = getFinishedSession(sessionId);
          hasEvent = peekSystemEvents("agent:main:main").some((event) => event.includes(prefix));
          return Boolean(finished && hasEvent);
        },
        { timeout: isWin ? 12_000 : 5_000, interval: POLL_INTERVAL_MS },
      )
      .toBe(true);
    if (!finished) {
      finished = getFinishedSession(sessionId);
    }
    if (!hasEvent) {
      hasEvent = peekSystemEvents("agent:main:main").some((event) => event.includes(prefix));
    }

    expect(finished).toBeTruthy();
    expect(hasEvent).toBe(true);
  });

  it("skips no-op completion events when command succeeds without output", async () => {
    const tool = createTestExecTool({
      allowBackground: true,
      backgroundMs: 0,
      notifyOnExit: true,
      sessionKey: "agent:main:main",
    });

    const result = await tool.execute("call2", {
      command: shortDelayCmd,
      background: true,
    });

    expect(result.details.status).toBe("running");
    const sessionId = (result.details as { sessionId: string }).sessionId;
    const status = await waitForCompletion(sessionId);
    expect(status).toBe("completed");
    expect(peekSystemEvents("agent:main:main")).toEqual([]);
  });

  it("can re-enable no-op completion events via notifyOnExitEmptySuccess", async () => {
    const tool = createTestExecTool({
      allowBackground: true,
      backgroundMs: 0,
      notifyOnExit: true,
      notifyOnExitEmptySuccess: true,
      sessionKey: "agent:main:main",
    });

    const result = await tool.execute("call3", {
      command: shortDelayCmd,
      background: true,
    });

    expect(result.details.status).toBe("running");
    const sessionId = (result.details as { sessionId: string }).sessionId;
    const status = await waitForCompletion(sessionId);
    expect(status).toBe("completed");
    const events = peekSystemEvents("agent:main:main");
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.includes("Exec completed"))).toBe(true);
  });
});

describe("exec PATH handling", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["PATH", "SHELL"]);
    if (!isWin && defaultShell) {
      process.env.SHELL = defaultShell;
    }
  });

  afterEach(() => {
    envSnapshot.restore();
  });

  it("prepends configured path entries", async () => {
    const basePath = isWin ? "C:\\Windows\\System32" : "/usr/bin";
    const prepend = isWin ? ["C:\\custom\\bin", "C:\\oss\\bin"] : ["/custom/bin", "/opt/oss/bin"];
    process.env.PATH = basePath;

    const tool = createTestExecTool({ pathPrepend: prepend });
    const result = await tool.execute("call1", {
      command: isWin ? "Write-Output $env:PATH" : "echo $PATH",
    });

    const text = normalizeText(result.content.find((c) => c.type === "text")?.text);
    const entries = text.split(path.delimiter);
    expect(entries.slice(0, prepend.length)).toEqual(prepend);
    expect(entries).toContain(basePath);
  });
});
