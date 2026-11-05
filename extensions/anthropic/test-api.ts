/** Plugin-owned test boundary for host/native Goal integration without provider I/O. */
export { prepareClaudeNativeGoal } from "./cli-native-goal.js";
export { executeClaudeCli } from "./cli.runtime.js";
export { createCliTestHarness, waitForProcessExit } from "./cli-runtime.test-support.js";
