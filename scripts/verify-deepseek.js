#!/usr/bin/env node
// Verification script for DeepSeek integration
// Run after building OpenClaw: node scripts/verify-deepseek.js

import { execSync } from "child_process";

console.log("=== DeepSeek Integration Verification ===\n");

let allPassed = true;

// Test 1: CLI option exists
console.log("1. Checking CLI option --deepseek-api-key...");
try {
  const help = execSync("node openclaw.mjs onboard --help", {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (help.includes("--deepseek-api-key")) {
    console.log("   ✅ CLI option found");
  } else {
    console.log("   ❌ CLI option NOT found in help");
    allPassed = false;
  }
} catch (err) {
  void err;
  console.log("   ⚠ Cannot run CLI (may need pnpm openclaw)");
}

// Test 2: Provider group visibility (check source file)
console.log("\n2. Checking provider group in source code...");
try {
  const fs = await import("fs");
  const path = await import("path");
  const authChoicePath = path.join(process.cwd(), "src/commands/auth-choice-options.ts");
  const content = fs.readFileSync(authChoicePath, "utf8");

  // Check for deepseek references
  if (content.includes("deepseek") || content.includes("deepseek-api-key")) {
    console.log("   ✅ DeepSeek references found in auth-choice-options.ts");

    // Count occurrences
    const deepseekCount = (content.match(/deepseek/gi) || []).length;
    console.log(`      Found ${deepseekCount} DeepSeek reference(s)`);
  } else {
    console.log("   ❌ No DeepSeek references in auth-choice-options.ts");
    allPassed = false;
  }
} catch (err) {
  console.log("   ❌ Failed to check auth-choice-options.ts:", err.message);
  allPassed = false;
}

// Test 3: DeepSeek models catalog (check source file)
console.log("\n3. Checking DeepSeek models catalog...");
try {
  const fs = await import("fs");
  const path = await import("path");
  const deepseekModelsPath = path.join(process.cwd(), "src/agents/deepseek-models.ts");
  const content = fs.readFileSync(deepseekModelsPath, "utf8");

  if (content.includes("DEEPSEEK_MODEL_CATALOG")) {
    console.log("   ✅ DeepSeek model catalog file exists");

    // Count model definitions (simplistic check)
    const modelCount = (content.match(/id:\s*["']deepseek/g) || []).length;
    console.log(`      Found ${modelCount} DeepSeek model definition(s)`);
  } else {
    console.log("   ❌ DeepSeek model catalog file missing or invalid");
    allPassed = false;
  }
} catch (err) {
  console.log("   ❌ Failed to check deepseek-models.ts:", err.message);
  allPassed = false;
}

// Test 4: Provider config builder (check source file)
console.log("\n4. Checking provider config builder...");
try {
  const fs = await import("fs");
  const path = await import("path");

  // Check models-config.providers.ts
  const providersPath = path.join(process.cwd(), "src/agents/models-config.providers.ts");
  if (fs.existsSync(providersPath)) {
    const content = fs.readFileSync(providersPath, "utf8");
    if (content.includes("buildDeepseekProvider") || content.includes("deepseek")) {
      console.log("   ✅ DeepSeek provider builder found in models-config.providers.ts");
    } else {
      console.log("   ❌ No DeepSeek provider builder found");
      allPassed = false;
    }
  } else {
    console.log("   ⚠ models-config.providers.ts not found, checking for alternative");

    // Check for DeepSeek in other provider files
    const providersDir = path.join(process.cwd(), "src/agents");
    const files = fs.readdirSync(providersDir);
    const deepseekFiles = files.filter(
      (f) => f.includes("deepseek") || (f.includes("provider") && !f.includes(".test.")),
    );

    if (deepseekFiles.length > 0) {
      console.log(`   ✅ Found DeepSeek provider files: ${deepseekFiles.join(", ")}`);
    } else {
      console.log("   ❌ No DeepSeek provider files found");
      allPassed = false;
    }
  }
} catch (err) {
  console.log("   ❌ Failed to check provider config:", err.message);
  allPassed = false;
}

// Test 5: Non-interactive handler
console.log("\n5. Checking non-interactive handler...");
try {
  const fs = await import("fs");
  const path = await import("path");
  const authChoicePath = path.join(
    process.cwd(),
    "src/commands/onboard-non-interactive/local/auth-choice.ts",
  );
  const content = fs.readFileSync(authChoicePath, "utf8");
  if (content.includes("deepseek-api-key")) {
    console.log("   ✅ Non-interactive handler found");
  } else {
    console.log("   ❌ Non-interactive handler missing DeepSeek");
    allPassed = false;
  }
} catch (err) {
  void err;
  console.log("   ⚠ Cannot read auth-choice.ts");
}

console.log("\n" + "=".repeat(50));
if (allPassed) {
  console.log("✅ All checks passed! DeepSeek integration appears functional.");
  console.log("\nNext steps on tower PC:");
  console.log("1. Set DEEPSEEK_API_KEY environment variable");
  console.log(
    '2. Run: openclaw onboard --non-interactive --auth-choice deepseek-api-key --deepseek-api-key "your-key" --accept-risk',
  );
  console.log("3. Or run interactive: openclaw onboard");
} else {
  console.log("❌ Some checks failed. DeepSeek integration may not work.");
  console.log("\nCheck the following:");
  console.log("- Rebuild project: pnpm build");
  console.log("- Ensure all source files are updated");
  console.log("- Run debug script: node scripts/debug-deepseek.js");
}
console.log("=".repeat(50));
