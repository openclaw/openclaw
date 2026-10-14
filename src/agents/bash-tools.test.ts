/** Integration tests for the public Bash/process tool factories. */
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { dispatchInboundMessageWithRoutedChannelDispatcher } from "../auto-reply/dispatch.js";
import type { SessionEventReceipt } from "../auto-reply/reply/session-event-contract.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  peekSystemEventEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import * as gatewayWork from "../process/gateway-work-admission.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { getFinishedSession, waitForExecScope } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import * as supervisorExit from "./bash-tools.exec-runtime.test-support.js";
import { createExecTool, createProcessTool } from "./bash-tools.js";
import { getBashShellConfig } from "./shell-utils.js";

// mock-isolation: Hold normal follow-up admission so factory tests can inspect exact queued routing.
vi.mock("../auto-reply/dispatch.js", () => ({
  dispatchInboundMessageWithRoutedChannelDispatcher: vi.fn<
    typeof dispatchInboundMessageWithRoutedChannelDispatcher
  >(async ({ replyOptions }) => {
    const lifecycle = expectDefined(replyOptions?.turnAdoptionLifecycle, "notification lifecycle");
    const signal = expectDefined(lifecycle.abortSignal, "notification cancellation");
    lifecycle.onDeferred?.();
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      try {
        lifecycle.onAbandoned?.();
      } finally {
        lifecycle.onSettled?.();
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    return {
      deferredToActiveRun: "followup",
      queuedFinal: false,
      counts: { tool: 0, block: 0, final: 0 },
    };
  }),
}));

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

it("awaits terminal shell results past the yield window without enabling notifications", async () => {
  const tool = createTool({ notifyOnExit: false, sessionKey });
  let execution: ReturnType<typeof execute> | undefined;
  let settled = false;
  await supervisorExit.withHeldSupervisorExit(
    async (exit) => {
      execution = execute(tool, `${shellEcho("before")}; ${shellEcho("after")}`, {
        awaitResults: true,
        yieldMs: 10,
      }).then((result) => {
        settled = true;
        return result;
      });
      await Promise.race([exit.waitStarted, execution]);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
    },
    () => waitForExecScope(scopeKey),
  );
  await expect(execution).resolves.toMatchObject({
    details: { status: "completed", exitCode: 0, aggregated: "before\nafter" },
  });
  expect(peekSystemEvents(sessionKey)).toEqual([]);
  await expect(
    execute(tool, shellEcho("detached"), { awaitResults: true, background: true }),
  ).rejects.toThrow("cannot be detached");
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
  let state: OpenClawTestState;
  let continuation: MockInstance<typeof gatewayWork.runWithGatewayDetachedWorkContinuation>;
  let receipts: SessionEventReceipt[];
  beforeEach(async () => {
    receipts = [];
    continuation = vi.spyOn(gatewayWork, "runWithGatewayDetachedWorkContinuation");
    const enqueue = sessionEvents.enqueueSessionEventForHost;
    vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockImplementation(
      (eventText, options) => {
        const receipt = enqueue(eventText, options);
        receipts.push(receipt);
        return receipt;
      },
    );
    state = await createOpenClawTestState({ layout: "state-only", prefix: "bash-notify-route-" });
    setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
    openOpenClawStateDatabase({ env: state.env });
    writeSessionEntry(openOpenClawAgentDatabase({ agentId: "main", env: state.env }), sessionKey, {
      sessionId: "bash-origin",
      lifecycleRevision: "original-revision",
      updatedAt: Date.now(),
    });
  });
  afterEach(async () => {
    resetSystemEventsForTest();
    await Promise.allSettled(receipts.map((receipt) => receipt.settled));
    await Promise.allSettled(
      continuation.mock.results.flatMap((result) =>
        result.type === "return" ? [result.value] : [],
      ),
    );
    clearRuntimeConfigSnapshot();
    await state.cleanup();
  });

  it("routes an ordinary completion event to the originating session", async () => {
    const id = await startBackground(
      notifyTool({
        messageProvider: "telegram",
        currentChannelId: "telegram:-100123:topic:47",
        currentThreadTs: "47",
      }),
      shellEcho("notify"),
    );
    await waitForExecScope(scopeKey);
    const receipt = expectDefined(receipts[0], "completion receipt");
    await expect(receipt.accepted).resolves.toEqual({ ok: true });
    expect(getFinishedSession(id)).toMatchObject({ id, terminalStatus: "completed", exitCode: 0 });
    expect(sessionEvents.enqueueSessionEventForHost).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("notify"),
      expect.objectContaining({
        agentId: "main",
        sessionKey,
        source: "exec",
        expectedTarget: expect.objectContaining({ sessionId: "bash-origin", sessionKey }),
      }),
    );
    expect(peekSystemEventEntries(sessionKey)).toContainEqual(
      expect.objectContaining({
        id: receipt.id,
        contextKey: `exec:${id}`,
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-100123:topic:47",
          threadId: "47",
          accountId: undefined,
        },
      }),
    );
    expect(
      await drainFormattedSystemEvents({
        cfg: {},
        agentId: "main",
        sessionKey,
        isMainSession: false,
        isNewSession: false,
      }),
    ).toBeUndefined();
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
    expect(receipts).toHaveLength(emits ? 1 : 0);
    if (emits) {
      await expect(expectDefined(receipts[0], "completion receipt").accepted).resolves.toEqual({
        ok: true,
      });
    }
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
