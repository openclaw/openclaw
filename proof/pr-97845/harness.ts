// Real-behavior proof for the streamed invoke-recognizer grammar-drift fix.
//
// It drives the actual built stream normalizer from packages/tool-call-repair via
// the same public API that src/plugin-sdk/provider-stream-shared.ts uses to wrap a
// provider stream (the matcher / createPromotedToolCallEvents / normalizeDoneMessage
// option wiring is mirrored here verbatim). Nothing about the recognizer or the
// normalizer is reimplemented: the harness only constructs a fake degraded provider
// stream and feeds it through the package's normalizePlainTextToolCallStreamEvents.
//
// Two scenarios run against the same fake stream:
//   BEFORE - a scratch copy of stream-normalizer.ts with the recognizer reverted to
//            the old literal-prefix logic. The whitespace-split invoke open is
//            classified "impossible" mid-stream and leaks as visible text.
//   AFTER  - the real (fixed) package source. The same bytes stay buffered and the
//            stream promotes them into a tool-call event with no visible leak.
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const packageSrc = path.join(repoRoot, "packages", "tool-call-repair", "src");
const outputDir = path.join(here, "output");
const repoRef = "packages/tool-call-repair/src/stream-normalizer.ts";

// Degraded provider stream: a grammar-legal attribute-dialect invoke open whose
// `name` attribute carries whitespace around the keyword and the equals sign,
// split into chunks AT those whitespace boundaries, then a parameter block and the
// closing tag. The tool name and argument are benign placeholders.
const STREAM_CHUNKS = [
  "<invoke",
  " name",
  " =",
  ' "exec">',
  '<parameter name="command">echo demo</parameter>',
  "</invoke>",
];
const FULL_TEXT = STREAM_CHUNKS.join("");
const ALLOWED_TOOL_NAMES = new Set(["exec"]);
// Fixed synthetic id so captured output is deterministic; the production wrapper
// uses a random id, which is irrelevant to the leak-vs-promote behavior proven here.
const SYNTHETIC_TOOL_CALL_ID = "call_demo0000000000000000000000";

type NormalizerModule = {
  normalizePlainTextToolCallStreamEvents: (
    source: AsyncIterable<unknown>,
    options: Record<string, unknown>,
  ) => AsyncGenerator<unknown>;
  promoteStandalonePlainTextToolCallMessage: (options: Record<string, unknown>) => unknown;
  extractStandalonePlainTextToolCallText: (params: Record<string, unknown>) => string | undefined;
  scrubOverCapPlainTextToolCallMessage: (params: Record<string, unknown>) => unknown;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

// Fake upstream provider event stream: a text block streamed delta-by-delta, then a
// normal `stop` completion whose final message still carries the full tool-call text.
async function* fakeDegradedProviderStream(): AsyncGenerator<unknown> {
  yield { type: "text_start", contentIndex: 0 };
  for (const delta of STREAM_CHUNKS) {
    yield { type: "text_delta", contentIndex: 0, delta };
  }
  yield { type: "text_end", contentIndex: 0 };
  yield {
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: FULL_TEXT }],
    },
  };
}

// Option wiring mirrored from src/plugin-sdk/provider-stream-shared.ts so the proof
// exercises the exact promote/scrub/matcher contract the runtime uses.
function buildNormalizerOptions(mod: NormalizerModule): Record<string, unknown> {
  const matcher = {
    hasExactName: (name: string) => ALLOWED_TOOL_NAMES.has(name),
    hasNamePrefix: (prefix: string) => {
      for (const toolName of ALLOWED_TOOL_NAMES) {
        if (toolName.startsWith(prefix)) {
          return true;
        }
      }
      return false;
    },
  };

  const createToolCallBlock = (block: { arguments: Record<string, unknown>; name: string }) => ({
    type: "toolCall",
    id: SYNTHETIC_TOOL_CALL_ID,
    name: block.name,
    arguments: block.arguments,
    partialArgs: JSON.stringify(block.arguments),
  });

  const promote = (message: unknown): Record<string, unknown> | undefined => {
    const record = asRecord(message);
    if (
      Array.isArray(record?.content) &&
      record.content.some((block) => asRecord(block)?.type === "toolCall")
    ) {
      return undefined;
    }
    return mod.promoteStandalonePlainTextToolCallMessage({
      allowedToolNames: ALLOWED_TOOL_NAMES,
      createToolCallBlock: (block: { arguments: Record<string, unknown> }, name: string) =>
        createToolCallBlock({ ...block, name }),
      isRetainableNonTextBlock: () => true,
      message,
    }) as Record<string, unknown> | undefined;
  };

  const normalizeDoneMessage = ({ message, reason }: { message: unknown; reason: unknown }) => {
    const scrubbed = mod.scrubOverCapPlainTextToolCallMessage({
      candidateText: mod.extractStandalonePlainTextToolCallText({
        allowOtherNonTextBlocks: true,
        message,
      }),
      matcher,
      message,
    });
    if (scrubbed) {
      return { kind: "scrubbed", message: scrubbed };
    }
    // Token-limit and error terminals can leave complete-looking tool syntax; only
    // normal completion or explicit tool use may promote it into an executable call.
    if (reason !== "stop" && reason !== "toolUse") {
      return undefined;
    }
    const promoted = promote(message);
    return promoted ? { kind: "promoted", message: promoted } : undefined;
  };

  const createPromotedToolCallEvents = (message: Record<string, unknown>): unknown[] => {
    const events: unknown[] = [];
    const content = Array.isArray(message.content) ? message.content : [];
    content.forEach((block, contentIndex) => {
      const record = asRecord(block);
      if (record?.type !== "toolCall") {
        return;
      }
      events.push({ type: "toolcall_start", contentIndex, partial: message });
      events.push({
        type: "toolcall_delta",
        contentIndex,
        delta: typeof record.partialArgs === "string" ? record.partialArgs : "{}",
        partial: message,
      });
    });
    return events;
  };

  return { matcher, createPromotedToolCallEvents, normalizeDoneMessage, stopAfterDone: true };
}

// Compact, redaction-safe projection of an emitted event (drops large `partial`
// snapshots; keeps only what the leak-vs-promote verdict depends on).
function projectEvent(event: unknown): Record<string, unknown> {
  const record = asRecord(event);
  if (!record) {
    return { raw: String(event) };
  }
  const type = typeof record.type === "string" ? record.type : "?";
  if (type === "text_start" || type === "text_end") {
    return { type, contentIndex: record.contentIndex };
  }
  if (type === "text_delta") {
    return { type, contentIndex: record.contentIndex, delta: record.delta };
  }
  if (type === "toolcall_start") {
    return { type, contentIndex: record.contentIndex };
  }
  if (type === "toolcall_delta") {
    return { type, contentIndex: record.contentIndex, delta: record.delta };
  }
  if (type === "done") {
    const message = asRecord(record.message);
    const content = Array.isArray(message?.content) ? message.content : [];
    return {
      type,
      reason: record.reason,
      messageStopReason: message?.stopReason,
      messageBlocks: content.map((block) => {
        const blockRecord = asRecord(block);
        if (blockRecord?.type === "toolCall") {
          return { type: "toolCall", name: blockRecord.name, arguments: blockRecord.arguments };
        }
        if (blockRecord?.type === "text") {
          return { type: "text", text: blockRecord.text };
        }
        return { type: blockRecord?.type ?? "?" };
      }),
    };
  }
  return { type, ...(record.reason !== undefined ? { reason: record.reason } : {}) };
}

type ScenarioResult = {
  emitted: Record<string, unknown>[];
  visibleText: string;
  promotedToolCall: { name: unknown; arguments: unknown } | undefined;
  doneReason: unknown;
};

async function runScenario(mod: NormalizerModule): Promise<ScenarioResult> {
  const options = buildNormalizerOptions(mod);
  const emitted: Record<string, unknown>[] = [];
  let visibleText = "";
  let promotedToolCall: { name: unknown; arguments: unknown } | undefined;
  let doneReason: unknown;

  for await (const event of mod.normalizePlainTextToolCallStreamEvents(
    fakeDegradedProviderStream(),
    options,
  )) {
    const projected = projectEvent(event);
    emitted.push(projected);
    if (projected.type === "text_delta" && typeof projected.delta === "string") {
      visibleText += projected.delta;
    }
    if (projected.type === "toolcall_delta" || projected.type === "toolcall_start") {
      const record = asRecord(event);
      const partial = asRecord(record?.partial);
      const block = Array.isArray(partial?.content)
        ? partial.content.find((entry) => asRecord(entry)?.type === "toolCall")
        : undefined;
      const blockRecord = asRecord(block);
      if (blockRecord && !promotedToolCall) {
        promotedToolCall = { name: blockRecord.name, arguments: blockRecord.arguments };
      }
    }
    if (projected.type === "done") {
      doneReason = projected.reason;
      const blocks = Array.isArray(projected.messageBlocks) ? projected.messageBlocks : [];
      const toolBlock = blocks.find((entry) => asRecord(entry)?.type === "toolCall");
      const toolRecord = asRecord(toolBlock);
      if (toolRecord && !promotedToolCall) {
        promotedToolCall = { name: toolRecord.name, arguments: toolRecord.arguments };
      }
    }
  }

  return { emitted, visibleText, promotedToolCall, doneReason };
}

// Build a scratch copy of the package with only isViableXmlishInvokeOpenPrefix
// reverted to the pre-fix literal-prefix recognizer. Everything else (grammar,
// payload, promote, the rest of the normalizer) is the real source verbatim.
async function materializeBeforeScratch(): Promise<NormalizerModule> {
  const scratchRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pr-97845-before-"));
  const scratchSrc = path.join(scratchRoot, "src");
  await fs.mkdir(scratchSrc, { recursive: true });

  for (const file of ["grammar.ts", "payload.ts", "promote.ts", "index.ts"]) {
    await fs.copyFile(path.join(packageSrc, file), path.join(scratchSrc, file));
  }

  const realNormalizer = await fs.readFile(path.join(packageSrc, "stream-normalizer.ts"), "utf8");
  const startAnchor = "function isViableXmlishInvokeOpenPrefix(";
  const endAnchor = "\nfunction couldStillBeXmlishInvokeOpen(";
  const startIdx = realNormalizer.indexOf(startAnchor);
  const endIdx = realNormalizer.indexOf(endAnchor);
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
    throw new Error("could not locate isViableXmlishInvokeOpenPrefix anchors in real source");
  }
  const oldFragment = await fs.readFile(path.join(here, "old-recognizer.fragment.ts"), "utf8");
  // Keep only the function definition from the fragment (drop the leading comment),
  // then splice it in place of the current recognizer.
  const oldFunctionStart = oldFragment.indexOf(startAnchor);
  if (oldFunctionStart < 0) {
    throw new Error("old-recognizer fragment is missing the expected function");
  }
  const oldFunction = `${oldFragment.slice(oldFunctionStart).trimEnd()}\n`;
  const beforeNormalizer =
    realNormalizer.slice(0, startIdx) + oldFunction + realNormalizer.slice(endIdx);
  await fs.writeFile(path.join(scratchSrc, "stream-normalizer.ts"), beforeNormalizer, "utf8");

  return import(pathToFileURL(path.join(scratchSrc, "index.ts")).href) as Promise<NormalizerModule>;
}

function renderScenarioReport(title: string, note: string, result: ScenarioResult): string {
  const lines: string[] = [];
  lines.push(`===== ${title} =====`);
  lines.push(note);
  lines.push("");
  lines.push(`source under test: ${repoRef}`);
  lines.push(
    `fake upstream chunks (split at whitespace boundaries): ${JSON.stringify(STREAM_CHUNKS)}`,
  );
  lines.push("");
  lines.push("emitted normalized event stream:");
  result.emitted.forEach((event, index) => {
    lines.push(`  [${index}] ${JSON.stringify(event)}`);
  });
  lines.push("");
  lines.push(`visible text emitted to user: ${JSON.stringify(result.visibleText)}`);
  lines.push(`promoted tool call: ${JSON.stringify(result.promotedToolCall ?? null)}`);
  lines.push(`done reason: ${JSON.stringify(result.doneReason ?? null)}`);
  lines.push("");
  const leaked = result.visibleText.includes("<invoke");
  lines.push(
    leaked
      ? "VERDICT: LEAK - raw invoke markup streamed as visible text."
      : "VERDICT: NO LEAK - no visible invoke markup streamed.",
  );
  return `${lines.join("\n")}\n`;
}

const FORBIDDEN_OUTPUT_PATTERNS: { label: string; pattern: RegExp }[] = [
  { label: "absolute /Users path", pattern: /\/Users\// },
  { label: "absolute /Volumes path", pattern: /\/Volumes\// },
  { label: "home-dir reference", pattern: /(^|[^A-Za-z0-9])~\// },
  {
    label: "AI-tool/vendor identity",
    pattern: /\b(?:anthropic|claude|antml|openai|gpt|gemini|minimax)\b/i,
  },
  { label: "attribution line", pattern: /Generated with|Co-Authored-By/i },
  {
    label: "credential-like token",
    pattern: /sk-[A-Za-z0-9]{8,}|api[_-]?key|bearer\s+[A-Za-z0-9]/i,
  },
];

function assertRedacted(label: string, text: string): void {
  for (const { label: patternLabel, pattern } of FORBIDDEN_OUTPUT_PATTERNS) {
    if (pattern.test(text)) {
      throw new Error(`redaction check failed in ${label}: matched ${patternLabel}`);
    }
  }
}

async function main(): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });

  const afterModule = (await import(
    pathToFileURL(path.join(packageSrc, "index.ts")).href
  )) as NormalizerModule;
  const beforeModule = await materializeBeforeScratch();

  const afterResult = await runScenario(afterModule);
  const beforeResult = await runScenario(beforeModule);

  const beforeReport = renderScenarioReport(
    "BEFORE (fix reverted - old literal-prefix recognizer)",
    "Expectation: the whitespace-split invoke open is rejected mid-stream and leaks as visible text.",
    beforeResult,
  );
  const afterReport = renderScenarioReport(
    "AFTER (fix in place - whitespace-flexible recognizer)",
    "Expectation: the same bytes stay buffered and promote into a tool-call event with no visible leak.",
    afterResult,
  );

  // Behavioral assertions: the proof must actually demonstrate the regression and its fix.
  const beforeLeaked = beforeResult.visibleText.includes("<invoke");
  const afterClean = afterResult.visibleText.trim() === "" && Boolean(afterResult.promotedToolCall);
  const summaryLines: string[] = [];
  summaryLines.push("PR #97845 - streamed invoke recognizer grammar-drift fix");
  summaryLines.push(`source under test: ${repoRef}`);
  summaryLines.push("");
  summaryLines.push(`BEFORE visible-text leak reproduced: ${beforeLeaked ? "YES" : "NO"}`);
  summaryLines.push(`  visible text: ${JSON.stringify(beforeResult.visibleText)}`);
  summaryLines.push(`AFTER no visible leak + promoted tool call: ${afterClean ? "YES" : "NO"}`);
  summaryLines.push(`  visible text: ${JSON.stringify(afterResult.visibleText)}`);
  summaryLines.push(
    `  promoted tool call: ${JSON.stringify(afterResult.promotedToolCall ?? null)}`,
  );
  summaryLines.push("");
  const passed = beforeLeaked && afterClean;
  summaryLines.push(
    `PROOF RESULT: ${passed ? "PASS - bug reproduced before, fixed after" : "FAIL"}`,
  );
  const summary = `${summaryLines.join("\n")}\n`;

  for (const [label, text] of [
    ["before.txt", beforeReport],
    ["after.txt", afterReport],
    ["summary.txt", summary],
  ] as const) {
    assertRedacted(label, text);
  }

  await fs.writeFile(path.join(outputDir, "before.txt"), beforeReport, "utf8");
  await fs.writeFile(path.join(outputDir, "after.txt"), afterReport, "utf8");
  await fs.writeFile(path.join(outputDir, "summary.txt"), summary, "utf8");

  process.stdout.write(summary);
  if (!passed) {
    process.stderr.write("proof assertions failed\n");
    process.exit(1);
  }
}

await main();
