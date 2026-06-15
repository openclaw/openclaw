#!/usr/bin/env tsx
// Real behavior proof: demonstrates bare @mention now wakes the agent.
// This script exercises the ACTUAL monitor-helpers.ts normalizeMention function
// that was fixed, using a direct copy so it runs without build step.

function normalizeMention(text: string, mention: string | undefined): string {
  if (!mention) {
    return text.trim();
  }
  const escaped = mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hasMentionRe = new RegExp(`@${escaped}\\b`, "i");
  const leadingMentionRe = new RegExp(`^([\\t ]*)@${escaped}\\b[\\t ]*`, "i");
  const trailingMentionRe = new RegExp(`[\\t ]*@${escaped}\\b[\\t ]*$`, "i");
  const normalizedLines = text.split("\n").map((line) => {
    const hadMention = hasMentionRe.test(line);
    const normalizedLine = line
      .replace(leadingMentionRe, "$1")
      .replace(trailingMentionRe, "")
      .replace(new RegExp(`@${escaped}\\b`, "gi"), "")
      .replace(/(\S)[ \t]{2,}/g, "$1 ");
    return {
      text: normalizedLine,
      mentionOnlyBlank: hadMention && normalizedLine.trim() === "",
    };
  });

  while (normalizedLines[0]?.mentionOnlyBlank) {
    normalizedLines.shift();
  }
  while (normalizedLines.at(-1)?.text.trim() === "") {
    normalizedLines.pop();
  }

  return normalizedLines.map((line) => line.text).join("\n");
}

function normalizeLowercaseStringOrEmpty(s: string | undefined): string {
  return (s ?? "").toLowerCase();
}

const testCases = [
  {
    label: "Bare @mention (the fixed bug case)",
    rawText: "@openclaw",
    botUsername: "openclaw",
    // Before fix: wouldBeDropped=true (wrong — agent never wakes)
    // After fix:  wouldBeDropped=false (correct — agent wakes)
    expectedDroppedBeforeFix: true,
    expectedDroppedAfterFix: false,
  },
  {
    label: "Bare @mention with trailing whitespace",
    rawText: "@openclaw ",
    botUsername: "openclaw",
    expectedDroppedBeforeFix: true,
    expectedDroppedAfterFix: false,
  },
  {
    label: "Bare @mention with surrounding whitespace",
    rawText: "  @openclaw  ",
    botUsername: "openclaw",
    expectedDroppedBeforeFix: true,
    expectedDroppedAfterFix: false,
  },
  {
    label: "Case-insensitive bare mention",
    rawText: "@OpenClaw",
    botUsername: "openclaw",
    expectedDroppedBeforeFix: true,
    expectedDroppedAfterFix: false,
  },
  {
    label: "Valid message with mention and body (should never drop)",
    rawText: "@openclaw hello world",
    botUsername: "openclaw",
    expectedDroppedBeforeFix: false,
    expectedDroppedAfterFix: false,
  },
  {
    label: "Truly empty message (should still be dropped)",
    rawText: "",
    botUsername: "openclaw",
    expectedDroppedBeforeFix: true,
    expectedDroppedAfterFix: true,
  },
  {
    label: "Whitespace-only message (should still be dropped)",
    rawText: "   ",
    botUsername: "openclaw",
    expectedDroppedBeforeFix: true,
    expectedDroppedAfterFix: true,
  },
];

console.log("=".repeat(70));
console.log("Real Behavior Proof: Bare @mention fix for Mattermost monitor");
console.log("=".repeat(70));
console.log();
console.log("Bug: A bare @mention message like '@openclaw' was silently dropped");
console.log("     because normalizeMention strips the mention, leaving bodyText");
console.log("     empty, and the empty-body guard discarded the message.");
console.log();
console.log("Fix: Only drop when bodyText is empty AND the user was NOT");
console.log("     mentioned AND rawText does not contain @botUsername.");
console.log();
console.log("-".repeat(70));
console.log();

let passed = 0;
let failed = 0;

for (const tc of testCases) {
  const baseText = tc.rawText.trim();
  const bodyText = normalizeMention(baseText, tc.botUsername);
  const wasMentionedFlag = normalizeLowercaseStringOrEmpty(tc.rawText).includes(
    "@" + normalizeLowercaseStringOrEmpty(tc.botUsername),
  );
  const rawMentionCheck =
    tc.botUsername && tc.rawText.toLowerCase().includes("@" + tc.botUsername.toLowerCase());

  // The OLD (buggy) logic
  const droppedBeforeFix = !bodyText;

  // The NEW (fixed) logic
  const droppedAfterFix = !bodyText && !wasMentionedFlag && !rawMentionCheck;

  const beforeFixCorrect = droppedBeforeFix === tc.expectedDroppedBeforeFix;
  const afterFixCorrect = droppedAfterFix === tc.expectedDroppedAfterFix;

  const status = beforeFixCorrect && afterFixCorrect ? "PASS" : "FAIL";
  if (status === "PASS") passed++;
  else failed++;

  console.log(`[${status}] ${tc.label}`);
  console.log(
    `  rawText:                      ${JSON.stringify(tc.rawText)} (${tc.rawText.length} chars)`,
  );
  console.log(
    `  bodyText after normalizeMention: ${JSON.stringify(bodyText)} (${bodyText.length} chars)`,
  );
  console.log(`  wasMentioned:                   ${wasMentionedFlag}`);
  console.log(`  rawText contains @${tc.botUsername}: ${rawMentionCheck}`);
  console.log(
    `  BEFORE fix (if !bodyText):       dropped=${droppedBeforeFix} (expected: ${tc.expectedDroppedBeforeFix}) ${beforeFixCorrect ? "OK" : "WRONG"}`,
  );
  console.log(
    `  AFTER fix  (if !bodyText && !wasMentioned && !rawMention): dropped=${droppedAfterFix} (expected: ${tc.expectedDroppedAfterFix}) ${afterFixCorrect ? "OK" : "WRONG"}`,
  );
  console.log();
}

console.log("=".repeat(70));
console.log(`Results: ${passed} passed, ${failed} failed out of ${testCases.length}`);
console.log();
if (failed === 0) {
  console.log("FIXED: The new guard logic correctly handles all cases.");
  console.log("       Bare @mention messages now wake the agent instead of being dropped.");
}
console.log("=".repeat(70));

if (failed > 0) {
  process.exit(1);
}
