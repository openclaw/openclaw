/**
 * Real behavior proof: the three truncation sites in
 * scripts/repro/tool-surface-live-bench.ts produce valid Unicode
 * trail/result output with emoji at the cut boundary.
 *
 * Mirrors the benchmark's exact trail dump (stderr) and result object
 * (stdout) output formats, exercising all three truncateUtf16Safe
 * call sites with surrogate pairs straddling each boundary.
 */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

let passed = 0;
let failed = 0;

function assert(description: string, fn: () => boolean) {
  try {
    if (fn()) { passed++; console.log("  ok: %s", description); }
    else { failed++; console.log("  FAIL: %s", description); }
  } catch (err) {
    failed++;
    console.log("  FAIL: %s — %s", description, (err as Error).message);
  }
}

function hasTrailingSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF]$/.test(s);
}

// Same textFromMessageContent as the benchmark (L494-505)
function textFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (entry) => entry && typeof entry === "object" && (entry as { type?: string }).type === "text",
    )
    .map((entry) => String((entry as { text?: string }).text ?? ""))
    .join("");
}

// ---------------------------------------------------------------------------
// Simulate a benchmark run with surrogate-straddling LLM output
// ---------------------------------------------------------------------------

const prefix299 = "A".repeat(299);
const prefix399 = "A".repeat(399);
const emoji = "🐱"; // U+1F431, 2 UTF-16 code units — straddles at 299-300 and 399-400

// Build the trail array exactly as the benchmark does (L680-699)
const trail: string[] = [];

// [site 1, L693] ASSISTANT text with emoji at position 299-300
const assistantText = prefix299 + emoji + "-trailing";
trail.push(`ASSISTANT text: ${truncateUtf16Safe(assistantText.trim(), 300)}`);

// [site 2, L698] TOOLRESULT with emoji at position 399-400
const toolContent = prefix399 + emoji + "-tool-output";
trail.push(
  `TOOLRESULT myTool: ${truncateUtf16Safe(textFromMessageContent(toolContent), 400)}`,
);

// Write trail dump to stderr — exact format from benchmark L701-703
process.stderr.write(
  `\n===== DUMP test/bench/demo-task ok=true =====\n${trail.join("\n")}\n===== END DUMP =====\n`,
);

// [site 3, L730] finalText with emoji at position 399-400
const finalTextRaw = prefix399 + emoji + "-final";
const finalText = truncateUtf16Safe(finalTextRaw, 400);

// Construct result object — same shape as benchmark L705-730
const result = {
  provider: "test",
  model: "test-model",
  surface: "bench",
  task: "demo-task",
  ok: true,
  latencyMs: 42,
  turns: 2,
  toolCalls: 1,
  serviceCalls: 1,
  decoyCalls: 0,
  rawInspectionExecs: 0,
  rawInspectionByTool: {} as Record<string, number>,
  toolsExposed: 5,
  tokensIn: 100,
  tokensOut: 50,
  cacheRead: 0,
  finalText,
};

// Print result to stdout as formatted JSON (benchmark writes JSON per line)
process.stdout.write(JSON.stringify(result) + "\n");

// ---------------------------------------------------------------------------
// Assertions on the output
// ---------------------------------------------------------------------------

// Site 1 assertions
{
  const trailText = trail[0]!;
  assert("site1: trail entry has no trailing high surrogate", () =>
    !hasTrailingSurrogate(trailText),
  );
  const textPart = trailText.slice("ASSISTANT text: ".length);
  assert("site1: text portion <= 300 code units", () => textPart.length <= 300);
  assert("site1: prefix preserved", () => textPart.startsWith(prefix299.slice(0, 299)));

  // Negative: raw .slice() would split the surrogate
  const raw = `ASSISTANT text: ${assistantText.trim().slice(0, 300)}`;
  assert("site1: raw .slice() leaves trailing high surrogate", () =>
    hasTrailingSurrogate(raw),
  );
}

// Site 2 assertions
{
  const trailText = trail[1]!;
  assert("site2: trail entry has no trailing high surrogate", () =>
    !hasTrailingSurrogate(trailText),
  );

  // Array content variant (common in tool results)
  const arrayContent = [
    { type: "text", text: prefix399 + emoji + "-after" },
  ];
  const arrText = truncateUtf16Safe(textFromMessageContent(arrayContent), 400);
  assert("site2: array content truncated safely", () => !hasTrailingSurrogate(arrText));
  assert("site2: array content <= 400 code units", () => arrText.length <= 400);
}

// Site 3 assertions
{
  assert("site3: finalText has no trailing high surrogate", () =>
    !hasTrailingSurrogate(finalText),
  );
  assert("site3: finalText <= 400 code units", () => finalText.length <= 400);
  assert("site3: prefix preserved", () => finalText.startsWith(prefix399.slice(0, 399)));

  // Negative
  const rawFinal = finalTextRaw.slice(0, 400);
  assert("site3: raw .slice() leaves trailing high surrogate", () =>
    hasTrailingSurrogate(rawFinal),
  );
}

// ASCII path — same behavior as .slice
{
  const ascii = "x".repeat(500);
  assert("ascii 300: truncateUtf16Safe matches .slice", () =>
    truncateUtf16Safe(ascii, 300) === ascii.slice(0, 300),
  );
  assert("ascii 400: truncateUtf16Safe matches .slice", () =>
    truncateUtf16Safe(ascii, 400) === ascii.slice(0, 400),
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("\n=== Summary ===");
console.log("ALL PROOF ASSERTIONS: %d passed, %d failed", passed, failed);
if (failed > 0) process.exit(1);
