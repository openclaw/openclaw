// Real behavior proof: Codex dynamic tool calls honor timeoutSeconds when
// timeoutMs is absent, on both the main dynamic tool path and the side-question
// path. This exercises the actual runtime handlers with a tool that sleeps
// longer than the requested deadline, so the result is a timeout failure
// response rather than a resolver-only assertion.

import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const { handleDynamicToolCallWithTimeout, resolveDynamicToolCallTimeoutMs } = await import(
  path.join(repoRoot, "extensions/codex/src/app-server/dynamic-tool-execution.js")
);
const { __testing: sideTesting } = await import(
  path.join(repoRoot, "extensions/codex/src/app-server/side-question.js")
);
const CODEX_SIDE_DYNAMIC_TOOL_TIMEOUT_MS = 90_000;

const baseCall = {
  threadId: "thread-1",
  turnId: "turn-1",
  namespace: null,
  tool: "session_status",
};

const baseSideCall = {
  threadId: "side-thread",
  turnId: "turn-1",
  tool: "session_status",
};

function makeSlowToolBridge(sleepMs: number) {
  return {
    handleToolCall: async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, sleepMs);
      });
      return {
        contentItems: [{ type: "inputText" as const, text: "finished" }],
        success: true,
      };
    },
  };
}

function makeAbortSignal(): AbortSignal {
  return new AbortController().signal;
}

function isTimeoutFailureResponse(response: {
  contentItems: Array<{ text?: string }>;
  success: boolean;
}): boolean {
  return (
    !response.success &&
    response.contentItems.some((item) =>
      item.text?.includes("OpenClaw dynamic tool call timed out"),
    )
  );
}

const resolverCases = [
  {
    name: "resolver/main: timeoutSeconds only",
    resolve: () =>
      resolveDynamicToolCallTimeoutMs({
        call: { ...baseCall, callId: "call-seconds", arguments: { timeoutSeconds: 30 } },
        config: undefined,
      }),
    expected: 32_000,
  },
  {
    name: "resolver/main: timeoutMs takes precedence",
    resolve: () =>
      resolveDynamicToolCallTimeoutMs({
        call: {
          ...baseCall,
          callId: "call-both",
          arguments: { timeoutMs: 5_000, timeoutSeconds: 30 },
        },
        config: undefined,
      }),
    expected: 5_000,
  },
  {
    name: "resolver/main: non-positive timeoutSeconds falls back to default",
    resolve: () =>
      resolveDynamicToolCallTimeoutMs({
        call: { ...baseCall, callId: "call-bad", arguments: { timeoutSeconds: -1 } },
        config: undefined,
      }),
    expected: 90_000,
  },
  {
    name: "resolver/main: fractional timeoutSeconds falls back to default",
    resolve: () =>
      resolveDynamicToolCallTimeoutMs({
        call: { ...baseCall, callId: "call-fraction", arguments: { timeoutSeconds: 1.5 } },
        config: undefined,
      }),
    expected: 90_000,
  },
  {
    name: "resolver/side: timeoutSeconds only",
    resolve: () =>
      sideTesting.resolveSideDynamicToolCallTimeoutMs({
        call: { ...baseSideCall, callId: "side-seconds", arguments: { timeoutSeconds: 45 } },
        config: {},
      }),
    expected: 47_000,
  },
  {
    name: "resolver/side: timeoutMs takes precedence",
    resolve: () =>
      sideTesting.resolveSideDynamicToolCallTimeoutMs({
        call: {
          ...baseSideCall,
          callId: "side-both",
          arguments: { timeoutMs: 5_000, timeoutSeconds: 45 },
        },
        config: {},
      }),
    expected: 5_000,
  },
  {
    name: "resolver/side: fractional timeoutSeconds falls back to default",
    resolve: () =>
      sideTesting.resolveSideDynamicToolCallTimeoutMs({
        call: {
          ...baseSideCall,
          callId: "side-fraction",
          arguments: { timeoutSeconds: 1.5 },
        },
        config: {},
      }),
    expected: CODEX_SIDE_DYNAMIC_TOOL_TIMEOUT_MS,
  },
];

const runtimeCases = [
  {
    name: "runtime/main: timeoutSeconds is enforced by handleDynamicToolCallWithTimeout",
    run: async () => {
      const timeoutMs = resolveDynamicToolCallTimeoutMs({
        call: {
          ...baseCall,
          callId: "call-runtime-seconds",
          arguments: { timeoutSeconds: 1 },
        },
        config: undefined,
      });
      const response = await handleDynamicToolCallWithTimeout({
        call: { ...baseCall, callId: "call-runtime-seconds", arguments: { timeoutSeconds: 1 } },
        toolBridge: makeSlowToolBridge(10_000),
        signal: makeAbortSignal(),
        timeoutMs,
      });
      return isTimeoutFailureResponse(response);
    },
  },
  {
    name: "runtime/main: timeoutMs still takes precedence over timeoutSeconds",
    run: async () => {
      const timeoutMs = resolveDynamicToolCallTimeoutMs({
        call: {
          ...baseCall,
          callId: "call-runtime-both",
          arguments: { timeoutMs: 200, timeoutSeconds: 60 },
        },
        config: undefined,
      });
      const response = await handleDynamicToolCallWithTimeout({
        call: {
          ...baseCall,
          callId: "call-runtime-both",
          arguments: { timeoutMs: 200, timeoutSeconds: 60 },
        },
        toolBridge: makeSlowToolBridge(10_000),
        signal: makeAbortSignal(),
        timeoutMs,
      });
      return isTimeoutFailureResponse(response);
    },
  },
  {
    name: "runtime/side: timeoutSeconds is enforced by handleSideDynamicToolCallWithTimeout",
    run: async () => {
      const timeoutMs = sideTesting.resolveSideDynamicToolCallTimeoutMs({
        call: {
          ...baseSideCall,
          callId: "side-runtime-seconds",
          arguments: { timeoutSeconds: 1 },
        },
        config: {},
      });
      const response = await sideTesting.handleSideDynamicToolCallWithTimeout({
        call: {
          ...baseSideCall,
          callId: "side-runtime-seconds",
          arguments: { timeoutSeconds: 1 },
        },
        toolBridge: makeSlowToolBridge(10_000),
        signal: makeAbortSignal(),
        timeoutMs,
      });
      return isTimeoutFailureResponse(response);
    },
  },
  {
    name: "runtime/side: timeoutMs still takes precedence over timeoutSeconds",
    run: async () => {
      const timeoutMs = sideTesting.resolveSideDynamicToolCallTimeoutMs({
        call: {
          ...baseSideCall,
          callId: "side-runtime-both",
          arguments: { timeoutMs: 200, timeoutSeconds: 60 },
        },
        config: {},
      });
      const response = await sideTesting.handleSideDynamicToolCallWithTimeout({
        call: {
          ...baseSideCall,
          callId: "side-runtime-both",
          arguments: { timeoutMs: 200, timeoutSeconds: 60 },
        },
        toolBridge: makeSlowToolBridge(10_000),
        signal: makeAbortSignal(),
        timeoutMs,
      });
      return isTimeoutFailureResponse(response);
    },
  },
];

console.log("=== Proof: Codex dynamic tool timeoutSeconds support ===\n");

let failed = false;

for (const { name, resolve, expected } of resolverCases) {
  const actual = resolve();
  const pass = actual === expected;
  console.log(`${name}: expected ${expected}ms, got ${actual}ms ${pass ? "PASS" : "FAIL"}`);
  if (!pass) {
    failed = true;
  }
}

for (const { name, run } of runtimeCases) {
  const pass = await run();
  console.log(`${name}: ${pass ? "PASS" : "FAIL"}`);
  if (!pass) {
    failed = true;
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log("\nAll cases passed.");
}
