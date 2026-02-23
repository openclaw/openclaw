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
const PROCESS_STATUS_RUNNING = "running";
const PROCESS_STATUS_COMPLETED = "completed";
const PROCESS_STATUS_FAILED = "failed";
const OUTPUT_DONE = "done";
const OUTPUT_NOPE = "nope";
const OUTPUT_EXEC_COMPLETED = "Exec completed";
const OUTPUT_EXIT_CODE_1 = "Command exited with code 1";
const COMMAND_ECHO_HELLO = "echo hello";
const SCOPE_KEY_ALPHA = "agent:alpha";
const SCOPE_KEY_BETA = "agent:beta";
const TEST_EXEC_DEFAULTS = { security: "full" as const, ask: "off" as const };
const DEFAULT_NOTIFY_SESSION_KEY = "agent:main:main";
const ECHO_HI_COMMAND = "echo hi";
let callIdCounter = 0;
const nextCallId = () => `call${++callIdCounter}`;
type ExecToolInstance = ReturnType<typeof createExecTool>;
type ProcessToolInstance = ReturnType<typeof createProcessTool>;
type ExecToolArgs = Parameters<ExecToolInstance["execute"]>[1];
type ProcessToolArgs = Parameters<ProcessToolInstance["execute"]>[1];
type ExecToolConfig = Exclude<Parameters<typeof createExecTool>[0], undefined>;
const createTestExecTool = (
  defaults?: Parameters<typeof createExecTool>[0],
): ReturnType<typeof createExecTool> => createExecTool({ ...TEST_EXEC_DEFAULTS, ...defaults });
const createDisallowedElevatedExecTool = (
  defaultLevel: "off" | "on",
  overrides: Partial<ExecToolConfig> = {},
) =>
  createTestExecTool({
    elevated: { enabled: true, allowed: false, defaultLevel },
    ...overrides,
  });
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
const readProcessStatus = (details: unknown) => (details as { status?: string }).status;
const readProcessStatusOrRunning = (details: unknown) =>
  readProcessStatus(details) ?? PROCESS_STATUS_RUNNING;
const expectProcessStatus = (details: unknown, expected: string) => {
  expect(readProcessStatus(details)).toBe(expected);
};
const expectTextContainsValues = (
  text: string,
  values: string[] | undefined,
  shouldContain: boolean,
) => {
  if (!values) {
    return;
  }
  for (const value of values) {
    if (shouldContain) {
      expect(text).toContain(value);
    } else {
      expect(text).not.toContain(value);
    }
  }
};
const expectTextContainsAll = (text: string, expected?: string[]) => {
  expectTextContainsValues(text, expected, true);
};
const expectTextContainsNone = (text: string, forbidden?: string[]) => {
  expectTextContainsValues(text, forbidden, false);
};
const expectTextContains = (text: string | undefined, expected?: string) => {
  if (expected === undefined) {
    throw new Error("expected text assertion value");
  }
  expectTextContainsAll(text ?? "", [expected]);
};
type ProcessSessionSummary = { sessionId: string; name?: string };
const readProcessSessions = (details: unknown) =>
  (details as { sessions: ProcessSessionSummary[] }).sessions;
const expectSessionMembership = (
  sessions: ProcessSessionSummary[],
  sessionId: string,
  shouldExist: boolean,
) => {
  expect(sessions.some((session) => session.sessionId === sessionId)).toBe(shouldExist);
};
const executeExecTool = (tool: ExecToolInstance, params: ExecToolArgs) =>
  tool.execute(nextCallId(), params);
const executeProcessTool = (tool: ProcessToolInstance, params: ProcessToolArgs) =>
  tool.execute(nextCallId(), params);
type ProcessPollResult = { status: string; output?: string };
async function listProcessSessions(tool: ProcessToolInstance) {
  const list = await executeProcessTool(tool, { action: "list" });
  return readProcessSessions(list.details);
}
async function pollProcessSession(params: {
  tool: ProcessToolInstance;
  sessionId: string;
}): Promise<ProcessPollResult> {
  const poll = await executeProcessTool(params.tool, {
    action: "poll",
    sessionId: params.sessionId,
  });
  return {
    status: readProcessStatusOrRunning(poll.details),
    output: readTextContent(poll.content),
  };
}

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
  let status = PROCESS_STATUS_RUNNING;
  await expect
    .poll(
      async () => {
        status = (await pollProcessSession({ tool: processTool, sessionId })).status;
        return status;
      },
      { timeout: BACKGROUND_POLL_TIMEOUT_MS, interval: POLL_INTERVAL_MS },
    )
    .not.toBe(PROCESS_STATUS_RUNNING);
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

async function waitForNotifyEvent(sessionId: string) {
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
  return {
    finished: finished ?? getFinishedSession(sessionId),
    hasEvent: hasEvent || hasNotifyEventForPrefix(prefix),
  };
}

async function startBackgroundSession(params: { tool: ExecToolInstance; command: string }) {
  const result = await executeExecTool(params.tool, {
    command: params.command,
    background: true,
  });
  expectProcessStatus(result.details, PROCESS_STATUS_RUNNING);
  return requireSessionId(result.details as { sessionId?: string });
}

async function runBackgroundEchoLines(lines: string[]) {
  const sessionId = await startBackgroundSession({
    tool: execTool,
    command: echoLines(lines),
  });
  await waitForCompletion(sessionId);
  return sessionId;
}

type ProcessLogWindow = { offset?: number; limit?: number };
async function readProcessLog(sessionId: string, options: ProcessLogWindow = {}) {
  return executeProcessTool(processTool, {
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

async function runBackgroundAndReadProcessLog(lines: string[], options: ProcessLogWindow = {}) {
  const sessionId = await runBackgroundEchoLines(lines);
  return readProcessLog(sessionId, options);
}
const readLogSlice = async (lines: string[], options: ProcessLogWindow = {}) => {
  const log = await runBackgroundAndReadProcessLog(lines, options);
  return {
    text: readNormalizedTextContent(log.content),
    totalLines: readTotalLines(log.details),
  };
};
const readLongProcessLog = (options: ProcessLogWindow = {}) =>
  runBackgroundAndReadProcessLog(createNumberedLines(LONG_LOG_LINE_COUNT), options);
type LongLogExpectationCase = {
  label: string;
  options?: ProcessLogWindow;
  firstLine: string;
  lastLine?: string;
  mustContain?: string[];
  mustNotContain?: string[];
};
type ShortLogExpectationCase = {
  label: string;
  lines: string[];
  options: ProcessLogWindow;
  expectedText: string;
  expectedTotalLines: number;
};
type DisallowedElevationCase = {
  label: string;
  defaultLevel: "off" | "on";
  overrides?: Partial<ExecToolConfig>;
  requestElevated?: boolean;
  expectedError?: string;
  expectedOutputIncludes?: string;
};
type NotifyNoopCase = {
  label: string;
  notifyOnExitEmptySuccess: boolean;
};
const NOOP_NOTIFY_CASES: NotifyNoopCase[] = [
  {
    label: "default behavior skips no-op completion events",
    notifyOnExitEmptySuccess: false,
  },
  {
    label: "explicitly enabling no-op completion emits completion events",
    notifyOnExitEmptySuccess: true,
  },
];
const expectNotifyNoopEvents = (
  events: string[],
  notifyOnExitEmptySuccess: boolean,
  label: string,
) => {
  if (!notifyOnExitEmptySuccess) {
    expect(events, label).toEqual([]);
    return;
  }
  expect(events.length, label).toBeGreaterThan(0);
  expect(
    events.some((event) => event.includes(OUTPUT_EXEC_COMPLETED)),
    label,
  ).toBe(true);
};

async function runBackgroundAndWaitForCompletion(params: {
  tool: ExecToolInstance;
  command: string;
}) {
  const sessionId = await startBackgroundSession(params);
  const status = await waitForCompletion(sessionId);
  expect(status).toBe(PROCESS_STATUS_COMPLETED);
  return { sessionId };
}

beforeEach(() => {
  callIdCounter = 0;
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
});

describe("exec tool backgrounding", () => {
  useCapturedShellEnv();

  it(
    "backgrounds after yield and can be polled",
    async () => {
      const result = await executeExecTool(execTool, {
        command: joinCommands([yieldDelayCmd, "echo done"]),
        yieldMs: 10,
      });

      // Timing can race here: command may already be complete before the first response.
      if (result.details.status === PROCESS_STATUS_COMPLETED) {
        const text = readTextContent(result.content) ?? "";
        expectTextContains(text, OUTPUT_DONE);
        return;
      }

      expectProcessStatus(result.details, PROCESS_STATUS_RUNNING);
      const sessionId = requireSessionId(result.details as { sessionId?: string });

      let output = "";
      await expect
        .poll(
          async () => {
            const pollResult = await pollProcessSession({
              tool: processTool,
              sessionId,
            });
            output = pollResult.output ?? "";
            return pollResult.status;
          },
          { timeout: BACKGROUND_POLL_TIMEOUT_MS, interval: POLL_INTERVAL_MS },
        )
        .toBe(PROCESS_STATUS_COMPLETED);

      expectTextContains(output, OUTPUT_DONE);
    },
    isWin ? 15_000 : 5_000,
  );

  it("supports explicit background and derives session name from the command", async () => {
    const sessionId = await startBackgroundSession({
      tool: execTool,
      command: COMMAND_ECHO_HELLO,
    });

    const sessions = await listProcessSessions(processTool);
    expectSessionMembership(sessions, sessionId, true);
    expect(sessions.find((s) => s.sessionId === sessionId)?.name).toBe(COMMAND_ECHO_HELLO);
  });

  it("uses default timeout when timeout is omitted", async () => {
    const customBash = createTestExecTool({
      timeoutSec: 0.05,
      backgroundMs: 10,
      allowBackground: false,
    });
    await expect(
      executeExecTool(customBash, {
        command: longDelayCmd,
      }),
    ).rejects.toThrow(/timed out/i);
  });

  it.each<DisallowedElevationCase>([
    {
      label: "rejects elevated requests when not allowed",
      defaultLevel: "off",
      overrides: {
        messageProvider: "telegram",
        sessionKey: DEFAULT_NOTIFY_SESSION_KEY,
      },
      requestElevated: true,
      expectedError: "Context: provider=telegram session=agent:main:main",
    },
    {
      label: "does not default to elevated when not allowed",
      defaultLevel: "on",
      overrides: {
        backgroundMs: 1000,
        timeoutSec: 5,
      },
      expectedOutputIncludes: "hi",
    },
  ])(
    "$label",
    async ({ defaultLevel, overrides, requestElevated, expectedError, expectedOutputIncludes }) => {
      const customBash = createDisallowedElevatedExecTool(defaultLevel, overrides);
      if (expectedError) {
        await expect(
          executeExecTool(customBash, {
            command: ECHO_HI_COMMAND,
            elevated: requestElevated,
          }),
        ).rejects.toThrow(expectedError);
        return;
      }

      const result = await executeExecTool(customBash, {
        command: ECHO_HI_COMMAND,
      });
      expectTextContains(readTextContent(result.content), expectedOutputIncludes);
    },
  );

  it.each<ShortLogExpectationCase>([
    {
      label: "logs line-based slices and defaults to last lines",
      lines: ["one", "two", "three"],
      options: { limit: 2 },
      expectedText: "two\nthree",
      expectedTotalLines: 3,
    },
    {
      label: "supports line offsets for log slices",
      lines: ["alpha", "beta", "gamma"],
      options: { offset: 1, limit: 1 },
      expectedText: "beta",
      expectedTotalLines: 3,
    },
  ])("$label", async ({ lines, options, expectedText, expectedTotalLines }) => {
    const slice = await readLogSlice(lines, options);
    expect(slice.text).toBe(expectedText);
    expect(slice.totalLines).toBe(expectedTotalLines);
  });

  it.each<LongLogExpectationCase>([
    {
      label: "applies default tail only when no explicit log window is provided",
      firstLine: "line-2",
      mustContain: ["showing last 200 of 201 lines", "line-2", "line-201"],
    },
    {
      label: "keeps offset-only log requests unbounded by default tail mode",
      options: { offset: 30 },
      firstLine: "line-31",
      lastLine: "line-201",
      mustNotContain: ["showing last 200"],
    },
  ])("$label", async ({ options, firstLine, lastLine, mustContain, mustNotContain }) => {
    const snapshot = readLogSnapshot(await readLongProcessLog(options));
    expect(snapshot.lines[0]).toBe(firstLine);
    if (lastLine) {
      expect(snapshot.lines[snapshot.lines.length - 1]).toBe(lastLine);
    }
    expect(snapshot.totalLines).toBe(LONG_LOG_LINE_COUNT);
    expectTextContainsAll(snapshot.text, mustContain);
    expectTextContainsNone(snapshot.text, mustNotContain);
  });
  it("scopes process sessions by scopeKey", async () => {
    const alphaTools = createScopedToolSet(SCOPE_KEY_ALPHA);
    const betaTools = createScopedToolSet(SCOPE_KEY_BETA);

    const sessionA = await startBackgroundSession({
      tool: alphaTools.exec,
      command: shortDelayCmd,
    });
    const sessionB = await startBackgroundSession({
      tool: betaTools.exec,
      command: shortDelayCmd,
    });

    const sessionsA = await listProcessSessions(alphaTools.process);
    expectSessionMembership(sessionsA, sessionA, true);
    expectSessionMembership(sessionsA, sessionB, false);

    const pollB = await pollProcessSession({
      tool: betaTools.process,
      sessionId: sessionA,
    });
    expect(pollB.status).toBe(PROCESS_STATUS_FAILED);
  });
});

describe("exec exit codes", () => {
  useCapturedShellEnv();

  it("treats non-zero exits as completed and appends exit code", async () => {
    const command = isWin
      ? joinCommands(["Write-Output nope", "exit 1"])
      : joinCommands([`echo ${OUTPUT_NOPE}`, "exit 1"]);
    const result = await executeExecTool(execTool, { command });
    const resultDetails = result.details as { status?: string; exitCode?: number | null };
    expectProcessStatus(resultDetails, PROCESS_STATUS_COMPLETED);
    expect(resultDetails.exitCode).toBe(1);

    const text = readNormalizedTextContent(result.content);
    expectTextContainsAll(text, [OUTPUT_NOPE, OUTPUT_EXIT_CODE_1]);
  });
});

describe("exec notifyOnExit", () => {
  it("enqueues a system event when a backgrounded exec exits", async () => {
    const tool = createNotifyOnExitExecTool();

    const sessionId = await startBackgroundSession({
      tool,
      command: echoAfterDelay("notify"),
    });

    const { finished, hasEvent } = await waitForNotifyEvent(sessionId);

    expect(finished).toBeTruthy();
    expect(hasEvent).toBe(true);
  });

  it.each<NotifyNoopCase>(NOOP_NOTIFY_CASES)(
    "$label",
    async ({ label, notifyOnExitEmptySuccess }) => {
      const tool = createNotifyOnExitExecTool(
        notifyOnExitEmptySuccess ? { notifyOnExitEmptySuccess: true } : {},
      );

      await runBackgroundAndWaitForCompletion({
        tool,
        command: shortDelayCmd,
      });
      const events = peekSystemEvents(DEFAULT_NOTIFY_SESSION_KEY);
      expectNotifyNoopEvents(events, notifyOnExitEmptySuccess, label);
    },
  );
});

describe("exec PATH handling", () => {
  useCapturedEnv(["PATH", "SHELL"], applyDefaultShellEnv);

  it("prepends configured path entries", async () => {
    const basePath = isWin ? "C:\\Windows\\System32" : "/usr/bin";
    const prepend = isWin ? ["C:\\custom\\bin", "C:\\oss\\bin"] : ["/custom/bin", "/opt/oss/bin"];
    process.env.PATH = basePath;

    const tool = createTestExecTool({ pathPrepend: prepend });
    const result = await executeExecTool(tool, {
      command: isWin ? "Write-Output $env:PATH" : "echo $PATH",
    });

    const text = readNormalizedTextContent(result.content);
    const entries = text.split(path.delimiter);
    expect(entries.slice(0, prepend.length)).toEqual(prepend);
    expect(entries).toContain(basePath);
  });
});
