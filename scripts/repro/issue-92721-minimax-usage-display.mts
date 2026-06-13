// Reproduction script for issue #92721
// Verifies that minimax usage display shows "X% used" instead of "X% left"

import { formatUsageWindowSummary, formatUsageSummaryLine, formatUsageReportLines } from "../../src/infra/provider-usage.format.js";
import type { ProviderUsageSnapshot, UsageSummary } from "../../src/infra/provider-usage.types.js";

function createMinimaxSnapshot(usedPercent: number): ProviderUsageSnapshot {
  return {
    provider: "minimax",
    displayName: "MiniMax",
    windows: [
      {
        label: "24h",
        usedPercent,
        resetAt: Date.now() + 86400000, // 24 hours from now
      },
    ],
  };
}

function createOtherProviderSnapshot(usedPercent: number): ProviderUsageSnapshot {
  return {
    provider: "openai",
    displayName: "OpenAI",
    windows: [
      {
        label: "24h",
        usedPercent,
        resetAt: Date.now() + 86400000,
      },
    ],
  };
}

async function main() {
  console.log("=== Reproduction for issue #92721 ===\n");

  // Test 1: MiniMax at 100% used should show "100% used"
  console.log("Test 1: MiniMax at 100% used");
  const minimaxFull = createMinimaxSnapshot(100);
  const minimaxSummary = formatUsageWindowSummary(minimaxFull);
  console.log(`  Result: ${minimaxSummary}`);

  if (!minimaxSummary?.includes("100% used")) {
    console.error("  FAIL: Expected '100% used' but got different output");
    process.exitCode = 1;
    return;
  }
  console.log("  PASS: Shows '100% used'\n");

  // Test 2: MiniMax at 0% used should show "0% used"
  console.log("Test 2: MiniMax at 0% used");
  const minimaxEmpty = createMinimaxSnapshot(0);
  const minimaxEmptySummary = formatUsageWindowSummary(minimaxEmpty);
  console.log(`  Result: ${minimaxEmptySummary}`);

  if (!minimaxEmptySummary?.includes("0% used")) {
    console.error("  FAIL: Expected '0% used' but got different output");
    process.exitCode = 1;
    return;
  }
  console.log("  PASS: Shows '0% used'\n");

  // Test 3: MiniMax at 50% used should show "50% used"
  console.log("Test 3: MiniMax at 50% used");
  const minimaxHalf = createMinimaxSnapshot(50);
  const minimaxHalfSummary = formatUsageWindowSummary(minimaxHalf);
  console.log(`  Result: ${minimaxHalfSummary}`);

  if (!minimaxHalfSummary?.includes("50% used")) {
    console.error("  FAIL: Expected '50% used' but got different output");
    process.exitCode = 1;
    return;
  }
  console.log("  PASS: Shows '50% used'\n");

  // Test 4: Other provider (OpenAI) should still show "X% left"
  console.log("Test 4: OpenAI at 100% used (should show '0% left')");
  const openaiFull = createOtherProviderSnapshot(100);
  const openaiSummary = formatUsageWindowSummary(openaiFull);
  console.log(`  Result: ${openaiSummary}`);

  if (!openaiSummary?.includes("0% left")) {
    console.error("  FAIL: Expected '0% left' but got different output");
    process.exitCode = 1;
    return;
  }
  console.log("  PASS: Shows '0% left' (unchanged behavior)\n");

  // Test 5: formatUsageSummaryLine with MiniMax
  console.log("Test 5: formatUsageSummaryLine with MiniMax at 75% used");
  const summary: UsageSummary = {
    updatedAt: Date.now(),
    providers: [createMinimaxSnapshot(75)],
  };
  const summaryLine = formatUsageSummaryLine(summary);
  console.log(`  Result: ${summaryLine}`);

  if (!summaryLine?.includes("75% used")) {
    console.error("  FAIL: Expected '75% used' in summary line");
    process.exitCode = 1;
    return;
  }
  console.log("  PASS: Shows '75% used' in summary line\n");

  // Test 6: formatUsageReportLines with MiniMax
  console.log("Test 6: formatUsageReportLines with MiniMax at 25% used");
  const reportLines = formatUsageReportLines({
    updatedAt: Date.now(),
    providers: [createMinimaxSnapshot(25)],
  });
  console.log("  Result:");
  reportLines.forEach(line => console.log(`    ${line}`));

  const hasUsedLine = reportLines.some(line => line.includes("25% used"));
  if (!hasUsedLine) {
    console.error("  FAIL: Expected '25% used' in report lines");
    process.exitCode = 1;
    return;
  }
  console.log("  PASS: Shows '25% used' in report lines\n");

  console.log("=== All tests passed! ===");
  console.log("MiniMax usage display now correctly shows 'X% used' instead of 'X% left'");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
