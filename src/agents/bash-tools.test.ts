/** Integration tests for the public Bash/process tool factories. */
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import { requestHeartbeatAndWait, setHeartbeatWakeHandler } from "../infra/heartbeat-wake.js";
import {
  peekSystemEventEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { getFinishedSession, waitForExecScope } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import * as supervisorExit from "./bash-tools.exec-runtime.test-support.js";
import { createExecTool, createProcessTool } from "./bash-tools.js";
import { acknowledgeInternalToolResult } from "./runtime/internal-hooks.js";
import { getBashShellConfig } from "./shell-utils.js";

vi.mock("../infra/channel-summary.js", () => ({
  buildChannelSummary: vi.fn(async () => []),
}));

vi.mock("./bash-tools.exec-approval-followup.js", () => ({
  sendExecApprovalFollowup: vi.fn(async () => false),
}));

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(async () => ({ ok: true })),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

vi.mock("../infra/shell-env.js", async () => {
  const actual =
    await vi.importActual<typeof import("../infra/shell-env.js")>("../infra/shell-env.js");
  return {
    ...actual,
    getShellPathFromLoginShell: vi.fn(() => null),
    resolveShellEnvFallbackTimeoutMs: vi.fn(() => 0),
  };
});

vi.mock("../process/supervisor/index.js", async () => {
  const { takeHeldSupervisorExit, createRunExit } =
    await import("./bash-tools.exec-runtime.test-support.js");
  type SpawnInput = {
    argv?: string[];
    env?: NodeJS.ProcessEnv;
    onStdout?: (chunk: string) => void;
  };

  const immediate = () =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  const readPathKey = (env?: NodeJS.ProcessEnv) =>
    env && "Path" in env && !("PATH" in env) ? "Path" : "PATH";
  const readEnvPath = (env?: NodeJS.ProcessEnv) => env?.[readPathKey(env)] ?? "";
  const writeEnvPath = (env: NodeJS.ProcessEnv, value: string) => {
    env[readPathKey(env)] = value;
  };
  const extractCommand = (input: SpawnInput) => input.argv?.at(-1) ?? "";
  const splitCommands = (command: string) =>
    command
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean);
  const applySegmentShellEffects = (segment: string, env: NodeJS.ProcessEnv) => {
    if (segment === 'export PATH="${OPENCLAW_PREPEND_PATH}${PATH:+:$PATH}"') {
      const prepend = env.OPENCLAW_PREPEND_PATH ?? "";
      const current = readEnvPath(env);
      writeEnvPath(env, `${prepend}${current ? `:${current}` : ""}`);
      return;
    }
    if (segment === "unset OPENCLAW_PREPEND_PATH") {
      delete env.OPENCLAW_PREPEND_PATH;
    }
  };
  const stdoutForSegment = (segment: string, env: NodeJS.ProcessEnv) => {
    if (segment === "echo $PATH" || segment === "Write-Output $env:PATH") {
      return `${readEnvPath(env)}\n`;
    }
    for (const prefix of ["echo ", "Write-Output "]) {
      if (segment.startsWith(prefix)) {
        return `${segment.slice(prefix.length)}\n`;
      }
    }
    return "";
  };

  const commandOutput = (command: string, env?: NodeJS.ProcessEnv) => {
    const shellEnv = { ...env };
    return splitCommands(command)
      .map((segment) => {
        applySegmentShellEffects(segment, shellEnv);
        return stdoutForSegment(segment, shellEnv);
      })
      .join("");
  };

  return {
    getProcessSupervisor: () => ({
      spawn: async (input: SpawnInput) => {
        const exitGate = takeHeldSupervisorExit();
        const command = extractCommand(input);
        const output = commandOutput(command, input.env);
        const exitCode = splitCommands(command).includes("exit 1") ? 1 : 0;
        const stagedOutput = command.includes("after")
          ? output.replace(/after[^\n]*\n?/gu, "")
          : output;
        const deferredOutput = output.slice(stagedOutput.length);
        if (stagedOutput) {
          input.onStdout?.(stagedOutput);
        }
        const activity = { resultSettled: false, lastOutputAtMs: Date.now() };
        return {
          activity,
          runId: "mock-bash-run",
          startedAtMs: Date.now(),
          pid: 123,
          stdin: undefined,
          wait: async () => {
            if (exitGate) {
              exitGate.markStarted();
              await exitGate.wait;
            } else {
              await immediate();
              await immediate();
            }
            if (deferredOutput) {
              input.onStdout?.(deferredOutput);
              activity.lastOutputAtMs = Date.now();
            }
            activity.resultSettled = true;
            return createRunExit({ exitCode, durationMs: 0 });
          },
          cancel: vi.fn(),
        };
      },
      cancel: vi.fn(),
      cancelScope: vi.fn(),
    }),
  };
});

const isWin = process.platform === "win32";
const defaultShell = isWin
  ? undefined
  : process.env.OPENCLAW_TEST_SHELL || getBashShellConfig().shell;
const scopeKey = "test:bash-tools";
const sessionKey = "agent:main:main";
const shellEcho = (text: string) => (isWin ? `Write-Output ${text}` : `echo ${text}`);
const createTool = (defaults?: Parameters<typeof createExecTool>[0]) =>
  createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    bypassHostApprovalFloors: true,
    scopeKey,
    ...defaults,
  });
const processTool = createProcessTool();
const text = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.find((part) => part.type === "text")?.text?.trim() ?? "";
let callId = 0;
type ExecOptions = Omit<Parameters<ReturnType<typeof createExecTool>["execute"]>[1], "command">;
const execute = (
  tool: ReturnType<typeof createExecTool>,
  command: string,
  options: ExecOptions = {},
) => tool.execute(`call-${++callId}`, { command, ...options });
const processAction = (args: Parameters<typeof processTool.execute>[1]) =>
  processTool.execute(`call-${++callId}`, args);
function runningId(result: Awaited<ReturnType<ReturnType<typeof createExecTool>["execute"]>>) {
  expect(result.details.status).toBe("running");
  if (result.details.status !== "running") {
    throw new Error("expected running session");
  }
  return result.details.sessionId;
}
const startBackground = async (tool: ReturnType<typeof createExecTool>, command: string) =>
  runningId(await execute(tool, command, { background: true }));
const notifyTool = (defaults?: Parameters<typeof createExecTool>[0]) =>
  createTool({
    backgroundMs: 0,
    notifyOnExit: true,
    sessionKey,
    ...defaults,
  });
const hasEvent = (id: string) =>
  peekSystemEventEntries(sessionKey).some((event) => event.contextKey === `exec:${id}`);

beforeEach(() => {
  callId = 0;
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
  vi.stubEnv("OPENCLAW_EXEC_SHELL_SNAPSHOT", "0");
  if (defaultShell) {
    vi.stubEnv("SHELL", defaultShell);
  }
});
afterEach(async () => {
  await waitForExecScope(scopeKey);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("yields a pollable process and releases foreground callbacks", async () => {
  const onUpdate = vi.fn();
  const abort = new AbortController();
  const addListener = vi.spyOn(abort.signal, "addEventListener");
  const removeListener = vi.spyOn(abort.signal, "removeEventListener");
  const tool = createTool();
  const id = await supervisorExit.withHeldSupervisorExit(
    async (exit) => {
      const execution = tool.execute(
        "yield",
        {
          command: `${shellEcho("before")}; ${shellEcho("after")}`,
          yieldMs: 10,
        },
        abort.signal,
        onUpdate,
      );
      await Promise.race([exit.waitStarted, execution]);
      await vi.advanceTimersByTimeAsync(10);
      const runningSessionId = runningId(await execution);
      expect(onUpdate).toHaveBeenCalledTimes(1);
      const listener = addListener.mock.calls.find(([type]) => type === "abort")?.[1];
      expect(listener).toBeDefined();
      expect(removeListener).toHaveBeenCalledWith("abort", listener);
      return runningSessionId;
    },
    () => waitForExecScope(scopeKey),
  );
  expect(onUpdate).toHaveBeenCalledTimes(1);
  const poll = await processAction({ action: "poll", sessionId: id });
  expect(poll.details).toMatchObject({ status: "completed" });
  expect(text(poll)).toContain("before\nafter");
});

it("rejects elevated requests when not allowed", async () => {
  const tool = createTool({
    elevated: { enabled: true, allowed: false, defaultLevel: "off" },
    messageProvider: "telegram",
    sessionKey,
  });
  await expect(execute(tool, shellEcho("hi"), { elevated: true })).rejects.toThrow(
    "Context: provider=telegram session=agent:main:main",
  );
});

it("does not default to elevated when not allowed", async () => {
  const tool = createTool({
    elevated: { enabled: true, allowed: false, defaultLevel: "on" },
    backgroundMs: 1000,
    timeoutSec: 5,
  });
  expect(text(await execute(tool, shellEcho("hi")))).toContain("hi");
});

it("treats non-zero exits as completed and appends the exit code", async () => {
  const result = await execute(createTool(), `${shellEcho("nope")}; exit 1`);
  expect(result.details).toMatchObject({ status: "completed", exitCode: 1 });
  expect(text(result)).toContain("nope");
  expect(text(result)).toContain("Command exited with code 1");
});

it.each([
  { name: "default tail", options: {}, first: "line-2", tailNote: true },
  { name: "unbounded offset", options: { offset: 30 }, first: "line-31", tailNote: false },
])("reads the $name log window", async ({ options, first, tailNote }) => {
  const sessionId = await startBackground(
    createTool(),
    Array.from({ length: 201 }, (_, i) => shellEcho(`line-${i + 1}`)).join("; "),
  );
  await waitForExecScope(scopeKey);
  const log = await processAction({ action: "log", sessionId, ...options });
  expect(log.details).toMatchObject({ totalLines: 201 });
  expect(text(log).split("\n")[0]).toBe(first);
  expect(text(log)).toContain("line-201");
  if (tailNote) {
    expect(text(log)).toContain("showing last 200 of 201 lines");
  } else {
    expect(text(log).split("\n").at(-1)).toBe("line-201");
    expect(text(log)).not.toContain("showing last 200");
  }
});

it("isolates process lists and polling by scopeKey", async () => {
  const alpha = await startBackground(createTool({ scopeKey: "agent:alpha" }), shellEcho("alpha"));
  const beta = await startBackground(createTool({ scopeKey: "agent:beta" }), shellEcho("beta"));
  try {
    const list = await createProcessTool({ scopeKey: "agent:alpha" }).execute("list", {
      action: "list",
    });
    expect(list.details).toMatchObject({
      sessions: [expect.objectContaining({ sessionId: alpha })],
    });
    expect(text(list)).not.toContain(beta);
    const poll = await createProcessTool({ scopeKey: "agent:beta" }).execute("poll", {
      action: "poll",
      sessionId: alpha,
    });
    expect(poll.details).toMatchObject({ status: "failed" });
  } finally {
    await Promise.all([waitForExecScope("agent:alpha"), waitForExecScope("agent:beta")]);
  }
});

describe("background completion notifications", () => {
  async function drainWakes() {
    const dispose = setHeartbeatWakeHandler(async () => ({ status: "ran", durationMs: 0 }));
    try {
      await expect(
        requestHeartbeatAndWait(
          {
            source: "other",
            intent: "immediate",
            reason: "test-cleanup",
            coalesceMs: 0,
          },
          { abortSignal: AbortSignal.timeout(isWin ? 12_000 : 5_000) },
        ),
      ).resolves.toEqual({ status: "ran", durationMs: 0 });
    } finally {
      dispose();
    }
  }
  beforeEach(drainWakes);
  afterEach(drainWakes);

  it("routes a completion event and heartbeat wake to the originating session", async () => {
    const wake = vi.fn<NonNullable<Parameters<typeof setHeartbeatWakeHandler>[0]>>(async () => ({
      status: "skipped",
      reason: "disabled",
    }));
    const dispose = setHeartbeatWakeHandler(wake);
    try {
      const id = await startBackground(
        notifyTool({
          messageProvider: "telegram",
          currentChannelId: "telegram:-100123:topic:47",
          currentThreadTs: "47",
        }),
        shellEcho("notify"),
      );
      await waitForExecScope(scopeKey);
      expect(getFinishedSession(id)).toMatchObject({
        id,
        terminalStatus: "completed",
        exitCode: 0,
      });
      expect(peekSystemEventEntries(sessionKey)).toContainEqual(
        expect.objectContaining({
          contextKey: `exec:${id}`,
          deliveryContext: {
            channel: "telegram",
            to: "telegram:-100123:topic:47",
            threadId: "47",
            accountId: undefined,
          },
        }),
      );
      await expect
        .poll(() => wake.mock.calls.at(0)?.[0], {
          timeout: isWin ? 12_000 : 5_000,
          interval: isWin ? 15 : 2,
        })
        .toEqual({
          source: "exec-event",
          intent: "event",
          reason: "exec-event",
          sessionKey,
        });
      expect(
        await drainFormattedSystemEvents({
          cfg: {},
          agentId: "main",
          sessionKey,
          isMainSession: false,
          isNewSession: false,
        }),
      ).toBeUndefined();
    } finally {
      dispose();
    }
  });

  it("consumes only the acknowledged poll's completion event", async () => {
    const tool = notifyTool();
    const unpolled = await startBackground(tool, shellEcho("unpolled"));
    await waitForExecScope(scopeKey);
    const polled = await startBackground(tool, shellEcho("polled"));
    await waitForExecScope(scopeKey);
    expect(hasEvent(unpolled)).toBe(true);
    expect(hasEvent(polled)).toBe(true);
    const queued = peekSystemEventEntries(sessionKey);
    const poll = await processAction({ action: "poll", sessionId: polled });
    expect(poll.details).toMatchObject({ status: "completed" });
    expect(peekSystemEventEntries(sessionKey)).toEqual(queued);
    acknowledgeInternalToolResult(poll);
    expect(hasEvent(polled)).toBe(false);
    expect(hasEvent(unpolled)).toBe(true);
  });

  it.each([
    {
      name: "defaults to notifying chat providers",
      notifyOnExitEmptySuccess: undefined,
      emits: true,
    },
    { name: "honors an explicit silent override", notifyOnExitEmptySuccess: false, emits: false },
  ])("$name on empty success", async ({ notifyOnExitEmptySuccess, emits }) => {
    const id = await startBackground(
      notifyTool({ messageProvider: " Telegram ", notifyOnExitEmptySuccess }),
      isWin ? "$null" : ":",
    );
    await waitForExecScope(scopeKey);
    expect(getFinishedSession(id)?.terminalStatus).toBe("completed");
    expect(peekSystemEvents(sessionKey)).toEqual(
      emits ? [`Exec completed (${id.slice(0, 8)}, code 0)`] : [],
    );
  });
});

it("prepends configured PATH entries ahead of existing shell paths", async () => {
  const existing = isWin ? ["C:\\evil\\bin", "C:\\Windows\\System32"] : ["/evil/bin", "/usr/bin"];
  const prepend = isWin ? ["C:\\custom\\bin", "C:\\oss\\bin"] : ["/custom/bin", "/opt/oss/bin"];
  vi.stubEnv("PATH", existing.join(path.delimiter));
  const result = await execute(
    createTool({ pathPrepend: prepend }),
    isWin ? "Write-Output $env:PATH" : "echo $PATH",
  );
  expect(text(result).split(path.delimiter)).toEqual([...prepend, ...existing]);
});

it("suppresses onUpdate after abort signal fires", async () => {
  const abort = new AbortController();
  const onUpdate = vi.fn(() => abort.abort());
  await expect(
    createTool().execute(
      "abort",
      {
        command: `${shellEcho("before-abort")}; ${shellEcho("after-abort")}`,
      },
      abort.signal,
      onUpdate,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(onUpdate).toHaveBeenCalledTimes(1);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(onUpdate).toHaveBeenCalledTimes(1);
});
