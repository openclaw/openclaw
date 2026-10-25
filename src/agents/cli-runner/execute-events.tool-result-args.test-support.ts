import { vi } from "vitest";
import type { CliToolTracking } from "./execute-tool-tracking.js";
import { createPreparedCliContext } from "./prepared-context.test-support.js";
import type { PreparedCliRunContext } from "./types.js";

export function buildContext(runId: string): PreparedCliRunContext {
  const backend = {
    command: "claude",
    args: [],
    output: "jsonl" as const,
    input: "stdin" as const,
    serialize: true,
  };
  return createPreparedCliContext(
    {
      provider: "claude-cli",
      model: "claude-haiku-4-5",
      runId,
      agentId: "main",
      sessionKey: "agent:main:main",
    },
    { id: "claude-cli", config: backend, bundleMcp: false },
  );
}

export function buildToolTracking(): CliToolTracking {
  return {
    shouldSuppressAssistantOutput: vi.fn(() => false),
    handleCliToolUseStart: vi.fn(),
    handleCliToolResult: vi.fn(),
    resolveCliLoopbackTerminalOutcome: vi.fn(() => undefined),
    beginGatewayCapture: vi.fn(),
  } as unknown as CliToolTracking;
}
