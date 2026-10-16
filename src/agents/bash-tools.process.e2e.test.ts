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
import { withinTest } from "../../test/helpers/promise.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../infra/system-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import {
  getFinishedSession,
  getSession,
  markBackgrounded,
  waitForExecScope,
} from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { runExecProcess } from "./bash-tools.exec-runtime.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import { createProcessTool } from "./bash-tools.process.js";
import type { RunEmbeddedAgentParams } from "./embedded-agent-runner/run/params.js";
import { runEmbeddedAgent } from "./embedded-agent.js";
import { createRequesterYieldCallback } from "./openclaw-tools.requester-yield.js";
import { acknowledgeInternalToolResult } from "./runtime/internal-hooks.js";
import { isToolResultError } from "./tool-result-error.js";
import { createSessionsYieldTool } from "./tools/sessions-yield-tool.js";

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
let config: OpenClawConfig;
const receipts: sessionEvents.SessionEventReceipt[] = [];
const completions = new Map<string, sessionEvents.SessionEventReceipt>();
const enqueue = sessionEvents.enqueueSessionEventForHost;
let observe: MockInstance<typeof enqueue>;

beforeAll(async () => {
  state = await createOpenClawTestState({
    label: "process-notification",
    env: { OPENCLAW_TEST_FAST: "0" },
  });
  config = {
    agents: {
      entries: { main: { workspace: state.workspaceDir } },
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        model: { primary: "mock-openai/gpt-5.6-luna" },
        models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
      },
    },
    plugins: { enabled: false },
    skills: { load: { watch: false } },
  };
  setRuntimeConfigSnapshot(config);
  await state.writeConfig(config);
  openOpenClawStateDatabase();
});

async function admitEvent(params: RunEmbeddedAgentParams) {
  await expectDefined(params.preparedRunAdmission, "real event admission").admit(
    "gateway",
    params.runId,
  );
  params.onExecutionPhase?.({ phase: "model_call_started" });
  await params.onExecutionStarted?.();
  await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
}

const silentReply = () => ({ payloads: [{ text: "NO_REPLY" }], meta: { durationMs: 1 } });

beforeEach(() => {
  model.mockReset().mockImplementation(async (params) => {
    await admitEvent(params);
    return silentReply();
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

async function seedOrigin(
  sessionKey: string,
  overrides: Partial<Parameters<typeof replaceSessionEntry>[1]> = {},
) {
  await replaceSessionEntry(
    { agentId: "main", sessionKey },
    {
      sessionId: sessionKey.replaceAll(":", "-"),
      lifecycleRevision: "original",
      updatedAt: Date.now(),
      sessionStartedAt: Date.now(),
      permissionMode: "full",
      ...overrides,
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
}

function currentNodeEvalCommand(source: string): string {
  const node = shellQuote(process.execPath);
  const script = shellQuote(source);
  return process.platform === "win32" ? `& ${node} -e ${script}` : `${node} -e ${script}`;
}

function textContent(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((part) => part.type === "text")?.text ?? "";
}

function runSandboxProcess({
  command,
  containerName = command,
  child,
  finalizeExec = async () => {},
  maxOutput = 1000,
  timeoutSec = 10,
  notifyOnExit = true,
  ...options
}: Pick<
  Parameters<typeof runExecProcess>[0],
  "command" | "scopeKey" | "notifyOnExitEmptySuccess"
> & {
  child: string;
  containerName?: string;
  finalizeExec?: () => Promise<void>;
  maxOutput?: number;
  timeoutSec?: number;
  notifyOnExit?: boolean;
}) {
  return runExecProcess({
    command,
    timeoutSec,
    notifyOnExit,
    workdir: process.cwd(),
    env: {},
    sandbox: {
      containerName,
      workspaceDir: process.cwd(),
      containerWorkdir: process.cwd(),
      buildExecSpec: async () => ({
        argv: [process.execPath, "-e", child],
        env: {},
        stdinMode: "pipe-closed",
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
  const sessionId = backgroundSessionId(started.details);
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
  return { tool, call, waitFor };
}

function backgroundSessionId(details: ExecToolDetails): string {
  const sessionId = details.status === "running" ? details.sessionId : undefined;
  expect(sessionId).toEqual(expect.any(String));
  if (!sessionId) {
    throw new Error("exec did not return a background session id");
  }
  return sessionId;
}

const FINALIZER_SECRET = ["sk", "synthetic", "fixture", "never", "real"].join("-");

test.skipIf(process.platform === "win32")(
  "keeps subagent yield blocked until a real finalized background exec is collected",
  async () => {
    const scopeKey = "agent:main:subagent:process-yield";
    const runId = "process-yield-run";
    const registry = await import("./subagents/registry/subagent-registry.test-helpers.js");
    await registry.resetSubagentRegistryForTests();
    await registry.addSubagentRunForTests({
      runId,
      childSessionKey: scopeKey,
      childAgentId: "main",
      createdAt: 1,
      expectsCompletionMessage: false,
    });
    const finalization = createDeferredCore();
    const run = await runSandboxProcess({
      command: "yield-retention-proof",
      child: "process.exit(2)",
      finalizeExec: () => finalization.promise,
      notifyOnExit: false,
      scopeKey,
    });
    markBackgrounded(run.session);
    let yieldCount = 0;
    const yieldTool = createSessionsYieldTool({
      sessionId: "process-yield",
      claimYield: createRequesterYieldCallback({
        requesterSessionKey: scopeKey,
        requesterAgentId: "main",
        requesterTurnRunId: runId,
      }),
      onYield: () => {
        yieldCount += 1;
      },
    });
    try {
      expect((await yieldTool.execute("yield-running", {})).details).toMatchObject({
        status: "error",
      });
      finalization.resolve();
      await run.promise;
      const retained = getFinishedSession(run.session.id);
      expect(retained?.scopeKey).toBe(scopeKey);
      expect(retained?.sessionKey).toBeUndefined();
      expect((await yieldTool.execute("yield-finished", {})).details).toMatchObject({
        status: "error",
        error: expect.stringContaining("Use process to poll and collect"),
      });
      expect(yieldCount).toBe(0);
      const poll = await processActions(scopeKey, run.session.id).call("poll");
      acknowledgeInternalToolResult(poll);
      expect(
        (await yieldTool.execute("yield-collected", { waitFor: "message" })).details,
      ).toMatchObject({
        status: "yielded",
      });
      expect(yieldCount).toBe(1);
    } finally {
      finalization.resolve();
      run.kill();
      await run.promise;
      await registry.resetSubagentRegistryForTests();
    }
  },
);

test.skipIf(process.platform === "win32").for([false, true])(
  "observes an explicit real process stop without hiding finalizer failure (fails=%s)",
  async (finalizerFails, { signal }) => {
    const scopeKey = `agent:main:requested-stop-${finalizerFails}`;
    await seedOrigin(scopeKey);
    const run = await runSandboxProcess({
      command: "requested-stop-proof",
      child: 'process.stdout.write("STOP_PROOF_READY"); setInterval(() => {}, 1000)',
      async finalizeExec() {
        if (finalizerFails) {
          throw new Error("requested stop cleanup failed");
        }
      },
      scopeKey,
    });
    markBackgrounded(run.session);
    const { tool: processTool, call } = processActions(scopeKey, run.session.id);
    try {
      await expect.poll(() => run.session.aggregated).toContain("STOP_PROOF_READY");
      await call("kill");
      await run.promise;
      if (finalizerFails) {
        expect(await completionPrompt(scopeKey, signal)).toContain("Exec failed");
      } else {
        expect(completions.has(scopeKey)).toBe(false);
        expect(model).not.toHaveBeenCalled();
      }
      for (const action of ["poll", "log"] as const) {
        const observed = await call(action);
        expect(observed.details).toMatchObject({
          status: finalizerFails ? "failed" : "completed",
          exitReason: "manual-cancel",
          exitSignal: "SIGTERM",
        });
        expect(isToolResultError(observed)).toBe(finalizerFails);
        expect(Value.Check(processTool.outputSchema!, observed.details)).toBe(true);
        expect(textContent(observed)).toContain("STOP_PROOF_READY");
        if (finalizerFails) {
          expect(textContent(observed)).not.toContain("Process stopped by request");
        } else {
          expect(textContent(observed)).toContain("Process stopped by request (signal SIGTERM).");
        }
      }
      expect(getFinishedSession(run.session.id)?.terminalStatus).toBe("failed");
    } finally {
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

    const { tool: processTool, call } = processActions(scopeKey, run.session.id);
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
    const details = poll.details as { status?: string; exitCode?: number };

    expect(outcome.status).toBe("failed");
    expect(details.status).toBe("failed");
    expect(Value.Check(processTool.outputSchema!, poll.details)).toBe(true);
    expect(details.exitCode).toBe(code);
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
  "consumes a real notify-on-exit event when the terminal process poll is acknowledged",
  async ({ signal }) => {
    const scopeKey = "agent:main:process-notify-poll";
    await seedOrigin(scopeKey);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const runModel = expectDefined(model.getMockImplementation(), "model inference fixture");
    model.mockImplementation(async (params) => {
      const result = await runModel(params);
      entered.resolve();
      await release.promise;
      return result;
    });
    const predecessor = enqueue("Hold the preceding turn", {
      agentId: "main",
      sessionKey: scopeKey,
      source: "task",
      expectedTarget: await sessionEvents.captureSessionEventTargetForHost("main", scopeKey),
      abortSignal: signal,
      deliver: false,
    });
    const marker = "REAL_NOTIFY_ON_EXIT";
    try {
      expect(await withinTest(predecessor.accepted, signal)).toEqual({ ok: true });
      await withinTest(entered.promise, signal);
      const { sessionId, call } = await startBackground(
        scopeKey,
        `process.stdout.write(${JSON.stringify(marker)});`,
      );

      await waitForExecScope(scopeKey);
      const completion = expectDefined(completions.get(scopeKey), "queued exec completion");
      expect(await withinTest(completion.accepted, signal)).toEqual({ ok: true });
      expect(peekSystemEventEntries(scopeKey)).toEqual([
        expect.objectContaining({ id: completion.id, text: expect.stringContaining(marker) }),
      ]);

      const poll = await call("poll");
      expect(poll.details).toMatchObject({ status: "completed", sessionId });
      expect(peekSystemEventEntries(scopeKey)).toHaveLength(1);
      acknowledgeInternalToolResult(poll);
      expect(await withinTest(completion.settled, signal)).toMatchObject({
        status: "cancelled",
        executionStarted: false,
      });
      expect(peekSystemEventEntries(scopeKey)).toHaveLength(0);
      release.resolve();
      expect(await withinTest(predecessor.settled, signal)).toMatchObject({ status: "completed" });
      expect(model).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await waitForExecScope(scopeKey);
      await predecessor.settled;
    }
  },
);

test.skipIf(process.platform === "win32")(
  "controls and cancels one real interactive background child through process tools",
  async () => {
    const scopeKey = "agent:main:process-control-roundtrip";
    const source = [
      'process.stdin.setEncoding("utf8");',
      "process.stdin.setRawMode?.(true);",
      'let pending = "";',
      "let lineCount = 0;",
      'process.stdout.write("READY\\n");',
      'process.stdin.on("data", (chunk) => {',
      "  for (const char of chunk) {",
      '    if (char === "\\u0003") {',
      "      process.stdout.write(`CONTROL:CTRL-C:${lineCount}\\n`);",
      "      continue;",
      "    }",
      '    if (char !== "\\r" && char !== "\\n") {',
      "      pending += char;",
      "      continue;",
      "    }",
      "    if (!pending) continue;",
      "    lineCount += 1;",
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
      const { tool: processTool, call, waitFor } = started;

      const listed = await call("list");
      expect(listed.details).toMatchObject({
        status: "completed",
        sessions: expect.arrayContaining([
          expect.objectContaining({
            sessionId,
            status: "running",
            stdinWritable: true,
          }),
        ]),
      });

      await waitFor("log", "READY");

      const readyPoll = await call("poll", { timeout: 30_000 }, AbortSignal.timeout(1_000));
      expect(readyPoll.details).toMatchObject({
        status: "running",
        sessionId,
        aggregated: expect.stringContaining("READY"),
      });

      const write = await call("write", { data: "alpha" });
      expect(write.details).toMatchObject({ status: "running", sessionId });
      expect(textContent(write)).toContain("Wrote 5 bytes");

      const beforeSubmit = await call("log");
      expect(textContent(beforeSubmit)).not.toContain("LINE:alpha");

      const submit = await call("submit");
      expect(submit.details).toMatchObject({ status: "running", sessionId });
      expect(textContent(submit)).toContain("Submitted");

      await waitFor("poll", "LINE:alpha");

      const literal = await call("send-keys", { literal: "beta" });
      expect(literal.details).toMatchObject({ status: "running", sessionId });
      expect(textContent(literal)).toContain("Sent 4 bytes");

      const enter = await call("send-keys", { keys: ["Enter"] });
      expect(enter.details).toMatchObject({ status: "running", sessionId });

      await waitFor("poll", "LINE:beta");

      const interrupt = await call("send-keys", { keys: ["C-c"] });
      expect(interrupt.details).toMatchObject({ status: "running", sessionId });
      await waitFor("log", "CONTROL:CTRL-C:2");

      const killed = await call("kill");
      expect(textContent(killed)).toBe(`Termination requested for session ${sessionId}.`);
      // A performed kill must not read as a failed tool call.
      expect(killed.details).toMatchObject({ status: "completed" });
      expect(Value.Check(processTool.outputSchema!, killed.details)).toBe(true);

      await waitForExecScope(scopeKey);
      const finalPoll = await call("poll", { timeout: 250 });
      expect(finalPoll.details).toMatchObject({
        status: "completed",
        exitReason: "manual-cancel",
        aggregated: expect.stringContaining("CONTROL:CTRL-C:2"),
      });

      const completedLog = await call("log");
      expect(completedLog.details).toMatchObject({ status: "completed", sessionId });
      expect(Value.Check(processTool.outputSchema!, completedLog.details)).toBe(true);
      for (const output of ["LINE:alpha", "LINE:beta", "CONTROL:CTRL-C:2"]) {
        expect(textContent(completedLog)).toContain(output);
      }
    } finally {
      if (sessionId && getSession(sessionId)) {
        await processActions(scopeKey, sessionId).call("kill");
      }
    }
  },
  20_000,
);

test.skipIf(process.platform === "win32")(
  "re-admits a real deferred exec completion under a policy published mid-turn",
  async ({ signal }) => {
    const scopeKey = "agent:main:process-config-readmission";
    await seedOrigin(scopeKey, {
      sessionId: "process-config-readmission",
      // A channel route arms the durable exec source claim.
      delivery: normalizeSessionDeliveryState({
        context: { channel: "telegram", to: "-100001", accountId: "readmission" },
      }),
    });
    const held = createDeferredCore();
    const firstStarted = createDeferredCore();
    const turns: Array<{ prompt: string; deny: readonly string[] | undefined }> = [];
    model.mockImplementation(async (params: RunEmbeddedAgentParams) => {
      await admitEvent(params);
      turns.push({ prompt: params.prompt, deny: params.config?.tools?.deny });
      if (turns.length === 1) {
        firstStarted.resolve();
        await held.promise;
      }
      return silentReply();
    });
    const target = await sessionEvents.captureSessionEventTargetForHost("main", scopeKey);
    sessionEvents.enqueueSessionEventForHost("Hold the active turn", {
      agentId: "main",
      sessionKey: scopeKey,
      source: "task",
      expectedTarget: target,
      deliver: false,
    });
    try {
      await withinTest(firstStarted.promise, signal);
      const run = await runSandboxProcess({
        command: "config-readmission-proof",
        child: 'setTimeout(() => { process.stdout.write("READMISSION_CHILD_OUTPUT"); }, 100)',
        notifyOnExitEmptySuccess: true,
        scopeKey,
      });
      markBackgrounded(run.session);
      await run.promise;
      const completion = expectDefined(completions.get(scopeKey), "real exec completion");
      // The active turn accepted the producer's completion as a deferred follow-up.
      expect(await withinTest(completion.accepted, signal)).toEqual({ ok: true });
      // The real producer's durable source identity rides along.
      expect(
        observe.mock.calls.find(([, options]) => options.source === "exec")?.[1].sourceTurnId,
      ).toMatch(/^exec:./);
      setRuntimeConfigSnapshot({ ...config, tools: { deny: ["write"] } });
      held.resolve();
      expect(await withinTest(completion.settled, signal)).toMatchObject({
        status: "completed",
        executionStarted: true,
      });
      expect(turns).toHaveLength(2);
      expect(turns[1]?.prompt).toContain("READMISSION_CHILD_OUTPUT");
      // The completion turn binds the published policy, not the enqueue-time snapshot.
      expect(turns[1]?.deny).toEqual(["write"]);
      expect(peekSystemEventEntries(scopeKey)).toEqual([]);
    } finally {
      held.resolve();
      setRuntimeConfigSnapshot(config);
    }
  },
);
