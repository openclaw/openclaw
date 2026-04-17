// Dynamic-import boundary for the Claude Agent SDK runtime driver.
//
// Per AGENTS.md's dynamic-import guardrail, lazy callers must never mix
// `await import("x")` and `import ... from "x"` for the same module in
// production code paths. This file exists so `agent-command.ts` (and any
// other lazy caller) can `await import("./claude-sdk/run.runtime.js")`
// without ever statically importing `./run.ts`.
//
// If `runClaudeSdkAgent` needs static import (for tests that exercise the
// adapter directly) import from `./run.ts` instead. Production callers must
// stay on this barrel.

export { runClaudeSdkAgent } from "./run.js";
export type { RunClaudeSdkAgentOptions } from "./run.js";
