// Live proof: #89897 - FLAG_TERMINATOR constant in getCommandPathInternal (#83902)
// Demonstrates that command-path parsing uses FLAG_TERMINATOR consistently.

import { getCommandPath, getCommandPathWithRootOptions } from "./src/cli/argv.js";
import { FLAG_TERMINATOR } from "./src/infra/cli-root-options.js";

console.log("=== Live Proof: #89897 / #83902 ===");
console.log("FLAG_TERMINATOR constant:", JSON.stringify(FLAG_TERMINATOR));
console.log("");

// Case 1: Basic command path with -- terminator
const argv1 = ["node", "openclaw", "channels", "--", "add"];
const path1 = getCommandPath(argv1, 2);
console.log("Case 1: getCommandPath([node, openclaw, channels, --, add], 2)");
console.log(`  Result: [${path1.join(", ")}]`);
console.log(`  PASS: ${JSON.stringify(path1) === JSON.stringify(["channels"])}`);

// Case 2: Command path without -- should continue
const argv2 = ["node", "openclaw", "channels", "add"];
const path2 = getCommandPath(argv2, 2);
console.log(`\nCase 2: getCommandPath([node, openclaw, channels, add], 2)`);
console.log(`  Result: [${path2.join(", ")}]`);
console.log(`  PASS: ${JSON.stringify(path2) === JSON.stringify(["channels", "add"])}`);

// Case 3: FLAG_TERMINATOR at position 3 stops parsing, "add" is excluded
const argv3 = ["node", "openclaw", "config", FLAG_TERMINATOR, "set", "--key", "value"];
const path3 = getCommandPath(argv3, 2);
console.log(`\nCase 3: getCommandPath([node, openclaw, config, --, set, --key, value], 2)`);
console.log(`  Result: [${path3.join(", ")}]`);
console.log(`  PASS: ${JSON.stringify(path3) === JSON.stringify(["config"])}`);

// Case 4: With root options skipping
const argv4 = ["node", "openclaw", "--debug", "status", FLAG_TERMINATOR, "extra"];
const path4 = getCommandPathWithRootOptions(argv4, 2);
console.log(`\nCase 4: getCommandPathWithRootOptions([node, openclaw, --debug, status, --, extra], 2)`);
console.log(`  Result: [${path4.join(", ")}]`);
console.log(`  PASS: ${JSON.stringify(path4) === JSON.stringify(["status"])}`);

// Case 5: Contract test — the constant is "--"
console.log(`\nCase 5: FLAG_TERMINATOR === "--"`);
console.log(`  PASS: ${FLAG_TERMINATOR === "--"}`);

const allPass =
  JSON.stringify(path1) === JSON.stringify(["channels"]) &&
  JSON.stringify(path2) === JSON.stringify(["channels", "add"]) &&
  JSON.stringify(path3) === JSON.stringify(["config"]) &&
  JSON.stringify(path4) === JSON.stringify(["status"]) &&
  FLAG_TERMINATOR === "--";

console.log(`\n=== Live Proof #89897: ${allPass ? "ALL PASSED" : "FAILED"} ===`);
console.log("Next: run test suite via node scripts/run-vitest.mjs run src/cli/argv.test.ts --reporter=verbose");
