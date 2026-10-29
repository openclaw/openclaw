import "../test-utils/prepare-compiled-subprocesses.js";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { Value } from "typebox/value";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  type MockInstance,
  test,
  vi,
} from "vitest";
import { acknowledgeInternalToolResult } from "../../packages/agent-core/src/internal-hooks.js";
import { withinTest } from "../../test/helpers/promise.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../infra/system-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  getFinishedSession,
  getSession,
  markBackgrounded,
  waitForExecScope,
} from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";
import {
  completionConfig,
  nodeCommand as currentNodeEvalCommand,
  runningSession,
} from "./bash-tools.lifecycle.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";
import { runEmbeddedAgent } from "./embedded-agent.js";
import { isToolResultError } from "./tool-result-error.js";

// mock-isolation: Only model inference is synthetic; process and session-event custody are real.
vi.mock("./embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const model = vi.mocked(runEmbeddedAgent);
await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

let state: OpenClawTestState;
const receipts: sessionEvents.SessionEventReceipt[] = [];
const completions = new Map<string, sessionEvents.SessionEventReceipt>();
const enqueue = sessionEvents.enqueueSessionEventForHost;
let observe: MockInstance<typeof enqueue>;

beforeAll(async () => {
  state = await createOpenClawTestState({
    label: "process-notification",
    env: { OPENCLAW_TEST_FAST: "0" },
  });
  const config = completionConfig(state.workspaceDir);
  setRuntimeConfigSnapshot(config);
  await state.writeConfig(config);
  openOpenClawStateDatabase();
});

beforeEach(() => {
  model.mockReset().mockImplementation(async (params) => {
    await expectDefined(params.preparedRunAdmission, "real event admission").admit(
      "gateway",
      params.runId,
    );
    params.onExecutionPhase?.({ phase: "model_call_started" });
    await params.onExecutionStarted?.();
    await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
    return { payloads: [{ text: "NO_REPLY" }], meta: { durationMs: 1 } };
  });
  observe = vi
    .spyOn(sessionEvents, "enqueueSessionEventForHost")
    .mockImplementation((text, options) => {
      const receipt = enqueue(text, options);
      receipts.push(receipt);
      if (options.source === "exec") {
        completions.set(options.sessionKey, receipt);
      }
      return receipt;
    });
});

afterEach(async () => {
  for (const receipt of receipts) {
    receipt.cancel();
  }
  await Promise.all(receipts.map((receipt) => receipt.settled));
  observe.mockRestore();
  receipts.length = 0;
  completions.clear();
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
});

afterAll(async () => {
  await state?.cleanup();
});

async function seedOrigin(sessionKey: string) {
  await replaceSessionEntry(
    { agentId: "main", sessionKey },
    {
      sessionId: sessionKey.replaceAll(":", "-"),
      lifecycleRevision: "original",
      updatedAt: Date.now(),
      sessionStartedAt: Date.now(),
      permissionMode: "full",
    },
  );
}

async function completionPrompt(sessionKey: string, signal: AbortSignal) {
  const receipt = expectDefined(completions.get(sessionKey), "ordinary exec completion");
  expect(await withinTest(receipt.accepted, signal)).toEqual({ ok: true });
  expect(await withinTest(receipt.settled, signal)).toMatchObject({
    status: "completed",
    executionStarted: true,
  });
  expect(model).toHaveBeenCalledOnce();
  const turn = expectDefined(model.mock.calls[0]?.[0], "completion turn");
  expect(turn).toMatchObject({
    trigger: "event",
    sessionKey,
    sessionId: sessionKey.replaceAll(":", "-"),
  });
  return turn.prompt;
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

function runSandboxProcess({
  command,
  containerName = command,
  child,
  finalizeExec,
  maxOutput = 1000,
  timeoutSec = 10,
  stdinMode = "pipe-closed",
  ...options
}: Pick<
  Parameters<typeof runExecProcess>[0],
  "command" | "scopeKey" | "notifyOnExitEmptySuccess" | "onUpdate"
> & {
  child: string;
  stdinMode?: "pipe-open" | "pipe-closed";
  containerName?: string;
  finalizeExec: () => Promise<void>;
  maxOutput?: number;
  timeoutSec?: number;
}) {
  return runExecProcess({
    command,
    timeoutSec,
    notifyOnExit: true,
    workdir: process.cwd(),
    env: {},
    sandbox: {
      containerName,
      workspaceDir: process.cwd(),
      containerWorkdir: process.cwd(),
      buildExecSpec: async () => ({
        argv: [process.execPath, "-e", child],
        env: {},
        stdinMode,
      }),
      finalizeExec,
    },
    usePty: false,
    warnings: [],
    maxOutput,
    pendingMaxOutput: maxOutput,
    sessionKey: options.scopeKey,
    ...options,
  });
}

function createGatewayExecTool(defaults: Parameters<typeof createExecTool>[0]) {
  return createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    timeoutSec: 10,
    ...defaults,
  });
}

async function startBackground(
  scopeKey: string,
  source: string,
  options: { notifyOnExit?: boolean; notifyOnExitEmptySuccess?: boolean; pty?: boolean } = {},
) {
  const { notifyOnExit = true, notifyOnExitEmptySuccess = true, ...params } = options;
  const tool = createGatewayExecTool({
    allowBackground: true,
    backgroundMs: 0,
    notifyOnExit,
    ...(notifyOnExit ? { notifyOnExitEmptySuccess } : {}),
    sessionKey: notifyOnExit ? scopeKey : undefined,
    scopeKey,
  });
  const started = await tool.execute("start", {
    command: currentNodeEvalCommand(source),
    background: true,
    ...params,
  });
  const { sessionId } = runningSession(started.details);
  expect(sessionId).toEqual(expect.any(String));
  return { sessionId, ...processActions(scopeKey, sessionId) };
}

function processActions(scopeKey: string, sessionId: string) {
  const tool = createProcessTool({ scopeKey });
  type Params = Parameters<typeof tool.execute>[1];
  const call = (
    action: Params["action"],
    extra: Omit<Params, "action"> = {},
    signal?: AbortSignal,
  ) => tool.execute(`process-${action}`, { action, sessionId, ...extra }, signal);
  const checkDetails = (result: Awaited<ReturnType<typeof call>>, details: object) => {
    expect(result.details).toMatchObject(details);
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
  };
  const checkRunning = async (action: Params["action"], extra: Omit<Params, "action"> = {}) => {
    const result = await call(action, extra);
    expect(result.details).toMatchObject({ status: "running", sessionId });
    return textContent(result);
  };
  const waitFor = (action: "poll" | "log", expected: string) =>
    expect
      .poll(
        async () => {
          const result = await call(action, action === "poll" ? { timeout: 250 } : {});
          return action === "log"
            ? textContent(result)
            : ((result.details as { aggregated?: string }).aggregated ?? "");
        },
        { timeout: 5_000, interval: 25 },
      )
      .toContain(expected);
  return { tool, call, waitFor, checkRunning, checkDetails };
}

const FINALIZER_SECRET = ["sk", "synthetic", "fixture", "never", "real"].join("-");

test.skipIf(process.platform === "win32")(
  "observes an explicit real process stop without hiding finalizer failure",
  async ({ signal }) => {
    const scopeKey = "agent:main:requested-stop-true";
    await seedOrigin(scopeKey);
    const ready = createDeferredCore();
    const finalizerEntered = createDeferredCore();
    const releaseFinalizer = createDeferredCore();
    const run = await runSandboxProcess({
      command: "requested-stop-proof",
      child: 'process.stdin.resume(); process.stdout.write("STOP_PROOF_READY");',
      stdinMode: "pipe-open",
      onUpdate(update) {
        if (textContent(update).includes("STOP_PROOF_READY")) {
          ready.resolve();
        }
      },
      async finalizeExec() {
        finalizerEntered.resolve();
        await releaseFinalizer.promise;
        throw new Error("requested stop cleanup failed");
      },
      scopeKey,
    });
    const { tool: processTool, call, checkDetails } = processActions(scopeKey, run.session.id);
    try {
      await withinTest(ready.promise, signal);
      markBackgrounded(run.session);
      const requested = await call("kill");
      await withinTest(finalizerEntered.promise, signal);
      checkDetails(requested, {
        status: "completed",
        sessionId: run.session.id,
        cancellationRequested: true,
        terminationConfirmed: false,
        followUp: { action: "poll", sessionId: run.session.id },
      });
      const pending = await call("poll");
      expect(pending.details).toMatchObject({ status: "running", sessionId: run.session.id });
      expect(textContent(pending)).toContain("STOP_PROOF_READY");
      releaseFinalizer.resolve();
      await run.promise;
      expect(await completionPrompt(scopeKey, signal)).toContain("Exec failed");
      const terminal = {
        status: "failed",
        exitReason: "manual-cancel",
        exitSignal: "SIGTERM",
        finalizationFailed: true,
      };
      const listed = await processTool.execute("requested-stop-list", { action: "list" });
      expect.soft(listed.details).toMatchObject({
        sessions: [{ sessionId: run.session.id, ...terminal }],
      });
      expect(Value.Check(processTool.outputSchema!, listed.details)).toBe(true);
      expect.soft(textContent(listed)).not.toContain("[stopped by request]");
      for (const action of ["kill", "poll", "log"] as const) {
        const observed = await call(action);
        checkDetails(observed, terminal);
        expect(isToolResultError(observed)).toBe(true);
        if (action === "kill") {
          expect(observed.details).not.toHaveProperty("cancellationRequested");
          expect(observed.details).not.toHaveProperty("aggregated");
          acknowledgeInternalToolResult(observed);
          // The failure notification already settled through completionPrompt.
          expect(peekSystemEventEntries(scopeKey)).toHaveLength(0);
          expect(observe).toHaveBeenCalledOnce();
          expect(textContent(observed)).toContain("already finished");
        } else if (action === "log") {
          expect(textContent(observed)).toContain("STOP_PROOF_READY");
        } else {
          expect(textContent(observed)).toContain("requested stop cleanup failed");
        }
        expect(textContent(observed)).not.toContain("Process stopped by request");
      }
      expect(getFinishedSession(run.session.id)?.terminalStatus).toBe("failed");
    } finally {
      releaseFinalizer.resolve();
      run.kill();
      await run.promise;
    }
  },
);

test.skipIf(process.platform === "win32").for([
  {
    name: "post-exit finalizer failure",
    child: 'setTimeout(() => { process.stdout.write("REAL_CHILD_OUTPUT"); process.exit(0); }, 80)',
    timeoutSec: 5,
    error: `REAL_FINALIZER_DIAGNOSTIC Authorization: Bearer ${FINALIZER_SECRET}`,
    code: undefined,
    label: "unknown exit code",
  },
  {
    name: "timeout after a clean child exit",
    child:
      'process.on("SIGTERM", () => process.exit(0)); process.stdout.write("REAL_CHILD_OUTPUT"); setInterval(() => {}, 1000)',
    timeoutSec: 1,
    error: undefined,
    code: 0,
    label: "code 0",
  },
] as const)(
  "keeps $name truthful across a real background child, notification, and waiting poll",
  async ({ name, child, timeoutSec, error, code, label }, { signal }) => {
    const scopeKey = `agent:main:process-terminal-${name.replaceAll(" ", "-")}`;
    await seedOrigin(scopeKey);
    const run = await runSandboxProcess({
      command: `real-process-terminal-${name}`,
      containerName: "process-terminal-proof",
      child,
      async finalizeExec() {
        if (error) {
          throw new Error(error);
        }
      },
      maxOutput: 10_000,
      notifyOnExitEmptySuccess: true,
      scopeKey,
      timeoutSec,
    });
    markBackgrounded(run.session);

    const { call, checkDetails } = processActions(scopeKey, run.session.id);
    const pendingPoll = call("poll", { timeout: 2_000 });

    const outcome = await run.promise;
    const notification = await completionPrompt(scopeKey, signal);
    let poll = await pendingPoll;
    if ((poll.details as { status?: string }).status === "running") {
      expect(poll.details).toMatchObject({
        status: "running",
        sessionId: run.session.id,
        aggregated: "REAL_CHILD_OUTPUT",
      });
      expect(textContent(poll)).toContain("REAL_CHILD_OUTPUT");
      poll = await call("poll");
    }
    expect(outcome.status).toBe("failed");
    checkDetails(poll, { status: "failed" });
    expect((poll.details as { exitCode?: number }).exitCode).toBe(code);
    expect(getFinishedSession(run.session.id)?.terminalStatus).toBe("failed");
    expect(textContent(poll)).toContain(`Process exited with ${label}.`);
    expect(notification).toContain(label);
    if (error) {
      for (const text of [textContent(poll), notification]) {
        expect(text).toContain("REAL_FINALIZER_DIAGNOSTIC");
        expect(text).not.toContain(FINALIZER_SECRET);
      }
      expect(getFinishedSession(run.session.id)?.aggregated).not.toContain(FINALIZER_SECRET);
      expect(notification).not.toContain("code 0");
    }
  },
);

test("rejects malformed direct actions before requiring a session id", async () => {
  const result = await createProcessTool().execute("invalid-process-action", {
    action: {},
  } as never);

  expect(textContent(result)).toContain("Invalid process action");
  expect(textContent(result)).not.toContain("sessionId is required");
  expect(result.details).toMatchObject({ status: "failed" });
});

test("renders a real foreground empty nonzero exit with the expected structured output", async () => {
  const execTool = createGatewayExecTool({ allowBackground: false });
  const result = await execTool.execute("foreground-exit-1", {
    command: currentNodeEvalCommand("process.exit(1)"),
  });

  const output = "(no output)\n\n(Command exited with code 1)";
  expect(textContent(result)).toBe(output);
  expect(result.details).toMatchObject({
    status: "completed",
    exitCode: 1,
    aggregated: output,
  });
});

test.skipIf(process.platform === "win32").for([
  { name: "quiet successful exit", exitCode: 0, expectsNotification: false },
  { name: "quiet nonzero exit", exitCode: 7, expectsNotification: true },
])(
  "preserves default completion wake behavior for a real $name",
  async ({ name, exitCode, expectsNotification }, { signal }) => {
    const scopeKey = `agent:main:process-default-wake-${name.replaceAll(" ", "-")}`;
    await seedOrigin(scopeKey);
    const { sessionId } = await startBackground(scopeKey, `process.exit(${exitCode});`, {
      notifyOnExitEmptySuccess: false,
    });

    await waitForExecScope(scopeKey);
    expect(getFinishedSession(sessionId)).toBeDefined();
    if (expectsNotification) {
      expect(await completionPrompt(scopeKey, signal)).toContain(`code ${exitCode}`);
    } else {
      expect(completions.has(scopeKey)).toBe(false);
      expect(model).not.toHaveBeenCalled();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "writes, submits, and confirms cancellation of a real interactive background child",
  async () => {
    const scopeKey = "agent:main:process-control-roundtrip";
    const source = [
      'process.stdin.setEncoding("utf8");',
      "process.stdin.setRawMode?.(true);",
      'let pending = "";',
      'process.stdout.write("READY\\n");',
      'process.stdin.on("data", (chunk) => {',
      "  for (const char of chunk) {",
      '    if (char !== "\\r" && char !== "\\n") {',
      "      pending += char;",
      "      continue;",
      "    }",
      "    if (!pending) continue;",
      "    process.stdout.write(`LINE:${pending}\\n`);",
      '    pending = "";',
      "  }",
      "});",
      "setInterval(() => {}, 1_000);",
    ].join("\n");

    let sessionId: string | undefined;
    try {
      const started = await startBackground(scopeKey, source, { notifyOnExit: false, pty: true });
      sessionId = started.sessionId;
      const { call, waitFor, checkRunning, checkDetails } = started;

      await waitFor("log", "READY");
      expect(await checkRunning("write", { data: "alpha" })).toContain("Wrote 5 bytes");
      expect(textContent(await call("log"))).not.toContain("LINE:alpha");
      expect(await checkRunning("submit")).toContain("Submitted");
      await waitFor("poll", "LINE:alpha");

      const killed = await call("kill");
      expect(textContent(killed)).toBe(
        `Termination requested for session ${sessionId}. Use process poll to confirm exit and cleanup before reporting it stopped.`,
      );
      // A performed kill must not read as a failed tool call.
      checkDetails(killed, { status: "completed" });

      await waitForExecScope(scopeKey);
      const finalPoll = await call("poll", { timeout: 250 });
      expect(finalPoll.details).toMatchObject({
        status: "completed",
        exitReason: "manual-cancel",
        aggregated: expect.stringContaining("LINE:alpha"),
      });

      const completedLog = await call("log");
      checkDetails(completedLog, { status: "completed", sessionId });
      expect(textContent(completedLog)).toContain("LINE:alpha");
    } finally {
      if (sessionId && getSession(sessionId)) {
        await processActions(scopeKey, sessionId).call("kill");
      }
    }
  },
  20_000,
);
