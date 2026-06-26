#!/usr/bin/env node
import { ensureAuthProfileStore } from "../src/agents/auth-profiles.js";
// Debug script to check DeepSeek provider visibility in auth choices
import { buildAuthChoiceGroups } from "../src/commands/auth-choice-options.js";

async function main() {
  console.log("=== DeepSeek Provider Visibility Debug ===\n");

  const store = ensureAuthProfileStore();
  const { groups } = buildAuthChoiceGroups({ store, includeSkip: false });

  console.log(`Total groups: ${groups.length}`);
  console.log("\nProvider groups:");

  let deepSeekFound = false;
  groups.forEach((g, i) => {
    console.log(`${i + 1}. ${g.label} (${g.value}): ${g.options.length} options`);
    if (g.value === "deepseek") {
      deepSeekFound = true;
      console.log(
        `   Options:`,
        g.options.map((o) => ({ value: o.value, label: o.label })),
      );
    }
  });

  console.log("\n=== Analysis ===");
  if (deepSeekFound) {
    const deepseekGroup = groups.find((g) => g.value === "deepseek");
    if (deepseekGroup.options.length === 0) {
      console.log("❌ DeepSeek group has ZERO options (should have 1)");
      console.log('   Check if "deepseek-api-key" is in optionByValue map');
    } else {
      console.log("✅ DeepSeek group found with", deepseekGroup.options.length, "option(s)");
      console.log("   Should appear in onboarding wizard");
    }
  } else {
    console.log("❌ DeepSeek group NOT FOUND in groups list");
    console.log("   Check AUTH_CHOICE_GROUP_DEFS array");
  }

  // Also check option mapping
  console.log("\n=== Checking option mapping ===");
  const { buildAuthChoiceOptions } = await import("../src/commands/auth-choice-options.js");
  const options = buildAuthChoiceOptions({ store, includeSkip: false });
  const deepseekOption = options.find((o) => o.value === "deepseek-api-key");
  if (deepseekOption) {
    console.log('✅ "deepseek-api-key" option exists in options list');
  } else {
    console.log('❌ "deepseek-api-key" option MISSING from options list');
  }

  // Check environment variable
  console.log("\n=== Environment Check ===");
  const hasEnvKey = process.env.DEEPSEEK_API_KEY ? "✅ Set" : "❌ Not set";
  console.log(`DEEPSEEK_API_KEY: ${hasEnvKey}`);

  console.log("\n=== Recommendation ===");
  if (!deepSeekFound || deepseekGroup?.options.length === 0) {
    console.log('1. Ensure "deepseek-api-key" is in buildAuthChoiceOptions()');
    console.log(
      '2. Ensure AUTH_CHOICE_GROUP_DEFS includes "deepseek" with choice "deepseek-api-key"',
    );
    console.log("3. Check for any filtering based on auth availability");
  } else {
    console.log("DeepSeek should appear in onboarding. If not, check UI filtering logic.");
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
