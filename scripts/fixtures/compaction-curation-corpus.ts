import type { AgentMessage } from "../../src/agents/runtime/index.js";

export type CompactionCurationCalibrationCase = {
  id: string;
  description: string;
  unresolvedAsk: string;
  messages: AgentMessage[];
  expectedChoice?: "essential" | "relevant" | "redundant" | "transient" | "uncertain";
  expectedProbability?: number;
  expectedConsidered: number;
  expectedOmitted: number;
  retainedMarker?: string;
};

function assistant(text: string, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp,
  } as AgentMessage;
}

function user(text: string, timestamp: number): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  } as AgentMessage;
}

function toolCall(name: string, id: string, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: {} }],
    timestamp,
  } as AgentMessage;
}

function toolResult(params: {
  text: string;
  toolName: string;
  toolCallId: string;
  timestamp: number;
  isError?: boolean;
}): AgentMessage {
  return {
    role: "toolResult",
    toolName: params.toolName,
    toolCallId: params.toolCallId,
    content: [{ type: "text", text: params.text }],
    timestamp: params.timestamp,
    ...(params.isError ? { isError: true } : {}),
  } as AgentMessage;
}

const passingTestLog = Array.from(
  { length: 180 },
  (_, index) => `PASS parser case ${String(index + 1).padStart(3, "0")} duration=4ms`,
).join("\n");

const directoryListing = Array.from(
  { length: 180 },
  (_, index) => `src/generated/module-${String(index + 1).padStart(3, "0")}.ts`,
).join("\n");

const successfulBuildLog = Array.from(
  { length: 160 },
  (_, index) => `[build] emitted chunk-${String(index + 1).padStart(3, "0")}.js`,
).join("\n");

const checksum = "sha256:3d9d2054f8f12f9d7cb4436dcb31e7fd";
const artifactPath = "/tmp/openclaw-curation-report.json";

const referencedToolOutput = [
  ...Array.from({ length: 150 }, (_, index) => `artifact-${index}: ok`),
  `CHECKSUM ${checksum}`,
].join("\n");

const hiddenFailureOutput = [
  ...Array.from({ length: 145 }, (_, index) => `parser-step-${index}: ok`),
  "FAILED parser schema reload: stale cache invalidated the generated token table",
  "next-action: clear cache and rerun parser suite",
].join("\n");

const oversizedTailOutput = `${"routine build line: ok\n".repeat(430)}MATERIAL_TAIL: preserve deployment target staging-only`;

export const COMPACTION_CURATION_CALIBRATION_CASES: readonly CompactionCurationCalibrationCase[] = [
  {
    id: "redundant-success-log",
    description: "Verbose passing test output already reduced to a later assistant status.",
    unresolvedAsk: "Confirm whether the parser tests passed.",
    messages: [
      toolCall("exec", "call-tests", 1),
      toolResult({
        text: passingTestLog,
        toolName: "exec",
        toolCallId: "call-tests",
        timestamp: 2,
      }),
      assistant("All 180 parser cases passed.", 3),
    ],
    expectedChoice: "redundant",
    expectedProbability: 0.94,
    expectedConsidered: 1,
    expectedOmitted: 1,
  },
  {
    id: "oversized-tail-fact",
    description: "A result larger than the evidence cap keeps material tail content intact.",
    unresolvedAsk: "Preserve the deployment target.",
    messages: [
      toolCall("exec", "call-build", 1),
      toolResult({
        text: oversizedTailOutput,
        toolName: "exec",
        toolCallId: "call-build",
        timestamp: 2,
      }),
      assistant("Build completed.", 3),
    ],
    expectedConsidered: 0,
    expectedOmitted: 0,
    retainedMarker: "MATERIAL_TAIL: preserve deployment target staging-only",
  },
  {
    id: "artifact-path-needed",
    description: "Successful output containing an artifact path remains when later work needs it.",
    unresolvedAsk: "Open the generated report and inspect its findings.",
    messages: [
      toolCall("exec", "call-report", 1),
      toolResult({
        text: `${"report row: complete\n".repeat(150)}artifact=${artifactPath}`,
        toolName: "exec",
        toolCallId: "call-report",
        timestamp: 2,
      }),
      user("Use the report path from that result for the next step.", 3),
    ],
    expectedChoice: "relevant",
    expectedProbability: 0.93,
    expectedConsidered: 1,
    expectedOmitted: 0,
    retainedMarker: artifactPath,
  },
  {
    id: "repeated-directory-listing",
    description: "A large directory listing is redundant after a later summary preserves its useful state.",
    unresolvedAsk: "Confirm the generated files exist.",
    messages: [
      toolCall("exec", "call-list", 1),
      toolResult({
        text: directoryListing,
        toolName: "exec",
        toolCallId: "call-list",
        timestamp: 2,
      }),
      assistant("The generated directory contains 180 TypeScript modules.", 3),
    ],
    expectedChoice: "redundant",
    expectedProbability: 0.91,
    expectedConsidered: 1,
    expectedOmitted: 1,
  },
  {
    id: "completed-build-output",
    description: "Routine successful build output becomes transient after completion is recorded.",
    unresolvedAsk: "Continue after the successful build.",
    messages: [
      toolCall("exec", "call-compile", 1),
      toolResult({
        text: successfulBuildLog,
        toolName: "exec",
        toolCallId: "call-compile",
        timestamp: 2,
      }),
      assistant("Production build completed successfully with no errors.", 3),
    ],
    expectedChoice: "transient",
    expectedProbability: 0.92,
    expectedConsidered: 1,
    expectedOmitted: 1,
  },
  {
    id: "later-reference",
    description: "A later request that depends on a checksum keeps the raw result available.",
    unresolvedAsk: "Compare the checksum against the release artifact.",
    messages: [
      toolCall("exec", "call-hash", 1),
      toolResult({
        text: referencedToolOutput,
        toolName: "exec",
        toolCallId: "call-hash",
        timestamp: 2,
      }),
      user("Compare that checksum against the release artifact.", 3),
    ],
    expectedChoice: "essential",
    expectedProbability: 0.95,
    expectedConsidered: 1,
    expectedOmitted: 0,
    retainedMarker: checksum,
  },
  {
    id: "hidden-failure-in-success-result",
    description: "A nominally successful tool result with an unresolved failure stays available.",
    unresolvedAsk: "Fix the parser failure.",
    messages: [
      toolCall("exec", "call-parser", 1),
      toolResult({
        text: hiddenFailureOutput,
        toolName: "exec",
        toolCallId: "call-parser",
        timestamp: 2,
      }),
      user("Fix the failure reported by that command.", 3),
    ],
    expectedChoice: "essential",
    expectedProbability: 0.97,
    expectedConsidered: 1,
    expectedOmitted: 0,
    retainedMarker: "FAILED parser schema reload",
  },
  {
    id: "error-result",
    description: "Tool errors are never eligible for curation.",
    unresolvedAsk: "Resolve the failed command.",
    messages: [
      toolCall("exec", "call-error", 1),
      toolResult({
        text: `${"command stderr line\n".repeat(160)}fatal: repository unavailable`,
        toolName: "exec",
        toolCallId: "call-error",
        timestamp: 2,
        isError: true,
      }),
      user("Resolve that command failure.", 3),
    ],
    expectedConsidered: 0,
    expectedOmitted: 0,
    retainedMarker: "fatal: repository unavailable",
  },
] as const;
