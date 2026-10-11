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
import { GatewayClientRequestError } from "../gateway/client.js";
import { createAbortError } from "../infra/abort-signal.js";
import {
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
  type DiagnosticToolLoopEvent,
} from "../infra/diagnostic-events.js";
import { MAX_PLUGIN_APPROVAL_TIMEOUT_MS } from "../infra/plugin-approvals.js";
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
import {
  PluginApprovalResolutions,
  type PluginApprovalResolution,
  type PluginHookBeforeToolCallResult,
} from "../plugins/hook-before-tool-call-result.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { createHookRunner, type HookRunner } from "../plugins/hooks.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { createDeferredCore } from "../shared/deferred.js";
import { consumeRunSkillUsage } from "../skills/runtime/run-usage.js";
import { createCanonicalFixtureSkill } from "../skills/test-support/test-helpers.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  type HookContext,
  getBeforeToolCallFailureDisposition,
  getBeforeToolCallPolicyDiagnosticState,
  runBeforeToolCallHook,
  wrapToolWithBeforeToolCallHook,
} from "./agent-tools.before-tool-call.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { createWriteTool } from "./sessions/index.js";
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

  it("blocks known poll loops and emits critical and security diagnostics", async () => {
    const { tool, params } = createNoProgressProcessFixture("sess-1");

    for (let i = 0; i < CRITICAL_THRESHOLD; i += 1) {
      await expectUnblockedToolExecution(tool, `poll-${i}`, params);
    }

    await withDiagnosticEvents(async (emitted, flush) => {
      const result = await tool.execute(`poll-${CRITICAL_THRESHOLD}`, params, undefined, undefined);
      await flush();
      expectToolLoopBlockedResult(result, "CRITICAL");
      expectCriticalLoopEvent(
        emitted.find((event): event is DiagnosticToolLoopEvent => event.type === "tool.loop"),
        { detector: "known_poll_no_progress", toolName: "process" },
      );
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

  it("does not activate reconciled churn when loop detection is unconfigured", async () => {
    const sessionId = "write-churn-unconfigured-session";
    const sessionKey = "main";
    const runId = "write-churn-unconfigured-run";
    const progressReasonsDuringExecution: Array<string | undefined> = [];
    const execute = vi.fn().mockImplementation(async (_toolCallId: string, params: unknown) => {
      const targetPath =
        typeof params === "object" && params !== null && "path" in params
          ? String(params.path)
          : "unknown";
      progressReasonsDuringExecution.push(
        getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey }).lastProgressReason,
      );
      return {
        content: [{ type: "text", text: `wrote ${targetPath}` }],
        details: { ok: true, path: targetPath },
      };
    });
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey, runId });
    const tool = createWrappedTool("write", execute, {
      agentId: "main",
      sessionId,
      sessionKey,
      runId,
    });
    const paths = ["/tmp/a.md", "/tmp/b.md", "/tmp/a.md", "/tmp/a.md", "/tmp/b.md"];

    for (let index = 0; index < GLOBAL_CIRCUIT_BREAKER_THRESHOLD; index += 1) {
      await expectUnblockedToolExecution(tool, `write-churn-unconfigured-${index}`, {
        path: paths[index % paths.length] ?? "/tmp/a.md",
        content: "same content",
      });
    }
    await expectUnblockedToolExecution(tool, "write-churn-unconfigured-next", {
      path: "/tmp/a.md",
      content: "same content",
    });

    expect(progressReasonsDuringExecution.at(-1)).not.toBe("tool_loop:argument_churn");
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
              ? "the runaway-loop limit"
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
      const pingPongWarns = emitted.filter(
        (evt) => evt.level === "warning" && evt.detector === "ping_pong",
      );
      expect(pingPongWarns).toHaveLength(1);
      const warningEvent = pingPongWarns[0];
      expect(warningEvent?.type).toBe("tool.loop");
      expect(warningEvent?.level).toBe("warning");
      expect(warningEvent?.action).toBe("warn");
      expect(warningEvent?.detector).toBe("ping_pong");
      expect(warningEvent?.count).toBe(10);
      expect(warningEvent?.toolName).toBe("list");

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

  it.each([
    {
      mode: "request",
      reason: "Denied by user",
      description: "Approve tool",
      toolCallId: "tool-call-denied",
    },
    {
      mode: "report",
      reason: "Review before running",
      description: "Review before running",
      toolCallId: "tool-call-report",
    },
  ] as const)(
    "emits a blocked terminal diagnostic for $mode approval denial",
    async ({ mode, reason, description, toolCallId }) => {
      hookRunner.hasHooks.mockImplementation((hookName: string) => hookName === "before_tool_call");
      hookRunner.runBeforeToolCall.mockResolvedValueOnce({
        requireApproval: { title: "Approve", description },
      });
      const mockCallGateway = vi.mocked(callGatewayTool);
      if (mode === "request") {
        mockCallGateway.mockResolvedValueOnce({ id: "approval-1", decision: "deny" });
      }
      const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
      const tool = wrapToolWithBeforeToolCallHook(
        { name: "exec", execute } as unknown as AnyAgentTool,
        { agentId: "main", sessionKey: "session-key", runId: "run-1" },
        { approvalMode: mode },
      );

      await withToolExecutionEvents(async (emitted, flush) => {
        await expect(
          tool.execute(toolCallId, { command: "private" }, undefined, undefined),
        ).rejects.toThrow(reason);
        await flush();
        expect(execute).not.toHaveBeenCalled();
        if (mode === "report") {
          expect(mockCallGateway).not.toHaveBeenCalled();
          expect(JSON.stringify(emitted)).not.toContain(description);
        }
        expect(emitted.map((event) => event.type)).toEqual(["tool.execution.blocked"]);
        expectEventFields(emitted[0], {
          type: "tool.execution.blocked",
          runId: "run-1",
          sessionKey: "session-key",
          toolName: "exec",
          toolCallId,
          deniedReason: "plugin-approval",
          reason: "plugin-approval",
        });
        expect(JSON.stringify(emitted)).not.toContain("private");
      });
      mockCallGateway.mockReset();
    },
  );

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

  function skillReadContext(
    skill: Parameters<typeof createCanonicalFixtureSkill>[0],
    workspaceDir?: string,
  ): HookContext {
    return {
      workspaceDir,
      skillsSnapshot: {
        prompt: "",
        skills: [{ name: skill.name }],
        resolvedSkills: [createCanonicalFixtureSkill(skill)],
      },
    };
  }

  const workspaceDir = path.join("/tmp", "openclaw-skill-usage");
  const workspaceSkillDir = path.join(workspaceDir, ".agents", "skills", "demo-skill");
  const workspaceSkillFile = path.join(workspaceSkillDir, "SKILL.md");
  const homeSkillDir = path.join(os.homedir(), ".openclaw", "skills", "home-skill");
  const homeSkillFile = path.join(homeSkillDir, "SKILL.md");
  const remoteSkillFile = "node://node-1/skills/remote-skill/SKILL.md";
  const skillReadCases: Array<{
    label: string;
    ctx: HookContext;
    params: Record<string, unknown>;
    expected?: Record<string, unknown>;
    privateFile?: string;
    forbidden: string[];
    trackRun?: boolean;
  }> = [
    {
      label: "workspace instruction",
      ctx: {
        ...skillReadContext(
          {
            name: "demo-skill",
            description: "Demo",
            filePath: workspaceSkillFile,
            baseDir: workspaceSkillDir,
            source: "workspace",
          },
          workspaceDir,
        ),
        sessionId: "session-id",
        runId: "run-1",
      },
      params: { path: `${path.join(".agents", "skills", "demo-skill", "SKILL.md")}</arg_value>>` },
      expected: {
        agentId: "main",
        runId: "run-1",
        sessionKey: "session-key",
        sessionId: "session-id",
        skillName: "demo-skill",
        skillSource: "workspace",
        toolCallId: "skill-read",
      },
      privateFile: workspaceSkillFile,
      forbidden: [workspaceSkillFile, "SKILL.md", workspaceSkillDir],
      trackRun: true,
    },
    {
      label: "home-compacted instruction",
      ctx: skillReadContext(
        {
          name: "home-skill",
          description: "Home skill",
          filePath: homeSkillFile,
          baseDir: homeSkillDir,
          source: "openclaw-managed",
        },
        "/tmp/openclaw-workspace",
      ),
      params: { path: "~/.openclaw/skills/home-skill/SKILL.md" },
      expected: { skillName: "home-skill", skillSource: "workspace" },
      privateFile: homeSkillFile,
      forbidden: [homeSkillFile, os.homedir()],
    },
    {
      label: "node locator",
      ctx: skillReadContext({
        name: "remote-skill",
        description: "Remote skill",
        filePath: remoteSkillFile,
        baseDir: "node://node-1/skills/remote-skill",
        source: "openclaw-node",
      }),
      params: { path: remoteSkillFile },
      expected: { skillName: "remote-skill" },
      forbidden: [],
    },
    {
      label: "sandbox instruction",
      ctx: {
        workspaceDir: "/workspace",
        skillUsagePaths: [
          {
            readPath: "/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md",
            skillFile: "/agent-workspace/skills/demo/SKILL.md",
            skillName: "demo",
            skillSource: "workspace",
          },
        ],
      },
      params: { path: ".openclaw/sandbox-skills/skills/demo/SKILL.md" },
      expected: { skillName: "demo", skillSource: "workspace" },
      privateFile: "/agent-workspace/skills/demo/SKILL.md",
      forbidden: ["/agent-workspace/skills/demo/SKILL.md"],
    },
    {
      label: "unused read parameter",
      ctx: skillReadContext(
        {
          name: "demo-skill",
          description: "Demo",
          filePath: workspaceSkillFile,
          baseDir: workspaceSkillDir,
          source: "workspace",
        },
        workspaceDir,
      ),
      params: { path: "README.md", file: path.join(".agents", "skills", "demo-skill", "SKILL.md") },
      forbidden: [],
    },
  ];

  it.each(skillReadCases)(
    "accounts for a $label read without exposing its path",
    async ({ ctx, params, expected, privateFile, forbidden, trackRun }) => {
      const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "skill" }] });
      const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
        agentId: "main",
        sessionKey: "session-key",
        loopDetection: { enabled: false },
        ...ctx,
      });

      await withSkillUsageDiagnosticEvents(async (emitted, privateData, flush) => {
        await tool.execute("skill-read", params, undefined, undefined);
        await flush();
        expect(emitted.map((evt) => evt.type)).toEqual([
          "tool.execution.started",
          ...(expected ? ["skill.used"] : []),
          "tool.execution.completed",
        ]);
        if (expected) {
          expectEventFields(emitted[1], {
            type: "skill.used",
            activation: "read",
            toolName: "read",
            ...expected,
          });
        }
        for (const value of forbidden) {
          expect(JSON.stringify(emitted)).not.toContain(value);
        }
        if (privateFile) {
          expect(privateData[0]?.skillUsage?.skillFile).toBe(privateFile);
        }
        if (trackRun) {
          expect(consumeRunSkillUsage("run-1")).toEqual([
            {
              name: "demo-skill",
              source: "workspace",
              activation: "read",
              skillFile: workspaceSkillFile,
            },
          ]);
          expect(consumeRunSkillUsage("run-1")).toEqual([]);
        }
      });
    },
  );

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
    const execute = vi.fn().mockRejectedValue(
      Object.assign(new Error("failed with key sk-1234567890abcdef1234567890abcdef"), {
        code: "SECRET_TOKEN",
        status: 429,
      }),
    );
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
        errorCode: "429",
      });
      expect(typeof errorEvent.durationMs).toBe("number");
      expect(JSON.stringify(emitted[1])).not.toContain("SECRET_TOKEN");
      expect(JSON.stringify(emitted[1])).not.toContain("sk-1234567890abcdef1234567890abcdef");
    });
  });

  it.each([
    {
      label: "run cancellation",
      abort: true,
      abortReason: undefined,
      message: "tool stopped with run",
      toolCallId: "tool-call-cancelled",
      terminalReason: "cancelled",
    },
    {
      label: "run timeout",
      abort: true,
      abortReason: Object.assign(new Error("timed out"), { name: "TimeoutError" }),
      message: "tool stopped with timeout",
      toolCallId: "tool-call-timeout",
      terminalReason: "timed_out",
    },
    {
      label: "tool-local timeout",
      abort: false,
      abortReason: undefined,
      message: "tool deadline elapsed",
      toolCallId: "tool-call-local-timeout",
      terminalReason: "timed_out",
    },
  ])(
    "classifies $label in terminal diagnostics",
    async ({ abort, abortReason, message, toolCallId, terminalReason }) => {
      const controller = new AbortController();
      const execute = vi.fn().mockImplementation(() => {
        if (abort) {
          controller.abort(abortReason);
        }
        throw Object.assign(new Error(message), { name: abort ? "Error" : "TimeoutError" });
      });
      const tool = wrapToolWithBeforeToolCallHook(asAgentTool({ name: "read", execute }), {
        agentId: "main",
        sessionKey: "session-key",
        loopDetection: { enabled: false },
      });

      await withToolExecutionEvents(async (emitted, flush) => {
        await expect(
          tool.execute(toolCallId, { path: "/tmp/file" }, controller.signal, undefined),
        ).rejects.toThrow(message);
        await flush();
        expectEventFields(emitted[1], {
          type: "tool.execution.error",
          toolCallId,
          terminalReason,
          ...(terminalReason === "cancelled" ? { errorCategory: "aborted" } : {}),
        });
      });
    },
  );

  it("emits blocked and security diagnostics for intentional hook vetoes", async () => {
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
      expect(
        emitted
          .filter((event) => event.type.startsWith("tool.execution."))
          .map((event) => event.type),
      ).toEqual(["tool.execution.blocked"]);
      expectEventFields(
        emitted.find((event) => event.type === "tool.execution.blocked"),
        {
          type: "tool.execution.blocked",
          toolName: "read",
          toolCallId: "tool-call-blocked",
          deniedReason: "plugin-before-tool-call",
          reason: "blocked by policy",
        },
      );
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

describe("before_tool_call requireApproval handling", () => {
  let hookRunner: TestHookRunner;
  const mockCallGateway = vi.mocked(callGatewayTool);

  const requireRecord = createRequireRecord("object", "label-not-object");

  function requireHookCall(
    index: number,
  ): [event: Record<string, unknown>, context: Record<string, unknown>] {
    const call = hookRunner.runBeforeToolCall.mock.calls[index] as unknown[] | undefined;
    if (!call) {
      throw new Error(`missing before_tool_call hook call ${index + 1}`);
    }
    return [
      requireRecord(call[0], "before_tool_call event"),
      requireRecord(call[1], "before_tool_call context"),
    ];
  }

  function requireGatewayCall(index: number): unknown[] {
    const call = mockCallGateway.mock.calls[index] as unknown[] | undefined;
    if (!call) {
      throw new Error(`missing gateway call ${index + 1}`);
    }
    return call;
  }

  function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
    for (const [key, value] of Object.entries(fields)) {
      expect(record[key]).toEqual(value);
    }
  }

  function registerTelegramPluginApprovalSetup(): void {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
            approvalCapability: {
              native: {},
              getActionAvailabilityState: () => ({ kind: "enabled" as const }),
              getExecInitiatingSurfaceState: () => ({ kind: "disabled" as const }),
              describePluginApprovalSetup: () => "Configure Telegram native approval setup.",
            },
          },
        },
      ]),
    );
  }

  beforeEach(() => {
    resetDiagnosticSessionStateForTest();
    resetDiagnosticEventsForTest();
    hookRunner = createTestHookRunner();
    hookRunner.hasHooks.mockImplementation((hookName) => hookName === "before_tool_call");
    mockGetGlobalHookRunner.mockReturnValue(hookRunner);
    // Keep the global singleton aligned as a fallback in case another setup path
    // preloads hook-runner-global before this test's module reset/mocks take effect.
    setGlobalHookRunnerForTest(hookRunner);
    mockCallGateway.mockReset();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  async function runAbortDuringApprovalWait(options?: {
    abortReason?: unknown;
    onResolution?: (decision: PluginApprovalResolution) => void | Promise<void>;
  }) {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Abortable",
        description: "Will be aborted",
        onResolution: options?.onResolution,
      },
    });

    const controller = new AbortController();
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-abort", status: "accepted" });
    mockCallGateway.mockImplementationOnce(async (_method, _options, _params, extra) => {
      const signal = extra?.signal;
      if (!signal) {
        throw new Error("Expected approval transport abort signal");
      }
      const cancelled = createDeferredCore<never>();
      const onAbort = () => cancelled.reject(createAbortError("gateway request aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      controller.abort(options?.abortReason ?? new Error("run cancelled"));
      try {
        return await cancelled.promise;
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    });

    return await runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
      signal: controller.signal,
    });
  }

  it("blocks without triggering approval when both block and requireApproval are set", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      block: true,
      blockReason: "Blocked by security plugin",
      requireApproval: {
        title: "Should not reach gateway",
        description: "This approval should be skipped",
        pluginId: "lower-priority-plugin",
      },
    });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "rm -rf" },
      ctx: { agentId: "main", sessionKey: "main" },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Blocked by security plugin");
    expect(mockCallGateway).not.toHaveBeenCalled();
  });

  it("passes diagnostic trace context to before_tool_call hooks", async () => {
    const trace = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: "01",
    };
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "pwd" },
      toolCallId: "tool-1",
      ctx: { agentId: "main", sessionKey: "main", runId: "run-1", trace },
    });

    expect(result.blocked).toBe(false);
    const [event, toolContext] = requireHookCall(0);
    expectRecordFields(event, {
      toolName: "exec",
      runId: "run-1",
      toolCallId: "tool-1",
    });
    expectRecordFields(toolContext, {
      toolName: "exec",
      runId: "run-1",
      toolCallId: "tool-1",
    });
    expect(toolContext.trace).toEqual(trace);
    expect(toolContext.trace).not.toBe(trace);
    expect(Object.isFrozen(toolContext.trace)).toBe(true);
  });

  it("passes host-derived apply_patch paths to before_tool_call hooks", async () => {
    const cwd = path.join("/tmp", "openclaw-hooks");
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+x",
      "*** Update File: src/old.ts",
      "*** Move to: src/renamed.ts",
      "@@",
      "+y",
      "*** Delete File: src/dead.ts",
      "*** End Patch",
    ].join("\n");
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { input: patch },
      toolCallId: "patch-1",
      ctx: { agentId: "main", cwd, sessionKey: "main", runId: "run-patch" },
    });

    expect(result.blocked).toBe(false);
    const [event, context] = requireHookCall(0);
    expectRecordFields(event, {
      toolName: "apply_patch",
      runId: "run-patch",
      toolCallId: "patch-1",
      derivedPaths: [
        path.join(cwd, "src/new.ts"),
        path.join(cwd, "src/old.ts"),
        path.join(cwd, "src/renamed.ts"),
        path.join(cwd, "src/dead.ts"),
      ],
    });
    expectRecordFields(context, {
      toolName: "apply_patch",
      runId: "run-patch",
      toolCallId: "patch-1",
    });
  });

  it.each([
    {
      label: "host-backed",
      rawPath: "/workspace/src/new.ts",
      hostPath: "/host/sandbox/src/new.ts",
      rejected: false,
      toolCallId: "patch-sandbox",
    },
    {
      label: "bridge-native absolute",
      rawPath: "/workspace//src/new.ts",
      hostPath: undefined,
      rejected: false,
      toolCallId: "patch-native",
    },
    {
      label: "rejected",
      rawPath: "/outside.ts",
      hostPath: undefined,
      rejected: true,
      toolCallId: "patch-sandbox-rejected",
    },
  ])(
    "derives $label apply_patch paths through the sandbox bridge",
    async ({ rawPath, hostPath, rejected, toolCallId }) => {
      const patch = ["*** Begin Patch", `*** Add File: ${rawPath}`, "+x", "*** End Patch"].join(
        "\n",
      );
      const resolvePath = vi.fn(({ filePath }: { filePath: string }) => {
        if (rejected) {
          throw new Error("Path escapes sandbox root");
        }
        return {
          containerPath: path.posix.normalize(filePath),
          ...(hostPath ? { hostPath } : {}),
          relativePath: hostPath ? "src/new.ts" : filePath,
        };
      });
      hookRunner.runBeforeToolCall.mockResolvedValue(undefined);
      const result = await runBeforeToolCallHook({
        toolName: "apply_patch",
        params: { input: patch },
        toolCallId,
        ctx: {
          agentId: "main",
          cwd: "/workspace",
          sessionKey: "main",
          runId: "run-patch",
          sandbox: { root: "/workspace", bridge: { resolvePath } as never },
        },
      });

      expect(result.blocked).toBe(false);
      expect(resolvePath).toHaveBeenCalledWith({ filePath: rawPath, cwd: "/workspace" });
      const [event, context] = requireHookCall(0);
      if (rejected) {
        expect(event).not.toHaveProperty("derivedPaths");
      } else {
        expectRecordFields(event, {
          toolName: "apply_patch",
          derivedPaths: [hostPath ?? path.posix.normalize(rawPath)],
        });
      }
      expectRecordFields(context, { toolName: "apply_patch", runId: "run-patch", toolCallId });
    },
  );

  it("derives remote apply_patch shorthand and literal paths like execution", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: @reference.md",
      "@@",
      "+reference",
      "*** Update File: @literal.md",
      "@@",
      "+literal",
      "*** End Patch",
    ].join("\n");
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);
    const resolvePath = ({ filePath }: { filePath: string }) => ({
      containerPath: path.posix.resolve("/workspace", filePath),
      relativePath: filePath,
    });

    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { input: patch },
      toolCallId: "patch-remote-at",
      ctx: {
        agentId: "main",
        cwd: "/workspace",
        sandbox: {
          root: "/workspace",
          bridge: {
            resolvePath,
            stat: async ({ filePath }: { filePath: string }) =>
              filePath === "./@literal.md" ? { type: "file", size: 7, mtimeMs: 0 } : null,
          } as never,
        },
        sessionKey: "main",
        runId: "run-patch",
      },
    });

    expect(result.blocked).toBe(false);
    const [event] = requireHookCall(0);
    expectRecordFields(event, {
      toolName: "apply_patch",
      derivedPaths: ["/workspace/reference.md", "/workspace/@literal.md"],
    });
  });

  it("cancels remote apply_patch path derivation with the run", async () => {
    const controller = new AbortController();
    let reportStatSignal!: (signal: AbortSignal | undefined) => void;
    const statStarted = new Promise<AbortSignal | undefined>((resolve) => {
      reportStatSignal = resolve;
    });
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const running = runBeforeToolCallHook({
      toolName: "apply_patch",
      params: {
        input: ["*** Begin Patch", "*** Update File: @remote.md", "*** End Patch"].join("\n"),
      },
      signal: controller.signal,
      ctx: {
        cwd: "/workspace",
        sandbox: {
          root: "/workspace",
          bridge: {
            resolvePath: ({ filePath }: { filePath: string }) => ({
              containerPath: path.posix.resolve("/workspace", filePath),
              relativePath: filePath,
            }),
            stat: ({ signal }: { signal?: AbortSignal }) => {
              reportStatSignal(signal);
              if (!signal) {
                return Promise.resolve(null);
              }
              return new Promise((_, reject) => {
                signal.addEventListener(
                  "abort",
                  () =>
                    reject(signal.reason instanceof Error ? signal.reason : new Error("aborted")),
                  { once: true },
                );
              });
            },
          } as never,
        },
      },
    });

    const statSignal = await statStarted;
    controller.abort();
    expect(statSignal).toBe(controller.signal);
    await expect(running).resolves.toMatchObject({
      blocked: true,
      kind: "failure",
      disposition: "cancelled",
    });
  });

  it("skips derived path extraction when no policies or hooks can consume it", async () => {
    hookRunner.hasHooks.mockReturnValue(false);
    const params = {};
    Object.defineProperty(params, "input", {
      enumerable: true,
      get() {
        throw new Error("should not derive paths");
      },
    });

    await expect(
      runBeforeToolCallHook({
        toolName: "apply_patch",
        params,
        toolCallId: "patch-no-hooks",
      }),
    ).resolves.toEqual({ blocked: false, params });
    expect(hookRunner.runBeforeToolCall).not.toHaveBeenCalled();
  });

  it("reports trusted policy diagnostics through guarded readers", () => {
    hookRunner.hasHooks.mockReturnValue(false);
    const registry = createEmptyPluginRegistry();
    const unreadableIdPolicy: Record<string, unknown> = {
      description: "synthetic trusted policy",
      evaluate: () => undefined,
    };
    Object.defineProperty(unreadableIdPolicy, "id", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin trusted policy id is unreadable");
      },
    });
    registry.trustedToolPolicies = [
      {
        pluginId: "fuzzplugin",
        pluginName: "Fuzz Plugin",
        source: "test",
        policy: unreadableIdPolicy as never,
      },
      {
        pluginId: "mockplugin",
        pluginName: "Mock Plugin",
        source: "test",
        policy: {
          id: "mockpolicy",
          description: "mock policy",
          evaluate: () => undefined,
        },
      },
    ];
    setActivePluginRegistry(registry);

    let state: ReturnType<typeof getBeforeToolCallPolicyDiagnosticState> | undefined;
    try {
      state = getBeforeToolCallPolicyDiagnosticState();
    } finally {
      setActivePluginRegistry(createEmptyPluginRegistry());
    }

    expect(state).toEqual({
      hasBeforeToolCallHook: false,
      trustedToolPolicies: [
        {
          id: "fuzzplugin",
          pluginId: "fuzzplugin",
          pluginName: "Fuzz Plugin",
        },
        {
          id: "mockpolicy",
          pluginId: "mockplugin",
          pluginName: "Mock Plugin",
        },
      ],
    });
  });

  it("recomputes host-derived paths after trusted policy param rewrites", async () => {
    const cwd = path.join("/tmp", "openclaw-hooks");
    const originalPatch = [
      "*** Begin Patch",
      "*** Add File: src/old.ts",
      "+x",
      "*** End Patch",
    ].join("\n");
    const rewrittenPatch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+x",
      "*** End Patch",
    ].join("\n");
    const seenByLaterPolicy: unknown[] = [];
    const registry = createEmptyPluginRegistry();
    registry.trustedToolPolicies = [
      {
        pluginId: "trusted-rewriter",
        pluginName: "Trusted Rewriter",
        source: "test",
        policy: {
          id: "rewrite",
          description: "rewrite",
          evaluate: () => ({ params: { input: rewrittenPatch } }),
        },
      },
      {
        pluginId: "trusted-inspector",
        pluginName: "Trusted Inspector",
        source: "test",
        policy: {
          id: "inspect",
          description: "inspect",
          evaluate: (event) => {
            seenByLaterPolicy.push(event.derivedPaths);
            return undefined;
          },
        },
      },
    ];
    setActivePluginRegistry(registry);
    hookRunner.runBeforeToolCall.mockResolvedValue(undefined);

    const result = await runBeforeToolCallHook({
      toolName: "apply_patch",
      params: { input: originalPatch },
      toolCallId: "patch-rewrite",
      ctx: { agentId: "main", cwd, sessionKey: "main", runId: "run-patch" },
    });

    expect(result).toEqual({ blocked: false, params: { input: rewrittenPatch } });
    expect(seenByLaterPolicy).toEqual([[path.join(cwd, "src/new.ts")]]);
    const [event] = requireHookCall(0);
    expectRecordFields(event, {
      params: { input: rewrittenPatch },
      derivedPaths: [path.join(cwd, "src/new.ts")],
    });
  });

  function setApproval(
    approval: Partial<NonNullable<PluginHookBeforeToolCallResult["requireApproval"]>> = {},
    params?: Record<string, unknown>,
  ) {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      ...(params ? { params } : {}),
      requireApproval: { title: "Approval", description: "Review tool execution", ...approval },
    });
  }

  function requestApproval(overrides: Partial<Parameters<typeof runBeforeToolCallHook>[0]> = {}) {
    return runBeforeToolCallHook({
      toolName: "bash",
      params: {},
      ctx: { agentId: "main", sessionKey: "main" },
      ...overrides,
    });
  }

  it.each([
    { decision: "allow-once", timeoutMs: undefined },
    { decision: "allow-always", timeoutMs: Number.MAX_SAFE_INTEGER },
  ] as const)(
    "returns $decision and notifies the plugin after two-phase approval",
    async ({ decision, timeoutMs }) => {
      const onResolution = vi.fn();
      setApproval({ pluginId: "sage", timeoutMs, onResolution });
      mockCallGateway.mockResolvedValueOnce({ id: "server-id", status: "accepted" });
      mockCallGateway.mockResolvedValueOnce({ id: "server-id", decision });

      const result = await requestApproval({ params: { command: "echo ok" } });

      expect(result).toEqual({
        blocked: false,
        params: { command: "echo ok" },
        approvalResolution: decision,
      });
      expect(onResolution).toHaveBeenCalledWith(decision);
      expect(mockCallGateway).toHaveBeenCalledTimes(2);
      const requestCall = requireGatewayCall(0);
      expect(requestCall[0]).toBe("plugin.approval.request");
      const requestClient = requireRecord(requestCall[1], "approval request gateway client");
      const requestParams = requireRecord(requestCall[2], "approval request params");
      expect(requestParams.twoPhase).toBe(true);
      expect(requestCall[3]).toEqual({ expectFinal: false });
      for (const field of [
        "turnSourceChannel",
        "turnSourceTo",
        "turnSourceAccountId",
        "turnSourceThreadId",
      ]) {
        expect(requestParams[field]).toBeUndefined();
      }
      const waitCall = requireGatewayCall(1);
      expect(waitCall[0]).toBe("plugin.approval.waitDecision");
      const waitClient = requireRecord(waitCall[1], "approval wait gateway client");
      expect(waitCall[2]).toEqual({ id: "server-id" });
      if (timeoutMs !== undefined) {
        expect(requestClient.timeoutMs).toBe(MAX_PLUGIN_APPROVAL_TIMEOUT_MS + 10_000);
        expect(requestParams.timeoutMs).toBe(MAX_PLUGIN_APPROVAL_TIMEOUT_MS);
        expect(waitClient.timeoutMs).toBe(MAX_PLUGIN_APPROVAL_TIMEOUT_MS + 10_000);
      }
    },
  );

  it("uses tool-neutral guidance and notifies the plugin for a denied tool call", async () => {
    const onResolution = vi.fn();
    setApproval({ onResolution });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id", decision: "deny" });

    const result = await requestApproval({ toolName: "web_search", params: { query: "OpenClaw" } });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("disposition", "blocked");
    expect(result).toHaveProperty(
      "reason",
      [
        "Denied by user. The tool call did not run.",
        "This denial is final: the approval request is closed. Do not mention /approve or any other approval command to the user.",
        "Do not run the tool call again or ask the user to approve it again.",
        "If the user still wants the action, explain that a new tool call will trigger a fresh approval request.",
      ].join("\n"),
    );
    expect(onResolution).toHaveBeenCalledWith("deny");
  });

  it("blocks turn-source plugin approval timeouts with setup guidance", async () => {
    registerTelegramPluginApprovalSetup();
    setApproval();
    mockCallGateway.mockResolvedValueOnce({
      id: "server-id",
      status: "accepted",
      deliveryRoute: "turn-source",
    });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id", decision: null });

    const result = await requestApproval({
      ctx: {
        agentId: "main",
        sessionKey: "main",
        turnSourceChannel: "telegram",
        turnSourceTo: "-100123456789",
        turnSourceAccountId: "default",
      },
    });

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("disposition", "timed_out");
    expect(result).toHaveProperty(
      "reason",
      "Approval timed out\n\nConfigure Telegram native approval setup.",
    );
  });

  it.each([
    { label: "an unknown decision", decision: "approved" },
    { label: "a malformed truthy decision", decision: true },
    { label: "an excluded allow decision", decision: "allow-always", restricted: true },
    { label: "a decision for another approval", decision: "allow-once", wrongId: true },
  ])(
    "fails closed on $label without applying approval rewrites",
    async ({ decision, restricted, wrongId }) => {
      const onResolution = vi.fn();
      setApproval(
        {
          onResolution,
          ...(restricted ? { allowedDecisions: ["allow-once", "deny"] } : {}),
        },
        { command: "safe-command" },
      );
      mockCallGateway.mockResolvedValueOnce({ id: "server-id", status: "accepted" });
      mockCallGateway.mockResolvedValueOnce({ id: wrongId ? "other-id" : "server-id", decision });

      const result = await requestApproval({ params: { command: "unsafe-command" } });

      expect(result).toMatchObject({
        blocked: true,
        kind: "failure",
        disposition: "timed_out",
        deniedReason: "plugin-approval",
        reason: "Approval timed out",
        params: { command: "unsafe-command" },
      });
      expect(onResolution).toHaveBeenCalledWith(PluginApprovalResolutions.TIMEOUT);
    },
  );

  it.each([
    {
      label: "unstructured gateway failure",
      phase: "request",
      error: new Error("unknown method plugin.approval.request"),
      reason: "Plugin approval required (gateway unavailable)",
    },
    {
      label: "request validation rejection",
      phase: "request",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message:
          "invalid plugin.approval.request params: at /title: must not have more than 80 characters",
      }),
      reason:
        "Plugin approval request rejected: invalid plugin.approval.request params: at /title: must not have more than 80 characters",
    },
    {
      label: "structured service failure",
      phase: "request",
      error: new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "approval service unavailable",
      }),
      reason: "Plugin approval required (gateway unavailable)",
    },
    {
      label: "expired accepted approval",
      phase: "wait",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "approval expired or not found",
      }),
      reason: "Plugin approval no longer available: approval expired or not found",
    },
  ])("classifies $label and cancels the plugin callback", async ({ phase, error, reason }) => {
    const onResolution = vi.fn();
    setApproval({ title: "x".repeat(81), onResolution });
    if (phase === "wait") {
      mockCallGateway.mockResolvedValueOnce({ id: "plugin:accepted", status: "accepted" });
    }
    mockCallGateway.mockRejectedValueOnce(error);

    const result = await requestApproval();

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", reason);
    expect(onResolution).toHaveBeenCalledWith("cancelled");
  });

  it("blocks and cancels the plugin callback when registration returns no id", async () => {
    const onResolution = vi.fn();
    setApproval({ description: "Registration returns no id", onResolution });
    mockCallGateway.mockResolvedValueOnce({ status: "error" });

    const result = await requestApproval();

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Registration returns no id");
    expect(onResolution).toHaveBeenCalledWith("cancelled");
  });

  it("blocks on immediate null decision without calling waitDecision", async () => {
    const onResolution = vi.fn();
    setApproval({ onResolution });
    mockCallGateway.mockResolvedValueOnce({ id: "server-id-immediate", decision: null });

    const result = await requestApproval();

    expect(result.blocked).toBe(true);
    expect(result).toHaveProperty("reason", "Plugin approval unavailable (no approval route)");
    expect(onResolution).toHaveBeenCalledWith("cancelled");
    expect(mockCallGateway.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
    ]);
  });

  it.each([new Error("run cancelled"), "sessions_yield"])(
    "cancels approval and notifies the plugin when the run aborts: %s",
    async (abortReason) => {
      const onResolution = vi.fn();
      const result = await runAbortDuringApprovalWait({ abortReason, onResolution });

      expect(result.blocked).toBe(true);
      expect(result).toHaveProperty("reason", "Approval cancelled (run aborted)");
      expect(mockCallGateway).toHaveBeenCalledTimes(2);
      expect(onResolution).toHaveBeenCalledWith("cancelled");
    },
  );

  it("does not await onResolution before returning approval outcome", async () => {
    const onResolution = vi.fn(() => new Promise<void>(() => {}));

    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Non-blocking callback",
        description: "Should not block tool execution",
        onResolution,
      },
    });

    mockCallGateway.mockResolvedValueOnce({ id: "server-id-r1-nonblocking", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({
      id: "server-id-r1-nonblocking",
      decision: "allow-once",
    });

    let timeoutId: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        runBeforeToolCallHook({
          toolName: "bash",
          params: {},
          ctx: { agentId: "main", sessionKey: "main" },
        }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("runBeforeToolCallHook waited for onResolution")),
            250,
          );
        }),
      ]);

      expect(result).toEqual({
        blocked: false,
        params: {},
        approvalResolution: "allow-once",
      });
      expect(onResolution).toHaveBeenCalledWith("allow-once");
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  });

  it("uses the transport channel when tool policy provider differs", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Transport routed approval",
        description: "Must use the transport channel",
        pluginId: "my-plugin",
      },
    });

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hook-route-"));
    await fs.writeFile(path.join(tempDir, "note.txt"), "hello");
    mockCallGateway.mockResolvedValueOnce({ id: "transport-route-id", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({
      id: "transport-route-id",
      decision: "allow-once",
    });

    const tools = createOpenClawCodingTools({
      workspaceDir: tempDir,
      messageProvider: "discord-voice",
      messageChannel: "discord",
      currentChannelId: "native-channel-1",
      currentMessagingTarget: "channel:deliverable-1",
      agentAccountId: "acct-1",
      currentThreadTs: "thread-1",
      approvalReviewerDeviceId: "device-tui-reviewer",
    });
    const readTool = tools.find((tool) => tool.name === "read");
    if (!readTool) {
      throw new Error("missing read tool");
    }
    await readTool.execute("tool-hook-route", { path: "note.txt" }, undefined, undefined);

    const requestCall = requireGatewayCall(0);
    expect(requestCall[0]).toBe("plugin.approval.request");
    const requestParams = requireRecord(requestCall[2], "approval request params");
    expect(requestParams.turnSourceChannel).toBe("discord");
    expect(requestParams.turnSourceTo).toBe("channel:deliverable-1");
    expect(requestParams.turnSourceAccountId).toBe("acct-1");
    expect(requestParams.turnSourceThreadId).toBe("thread-1");
    expect(requestParams.approvalReviewerDeviceIds).toEqual(["device-tui-reviewer"]);
  });

  it.each([
    {
      label: "cron",
      trigger: "cron",
      reason: "Plugin approval unavailable: cron runs have no approval-capable initiating surface.",
    },
    {
      label: "non-interactive CLI",
      trigger: "user",
      reason:
        "Plugin approval unavailable: non-interactive CLI runs have no approval-capable initiating surface.",
    },
  ])("fails fast when a $label run requires plugin approval", async ({ trigger, reason }) => {
    const onResolution = vi.fn();
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Unattended approval",
        description: "Command needs review",
        onResolution,
      },
    });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "gh run view 1" },
      ctx: { agentId: "main", sessionKey: "main", trigger },
    });

    expect(result).toEqual({
      blocked: true,
      kind: "failure",
      disposition: "failed",
      deniedReason: "plugin-approval-unavailable",
      reason,
      params: { command: "gh run view 1" },
    });
    expect(mockCallGateway).not.toHaveBeenCalled();
    expect(onResolution).toHaveBeenCalledWith("cancelled");
  });

  it("keeps waiting when an interactive approval surface is bound", async () => {
    hookRunner.runBeforeToolCall.mockResolvedValue({
      requireApproval: {
        title: "Interactive approval",
        description: "CLI command needs review",
      },
    });
    mockCallGateway.mockResolvedValueOnce({ id: "interactive-id", status: "accepted" });
    mockCallGateway.mockResolvedValueOnce({ id: "interactive-id", decision: "allow-once" });

    const result = await runBeforeToolCallHook({
      toolName: "bash",
      params: { command: "gh run view 1" },
      ctx: {
        agentId: "main",
        sessionKey: "main",
        trigger: "user",
        approvalReviewerDeviceId: "device-tui-reviewer",
      },
    });

    expect(result).toMatchObject({ blocked: false, approvalResolution: "allow-once" });
    expect(mockCallGateway.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
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
    const liveParams = { path: "/etc/secret" };
    const execute = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "file body" }] });
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
        content: [{ type: "text", text: "file body" }],
      });
      expect(completed?.privateData.toolContent?.toolInput).not.toBe(liveParams);
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
