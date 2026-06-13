/**
 * Repro script for #92474: Validate MCP env keys at mcp set time.
 *
 * Verifies that isDangerousMcpStdioEnvVarName correctly identifies
 * blocked env keys so they can be flagged before config is written.
 */
import { isDangerousMcpStdioEnvVarName } from "../src/agents/mcp-config-shared.js";

const results = { passed: 0, failed: 0 };
function assert(cond, label) {
  if (cond) { results.passed++; console.log(`  ✓ ${label}`); }
  else { results.failed++; console.log(`  ✗ ${label}`); }
}

console.log("=== #92474: Validate MCP env keys at config time ===\n");

console.log("1. Known dangerous env keys are detected:");
assert(isDangerousMcpStdioEnvVarName("PYTHONPATH"), "PYTHONPATH → blocked");
assert(isDangerousMcpStdioEnvVarName("LD_PRELOAD"), "LD_PRELOAD → blocked");
assert(isDangerousMcpStdioEnvVarName("BASH_ENV"), "BASH_ENV → blocked");
assert(isDangerousMcpStdioEnvVarName("NODE_OPTIONS"), "NODE_OPTIONS → blocked");
assert(isDangerousMcpStdioEnvVarName("ANSIBLE_CONFIG"), "ANSIBLE_CONFIG → blocked");

console.log("\n2. Safe env keys are NOT blocked:");
assert(!isDangerousMcpStdioEnvVarName("PYTHONUNBUFFERED"), "PYTHONUNBUFFERED → allowed");
assert(!isDangerousMcpStdioEnvVarName("DEBUG"), "DEBUG → allowed");
assert(!isDangerousMcpStdioEnvVarName("HOME"), "HOME → allowed");
assert(!isDangerousMcpStdioEnvVarName("PATH"), "PATH → allowed");

console.log("\n3. Explicit credential env keys are allowed:");
assert(!isDangerousMcpStdioEnvVarName("AWS_ACCESS_KEY_ID"), "AWS_ACCESS_KEY_ID → allowed (explicit credential)");
assert(!isDangerousMcpStdioEnvVarName("GITHUB_TOKEN"), "GITHUB_TOKEN → allowed (explicit credential)");
assert(!isDangerousMcpStdioEnvVarName("DATABASE_URL"), "DATABASE_URL → allowed (explicit credential)");

console.log("\n4. Case-insensitive matching:");
assert(isDangerousMcpStdioEnvVarName("pythonpath"), "pythonpath → blocked");
assert(isDangerousMcpStdioEnvVarName("PythonPath"), "PythonPath → blocked");

console.log(`\n=== Results: ${results.passed} passed, ${results.failed} failed ===`);
process.exit(results.failed > 0 ? 1 : 0);
