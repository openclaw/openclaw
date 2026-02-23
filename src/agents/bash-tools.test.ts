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
const shortDelayCmd = isWin ? "Start-Sleep -Milliseconds 4" : "sleep 0.004";
const yieldDelayCmd = isWin ? "Start-Sleep -Milliseconds 16" : "sleep 0.016";
const longDelayCmd = isWin ? "Start-Sleep -Milliseconds 72" : "sleep 0.072";
const POLL_INTERVAL_MS = 15;
const BACKGROUND_POLL_TIMEOUT_MS = isWin ? 8000 : 1200;
const NOTIFY_EVENT_TIMEOUT_MS = isWin ? 12_000 : 5_000;
const TEST_EXEC_DEFAULTS = { security: "full" as const, ask: "off" as const };
const DEFAULT_NOTIFY_SESSION_KEY = "agent:main:main";
type ExecToolConfig = Exclude<Parameters<typeof createExecTool>[0], undefined>;
const createTestExecTool = (
  defaults?: Parameters<typeof createExecTool>[0],
): ReturnType<typeof createExecTool> => createExecTool({ ...TEST_EXEC_DEFAULTS, ...defaults });
const createNotifyOnExitExecTool = (overrides: Partial<ExecToolConfig> = {}) =>
  createTestExecTool({
    allowBackground: true,
    backgroundMs: 0,
    notifyOnExit: true,
    sessionKey: DEFAULT_NOTIFY_SESSION_KEY,
    ...overrides,
  });
const createScopedToolSet = (scopeKey: string) => ({
  exec: createTestExecTool({ backgroundMs: 10, scopeKey }),
  process: createProcessTool({ scopeKey }),
});
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
type ToolTextContent = Array<{ type: string; text?: string }>;
const readTextContent = (content: ToolTextContent) =>
  content.find((part) => part.type === "text")?.text;
const readNormalizedTextContent = (content: ToolTextContent) =>
  normalizeText(readTextContent(content));
const readTrimmedLines = (content: ToolTextContent) =>
  (readTextContent(content) ?? "").split("\n").map((line) => line.trim());
const readTotalLines = (details: unknown) => (details as { totalLines?: number }).totalLines;

function applyDefaultShellEnv() {
  if (!isWin && defaultShell) {
    process.env.SHELL = defaultShell;
  }
}

function useCapturedEnv(keys: string[], afterCapture?: () => void) {
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(keys);
    afterCapture?.();
  });

  afterEach(() => {
    envSnapshot.restore();
  });
}

function useCapturedShellEnv() {
  useCapturedEnv(["SHELL"], applyDefaultShellEnv);
}

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
      { timeout: BACKGROUND_POLL_TIMEOUT_MS, interval: POLL_INTERVAL_MS },
    )
    .not.toBe("running");
  return status;
}

function requireSessionId(details: { sessionId?: string }): string {
  if (!details.sessionId) {
    throw new Error("expected sessionId in exec result details");
  }
  return details.sessionId;
}

function hasNotifyEventForPrefix(prefix: string): boolean {
  return peekSystemEvents(DEFAULT_NOTIFY_SESSION_KEY).some((event) => event.includes(prefix));
}

async function startBackgroundSession(params: {
  tool: ReturnType<typeof createExecTool>;
  callId: string;
  command: string;
}) {
  const result = await params.tool.execute(params.callId, {
    command: params.command,
    background: true,
  });
  expect(result.details.status).toBe("running");
  return requireSessionId(result.details as { sessionId?: string });
}

async function runBackgroundEchoLines(lines: string[]) {
  const sessionId = await startBackgroundSession({
    tool: execTool,
    callId: "call1",
    command: echoLines(lines),
  });
  await waitForCompletion(sessionId);
  return sessionId;
}

async function readProcessLog(
  sessionId: string,
  options: { offset?: number; limit?: number } = {},
) {
  return processTool.execute("call-log", {
    action: "log",
    sessionId,
    ...options,
  });
}

type ProcessLogResult = Awaited<ReturnType<typeof readProcessLog>>;
const readLogSnapshot = (log: ProcessLogResult) => ({
  text: readTextContent(log.content) ?? "",
  lines: readTrimmedLines(log.content),
  totalLines: readTotalLines(log.details),
});
const createNumberedLines = (count: number) =>
  Array.from({ length: count }, (_value, index) => `line-${index + 1}`);
const LONG_LOG_LINE_COUNT = 201;

async function runBackgroundAndReadProcessLog(
  lines: string[],
  options: { offset?: number; limit?: number } = {},
) {
  const sessionId = await runBackgroundEchoLines(lines);
  return readProcessLog(sessionId, options);
}
const readLongProcessLog = (options: { offset?: number; limit?: number } = {}) =>
  runBackgroundAndReadProcessLog(createNumberedLines(LONG_LOG_LINE_COUNT), options);

async function runBackgroundAndWaitForCompletion(params: {
  tool: ReturnType<typeof createExecTool>;
  callId: string;
  command: string;
}) {
  const sessionId = await startBackgroundSession(params);
  const status = await waitForCompletion(sessionId);
  expect(status).toBe("completed");
  return { sessionId };
}

beforeEach(() => {
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
});

describe("exec tool backgrounding", () => {
  useCapturedShellEnv();

  it(
    "backgrounds after yield and can be polled",
    async () => {
      const result = await execTool.execute("call1", {
        command: joinCommands([yieldDelayCmd, "echo done"]),
        yieldMs: 10,
      });

      // Timing can race here: command may already be complete before the first response.
      if (result.details.status === "completed") {
        const text = readTextContent(result.content) ?? "";
        expect(text).toContain("done");
        return;
      }

      expect(result.details.status).toBe("running");
      const sessionId = requireSessionId(result.details as { sessionId?: string });

      let output = "";
      await expect
        .poll(
          async () => {
            const poll = await processTool.execute("call2", {
              action: "poll",
              sessionId,
            });
            const status = (poll.details as { status: string }).status;
            output = readTextContent(poll.content) ?? "";
            return status;
          },
          { timeout: BACKGROUND_POLL_TIMEOUT_MS, interval: POLL_INTERVAL_MS },
        )
        .toBe("completed");

      expect(output).toContain("done");
    },
    isWin ? 15_000 : 5_000,
  );

  it("supports explicit background and derives session name from the command", async () => {
    const sessionId = await startBackgroundSession({
      tool: execTool,
      callId: "call1",
      command: "echo hello",
    });

    const list = await processTool.execute("call2", { action: "list" });
    const sessions = (list.details as { sessions: Array<{ sessionId: string; name?: string }> })
      .sessions;
    expect(sessions.some((s) => s.sessionId === sessionId)).toBe(true);
    expect(sessions.find((s) => s.sessionId === sessionId)?.name).toBe("echo hello");
  });

  it("uses default timeout when timeout is omitted", async () => {
    const customBash = createTestExecTool({
      timeoutSec: 0.05,
      backgroundMs: 10,
      allowBackground: false,
    });
    await expect(
      customBash.execute("call1", {
        command: longDelayCmd,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it("rejects elevated requests when not allowed", async () => {
    const customBash = createTestExecTool({
      elevated: { enabled: true, allowed: false, defaultLevel: "off" },
      messageProvider: "telegram",
      sessionKey: DEFAULT_NOTIFY_SESSION_KEY,
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
    const text = readTextContent(result.content) ?? "";
    expect(text).toContain("hi");
  });

  it("logs line-based slices and defaults to last lines", async () => {
    const { sessionId } = await runBackgroundAndWaitForCompletion({
      tool: execTool,
      callId: "call1",
      command: echoLines(["one", "two", "three"]),
    });

    const log = await readProcessLog(sessionId, { limit: 2 });
    expect(readNormalizedTextContent(log.content)).toBe("two\nthree");
    expect(readTotalLines(log.details)).toBe(3);
  });

  it("applies default tail only when no explicit log window is provided", async () => {
    const snapshot = readLogSnapshot(await readLongProcessLog());
    expect(snapshot.text).toContain("showing last 200 of 201 lines");
    expect(snapshot.lines[0]).toBe("line-2");
    expect(snapshot.text).toContain("line-2");
    expect(snapshot.text).toContain("line-201");
    expect(snapshot.totalLines).toBe(LONG_LOG_LINE_COUNT);
  });

  it("supports line offsets for log slices", async () => {
    const sessionId = await runBackgroundEchoLines(["alpha", "beta", "gamma"]);

    const log = await readProcessLog(sessionId, { offset: 1, limit: 1 });
    expect(readNormalizedTextContent(log.content)).toBe("beta");
  });

  it("keeps offset-only log requests unbounded by default tail mode", async () => {
    const snapshot = readLogSnapshot(await readLongProcessLog({ offset: 30 }));
    expect(snapshot.lines[0]).toBe("line-31");
    expect(snapshot.lines[snapshot.lines.length - 1]).toBe("line-201");
    expect(snapshot.text).not.toContain("showing last 200");
    expect(snapshot.totalLines).toBe(LONG_LOG_LINE_COUNT);
  });
  it("scopes process sessions by scopeKey", async () => {
    const alphaTools = createScopedToolSet("agent:alpha");
    const betaTools = createScopedToolSet("agent:beta");

    const sessionA = await startBackgroundSession({
      tool: alphaTools.exec,
      callId: "call1",
      command: shortDelayCmd,
    });
    const sessionB = await startBackgroundSession({
      tool: betaTools.exec,
      callId: "call2",
      command: shortDelayCmd,
    });

    const listA = await alphaTools.process.execute("call3", { action: "list" });
    const sessionsA = (listA.details as { sessions: Array<{ sessionId: string }> }).sessions;
    expect(sessionsA.some((s) => s.sessionId === sessionA)).toBe(true);
    expect(sessionsA.some((s) => s.sessionId === sessionB)).toBe(false);

    const pollB = await betaTools.process.execute("call4", {
      action: "poll",
      sessionId: sessionA,
    });
    const pollBDetails = pollB.details as { status?: string };
    expect(pollBDetails.status).toBe("failed");
  });
});

describe("exec exit codes", () => {
  useCapturedShellEnv();

  it("treats non-zero exits as completed and appends exit code", async () => {
    const command = isWin
      ? joinCommands(["Write-Output nope", "exit 1"])
      : joinCommands(["echo nope", "exit 1"]);
    const result = await execTool.execute("call1", { command });
    const resultDetails = result.details as { status?: string; exitCode?: number | null };
    expect(resultDetails.status).toBe("completed");
    expect(resultDetails.exitCode).toBe(1);

    const text = readNormalizedTextContent(result.content);
    expect(text).toContain("nope");
    expect(text).toContain("Command exited with code 1");
  });
});

describe("exec notifyOnExit", () => {
  it("enqueues a system event when a backgrounded exec exits", async () => {
    const tool = createNotifyOnExitExecTool();

    const sessionId = await startBackgroundSession({
      tool,
      callId: "call1",
      command: echoAfterDelay("notify"),
    });

    const prefix = sessionId.slice(0, 8);
    let finished = getFinishedSession(sessionId);
    let hasEvent = hasNotifyEventForPrefix(prefix);
    await expect
      .poll(
        () => {
          finished = getFinishedSession(sessionId);
          hasEvent = hasNotifyEventForPrefix(prefix);
          return Boolean(finished && hasEvent);
        },
        { timeout: NOTIFY_EVENT_TIMEOUT_MS, interval: POLL_INTERVAL_MS },
      )
      .toBe(true);
    if (!finished) {
      finished = getFinishedSession(sessionId);
    }
    if (!hasEvent) {
      hasEvent = hasNotifyEventForPrefix(prefix);
    }

    expect(finished).toBeTruthy();
    expect(hasEvent).toBe(true);
  });

  it("handles no-op completion events based on notifyOnExitEmptySuccess", async () => {
    for (const testCase of [
      {
        label: "default behavior skips no-op completion events",
        notifyOnExitEmptySuccess: false,
      },
      {
        label: "explicitly enabling no-op completion emits completion events",
        notifyOnExitEmptySuccess: true,
      },
    ]) {
      resetSystemEventsForTest();
      const tool = createNotifyOnExitExecTool(
        testCase.notifyOnExitEmptySuccess ? { notifyOnExitEmptySuccess: true } : {},
      );

      await runBackgroundAndWaitForCompletion({
        tool,
        callId: "call-noop",
        command: shortDelayCmd,
      });
      const events = peekSystemEvents(DEFAULT_NOTIFY_SESSION_KEY);
      if (!testCase.notifyOnExitEmptySuccess) {
        expect(events, testCase.label).toEqual([]);
      } else {
        expect(events.length, testCase.label).toBeGreaterThan(0);
        expect(
          events.some((event) => event.includes("Exec completed")),
          testCase.label,
        ).toBe(true);
      }
    }
  });
});

describe("exec PATH handling", () => {
  useCapturedEnv(["PATH", "SHELL"], applyDefaultShellEnv);

  it("prepends configured path entries", async () => {
    const basePath = isWin ? "C:\\Windows\\System32" : "/usr/bin";
    const prepend = isWin ? ["C:\\custom\\bin", "C:\\oss\\bin"] : ["/custom/bin", "/opt/oss/bin"];
    process.env.PATH = basePath;

    const tool = createTestExecTool({ pathPrepend: prepend });
    const result = await tool.execute("call1", {
      command: isWin ? "Write-Output $env:PATH" : "echo $PATH",
    });

    const text = readNormalizedTextContent(result.content);
    const entries = text.split(path.delimiter);
    expect(entries.slice(0, prepend.length)).toEqual(prepend);
    expect(entries).toContain(basePath);
  });
});
