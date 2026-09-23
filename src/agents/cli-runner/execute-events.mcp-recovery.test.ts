import { afterEach, expect, it, vi } from "vitest";
import {
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../../infra/diagnostic-events.js";
import {
  getDiagnosticSessionActivitySnapshot,
  resetDiagnosticRunActivityForTest,
  resolveRunStaleThresholdMs,
  startDiagnosticRunActivityTracking,
} from "../../logging/diagnostic-run-activity.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import { createCliEventHandlers } from "./execute-events.js";
import type { CliToolTracking } from "./execute-tool-tracking.js";
import type { PreparedCliRunContext } from "./types.js";

afterEach(() => {
  vi.useRealTimers();
  resetDiagnosticRunActivityForTest();
  resetDiagnosticEventsForTest();
});

it("keeps a managed Claude MCP call alive through its enforced response timeout", async () => {
  vi.useFakeTimers();
  const now = Date.parse("2026-09-22T00:00:00Z");
  vi.setSystemTime(now);
  startDiagnosticRunActivityTracking();
  const runId = "managed-mcp-deadline";
  const backend = {
    command: "claude",
    args: [],
    output: "jsonl" as const,
    input: "stdin" as const,
    serialize: true,
  };
  const context = {
    params: {
      admittedRunContext: createTestAdmittedRunContext(runId),
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-cli",
      model: "claude-haiku-4-5",
      timeoutMs: 5_000_000,
      runId,
    },
    started: now,
    startedMonotonicMs: performance.now(),
    workspaceDir: "/tmp",
    backendResolved: { id: "claude-cli", config: backend, bundleMcp: true },
    preparedBackend: { backend, env: {} },
    managedMcpToolTimeoutMs: 3_610_000,
    executionTarget: { kind: "process" },
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: "claude-haiku-4-5",
    normalizedModel: "claude-haiku-4-5",
    systemPrompt: "system",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    claudeSkillsPluginArgs: [],
    authEpochVersion: 2,
  } as PreparedCliRunContext;
  const toolTracking = { handleCliToolUseStart: vi.fn() } as unknown as CliToolTracking;
  const handlers = createCliEventHandlers({
    context,
    toolTracking,
    getRunState: () => ({ failed: false, error: undefined }),
  });
  handlers.emitParsedToolUseStart({
    toolCallId: "open-call",
    name: "mcp__openclaw__remote_tool",
    kind: "mcp_tool_use",
    args: {},
  });
  await vi.advanceTimersByTimeAsync(0);
  await waitForDiagnosticEventsDrained();
  vi.setSystemTime(now + 900_000);
  const activity = getDiagnosticSessionActivitySnapshot(context.params, now + 900_000);
  expect(activity.activeToolDeadlineAtMs).toBe(now + 3_610_000 + 900_000);
  expect(resolveRunStaleThresholdMs(activity, 900_000)).toBe(4_510_000);
});
