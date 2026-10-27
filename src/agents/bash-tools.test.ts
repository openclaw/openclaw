import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
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
import type { SpawnInput } from "../process/supervisor/types.js";
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
vi.mock("../auto-reply/dispatch.js", async () => {
  const { createDeferredExecDispatchMock } =
    await import("./bash-tools.exec-runtime.test-support.js");
  return createDeferredExecDispatchMock();
});

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
  return {
    ...(await vi.importActual<typeof import("../infra/shell-env.js")>("../infra/shell-env.js")),
    getShellPathFromLoginShell: vi.fn(() => null),
    resolveShellEnvFallbackTimeoutMs: vi.fn(() => 0),
  };
});

// mock-isolation: Simulate process output and settlement without launching host commands.
vi.mock("../process/supervisor/index.js", async () => {
  const { takeHeldSupervisorExit, createRunExit } =
    await import("./bash-tools.exec-runtime.test-support.js");
  const { setImmediate: immediate } = await import("node:timers/promises");
  const splitCommands = (command: string) =>
    command
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean);
  const commandOutput = (command: string, env?: NodeJS.ProcessEnv) => {
    const shellEnv = { ...env };
    const pathKey = "Path" in shellEnv && !("PATH" in shellEnv) ? "Path" : "PATH";
    return splitCommands(command)
      .map((segment) => {
        if (segment === 'export PATH="${OPENCLAW_PREPEND_PATH}${PATH:+:$PATH}"') {
          const current = shellEnv[pathKey];
          shellEnv[pathKey] =
            `${shellEnv.OPENCLAW_PREPEND_PATH ?? ""}${current ? `:${current}` : ""}`;
        } else if (segment === "unset OPENCLAW_PREPEND_PATH") {
          delete shellEnv.OPENCLAW_PREPEND_PATH;
        }
        if (segment === "echo $PATH" || segment === "Write-Output $env:PATH") {
          return `${shellEnv[pathKey] ?? ""}\n`;
        }
        const prefix = ["echo ", "Write-Output "].find((value) => segment.startsWith(value));
        return prefix ? `${segment.slice(prefix.length)}\n` : "";
      })
      .join("");
  };

  return {
    getProcessSupervisor: () => ({
      spawn: async (input: Partial<Extract<SpawnInput, { mode: "child" }>>) => {
        const exitGate = takeHeldSupervisorExit();
        const command = input.argv?.at(-1) ?? "";
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
const echoSequence = (...values: string[]) => values.map(shellEcho).join("; ");
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
const heldExit = <T>(
  run: (exit: Pick<supervisorExit.HeldSupervisorExit, "waitStarted">) => Promise<T>,
) => supervisorExit.withHeldSupervisorExit(run, () => waitForExecScope(scopeKey));
const startAndFinish = async (tool: ReturnType<typeof createExecTool>, command: string) => {
  const id = await startBackground(tool, command);
  await waitForExecScope(scopeKey);
  return id;
};

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
  const id = await heldExit(async (exit) => {
    const execution = tool.execute(
      "yield",
      {
        command: echoSequence("before", "after"),
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
  });
  expect(onUpdate).toHaveBeenCalledTimes(1);
  const poll = await processAction({ action: "poll", sessionId: id });
  expect(poll.details).toMatchObject({ status: "completed" });
  expect(text(poll)).toContain("before\nafter");
});

it("awaits terminal shell results past the yield window without enabling notifications", async () => {
  const tool = createTool({ notifyOnExit: false, sessionKey });
  let execution: ReturnType<typeof execute> | undefined;
  let settled = false;
  await heldExit(async (exit) => {
    execution = execute(tool, echoSequence("before", "after"), {
      awaitResults: true,
      yieldMs: 10,
    }).then((result) => {
      settled = true;
      return result;
    });
    await Promise.race([exit.waitStarted, execution]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
  });
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

it("reads the unbounded offset log window", async () => {
  const sessionId = await startAndFinish(
    createTool(),
    Array.from({ length: 201 }, (_, i) => shellEcho(`line-${i + 1}`)).join("; "),
  );
  const log = await processAction({ action: "log", sessionId, offset: 30 });
  expect(log.details).toMatchObject({ totalLines: 201 });
  expect(text(log).split("\n")[0]).toBe("line-31");
  expect(text(log)).toMatch(/line-201\n\nProcess exited with code 0\.$/);
  expect(text(log)).not.toContain("showing last 200");
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

  it.each([
    {
      name: "defaults to notifying chat providers",
      notifyOnExitEmptySuccess: undefined,
      emits: true,
    },
    { name: "honors an explicit silent override", notifyOnExitEmptySuccess: false, emits: false },
  ])("$name on empty success", async ({ notifyOnExitEmptySuccess, emits }) => {
    const id = await startAndFinish(
      notifyTool({
        messageProvider: " Telegram ",
        currentChannelId: "telegram:-100123:topic:47",
        currentThreadTs: "47",
        notifyOnExitEmptySuccess,
      }),
      isWin ? "$null" : ":",
    );
    expect(getFinishedSession(id)).toMatchObject({ id, terminalStatus: "completed", exitCode: 0 });
    expect(receipts).toHaveLength(emits ? 1 : 0);
    if (emits) {
      const receipt = expectDefined(receipts[0], "completion receipt");
      await expect(receipt.accepted).resolves.toEqual({ ok: true });
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
      { command: echoSequence("before-abort", "after-abort") },
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
