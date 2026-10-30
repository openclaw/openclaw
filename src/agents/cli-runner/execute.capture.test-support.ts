/** Shared protocol and loopback capture fixtures for executor tests. */
import { beforeEach, expect, onTestFinished, vi } from "vitest";
import {
  markMcpLoopbackToolCallFinished,
  markMcpLoopbackToolCallStarted,
  recordMcpLoopbackToolCallResult as recordMcpLoopbackToolCallResultForHandle,
} from "../../gateway/mcp-http.loopback-runtime.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import {
  onTrustedToolExecutionEvent,
  resetDiagnosticEventsForTest,
  type TrustedToolExecutionEvent,
} from "../../infra/diagnostic-events.js";
import type { CliBackendParseJsonlEvent } from "../../plugins/cli-backend.types.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
} from "./execute.test-support.js";
import { createPreparedCliContext } from "./prepared-context.test-support.js";
import type { PreparedCliRunContext } from "./types.js";

type SupervisorSpawnInput = Parameters<ReturnType<typeof getProcessSupervisor>["spawn"]>[0];

export function jsonl(record: unknown) {
  return JSON.stringify(record) + "\n";
}

export function messageRecord(role: "assistant" | "user", content: unknown) {
  return { type: role, message: { role, content } };
}

export function assistant(...content: unknown[]) {
  return jsonl(messageRecord("assistant", content));
}
export function user(...content: unknown[]) {
  return jsonl(messageRecord("user", content));
}

export function toolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
  type = "mcp_tool_use",
) {
  return { type, id, name, input };
}

export function terminal(result = "done", session_id = "session-jsonl") {
  return jsonl({ type: "result", session_id, result });
}
export function messageUse(id: string, input: Record<string, unknown>) {
  return toolUse(id, "mcp__openclaw__message", input);
}
export function toolResult(
  tool_use_id: string,
  content: unknown,
  is_error?: boolean,
  type = "tool_result",
) {
  return { type, tool_use_id, content, ...(is_error === undefined ? {} : { is_error }) };
}

type ToolEventSpec = [
  kind: "started" | "completed" | "error" | "blocked",
  toolCallId: string,
  details?: Record<string, unknown>,
];
export function expectToolEvents(
  events: TrustedToolExecutionEvent[],
  specs: ToolEventSpec[],
  unordered = false,
) {
  const expected = specs.map(([kind, toolCallId, details]) =>
    expect.objectContaining({ type: `tool.execution.${kind}`, toolCallId, ...details }),
  );
  expect(events).toEqual(unordered ? expect.arrayContaining(expected) : expected);
}

export function captureToolEvents() {
  const events: TrustedToolExecutionEvent[] = [];
  onTestFinished(onTrustedToolExecutionEvent((event) => events.push(event)));
  return events;
}

export function mockCaptureSpawn(
  emit: (input: SupervisorSpawnInput, captureKey: string) => void,
  exit: Partial<ReturnType<typeof createSuccessfulProcessExit>> = {},
) {
  supervisorSpawnMock.mockImplementationOnce(async (input) => {
    emit(input, input.env?.OPENCLAW_MCP_CLI_CAPTURE_KEY ?? "");
    return createManagedRun({ ...createSuccessfulProcessExit(), ...exit });
  });
}

export function recordToolOutcome(
  captureKey: string,
  toolName: string,
  args: Record<string, unknown>,
  outcome: "completed" | "failed" | "unknown" = "completed",
  result?: unknown,
) {
  const captureHandle = markMcpLoopbackToolCallStarted({ captureKey, toolName, args });
  if (!captureHandle) {
    return;
  }
  recordMcpLoopbackToolCallResultForHandle({ captureHandle, toolName, args, outcome, result });
  markMcpLoopbackToolCallFinished(captureHandle);
}

export function buildPreparedCliRunContext(params: {
  output: "json" | "jsonl" | "text";
  provider?: string;
  runId?: string;
  beforeExecution?: () => Promise<void>;
  parseJsonlEvent?: CliBackendParseJsonlEvent;
}): PreparedCliRunContext {
  const provider = params.provider ?? "codex-cli";
  const runId = params.runId ?? `run-${params.output}`;
  const backend = {
    command: "agent-cli",
    args: [],
    output: params.output,
    input: "stdin" as const,
    serialize: true,
  };
  return createPreparedCliContext(
    { provider, model: "model", runId, agentId: "main", sessionKey: "agent:main:main" },
    { id: provider, config: backend, bundleMcp: false, parseJsonlEvent: params.parseJsonlEvent },
    {
      preparedBackend: {
        backend,
        env: {},
        ...(params.beforeExecution ? { beforeExecution: params.beforeExecution } : {}),
      },
    },
  );
}

export function claudeJsonlContext() {
  return buildPreparedCliRunContext({ output: "jsonl", provider: "claude-cli" });
}
export function captureContext(provider = "claude-cli", output: "text" | "jsonl" = "jsonl") {
  const context = buildPreparedCliRunContext({ output, provider });
  context.mcpDeliveryCapture = true;
  return context;
}
export function installCliCaptureFixture() {
  beforeEach(() => {
    vi.unstubAllEnvs();
    resetAgentEventsForTest();
    resetDiagnosticEventsForTest();
    supervisorSpawnMock.mockReset(); // These contexts bypass preparation, which normally loads the provider owner.
    // Unknown CLI errors must not materialize bundled plugins inside this fixture.
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: "fixture-cli-provider",
      provider: {
        id: "fixture-cli-provider",
        label: "Fixture CLI provider",
        hookAliases: ["claude-cli", "codex-cli", "google-gemini-cli"],
        auth: [],
      },
      source: "test",
    });
    setActivePluginRegistry(registry);
  });
}
