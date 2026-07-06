// Real behavior proof: Codex dynamic tool calls honor timeoutSeconds when
// timeoutMs is absent.

import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const { resolveDynamicToolCallTimeoutMs, CODEX_DYNAMIC_TOOL_TIMEOUT_MS } = await import(
  path.join(repoRoot, "extensions/codex/src/app-server/dynamic-tool-execution.js")
);

const baseCall = {
  threadId: "thread-1",
  turnId: "turn-1",
  namespace: null,
  tool: "session_status",
};

const cases = [
  {
    name: "timeoutSeconds only",
    arguments: { timeoutSeconds: 30 },
    expected: 30_000,
  },
  {
    name: "timeoutMs takes precedence",
    arguments: { timeoutMs: 5_000, timeoutSeconds: 30 },
    expected: 5_000,
  },
  {
    name: "non-positive timeoutSeconds falls back to default",
    arguments: { timeoutSeconds: -1 },
    expected: CODEX_DYNAMIC_TOOL_TIMEOUT_MS,
  },
];

console.log("=== Proof: Codex dynamic tool timeoutSeconds support ===\n");

let failed = false;
for (const { name, arguments: args, expected } of cases) {
  const actual = resolveDynamicToolCallTimeoutMs({
    call: { ...baseCall, callId: `call-${name}`, arguments: args },
    config: undefined,
  });
  const pass = actual === expected;
  console.log(`${name}: expected ${expected}ms, got ${actual}ms ${pass ? "PASS" : "FAIL"}`);
  if (!pass) {
    failed = true;
  }
}

if (failed) {
  process.exitCode = 1;
} else {
  console.log("\nAll cases passed.");
}
