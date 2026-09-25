import fs from "node:fs/promises";
/**
 * Integration-style tests for before_tool_call behavior.
 * Covers loop detection, diagnostics, plugin approval, and skill telemetry
 * around wrapped tool execution.
 */
import os from "node:os";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
  type DiagnosticToolLoopEvent,
} from "../infra/diagnostic-events.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticArgumentChurnObservation,
  markDiagnosticEmbeddedRunStarted,
  resetDiagnosticRunActivityForTest,
} from "../logging/diagnostic-run-activity.js";
import {
  getDiagnosticSessionState,
  resetDiagnosticSessionStateForTest,
} from "../logging/diagnostic-session-state.js";
import { PluginApprovalResolutions } from "../plugins/hook-before-tool-call-result.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createHookRunner, type HookRunner } from "../plugins/hooks.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { consumeRunSkillUsage } from "../skills/runtime/run-usage.js";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";
import {
  getBeforeToolCallFailureDisposition,
  runBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import { beforeToolCallRuntime } from "./agent-tools.before-tool-call.runtime.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { createReadTool, createWriteTool } from "./sessions/index.js";
import { TOOL_LOOP_WARNING_THRESHOLD } from "./tool-loop-thresholds.js";
import type { AnyAgentTool } from "./tools/common.js";
import { callGatewayTool } from "./tools/gateway.js";

const CRITICAL_THRESHOLD = 20;
const GLOBAL_CIRCUIT_BREAKER_THRESHOLD = 30;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function currentNodeEvalCommand(source: string): string {
  const shellQuote = (value: string) =>
    `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
  const command = `${shellQuote(process.execPath)} -e ${shellQuote(source)}`;
  return process.platform === "win32" ? `& ${command}` : command;
}

vi.mock("../plugins/hook-runner-global.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/hook-runner-global.js")>(
    "../plugins/hook-runner-global.js",
  );
  return {
    ...actual,
    getGlobalHookRunner: vi.fn(actual.getGlobalHookRunner),
  };
});
vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const hookRunnerGlobalStateKey = Symbol.for("openclaw.plugins.hook-runner-global-state");

function setGlobalHookRunnerForTest(hookRunner: HookRunner | null): void {
  const hookRunnerGlobalState = globalThis as Record<
    symbol,
    { hookRunner: HookRunner | null; registry?: unknown } | undefined
  >;
  if (!hookRunnerGlobalState[hookRunnerGlobalStateKey]) {
    hookRunnerGlobalState[hookRunnerGlobalStateKey] = {
      hookRunner: null,
      registry: null,
    };
  }
  hookRunnerGlobalState[hookRunnerGlobalStateKey].hookRunner = hookRunner;
}

function getGlobalHookRunnerForTest(): HookRunner | null {
  const hookRunnerGlobalState = globalThis as Record<
    symbol,
    { hookRunner: HookRunner | null; registry?: unknown } | undefined
  >;
  return hookRunnerGlobalState[hookRunnerGlobalStateKey]?.hookRunner ?? null;
}

type TestHookRunner = HookRunner & {
  hasHooks: ReturnType<typeof vi.fn<HookRunner["hasHooks"]>>;
  runBeforeToolCall: ReturnType<typeof vi.fn<HookRunner["runBeforeToolCall"]>>;
};

function createTestHookRunner(): TestHookRunner {
  return {
    ...createHookRunner(createEmptyPluginRegistry()),
    hasHooks: vi.fn<HookRunner["hasHooks"]>(),
    runBeforeToolCall: vi.fn<HookRunner["runBeforeToolCall"]>(),
  };
}

function createStableNoProgressWriteResult() {
  return {
    content: [{ type: "text" as const, text: "write made no changes" }],
    details: { ok: true, changed: false },
  };
}

function asAgentTool(tool: { name: string; execute: ReturnType<typeof vi.fn> }): AnyAgentTool {
  return tool as unknown as AnyAgentTool;
}

afterEach(() => {
  resetDiagnosticRunActivityForTest();
  setGlobalHookRunnerForTest(null);
  mockGetGlobalHookRunner.mockReset();
  mockGetGlobalHookRunner.mockImplementation(() => getGlobalHookRunnerForTest());
});

describe("before_tool_call loop detection behavior", () => {
  let hookRunner: TestHookRunner;
  const enabledLoopDetectionContext = {
    agentId: "main",
    sessionKey: "main",
    loopDetection: { enabled: true },
  };

  const disabledLoopDetectionContext = {
    agentId: "main",
    sessionKey: "main",
    loopDetection: { enabled: false },
  };

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
    hookRunner = createTestHookRunner();
    mockGetGlobalHookRunner.mockReturnValue(hookRunner);
    hookRunner.hasHooks.mockReturnValue(false);
  });

  function createWrappedTool(
    name: string,
    execute: ReturnType<typeof vi.fn>,
    loopDetectionContext: Parameters<
      typeof wrapToolWithBeforeToolCallHook
    >[1] = enabledLoopDetectionContext,
  ) {
    return wrapToolWithBeforeToolCallHook(
      { name, execute } as unknown as AnyAgentTool,
      loopDetectionContext,
    );
  }

  async function withToolLoopEvents(
    run: (emitted: DiagnosticToolLoopEvent[]) => Promise<void>,
    filter: (evt: DiagnosticToolLoopEvent) => boolean = () => true,
  ) {
    const emitted: DiagnosticToolLoopEvent[] = [];
    const stop = onDiagnosticEvent((evt) => {
      if (evt.type === "tool.loop" && filter(evt)) {
        emitted.push(evt);
      }
    });
    try {
      await run(emitted);
    } finally {
      stop();
    }
  }

  async function withToolExecutionEvents(
    run: (emitted: DiagnosticEventPayload[], flush: () => Promise<void>) => Promise<void>,
  ) {
    const emitted: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((evt) => {
      if (evt.type.startsWith("tool.execution.")) {
        emitted.push(evt);
      }
    });
    const flush = () =>
      new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    try {
      await run(emitted, flush);
    } finally {
      stop();
    }
  }

  async function withDiagnosticEvents(
    run: (emitted: DiagnosticEventPayload[], flush: () => Promise<void>) => Promise<void>,
  ) {
    const emitted: DiagnosticEventPayload[] = [];
    const stop = onInternalDiagnosticEvent((evt) => {
      emitted.push(evt);
    });
    const flush = () =>
      new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    try {
      await run(emitted, flush);
    } finally {
      stop();
    }
  }

  async function withSkillUsageDiagnosticEvents(
    run: (
      emitted: DiagnosticEventPayload[],
      privateData: DiagnosticEventPrivateData[],
      flush: () => Promise<void>,
    ) => Promise<void>,
  ) {
    const emitted: DiagnosticEventPayload[] = [];
    const skillUsagePrivateData: DiagnosticEventPrivateData[] = [];
    const stopShared = onInternalDiagnosticEvent((event) => emitted.push(event));
    const stopTrusted = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type === "skill.used") {
        skillUsagePrivateData.push(privateData);
      }
    });
    const flush = () =>
      new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    try {
      await run(emitted, skillUsagePrivateData, flush);
    } finally {
      stopTrusted();
      stopShared();
    }
  }

  function createPingPongTools(options?: { withProgress?: boolean }) {
    const readExecute = options?.withProgress
      ? vi.fn().mockImplementation(async (toolCallId: string) => ({
          content: [{ type: "text", text: `read ${toolCallId}` }],
          details: { ok: true },
        }))
      : vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "read ok" }],
          details: { ok: true },
        });
    const listExecute = options?.withProgress
      ? vi.fn().mockImplementation(async (toolCallId: string) => ({
          content: [{ type: "text", text: `list ${toolCallId}` }],
          details: { ok: true },
        }))
      : vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "list ok" }],
          details: { ok: true },
        });
    return {
      readTool: createWrappedTool("read", readExecute),
      listTool: createWrappedTool("list", listExecute),
    };
  }

  async function runPingPongSequence(
    readTool: ReturnType<typeof createWrappedTool>,
    listTool: ReturnType<typeof createWrappedTool>,
    count: number,
  ) {
    for (let i = 0; i < count; i += 1) {
      if (i % 2 === 0) {
        await readTool.execute(`read-${i}`, { path: "/a.txt" }, undefined, undefined);
      } else {
        await listTool.execute(`list-${i}`, { dir: "/workspace" }, undefined, undefined);
      }
    }
  }

  function createGenericReadRepeatFixture(
    loopDetectionContext?: Parameters<typeof createWrappedTool>[2],
  ) {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "same output" }],
      details: { ok: true },
    });
    return {
      tool: createWrappedTool("read", execute, loopDetectionContext),
      execute,
      params: { path: "/tmp/file" },
    };
  }

  function createNoProgressProcessFixture(sessionId: string) {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "(no new output)\n\nProcess still running." }],
      details: { status: "running", aggregated: "steady" },
    });
    return {
      tool: createWrappedTool("process", execute),
      params: { action: "poll", sessionId },
    };
  }

  function expectCriticalLoopEvent(
    loopEvent: DiagnosticToolLoopEvent | undefined,
    params: {
      detector: "ping_pong" | "known_poll_no_progress" | "global_circuit_breaker";
      toolName: string;
      count?: number;
    },
  ) {
    expect(loopEvent?.type).toBe("tool.loop");
    expect(loopEvent?.level).toBe("critical");
    expect(loopEvent?.action).toBe("block");
    expect(loopEvent?.detector).toBe(params.detector);
    expect(loopEvent?.count).toBe(params.count ?? CRITICAL_THRESHOLD);
    expect(loopEvent?.toolName).toBe(params.toolName);
  }

  function expectToolLoopBlockedResult(result: unknown, expectedReason: string) {
    const record = requireRecord(result, "tool result");
    const content = requireArray(record.content, "tool result content");
    const textContent = requireRecord(content[0], "tool result content item");
    expect(textContent.type).toBe("text");
    expect(String(textContent.text)).toContain(expectedReason);
    const details = requireRecord(record.details, "tool result details");
    expect(details.status).toBe("blocked");
    expect(details.deniedReason).toBe("tool-loop");
    expect(String(details.reason)).toContain(expectedReason);
  }

  async function expectUnblockedToolExecution(
    tool: ReturnType<typeof createWrappedTool>,
    toolCallId: string,
    params: unknown,
  ) {
    const result = await tool.execute(toolCallId, params, undefined, undefined);
    const record = requireRecord(result, "tool result");
    requireArray(record.content, "tool result content");
    requireRecord(record.details, "tool result details");
    return result;
  }

  const requireRecord = createRequireRecord("object", "label-not-object");

  function requireArray(value: unknown, label: string): unknown[] {
    expect(Array.isArray(value)).toBe(true);
    if (!Array.isArray(value)) {
      throw new Error(`${label} was not an array`);
    }
    return value;
  }

  function expectEventFields(
    event: DiagnosticEventPayload | DiagnosticToolLoopEvent | undefined,
    fields: Record<string, unknown>,
  ): Record<string, unknown> {
    const record = requireRecord(event, "diagnostic event");
    for (const [key, value] of Object.entries(fields)) {
      expect(record[key]).toEqual(value);
    }
    return record;
  }

  it("blocks known poll loops when no progress repeats", async () => {
    const { tool, params } = createNoProgressProcessFixture("sess-1");

    for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
      await expectUnblockedToolExecution(tool, `poll-${i}`, params);
    }

    await withDiagnosticEvents(async (emitted, flush) => {
      const result = await tool.execute(`poll-${CRITICAL_THRESHOLD}`, params, undefined, undefined);
      await flush();
      expectToolLoopBlockedResult(result, "CRITICAL");
      const securityEvent = emitted.find(
        (event): event is Extract<DiagnosticEventPayload, { type: "security.event" }> =>
          event.type === "security.event",
      );
      expect(securityEvent).toMatchObject({
        type: "security.event",
        category: "tool",
        action: "tool.execution.blocked",
        outcome: "denied",
        reason: "tool-loop",
        policy: {
          id: "tool-loop-detection",
          decision: "deny",
          reason: "tool-loop",
        },
        control: {
          id: "tool-loop-detection",
          family: "authorization",
        },
        attributes: {
          params_kind: "object",
          tool_source: "core",
        },
      });
    });
  });

  it("does nothing when loopDetection.enabled is false", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "(no new output)\n\nProcess still running." }],
      details: { status: "running", aggregated: "steady" },
    });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "process", execute }), {
      ...disabledLoopDetectionContext,
    });
    const params = { action: "poll", sessionId: "sess-off" };

    for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
      await expectUnblockedToolExecution(tool, `poll-${i}`, params);
    }
  });

  it.each([
    { label: "unconfigured", loopDetection: undefined },
    { label: "disabled", loopDetection: { enabled: false } },
  ])(
    "does not warn or activate changed-write churn when loop detection is $label",
    async (testCase) => {
      const sessionId = `write-churn-${testCase.label}-session`;
      const sessionKey = "main";
      const runId = `write-churn-${testCase.label}-run`;
      const execute = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "write complete" }],
        details: { changed: true },
      });
      markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey, runId });
      const tool = createWrappedTool("write", execute, {
        agentId: "main",
        cwd: "/tmp",
        sessionId,
        sessionKey,
        runId,
        ...(testCase.loopDetection ? { loopDetection: testCase.loopDetection } : {}),
      });
      const markChurn = vi.spyOn(beforeToolCallRuntime, "markDiagnosticArgumentChurnObservation");

      try {
        await withToolLoopEvents(async (emitted) => {
          for (let index = 0; index <= TOOL_LOOP_WARNING_THRESHOLD; index += 1) {
            await expectUnblockedToolExecution(tool, `write-churn-${testCase.label}-${index}`, {
              path: "draft.md",
              content: `synthetic revision ${index}`,
            });
          }
          expect(emitted).toHaveLength(0);
        });
        expect(markChurn).not.toHaveBeenCalled();
        expect(
          getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey }).lastProgressReason,
        ).not.toBe("tool_loop:argument_churn");
      } finally {
        markChurn.mockRestore();
      }
    },
  );

  it("does not block known poll loops when output progresses", async () => {
    const execute = vi.fn().mockImplementation(async (toolCallId: string) => {
      return {
        content: [{ type: "text", text: `output ${toolCallId}` }],
        details: { status: "running", aggregated: `output ${toolCallId}` },
      };
    });
    const tool = createWrappedTool("process", execute);
    const params = { action: "poll", sessionId: "sess-2" };

    for (let i = 0; i < CRITICAL_THRESHOLD + 5; i += 1) {
      await expectUnblockedToolExecution(tool, `poll-progress-${i}`, params);
    }
  });

  it("keeps generic repeated calls unblocked below critical threshold", async () => {
    const { tool, params } = createGenericReadRepeatFixture();

    for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
      await expectUnblockedToolExecution(tool, `read-${i}`, params);
    }
  });

  it("blocks generic repeated no-progress calls at critical threshold", async () => {
    const { tool, params } = createGenericReadRepeatFixture();

    for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
      await expectUnblockedToolExecution(tool, `read-${i}`, params);
    }

    const result = await tool.execute(`read-${CRITICAL_THRESHOLD}`, params, undefined, undefined);
    expectToolLoopBlockedResult(result, "identical outcomes");
  });

  it("blocks real exec failures whose process ids drift across a session alias merge", async () => {
    const workspace = tempDirs.make("openclaw-exec-loop-merge-");
    const sessionId = "exec-loop-merge-session";
    const sessionKey = "agent:main:exec-loop-merge";
    const sessionIdAlias = "agent:main:exec-loop-merge-id";
    const runId = "exec-loop-merge-run";
    const script = "process.stderr.write(`retry pid ${process.pid}\\n`); process.exit(1)";
    const command = currentNodeEvalCommand(script);
    const execDefaults = {
      host: "gateway" as const,
      security: "full" as const,
      ask: "off" as const,
      cwd: workspace,
      allowBackground: false,
    };
    const sessionIdTool = wrapToolWithBeforeToolCallHook(createExecTool(execDefaults), {
      agentId: "main",
      sessionId,
      sessionKey: sessionIdAlias,
      runId,
      loopDetection: { enabled: true },
    });
    const sessionKeyTool = wrapToolWithBeforeToolCallHook(createExecTool(execDefaults), {
      agentId: "main",
      sessionKey,
      runId,
      loopDetection: { enabled: true },
    });
    const outputs = new Set<string>();

    for (const [alias, tool] of [
      ["id", sessionIdTool],
      ["key", sessionKeyTool],
    ] as const) {
      for (let index = 0; index < CRITICAL_THRESHOLD / 2; index += 1) {
        const result = await tool.execute(`exec-loop-${alias}-${index}`, { command });
        const details = requireRecord(result.details, "exec result details");
        expect(details).toMatchObject({ status: "completed", exitCode: 1 });
        const aggregated = details.aggregated;
        expect(aggregated).toBeTypeOf("string");
        if (typeof aggregated !== "string") {
          throw new Error("exec result details.aggregated was not a string");
        }
        outputs.add(aggregated);
      }
    }
    expect(outputs.size).toBeGreaterThan(1);

    const merged = getDiagnosticSessionState({ sessionId, sessionKey });
    expect(merged.toolCallHistory).toHaveLength(CRITICAL_THRESHOLD);

    const mergedTool = wrapToolWithBeforeToolCallHook(createExecTool(execDefaults), {
      agentId: "main",
      sessionId,
      sessionKey,
      runId,
      loopDetection: { enabled: true },
    });
    const blocked = await mergedTool.execute("exec-loop-blocked", { command });
    expectToolLoopBlockedResult(blocked, "identical outcomes");
  });

  it("blocks changing-argument terminal exec failures and escalates vetoes", async () => {
    const output = "Traceback: missing package\n\n(Command exited with code 1)";
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: output }],
      details: { status: "completed", exitCode: 1, aggregated: output },
    });
    const tool = createWrappedTool("exec", execute);

    await withToolLoopEvents(async (emitted) => {
      for (let index = 0; index <= GLOBAL_CIRCUIT_BREAKER_THRESHOLD; index += 1) {
        const result = await tool.execute(
          `exec-semantic-${index}`,
          { command: `python job-${index}.py` },
          undefined,
          undefined,
        );
        if (index >= CRITICAL_THRESHOLD) {
          expectToolLoopBlockedResult(
            result,
            index === GLOBAL_CIRCUIT_BREAKER_THRESHOLD
              ? "global circuit breaker"
              : "identical outcomes",
          );
        }
      }

      expect(execute).toHaveBeenCalledTimes(CRITICAL_THRESHOLD);
      expect(emitted.find((event) => event.detector === "generic_repeat")).toMatchObject({
        level: "critical",
        action: "block",
        count: CRITICAL_THRESHOLD,
        toolName: "exec",
      });
      expect(emitted.at(-1)).toMatchObject({
        detector: "global_circuit_breaker",
        level: "critical",
        action: "block",
        count: GLOBAL_CIRCUIT_BREAKER_THRESHOLD,
        toolName: "exec",
      });
    });
  });

  it("does not activate changed-write liveness below the warning threshold", async () => {
    const sessionId = "same-target-write-below-threshold-session";
    const runId = "same-target-write-below-threshold-run";
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "write complete" }],
      details: { changed: true },
    });
    const loopDetectionContext = {
      ...enabledLoopDetectionContext,
      cwd: "/tmp",
      sessionId,
      runId,
    };
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey: "main", runId });
    const writeTool = createWrappedTool("write", execute, loopDetectionContext);
    const markChurn = vi.spyOn(beforeToolCallRuntime, "markDiagnosticArgumentChurnObservation");

    try {
      for (let index = 0; index < TOOL_LOOP_WARNING_THRESHOLD; index += 1) {
        await expectUnblockedToolExecution(writeTool, `same-target-write-below-${index}`, {
          path: "draft.md",
          content: `synthetic revision ${index}`,
        });
      }

      expect(
        markChurn.mock.calls
          .map(([observation]) => observation)
          .filter((observation) => observation.existingOnly),
      ).not.toContainEqual(expect.objectContaining({ active: true }));
    } finally {
      markChurn.mockRestore();
    }
  });

  it("warns on same-target changed-write churn while preserving execution and read escape", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-same-target-churn-"));
    const sessionId = "same-target-write-churn-session";
    const runId = "same-target-write-churn-run";
    const loopDetectionContext = {
      ...enabledLoopDetectionContext,
      cwd: tmpDir,
      sessionId,
      runId,
    };
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey: "main", runId });
    const writeTool = wrapToolWithBeforeToolCallHook(
      createWriteTool(tmpDir) as unknown as AnyAgentTool,
      loopDetectionContext,
    );
    const readTool = wrapToolWithBeforeToolCallHook(
      createReadTool(tmpDir) as unknown as AnyAgentTool,
      loopDetectionContext,
    );

    try {
      for (let index = 0; index < TOOL_LOOP_WARNING_THRESHOLD; index += 1) {
        await expectUnblockedToolExecution(writeTool, `same-target-write-${index}`, {
          path: "draft.md",
          content: `synthetic revision ${index}`,
        });
      }

      await withToolLoopEvents(async (emitted) => {
        await expectUnblockedToolExecution(writeTool, "same-target-write-warning", {
          path: "notes/../draft.md",
          content: "synthetic next revision",
        });
        expect(emitted).toHaveLength(1);
        expect(emitted.at(-1)).toMatchObject({
          type: "tool.loop",
          level: "warning",
          action: "warn",
          detector: "argument_churn",
          toolName: "write",
          count: TOOL_LOOP_WARNING_THRESHOLD,
        });
      });
      expect(getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey: "main" })).toMatchObject(
        {
          lastProgressReason: "tool_loop:argument_churn",
        },
      );
      await expect(fs.readFile(path.join(tmpDir, "draft.md"), "utf8")).resolves.toBe(
        "synthetic next revision",
      );

      await expectUnblockedToolExecution(readTool, "same-target-write-readback", {
        path: "draft.md",
      });
      await withToolLoopEvents(async (emitted) => {
        await expectUnblockedToolExecution(writeTool, "same-target-write-after-read", {
          path: "draft.md",
          content: "verified revision",
        });
        expect(emitted).toHaveLength(0);
      });
      await expect(fs.readFile(path.join(tmpDir, "draft.md"), "utf8")).resolves.toBe(
        "verified revision",
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("activates stable no-progress churn on the sixth completed outcome", async () => {
    const sessionId = "stable-churn-completion-session";
    const runId = "stable-churn-completion-run";
    const markChurn = vi.spyOn(beforeToolCallRuntime, "markDiagnosticArgumentChurnObservation");
    const tool = createWrappedTool(
      "write",
      vi.fn().mockResolvedValue(createStableNoProgressWriteResult()),
      { ...enabledLoopDetectionContext, sessionId, runId },
    );
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey: "main", runId });

    try {
      for (let index = 0; index < 6; index += 1) {
        await expectUnblockedToolExecution(tool, `stable-churn-completion-${index}`, {
          path: index % 2 === 0 ? "/tmp/a.md" : "/tmp/b.md",
          content: "same content",
        });
      }
      const outcomeObservations = markChurn.mock.calls
        .map(([observation]) => observation)
        .filter((observation) => observation.existingOnly === true);
      expect(outcomeObservations).toHaveLength(6);
      expect(outcomeObservations.slice(0, 5).every((observation) => !observation.active)).toBe(
        true,
      );
      expect(outcomeObservations.at(-1)?.active).toBe(true);
    } finally {
      markChurn.mockRestore();
    }
  });

  it("warns on non-strict same-tool argument churn while preserving tool execution", async () => {
    const execute = vi.fn().mockImplementation(async (toolCallId: string, _params: unknown) => {
      const progressed = toolCallId === "write-churn-progress";
      return progressed
        ? {
            content: [{ type: "text", text: "write updated content" }],
            details: { ok: true, changed: true, revision: 2 },
          }
        : createStableNoProgressWriteResult();
    });
    const sessionId = "write-churn-session";
    const runId = "write-churn-run";
    const loopDetectionContext = {
      ...enabledLoopDetectionContext,
      sessionId,
      runId,
    };
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey: "main", runId });
    const tool = createWrappedTool("write", execute, loopDetectionContext);
    const paths = ["/tmp/a.md", "/tmp/b.md", "/tmp/a.md", "/tmp/a.md", "/tmp/b.md"];

    for (let index = 0; index < GLOBAL_CIRCUIT_BREAKER_THRESHOLD; index += 1) {
      const targetPath = paths[index % paths.length] ?? "/tmp/a.md";
      await expectUnblockedToolExecution(tool, `write-churn-${index}`, {
        path: targetPath,
        content: "same content",
      });
    }

    await withToolLoopEvents(async (emitted) => {
      await expectUnblockedToolExecution(tool, "write-churn-warning", {
        path: "/tmp/a.md",
        content: "same content",
      });
      expect(emitted.at(-1)).toMatchObject({
        type: "tool.loop",
        level: "warning",
        action: "warn",
        detector: "argument_churn",
        toolName: "write",
        count: GLOBAL_CIRCUIT_BREAKER_THRESHOLD,
      });
    });
    expect(getDiagnosticSessionActivitySnapshot({ sessionKey: "main" }).lastProgressReason).toBe(
      "tool_loop:argument_churn",
    );

    await expectUnblockedToolExecution(tool, "write-churn-progress", {
      path: "/tmp/a.md",
      content: "same content",
    });
    expect(
      getDiagnosticSessionActivitySnapshot({ sessionKey: "main" }).lastProgressReason,
    ).not.toBe("tool_loop:argument_churn");

    await expectUnblockedToolExecution(tool, "write-churn-escape", {
      path: "/tmp/c.md",
      content: "same content",
    });
    expect(
      getDiagnosticSessionActivitySnapshot({ sessionKey: "main" }).lastProgressReason,
    ).not.toBe("tool_loop:argument_churn");
    expect(execute).toHaveBeenCalledTimes(GLOBAL_CIRCUIT_BREAKER_THRESHOLD + 3);
  });

  it("detects alternating-path churn from the production write result contract", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-write-churn-"));
    const sessionId = "production-write-churn-session";
    const sessionKey = "main";
    const runId = "production-write-churn-run";
    const content = "same content";
    const paths = ["a.md", "b.md", "a.md", "a.md", "b.md"];
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey, runId });
    const tool = wrapToolWithBeforeToolCallHook(
      createWriteTool(tmpDir) as unknown as AnyAgentTool,
      {
        ...enabledLoopDetectionContext,
        sessionId,
        sessionKey,
        runId,
      },
    );

    try {
      await withToolLoopEvents(async (emitted) => {
        for (let index = 0; index < 16; index += 1) {
          await expectUnblockedToolExecution(tool, `production-write-churn-${index}`, {
            path: paths[index % paths.length]!,
            content,
          });
        }
        expect(emitted.some((event) => event.detector === "argument_churn")).toBe(true);
      });
      const history = getDiagnosticSessionState({ sessionId, sessionKey }).toolCallHistory;
      expect(history?.[0]?.resultHash).toBeTypeOf("string");
      expect(history?.[0]?.resultHash).not.toBe(history?.[1]?.resultHash);
      const noProgressHashes = (history ?? [])
        .filter((record) => record.noProgress)
        .map((record) => record.resultHash);
      expect(noProgressHashes.length).toBeGreaterThanOrEqual(6);
      expect(new Set(noProgressHashes).size).toBe(1);
      expect(getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey })).toMatchObject({
        lastProgressReason: "tool_loop:argument_churn",
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("suspends churn liveness while a before-tool policy is pending", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-07-27T00:00:00Z");
    vi.setSystemTime(startedAt);
    const sessionId = "write-churn-policy-wait-session";
    const sessionKey = "main";
    const runId = "write-churn-policy-wait-run";
    const activityDuringExecution: ReturnType<typeof getDiagnosticSessionActivitySnapshot>[] = [];
    const execute = vi.fn().mockImplementation(async (_toolCallId: string, _params: unknown) => {
      activityDuringExecution.push(getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey }));
      return createStableNoProgressWriteResult();
    });
    const loopDetectionContext = {
      ...enabledLoopDetectionContext,
      sessionId,
      sessionKey,
      runId,
    };
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey, runId });
    const tool = createWrappedTool("write", execute, loopDetectionContext);
    const paths = ["/tmp/a.md", "/tmp/b.md", "/tmp/a.md", "/tmp/a.md", "/tmp/b.md"];

    for (let index = 0; index < GLOBAL_CIRCUIT_BREAKER_THRESHOLD; index += 1) {
      await expectUnblockedToolExecution(tool, `write-churn-policy-wait-${index}`, {
        path: paths[index % paths.length] ?? "/tmp/a.md",
        content: "same content",
      });
    }
    await expectUnblockedToolExecution(tool, "write-churn-policy-wait-warning", {
      path: "/tmp/a.md",
      content: "same content",
    });
    expect(getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey }).lastProgressReason).toBe(
      "tool_loop:argument_churn",
    );

    let resolvePolicy:
      | ((value: Awaited<ReturnType<HookRunner["runBeforeToolCall"]>>) => void)
      | undefined;
    const policyPending = new Promise<Awaited<ReturnType<HookRunner["runBeforeToolCall"]>>>(
      (resolve) => {
        resolvePolicy = resolve;
      },
    );
    let markPolicyEntered!: () => void;
    const policyEntered = new Promise<void>((resolve) => {
      markPolicyEntered = resolve;
    });
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runBeforeToolCall.mockImplementation(() => {
      markPolicyEntered();
      return policyPending;
    });

    vi.setSystemTime(startedAt + 4 * 60_000);
    const pendingExecution = tool.execute(
      "write-churn-policy-wait-next",
      { path: "/tmp/b.md", content: "same content" },
      undefined,
      undefined,
    );
    await policyEntered;
    vi.setSystemTime(startedAt + 6 * 60_000);
    expect(getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey })).toMatchObject({
      lastProgressAgeMs: 0,
      lastProgressReason: "tool_policy:pending",
    });

    resolvePolicy?.({});
    await pendingExecution;
    expect(activityDuringExecution.at(-1)).toMatchObject({
      lastProgressAgeMs: 6 * 60_000,
      lastProgressReason: "tool_loop:argument_churn",
    });
  });

  it("releases churn suspension when a before-tool policy fails", async () => {
    vi.useFakeTimers();
    const startedAt = Date.parse("2026-07-27T00:00:00Z");
    vi.setSystemTime(startedAt);
    const sessionId = "write-churn-policy-failure-session";
    const sessionKey = "main";
    const runId = "write-churn-policy-failure-run";

    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey, runId });
    markDiagnosticArgumentChurnObservation({
      sessionId,
      sessionKey,
      runId,
      active: true,
    });
    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runBeforeToolCall.mockRejectedValue(new Error("policy failed"));

    vi.setSystemTime(startedAt + 6 * 60_000);
    await expect(
      runBeforeToolCallHook({
        toolName: "write",
        params: { path: "/tmp/a.md", content: "same content" },
        toolCallId: "write-churn-policy-failure",
        ctx: {
          ...enabledLoopDetectionContext,
          sessionId,
          sessionKey,
          runId,
        },
      }),
    ).resolves.toMatchObject({
      blocked: true,
      kind: "failure",
    });

    expect(getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey })).toMatchObject({
      lastProgressAgeMs: 6 * 60_000,
      lastProgressReason: "tool_loop:argument_churn",
    });
  });

  it("clears churn liveness before executing params rewritten to a novel variant", async () => {
    const sessionId = "write-churn-rewrite-session";
    const sessionKey = "main";
    const runId = "write-churn-rewrite-run";
    const progressReasonsDuringExecution: Array<string | undefined> = [];
    const execute = vi.fn().mockImplementation(async (_toolCallId: string, _params: unknown) => {
      progressReasonsDuringExecution.push(
        getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey }).lastProgressReason,
      );
      return createStableNoProgressWriteResult();
    });
    const loopDetectionContext = {
      ...enabledLoopDetectionContext,
      sessionId,
      sessionKey,
      runId,
    };
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey, runId });
    const tool = createWrappedTool("write", execute, loopDetectionContext);
    const paths = ["/tmp/a.md", "/tmp/b.md", "/tmp/a.md", "/tmp/a.md", "/tmp/b.md"];

    for (let index = 0; index < GLOBAL_CIRCUIT_BREAKER_THRESHOLD; index += 1) {
      const targetPath = paths[index % paths.length] ?? "/tmp/a.md";
      await expectUnblockedToolExecution(tool, `write-churn-rewrite-${index}`, {
        path: targetPath,
        content: "same content",
      });
    }

    hookRunner.hasHooks.mockReturnValue(true);
    hookRunner.runBeforeToolCall.mockResolvedValue({
      params: { path: "/tmp/c.md", content: "same content" },
    });
    await expectUnblockedToolExecution(tool, "write-churn-rewrite-warning", {
      path: "/tmp/a.md",
      content: "same content",
    });

    expect(execute).toHaveBeenLastCalledWith(
      "write-churn-rewrite-warning",
      { path: "/tmp/c.md", content: "same content" },
      undefined,
      undefined,
    );
    expect(progressReasonsDuringExecution.at(-1)).not.toBe("tool_loop:argument_churn");
    expect(
      getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey }).lastProgressReason,
    ).not.toBe("tool_loop:argument_churn");
  });

  it("does not activate reconciled churn below the warning threshold", async () => {
    const sessionId = "write-churn-below-threshold-session";
    const sessionKey = "main";
    const runId = "write-churn-below-threshold-run";
    const progressReasonsDuringExecution: Array<string | undefined> = [];
    const execute = vi.fn().mockImplementation(async (_toolCallId: string, _params: unknown) => {
      progressReasonsDuringExecution.push(
        getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey }).lastProgressReason,
      );
      return createStableNoProgressWriteResult();
    });
    const loopDetectionContext = {
      ...enabledLoopDetectionContext,
      sessionId,
      sessionKey,
      runId,
    };
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey, runId });
    const tool = createWrappedTool("write", execute, loopDetectionContext);
    const paths = ["/tmp/a.md", "/tmp/b.md", "/tmp/a.md", "/tmp/b.md", "/tmp/a.md", "/tmp/b.md"];

    for (const [index, targetPath] of paths.entries()) {
      await expectUnblockedToolExecution(tool, `write-churn-below-threshold-${index}`, {
        path: targetPath,
        content: "same content",
      });
    }
    await expectUnblockedToolExecution(tool, "write-churn-below-threshold-next", {
      path: "/tmp/a.md",
      content: "same content",
    });

    expect(progressReasonsDuringExecution.at(-1)).not.toBe("tool_loop:argument_churn");
  });

  it("does not reconcile argument churn across run ids", async () => {
    const sessionId = "write-churn-cross-run-session";
    const sessionKey = "main";
    const oldRunId = "write-churn-old-run";
    const newRunId = "write-churn-new-run";
    const progressReasonsDuringExecution: Array<string | undefined> = [];
    const execute = vi.fn().mockImplementation(async (_toolCallId: string, _params: unknown) => {
      progressReasonsDuringExecution.push(
        getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey }).lastProgressReason,
      );
      return createStableNoProgressWriteResult();
    });
    const oldRunTool = createWrappedTool("write", execute, {
      ...enabledLoopDetectionContext,
      sessionId,
      sessionKey,
      runId: oldRunId,
    });
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey, runId: oldRunId });
    const paths = ["/tmp/a.md", "/tmp/b.md", "/tmp/a.md", "/tmp/a.md", "/tmp/b.md"];
    for (let index = 0; index < 10; index += 1) {
      await expectUnblockedToolExecution(oldRunTool, `write-churn-old-run-${index}`, {
        path: paths[index % paths.length] ?? "/tmp/a.md",
        content: "same content",
      });
    }

    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey, runId: newRunId });
    const newRunTool = createWrappedTool("write", execute, {
      ...enabledLoopDetectionContext,
      sessionId,
      sessionKey,
      runId: newRunId,
    });
    await expectUnblockedToolExecution(newRunTool, "write-churn-new-run-first", {
      path: "/tmp/a.md",
      content: "same content",
    });

    expect(progressReasonsDuringExecution.at(-1)).not.toBe("tool_loop:argument_churn");
  });

  it("allows a two-pass same-tool batch through the wrapped tool runtime", async () => {
    const execute = vi.fn().mockImplementation(async (_toolCallId: string, params: unknown) => {
      const targetPath =
        typeof params === "object" && params !== null && "path" in params
          ? String(params.path)
          : "unknown";
      return {
        content: [{ type: "text", text: `wrote ${targetPath}` }],
        details: { ok: true, path: targetPath },
      };
    });
    const tool = createWrappedTool("write", execute);
    const paths = Array.from({ length: 15 }, (_, index) => `/tmp/batch-${index}.md`);

    for (let index = 0; index < GLOBAL_CIRCUIT_BREAKER_THRESHOLD; index += 1) {
      const targetPath = paths[index % paths.length]!;
      await expectUnblockedToolExecution(tool, `write-batch-${index}`, {
        path: targetPath,
        content: "same content",
      });
    }

    await expectUnblockedToolExecution(tool, "write-batch-next", {
      path: "/tmp/batch-next.md",
      content: "same content",
    });
    expect(execute).toHaveBeenCalledTimes(GLOBAL_CIRCUIT_BREAKER_THRESHOLD + 1);
  });

  it("does not carry loop history across run ids", async () => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "same output" }],
      details: { ok: true },
    });
    const params = { path: "/tmp/file" };
    const firstRunTool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      ...enabledLoopDetectionContext,
      runId: "heartbeat-1",
    });
    const secondRunTool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      ...enabledLoopDetectionContext,
      runId: "heartbeat-2",
    });

    for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
      await expectUnblockedToolExecution(firstRunTool, `old-run-${i}`, params);
    }

    await expectUnblockedToolExecution(secondRunTool, "new-run-0", params);
  });

  it.each(["success", "error"])("warns on repeated %s results before blocking", async (status) => {
    await withToolLoopEvents(async (emitted) => {
      const { tool, params, execute } = createGenericReadRepeatFixture();
      const rawResult = {
        content: [{ type: "text", text: "same output" }],
        details: { status },
      };
      execute.mockResolvedValue(rawResult);

      for (let i = 0; i < 21; i += 1) {
        const result = await tool.execute(`read-bucket-${i}`, params, undefined, undefined);
        if (i === 20) {
          expectToolLoopBlockedResult(result, "identical outcomes");
        } else {
          expect(result.content).toEqual([
            ...rawResult.content,
            ...(i === 10
              ? [{ type: "text", text: expect.stringMatching(/\[.*10.*change.*stop.*\]/i) }]
              : []),
          ]);
          expect(result.details).toEqual(rawResult.details);
        }
      }

      const genericEvents = emitted.filter((evt) => evt.detector === "generic_repeat");
      expect(genericEvents.map((evt) => [evt.level, evt.count])).toEqual([
        ["warning", 10],
        ["critical", 20],
      ]);
      expect(execute).toHaveBeenCalledTimes(20);
      expect(rawResult.content).toEqual([{ type: "text", text: "same output" }]);
      const outcomes = getDiagnosticSessionState({ sessionKey: "main" }).toolCallHistory;
      const resultHashes = outcomes?.flatMap((outcome) => outcome.resultHash ?? []);
      expect(resultHashes).toHaveLength(20);
      expect(new Set(resultHashes).size).toBe(1);
    });
  });

  it("escalates repeated critical vetoes to the global circuit breaker", async () => {
    await withToolLoopEvents(async (emitted) => {
      const runId = "codex-native-global-breaker";
      const { tool, params, execute } = createGenericReadRepeatFixture({
        ...enabledLoopDetectionContext,
        runId,
      });

      for (let i = 0; i <= GLOBAL_CIRCUIT_BREAKER_THRESHOLD; i += 1) {
        const toolCallId = `read-global-${i}`;
        const nativeOutcome = await runBeforeToolCallHook({
          toolName: "read",
          params,
          toolCallId,
          ctx: {
            agentId: enabledLoopDetectionContext.agentId,
            sessionKey: enabledLoopDetectionContext.sessionKey,
            runId,
          },
        });
        expect(nativeOutcome.blocked).toBe(false);
        await tool.execute(toolCallId, params, undefined, undefined);
      }

      expect(execute).toHaveBeenCalledTimes(CRITICAL_THRESHOLD);
      expect(emitted.at(-1)).toMatchObject({
        type: "tool.loop",
        level: "critical",
        action: "block",
        detector: "global_circuit_breaker",
        count: 30,
        toolName: "read",
      });
    });
  });

  it("emits structured warning diagnostic events for ping-pong loops", async () => {
    await withToolLoopEvents(async (emitted) => {
      const { readTool, listTool } = createPingPongTools();
      await runPingPongSequence(readTool, listTool, 9);

      await listTool.execute("list-9", { dir: "/workspace" }, undefined, undefined);
      await readTool.execute("read-10", { path: "/a.txt" }, undefined, undefined);
      await listTool.execute("list-11", { dir: "/workspace" }, undefined, undefined);

      const pingPongWarns = emitted.filter(
        (evt) => evt.level === "warning" && evt.detector === "ping_pong",
      );
      expect(pingPongWarns).toHaveLength(1);
      const loopEvent = pingPongWarns[0];
      expect(loopEvent?.type).toBe("tool.loop");
      expect(loopEvent?.level).toBe("warning");
      expect(loopEvent?.action).toBe("warn");
      expect(loopEvent?.detector).toBe("ping_pong");
      expect(loopEvent?.count).toBe(10);
      expect(loopEvent?.toolName).toBe("list");
    });
  });

  it("blocks ping-pong loops at critical threshold and emits critical diagnostic events", async () => {
    await withToolLoopEvents(async (emitted) => {
      const { readTool, listTool } = createPingPongTools();
      await runPingPongSequence(readTool, listTool, CRITICAL_THRESHOLD - 1);

      const result = await listTool.execute(
        `list-${CRITICAL_THRESHOLD - 1}`,
        { dir: "/workspace" },
        undefined,
        undefined,
      );
      expectToolLoopBlockedResult(result, "CRITICAL");

      const loopEvent = emitted.at(-1);
      expectCriticalLoopEvent(loopEvent, {
        detector: "ping_pong",
        toolName: "list",
      });
    });
  });

  it("does not block ping-pong at critical threshold when outcomes are progressing", async () => {
    await withToolLoopEvents(async (emitted) => {
      const { readTool, listTool } = createPingPongTools({ withProgress: true });
      await runPingPongSequence(readTool, listTool, CRITICAL_THRESHOLD - 1);

      await expectUnblockedToolExecution(listTool, `list-${CRITICAL_THRESHOLD - 1}`, {
        dir: "/workspace",
      });

      const criticalPingPong = emitted.find(
        (evt) => evt.level === "critical" && evt.detector === "ping_pong",
      );
      expect(criticalPingPong).toBeUndefined();
      const warningPingPong = emitted.find(
        (evt) => evt.level === "warning" && evt.detector === "ping_pong",
      );
      expectEventFields(warningPingPong, {
        type: "tool.loop",
        level: "warning",
        action: "warn",
        detector: "ping_pong",
      });
    });
  });

  it("emits structured critical diagnostic events when blocking loops", async () => {
    await withToolLoopEvents(async (emitted) => {
      const { tool, params } = createNoProgressProcessFixture("sess-crit");

      for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
        await tool.execute(`poll-${i}`, params, undefined, undefined);
      }

      const result = await tool.execute(`poll-${CRITICAL_THRESHOLD}`, params, undefined, undefined);
      expectToolLoopBlockedResult(result, "CRITICAL");

      const loopEvent = emitted.at(-1);
      expectCriticalLoopEvent(loopEvent, {
        detector: "known_poll_no_progress",
        toolName: "process",
      });
    });
  });

  it("emits diagnostic tool execution events without parameter values", async () => {
    const trace = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    };
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
    });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "bash", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      sessionId: "session-id",
      runId: "run-1",
      trace,
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      await tool.execute(
        "tool-call-1",
        { command: "pwd", token: "sk-1234567890abcdef1234567890abcdef" },
        undefined,
        undefined,
      );
      await flush();

      expect(emitted.map((evt) => evt.type)).toEqual([
        "tool.execution.started",
        "tool.execution.completed",
      ]);
      const started = expectEventFields(emitted[0], {
        type: "tool.execution.started",
        runId: "run-1",
        sessionKey: "session-key",
        sessionId: "session-id",
        toolName: "exec",
        toolCallId: "tool-call-1",
        paramsSummary: {
          kind: "object",
        },
      });
      const startedTrace = requireRecord(started.trace, "started trace");
      expect(startedTrace.traceId).toBe(trace.traceId);
      expect(startedTrace.parentSpanId).toBe(trace.spanId);
      expect(typeof startedTrace.spanId).toBe("string");
      expect(startedTrace.traceFlags).toBe(trace.traceFlags);
      expect(emitted[0]?.trace).not.toBe(trace);
      expect(Object.isFrozen(emitted[0]?.trace)).toBe(true);
      const completed = expectEventFields(emitted[1], {
        type: "tool.execution.completed",
      });
      expect(typeof completed.durationMs).toBe("number");
      expect(JSON.stringify(emitted)).not.toContain("sk-1234567890abcdef1234567890abcdef");
      expect(JSON.stringify(emitted)).not.toContain("pwd");
    });
  });

  it.each([
    { label: "fails", error: new Error("hook crashed"), terminalReason: "failed" },
    {
      label: "times out",
      error: Object.assign(new Error("timed out after 5ms"), { name: "TimeoutError" }),
      terminalReason: "timed_out",
    },
  ] as const)(
    "emits a terminal diagnostic when a before_tool_call hook $label",
    async (testCase) => {
      hookRunner.hasHooks.mockImplementation((hookName: string) => hookName === "before_tool_call");
      hookRunner.runBeforeToolCall.mockRejectedValueOnce(testCase.error);
      const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
      const tool = wrapToolWithBeforeToolCallHook(
        { name: "exec", execute } as unknown as AnyAgentTool,
        {
          agentId: "main",
          sessionKey: "session-key",
          sessionId: "session-id",
          runId: "run-1",
          loopDetection: { enabled: false },
        },
      );

      await withToolExecutionEvents(async (emitted, flush) => {
        await expect(
          tool.execute("tool-call-hook-failure", { command: "private" }, undefined, undefined),
        ).rejects.toThrow("Tool call blocked because before_tool_call hook failed");
        await flush();

        expect(execute).not.toHaveBeenCalled();
        expect(emitted.map((event) => event.type)).toEqual(["tool.execution.error"]);
        const terminal = expectEventFields(emitted[0], {
          type: "tool.execution.error",
          runId: "run-1",
          sessionKey: "session-key",
          sessionId: "session-id",
          agentId: "main",
          toolName: "exec",
          toolCallId: "tool-call-hook-failure",
          paramsSummary: { kind: "object" },
          errorCategory: "before_tool_call",
          terminalReason: testCase.terminalReason,
        });
        expect(typeof terminal.durationMs).toBe("number");
        expect(JSON.stringify(emitted)).not.toContain("private");
      });
    },
  );

  it("emits a terminal diagnostic when hook preflight rejects", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const params = Object.defineProperty({}, "private", {
      enumerable: true,
      get() {
        throw new Error("private hook preflight failure");
      },
    });
    const tool = wrapToolWithBeforeToolCallHook(
      { name: "read", execute } as unknown as AnyAgentTool,
      {
        agentId: "main",
        sessionKey: "session-key",
        runId: "run-1",
        loopDetection: { enabled: true },
      },
    );

    await withToolExecutionEvents(async (emitted, flush) => {
      await expect(
        tool.execute("tool-call-preflight", params, undefined, undefined),
      ).rejects.toThrow("Tool call blocked because before_tool_call hook failed");
      await flush();

      expect(execute).not.toHaveBeenCalled();
      expect(emitted.map((event) => event.type)).toEqual(["tool.execution.error"]);
      expectEventFields(emitted[0], {
        type: "tool.execution.error",
        runId: "run-1",
        sessionKey: "session-key",
        agentId: "main",
        toolName: "read",
        toolCallId: "tool-call-preflight",
        paramsSummary: { kind: "object" },
        errorCategory: "before_tool_call",
        terminalReason: "failed",
      });
      expect(JSON.stringify(emitted)).not.toContain("private hook preflight failure");
    });
  });

  it("preserves preparation timeout disposition when wrapper diagnostics are delegated", async () => {
    const timeout = Object.assign(new Error("private preparation timeout"), {
      name: "TimeoutError",
    });
    const tool = wrapToolWithBeforeToolCallHook(
      {
        name: "exec",
        execute: vi.fn(),
        prepareBeforeToolCallParams: vi.fn().mockRejectedValue(timeout),
      } as unknown as AnyAgentTool,
      { runId: "run-1" },
      { emitDiagnostics: false },
    );

    const error = await tool
      .execute("tool-call-preparation-timeout", { command: "private" }, undefined, undefined)
      .catch((cause: unknown) => cause);

    expect(getBeforeToolCallFailureDisposition(error)).toBe("timed_out");
    expect(error).toHaveProperty("cause", timeout);
  });

  it("emits a blocked terminal diagnostic when tool approval is denied", async () => {
    hookRunner.hasHooks.mockImplementation((hookName: string) => hookName === "before_tool_call");
    hookRunner.runBeforeToolCall.mockResolvedValueOnce({
      requireApproval: { title: "Approve", description: "Approve tool" },
    });
    const mockCallGateway = vi.mocked(callGatewayTool);
    mockCallGateway.mockResolvedValueOnce({ id: "approval-1", decision: "deny" });
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const tool = wrapToolWithBeforeToolCallHook(
      { name: "exec", execute } as unknown as AnyAgentTool,
      { agentId: "main", sessionKey: "session-key", runId: "run-1" },
    );

    await withToolExecutionEvents(async (emitted, flush) => {
      await expect(
        tool.execute("tool-call-denied", { command: "private" }, undefined, undefined),
      ).rejects.toThrow("Denied by user");
      await flush();

      expect(execute).not.toHaveBeenCalled();
      expect(emitted.map((event) => event.type)).toEqual(["tool.execution.blocked"]);
      expectEventFields(emitted[0], {
        type: "tool.execution.blocked",
        runId: "run-1",
        sessionKey: "session-key",
        toolName: "exec",
        toolCallId: "tool-call-denied",
        deniedReason: "plugin-approval",
        reason: "plugin-approval",
      });
      expect(JSON.stringify(emitted)).not.toContain("private");
    });
    mockCallGateway.mockReset();
  });

  it("emits a blocked terminal diagnostic when approval is report-only", async () => {
    hookRunner.hasHooks.mockImplementation((hookName: string) => hookName === "before_tool_call");
    hookRunner.runBeforeToolCall.mockResolvedValueOnce({
      requireApproval: { title: "Approve", description: "Review before running" },
    });
    const mockCallGateway = vi.mocked(callGatewayTool);
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const tool = wrapToolWithBeforeToolCallHook(
      { name: "exec", execute } as unknown as AnyAgentTool,
      { agentId: "main", sessionKey: "session-key", runId: "run-1" },
      { approvalMode: "report" },
    );

    await withToolExecutionEvents(async (emitted, flush) => {
      await expect(
        tool.execute("tool-call-report", { command: "private" }, undefined, undefined),
      ).rejects.toThrow("Review before running");
      await flush();

      expect(execute).not.toHaveBeenCalled();
      expect(mockCallGateway).not.toHaveBeenCalled();
      expect(emitted.map((event) => event.type)).toEqual(["tool.execution.blocked"]);
      expectEventFields(emitted[0], {
        type: "tool.execution.blocked",
        runId: "run-1",
        sessionKey: "session-key",
        toolName: "exec",
        toolCallId: "tool-call-report",
        deniedReason: "plugin-approval",
        reason: "plugin-approval",
      });
      expect(JSON.stringify(emitted)).not.toContain("private");
      expect(JSON.stringify(emitted)).not.toContain("Review before running");
    });
    mockCallGateway.mockReset();
  });

  it("returns a structured denial without an approval request in deny mode", async () => {
    const onResolution = vi.fn();
    hookRunner.hasHooks.mockImplementation((hookName: string) => hookName === "before_tool_call");
    hookRunner.runBeforeToolCall.mockResolvedValueOnce({
      requireApproval: { title: "Approve", description: "Approval required", onResolution },
    });
    const mockCallGateway = vi.mocked(callGatewayTool);
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const tool = wrapToolWithBeforeToolCallHook(
      { name: "exec", execute } as unknown as AnyAgentTool,
      { agentId: "main", sessionKey: "session-key", runId: "run-1" },
      { approvalMode: "deny" },
    );

    const result = await tool.execute("tool-call-deny", { command: "private" });

    expect(result.details).toEqual({
      status: "blocked",
      deniedReason: "plugin-approval",
      reason: "approval_required",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(mockCallGateway).not.toHaveBeenCalled();
    expect(onResolution).toHaveBeenCalledWith(PluginApprovalResolutions.DENY);
    mockCallGateway.mockReset();
  });

  it.each([
    {
      label: "failure",
      details: { status: "failed", exitCode: 1 },
      terminal: {
        type: "tool.execution.error",
        errorCategory: "tool_result_error",
        terminalReason: "failed",
      },
    },
    {
      label: "timeout",
      details: { status: "timeout", timedOut: true },
      terminal: {
        type: "tool.execution.error",
        errorCategory: "tool_result_error",
        terminalReason: "timed_out",
      },
    },
    {
      label: "cancellation",
      details: { status: "cancelled" },
      terminal: {
        type: "tool.execution.error",
        errorCategory: "tool_result_error",
        terminalReason: "cancelled",
      },
    },
    {
      label: "blocked action",
      details: { status: "blocked" },
      terminal: {
        type: "tool.execution.blocked",
        deniedReason: "tool_result_blocked",
        reason: "tool_result_blocked",
      },
    },
  ])("classifies a resolved $label result as terminal failure", async ({ details, terminal }) => {
    const execute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "tool failed" }],
      details,
    });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "exec", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      runId: "run-1",
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      await tool.execute("tool-call-1", { command: "false" }, undefined, undefined);
      await flush();

      expect(emitted.map((event) => event.type)).toEqual(["tool.execution.started", terminal.type]);
      expectEventFields(emitted[1], terminal);
    });
  });

  it("classifies plugin and MCP tool execution diagnostics with bounded owner labels", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const rawTool = { name: "mcp_search", execute } as unknown as AnyAgentTool;
    setPluginToolMeta(rawTool, { pluginId: "bundle-mcp", optional: false });
    const tool = wrapToolWithBeforeToolCallHook(rawTool, {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      await tool.execute("tool-call-mcp", { query: "status" }, undefined, undefined);
      await flush();

      expectEventFields(emitted[0], {
        type: "tool.execution.started",
        toolName: "mcp_search",
        toolSource: "mcp",
        toolOwner: "bundle-mcp",
      });
      expectEventFields(emitted[1], {
        type: "tool.execution.completed",
        toolSource: "mcp",
        toolOwner: "bundle-mcp",
      });
    });
  });

  it("emits skill usage diagnostics when a run reads a known skill instruction file", async () => {
    const workspaceDir = path.join("/tmp", "openclaw-skill-usage");
    const skillBaseDir = path.join(workspaceDir, ".agents", "skills", "demo-skill");
    const skillFilePath = path.join(skillBaseDir, "SKILL.md");
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "skill" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      sessionId: "session-id",
      runId: "run-1",
      workspaceDir,
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "demo-skill" }],
        resolvedSkills: [
          createCanonicalFixtureSkill({
            name: "demo-skill",
            description: "Demo",
            filePath: skillFilePath,
            baseDir: skillBaseDir,
            source: "workspace",
          }),
        ],
      },
      loopDetection: { enabled: false },
    });

    await withSkillUsageDiagnosticEvents(async (emitted, privateData, flush) => {
      await tool.execute(
        "tool-call-skill-read",
        { path: `${path.join(".agents", "skills", "demo-skill", "SKILL.md")}</arg_value>>` },
        undefined,
        undefined,
      );
      await flush();

      expect(emitted.map((evt) => evt.type)).toEqual([
        "tool.execution.started",
        "skill.used",
        "tool.execution.completed",
      ]);
      expectEventFields(emitted[1], {
        type: "skill.used",
        agentId: "main",
        runId: "run-1",
        sessionKey: "session-key",
        sessionId: "session-id",
        skillName: "demo-skill",
        skillSource: "workspace",
        activation: "read",
        toolName: "read",
        toolCallId: "tool-call-skill-read",
      });
      expect(JSON.stringify(emitted[1])).not.toContain(skillFilePath);
      expect(JSON.stringify(emitted)).not.toContain("SKILL.md");
      expect(JSON.stringify(emitted)).not.toContain(skillBaseDir);
      expect(privateData[0]?.skillUsage?.skillFile).toBe(skillFilePath);
      expect(consumeRunSkillUsage("run-1")).toEqual([
        {
          name: "demo-skill",
          source: "workspace",
          activation: "read",
          skillFile: skillFilePath,
        },
      ]);
      expect(consumeRunSkillUsage("run-1")).toEqual([]);
    });
  });

  it("matches home-compacted skill instruction paths from prompts", async () => {
    const skillBaseDir = path.join(os.homedir(), ".openclaw", "skills", "home-skill");
    const skillFilePath = path.join(skillBaseDir, "SKILL.md");
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "skill" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      workspaceDir: "/tmp/openclaw-workspace",
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "home-skill" }],
        resolvedSkills: [
          createCanonicalFixtureSkill({
            name: "home-skill",
            description: "Home skill",
            filePath: skillFilePath,
            baseDir: skillBaseDir,
            source: "openclaw-managed",
          }),
        ],
      },
      loopDetection: { enabled: false },
    });

    await withSkillUsageDiagnosticEvents(async (emitted, privateData, flush) => {
      await tool.execute(
        "tool-call-home-skill",
        { path: "~/.openclaw/skills/home-skill/SKILL.md" },
        undefined,
        undefined,
      );
      await flush();

      expectEventFields(emitted[1], {
        type: "skill.used",
        skillName: "home-skill",
        skillSource: "workspace",
        activation: "read",
        toolName: "read",
      });
      expect(JSON.stringify(emitted[1])).not.toContain(skillFilePath);
      expect(JSON.stringify(emitted)).not.toContain(os.homedir());
      expect(privateData[0]?.skillUsage?.skillFile).toBe(skillFilePath);
    });
  });

  it("emits skill usage diagnostics for node skill locators", async () => {
    const locator = "node://node-1/skills/remote-skill/SKILL.md";
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "skill" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "remote-skill" }],
        resolvedSkills: [
          createCanonicalFixtureSkill({
            name: "remote-skill",
            description: "Remote skill",
            filePath: locator,
            baseDir: "node://node-1/skills/remote-skill",
            source: "openclaw-node",
          }),
        ],
      },
      loopDetection: { enabled: false },
    });

    await withSkillUsageDiagnosticEvents(async (emitted, _privateData, flush) => {
      await tool.execute("tool-call-node-skill", { path: locator }, undefined, undefined);
      await flush();

      expectEventFields(emitted[1], {
        type: "skill.used",
        skillName: "remote-skill",
        activation: "read",
        toolName: "read",
      });
    });
  });

  it("accounts sandbox skill reads against the original canonical file", async () => {
    const workspaceDir = "/workspace";
    const readPath = "/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md";
    const skillFile = "/agent-workspace/skills/demo/SKILL.md";
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "skill" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      workspaceDir,
      skillUsagePaths: [
        {
          readPath,
          skillFile,
          skillName: "demo",
          skillSource: "workspace",
        },
      ],
      loopDetection: { enabled: false },
    });

    await withSkillUsageDiagnosticEvents(async (emitted, privateData, flush) => {
      await tool.execute(
        "tool-call-sandbox-skill",
        { path: ".openclaw/sandbox-skills/skills/demo/SKILL.md" },
        undefined,
        undefined,
      );
      await flush();

      expectEventFields(emitted[1], {
        type: "skill.used",
        skillName: "demo",
        skillSource: "workspace",
        activation: "read",
        toolName: "read",
      });
      expect(JSON.stringify(emitted[1])).not.toContain(skillFile);
      expect(privateData[0]?.skillUsage?.skillFile).toBe(skillFile);
    });
  });

  it("does not count unused read params as skill usage", async () => {
    const workspaceDir = path.join("/tmp", "openclaw-skill-unused-param");
    const skillBaseDir = path.join(workspaceDir, ".agents", "skills", "demo-skill");
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "readme" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      workspaceDir,
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: "demo-skill" }],
        resolvedSkills: [
          createCanonicalFixtureSkill({
            name: "demo-skill",
            description: "Demo",
            filePath: path.join(skillBaseDir, "SKILL.md"),
            baseDir: skillBaseDir,
            source: "workspace",
          }),
        ],
      },
      loopDetection: { enabled: false },
    });

    await withDiagnosticEvents(async (emitted, flush) => {
      await tool.execute(
        "tool-call-unused-skill-param",
        {
          path: "README.md",
          file: path.join(".agents", "skills", "demo-skill", "SKILL.md"),
        },
        undefined,
        undefined,
      );
      await flush();

      expect(emitted.map((evt) => evt.type)).toEqual([
        "tool.execution.started",
        "tool.execution.completed",
      ]);
    });
  });

  it("emits skill usage diagnostics for command-dispatched skill tools", async () => {
    const skillBaseDir = path.join("/tmp", "openclaw-skill-command", "skills", "matrix-profile");
    const skillFilePath = path.join(skillBaseDir, "SKILL.md");
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "sent" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "message", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      sessionId: "session-id",
      skillCommand: {
        commandName: "set_profile",
        skillFile: skillFilePath,
        skillName: "matrix-profile",
        skillSource: "workspace",
        toolName: "message",
      },
      loopDetection: { enabled: false },
    });

    await withSkillUsageDiagnosticEvents(async (emitted, privateData, flush) => {
      await tool.execute(
        "tool-call-skill-command",
        { command: "display name", commandName: "set_profile", skillName: "matrix-profile" },
        undefined,
        undefined,
      );
      await flush();

      expect(emitted.map((evt) => evt.type)).toEqual([
        "tool.execution.started",
        "skill.used",
        "tool.execution.completed",
      ]);
      expectEventFields(emitted[1], {
        type: "skill.used",
        skillName: "matrix-profile",
        skillSource: "workspace",
        activation: "command",
        toolName: "message",
        toolCallId: "tool-call-skill-command",
      });
      expect(JSON.stringify(emitted[1])).not.toContain(skillFilePath);
      expect(privateData[0]?.skillUsage?.skillFile).toBe(skillFilePath);
      expect(JSON.stringify(emitted)).not.toContain("display name");
    });
  });

  it("emits diagnostic tool execution error events with redacted errors", async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(new Error("failed with key sk-1234567890abcdef1234567890abcdef"));
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      await expect(
        tool.execute("tool-call-error", { path: "/tmp/file" }, undefined, undefined),
      ).rejects.toThrow("failed with key");
      await flush();

      expect(emitted.map((evt) => evt.type)).toEqual([
        "tool.execution.started",
        "tool.execution.error",
      ]);
      const errorEvent = expectEventFields(emitted[1], {
        type: "tool.execution.error",
        toolName: "read",
        toolCallId: "tool-call-error",
        errorCategory: "Error",
      });
      expect(typeof errorEvent.durationMs).toBe("number");
      expect(JSON.stringify(emitted[1])).not.toContain("sk-1234567890abcdef1234567890abcdef");
    });
  });

  it("classifies a tool error as cancelled only when the run signal is aborted", async () => {
    const abortController = new AbortController();
    const execute = vi.fn().mockImplementation(() => {
      abortController.abort();
      throw new Error("tool stopped with run");
    });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      await expect(
        tool.execute(
          "tool-call-cancelled",
          { path: "/tmp/file" },
          abortController.signal,
          undefined,
        ),
      ).rejects.toThrow("tool stopped with run");
      await flush();

      expectEventFields(emitted[1], {
        type: "tool.execution.error",
        toolCallId: "tool-call-cancelled",
        errorCategory: "aborted",
        terminalReason: "cancelled",
      });
    });
  });

  it("classifies a tool error as timed out when the run timeout signal is aborted", async () => {
    const abortController = new AbortController();
    const execute = vi.fn().mockImplementation(() => {
      abortController.abort(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
      throw new Error("tool stopped with timeout");
    });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      await expect(
        tool.execute("tool-call-timeout", { path: "/tmp/file" }, abortController.signal, undefined),
      ).rejects.toThrow("tool stopped with timeout");
      await flush();

      expectEventFields(emitted[1], {
        type: "tool.execution.error",
        toolCallId: "tool-call-timeout",
        terminalReason: "timed_out",
      });
    });
  });

  it("classifies a tool-local timeout without an aborted run signal", async () => {
    const execute = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("tool deadline elapsed"), { name: "TimeoutError" }),
      );
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });
    const runSignal = new AbortController().signal;

    await withToolExecutionEvents(async (emitted, flush) => {
      await expect(
        tool.execute("tool-call-local-timeout", { path: "/tmp/file" }, runSignal, undefined),
      ).rejects.toThrow("tool deadline elapsed");
      await flush();

      expectEventFields(emitted[1], {
        type: "tool.execution.error",
        toolCallId: "tool-call-local-timeout",
        terminalReason: "timed_out",
      });
    });
  });

  it("emits blocked diagnostics without error severity for intentional hook vetoes", async () => {
    hookRunner.hasHooks.mockImplementation((hookName: string) => hookName === "before_tool_call");
    hookRunner.runBeforeToolCall.mockResolvedValue({
      block: true,
      blockReason: "blocked by policy",
    });
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "nope" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      const result = await tool.execute("tool-call-blocked", { path: "/tmp/file" });
      await flush();

      expect(result).toEqual({
        content: [{ type: "text", text: "blocked by policy" }],
        details: {
          status: "blocked",
          deniedReason: "plugin-before-tool-call",
          reason: "blocked by policy",
        },
      });
      expect(execute).not.toHaveBeenCalled();
      expect(emitted.map((evt) => evt.type)).toEqual(["tool.execution.blocked"]);
      expectEventFields(emitted[0], {
        type: "tool.execution.blocked",
        toolName: "read",
        toolCallId: "tool-call-blocked",
        deniedReason: "plugin-before-tool-call",
        reason: "blocked by policy",
      });
    });
  });

  it("emits a security event for intentional hook vetoes", async () => {
    hookRunner.hasHooks.mockImplementation((hookName: string) => hookName === "before_tool_call");
    hookRunner.runBeforeToolCall.mockResolvedValue({
      block: true,
      blockReason: "blocked by policy",
    });
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "nope" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });

    await withDiagnosticEvents(async (emitted, flush) => {
      await tool.execute("tool-call-blocked", { path: "/tmp/file" });
      await flush();

      const securityEvent = emitted.find(
        (event): event is Extract<DiagnosticEventPayload, { type: "security.event" }> =>
          event.type === "security.event",
      );
      expect(securityEvent).toMatchObject({
        type: "security.event",
        category: "tool",
        action: "tool.execution.blocked",
        outcome: "denied",
        severity: "medium",
        reason: "plugin-before-tool-call",
        actor: { kind: "agent" },
        target: {
          kind: "tool",
          name: "read",
        },
        policy: {
          id: "plugin-before-tool-call",
          decision: "deny",
          reason: "plugin-before-tool-call",
        },
        control: {
          id: "before-tool-call",
          family: "approval",
        },
        attributes: {
          params_kind: "object",
          tool_source: "core",
        },
      });
      expect(securityEvent?.eventId).toBeTypeOf("string");
      expect(JSON.stringify(securityEvent)).not.toContain("/tmp/file");
      expect(emitted.some((event) => event.type === "tool.execution.blocked")).toBe(true);
    });
  });

  it("does not let hostile thrown values break diagnostic error emission", async () => {
    const hostileError = new Proxy(
      {},
      {
        get() {
          throw new Error("diagnostic getter should not run");
        },
        getOwnPropertyDescriptor() {
          throw new Error("diagnostic descriptor failed");
        },
      },
    );
    const execute = vi.fn().mockRejectedValue(hostileError);
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      await expect(
        tool.execute("tool-call-hostile-error", { path: "/tmp/file" }, undefined, undefined),
      ).rejects.toBe(hostileError);
      await flush();

      expect(emitted.map((evt) => evt.type)).toEqual([
        "tool.execution.started",
        "tool.execution.error",
      ]);
      expectEventFields(emitted[1], {
        type: "tool.execution.error",
        toolName: "read",
        toolCallId: "tool-call-hostile-error",
        errorCategory: "object",
      });
      expect(emitted[1]).not.toHaveProperty("errorCode");
    });
  });

  it("emits only numeric HTTP status codes as diagnostic tool error codes", async () => {
    const error = Object.assign(new Error("rate limited"), {
      code: "SECRET_TOKEN",
      status: 429,
    });
    const execute = vi.fn().mockRejectedValue(error);
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });

    await withToolExecutionEvents(async (emitted, flush) => {
      await expect(
        tool.execute("tool-call-status-code", { path: "/tmp/file" }, undefined, undefined),
      ).rejects.toThrow("rate limited");
      await flush();

      expectEventFields(emitted[1], {
        type: "tool.execution.error",
        errorCode: "429",
      });
      expect(JSON.stringify(emitted[1])).not.toContain("SECRET_TOKEN");
    });
  });

  it("summarizes hostile object params without enumerating keys", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "bash", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      loopDetection: { enabled: false },
    });
    const params = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("should not enumerate params");
        },
      },
    );

    await withToolExecutionEvents(async (emitted, flush) => {
      await tool.execute("tool-call-proxy", params, undefined, undefined);
      await flush();

      const started = expectEventFields(emitted[0], {
        type: "tool.execution.started",
      });
      expect(started.paramsSummary).toEqual({ kind: "object" });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[1]).toBe(params);
    });
  });
});

describe("before_tool_call tool content private-data capture", () => {
  type TrustedToolEvent = {
    event: DiagnosticEventPayload;
    privateData: DiagnosticEventPrivateData;
  };

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
  });

  async function withTrustedToolEvents(
    run: (emitted: TrustedToolEvent[], flush: () => Promise<void>) => Promise<void>,
  ) {
    const emitted: TrustedToolEvent[] = [];
    const stop = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type.startsWith("tool.execution.")) {
        emitted.push({ event, privateData });
      }
    });
    const flush = () =>
      new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    try {
      await run(emitted, flush);
    } finally {
      stop();
    }
  }

  function configWithToolContent(): OpenClawConfig {
    return {
      diagnostics: {
        enabled: true,
        otel: {
          enabled: true,
          traces: true,
          captureContent: true,
        },
      },
    };
  }

  it("attaches tool input/output to private data when opted in", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "file body" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      runId: "run-1",
      loopDetection: { enabled: false },
      config: configWithToolContent(),
    });

    await withTrustedToolEvents(async (emitted, flush) => {
      await tool.execute("call-1", { path: "/etc/secret" }, undefined, undefined);
      await flush();

      const completed = emitted.find((e) => e.event.type === "tool.execution.completed");
      expect(completed?.privateData.toolContent?.toolInput).toEqual({ path: "/etc/secret" });
      expect(completed?.privateData.toolContent?.toolOutput).toEqual({
        content: [{ type: "text", text: "file body" }],
      });
      // Public event payload must never carry raw params/results.
      expect(JSON.stringify(completed?.event)).not.toContain("/etc/secret");
      expect(JSON.stringify(completed?.event)).not.toContain("file body");
    });
  });

  it("omits tool content from private data when capture is not configured", async () => {
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      runId: "run-1",
      loopDetection: { enabled: false },
    });

    await withTrustedToolEvents(async (emitted, flush) => {
      await tool.execute("call-1", { path: "/etc/secret" }, undefined, undefined);
      await flush();

      const completed = emitted.find((e) => e.event.type === "tool.execution.completed");
      expect(completed).toBeDefined();
      expect(completed?.privateData.toolContent).toBeUndefined();
    });
  });

  it("clones captured content away from live params", async () => {
    const liveParams = { path: "/etc/secret" };
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "out" }] });
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      runId: "run-1",
      loopDetection: { enabled: false },
      config: configWithToolContent(),
    });

    await withTrustedToolEvents(async (emitted, flush) => {
      await tool.execute("call-1", liveParams, undefined, undefined);
      await flush();

      const completed = emitted.find((e) => e.event.type === "tool.execution.completed");
      expect(completed?.privateData.toolContent?.toolInput).toEqual({ path: "/etc/secret" });
      expect(completed?.privateData.toolContent?.toolOutput).toEqual({
        content: [{ type: "text", text: "out" }],
      });
      // Captured snapshot is a clone, not the live params object.
      expect(completed?.privateData.toolContent?.toolInput).not.toBe(liveParams);
    });
  });

  it("attaches tool input but not output on execution errors", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("boom"));
    const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
      agentId: "main",
      sessionKey: "session-key",
      runId: "run-1",
      loopDetection: { enabled: false },
      config: configWithToolContent(),
    });

    await withTrustedToolEvents(async (emitted, flush) => {
      await expect(
        tool.execute("call-1", { path: "/etc/secret" }, undefined, undefined),
      ).rejects.toThrow("boom");
      await flush();

      const errored = emitted.find((e) => e.event.type === "tool.execution.error");
      expect(errored?.privateData.toolContent?.toolInput).toEqual({ path: "/etc/secret" });
      expect(errored?.privateData.toolContent?.toolOutput).toBeUndefined();
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
