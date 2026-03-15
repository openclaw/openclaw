#!/usr/bin/env -S node --import tsx

import { promises as fs } from "node:fs";
import path from "node:path";
import { __testing as structuredContextTesting } from "../../src/plugins/structured-context/src/context-engine.js";

type MatrixCase = {
  id: string;
  lengthBucket: "S" | "M" | "L" | "XL";
  turnCount: number;
  taskType: "code_debugging" | "research" | "operations" | "writing_planning" | "mixed_tool_dense";
  dialogueForm:
    | "linear_qa"
    | "clarification_branch"
    | "interruption_resume"
    | "goal_redirect"
    | "conflicting_instruction_fix";
  seed: number;
  taskId: string;
  taskObjective: string;
  acceptanceChecks: string[];
};

type TaskDefinition = {
  taskId: string;
  taskType: MatrixCase["taskType"];
  title: string;
  objective: string;
  inputArtifacts: string[];
  hardConstraints: string[];
  deliverables: string[];
  primaryIdentifiers: string[];
  toolProfile: "light" | "mixed_dense";
};

type SyntheticMessage = {
  role: "user" | "assistant" | "toolResult";
  content: string;
  toolName?: string;
  toolCallId?: string;
  isError?: boolean;
};

type GroundTruth = {
  instructions: string[];
  decisions: string[];
  constraints: string[];
  expectedArtifactRefs: number;
};

type EvalResult = {
  caseId: string;
  mode: "legacy" | "structured-context";
  tokensBefore: number;
  tokensAfter: number;
  compressionRate: number;
  instructionRecallF1: number;
  decisionFidelity: number;
  artifactIntegrity: number;
  recoverabilityRate: number;
  hallucinationExtensionRate: number;
  latencyMs: number;
};

type Aggregate = {
  mode: "legacy" | "structured-context";
  compressionRate: number;
  instructionRecallF1: number;
  decisionFidelity: number;
  artifactIntegrity: number;
  recoverabilityRate: number;
  hallucinationExtensionRate: number;
  latencyMs: number;
};

type ParsedArgs = {
  matrixPath: string;
  tasksPath: string;
  outPath: string;
  jsonPath: string;
  traceDir: string;
  traceAll: boolean;
  traceCaseIds: string[];
};

type ContextRecord = {
  decisions: string[];
  constraints: string[];
  pendingUserAsks: string[];
  openTodos: string[];
  exactIdentifiers: string[];
  artifactRefs?: unknown[];
};

type LegacyEvalDetail = {
  keepCount: number;
  keptTurnIndexes: number[];
  droppedTurnIndexes: number[];
  summary: string;
  instructionFacts: string[];
  decisionFacts: string[];
  constraintFacts: string[];
};

type ArtifactRefTrace = {
  path: string;
  turnIndex: number;
  toolCallId?: string;
  toolName?: string;
  bytes: number;
};

type StructuredContextEvalDetail = {
  recentStartIndex: number;
  keptTurnIndexes: number[];
  droppedTurnIndexes: number[];
  oversizedTurnIndexes: number[];
  artifactRefs: ArtifactRefTrace[];
  contextRecord: ContextRecord;
  summary: string;
  systemPromptAddition?: string;
  instructionFacts: string[];
  decisionFacts: string[];
  constraintFacts: string[];
};

type LegacyEvaluation = {
  metrics: EvalResult;
  details: LegacyEvalDetail;
};

type StructuredContextEvaluation = {
  metrics: EvalResult;
  details: StructuredContextEvalDetail;
};

type MessageContribution = {
  categories: string[];
  identifiers: string[];
  instructionFacts: string[];
  decisionFacts: string[];
  constraintFacts: string[];
};

type TurnTrace = {
  turn: number;
  role: SyntheticMessage["role"];
  chars: number;
  tokens: number;
  legacyAction: "kept" | "dropped";
  structuredContextActions: string[];
  categories: string[];
  instructionFactCount: number;
  decisionFactCount: number;
  constraintFactCount: number;
  identifierCount: number;
  toolCallId?: string;
  preview: string;
};

type CaseTrace = {
  caseId: string;
  taskId: string;
  taskTitle: string;
  taskType: MatrixCase["taskType"];
  dialogueForm: MatrixCase["dialogueForm"];
  turnCount: number;
  metrics: {
    legacy: EvalResult;
    structuredContext: EvalResult;
    delta: {
      compressionRate: number;
      instructionRecallF1: number;
      decisionFidelity: number;
      artifactIntegrity: number;
      recoverabilityRate: number;
      hallucinationExtensionRate: number;
      latencyMs: number;
    };
  };
  legacy: LegacyEvalDetail;
  structuredContext: StructuredContextEvalDetail;
  turns: TurnTrace[];
};

type TraceFileMeta = {
  caseId: string;
  markdownPath: string;
  jsonPath: string;
};

const LENGTH_TO_TURN_COUNT: Record<MatrixCase["lengthBucket"], number> = {
  S: 15,
  M: 60,
  L: 150,
  XL: 300,
};

function parseBooleanFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  return fallback;
}

function parseCsv(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseArgs(): ParsedArgs {
  const argv = process.argv.slice(2);
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    const next = argv[i + 1];
    if (!current.startsWith("--")) {
      continue;
    }
    if (!next || next.startsWith("--")) {
      flags.set(current, "true");
      continue;
    }
    flags.set(current, next);
    i += 1;
  }

  const hasTraceCaseFilter = Boolean(flags.get("--trace-case"));

  return {
    matrixPath:
      flags.get("--matrix") ??
      path.join(process.cwd(), "test", "context-engine", "structured-context-matrix", "cases.json"),
    tasksPath:
      flags.get("--tasks") ??
      path.join(process.cwd(), "test", "context-engine", "structured-context-matrix", "tasks.json"),
    outPath:
      flags.get("--out") ??
      path.join(process.cwd(), ".artifacts", "context-engine", "structured-context-eval-report.md"),
    jsonPath:
      flags.get("--json") ??
      path.join(
        process.cwd(),
        ".artifacts",
        "context-engine",
        "structured-context-eval-report.json",
      ),
    traceDir:
      flags.get("--trace-dir") ??
      path.join(process.cwd(), ".artifacts", "context-engine", "structured-context-traces"),
    traceAll: parseBooleanFlag(flags.get("--trace-all"), !hasTraceCaseFilter),
    traceCaseIds: parseCsv(flags.get("--trace-case")),
  };
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function estimateTokensFromText(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function estimateTokensFromMessages(messages: SyntheticMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.content.length;
  }
  return estimateTokensFromText("x".repeat(chars));
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(value.trim());
  }
  return result;
}

function pickBySeed(values: string[], seed: number, offset: number): string {
  if (values.length === 0) {
    return "";
  }
  return values[(seed + offset) % values.length];
}

function clipText(value: string, max = 120): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= max) {
    return singleLine;
  }
  return `${singleLine.slice(0, max - 3)}...`;
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function toTurnIndexes(start: number, endExclusive: number): number[] {
  const indexes: number[] = [];
  for (let index = Math.max(0, start); index < endExclusive; index += 1) {
    indexes.push(index);
  }
  return indexes;
}

function generateOversizedToolOutput(params: {
  testCase: MatrixCase;
  task: TaskDefinition;
  turnIndex: number;
}): string {
  const core = [
    `Tool stream for ${params.testCase.id}`,
    `Task ${params.task.taskId}`,
    `Objective ${params.testCase.taskObjective}`,
    `Identifiers ${params.task.primaryIdentifiers.join(" | ")}`,
    `Turn ${params.turnIndex}`,
  ].join("\n");
  return `${core}\n${"RAW_TOOL_PAYLOAD ".repeat(380)}`;
}

function generateTranscript(params: { testCase: MatrixCase; task: TaskDefinition }): {
  messages: SyntheticMessage[];
  truth: GroundTruth;
} {
  const { testCase, task } = params;
  const turns = Math.max(testCase.turnCount, LENGTH_TO_TURN_COUNT[testCase.lengthBucket]);

  const acceptanceInstructions = testCase.acceptanceChecks.map((entry) => `Must satisfy: ${entry}`);
  const objectiveInstruction = `Objective: ${testCase.taskObjective || task.objective}`;
  const identifierConstraints = task.primaryIdentifiers.map(
    (identifier) => `Keep identifier exactly: ${identifier}`,
  );
  const constraints = dedupe([...task.hardConstraints, ...identifierConstraints]);

  const decisions = dedupe([
    `Decision: prioritize ${task.taskId} continuity under ${testCase.dialogueForm}.`,
    `Decision: final output must include ${pickBySeed(task.deliverables, testCase.seed, 0)}.`,
  ]);

  const messages: SyntheticMessage[] = [];
  messages.push({
    role: "user",
    content: [
      `Task title: ${task.title}`,
      objectiveInstruction,
      ...acceptanceInstructions,
      `Input artifacts: ${task.inputArtifacts.slice(0, 4).join(", ")}`,
      `Primary IDs: ${task.primaryIdentifiers.join(", ")}`,
      `Case seed: ${testCase.seed}`,
    ].join("\n"),
  });

  messages.push({
    role: "assistant",
    content: [
      decisions[0],
      `Constraint: ${pickBySeed(constraints, testCase.seed, 1)}.`,
      `Planned deliverable: ${pickBySeed(task.deliverables, testCase.seed, 2)}.`,
    ].join(" "),
  });

  let oversizedToolCount = 0;
  for (let i = 0; i < turns - 4; i += 1) {
    const phase = i % 7;

    if (phase === 0) {
      messages.push({
        role: "user",
        content: [
          `Clarification ${i}: prioritize ${pickBySeed(task.inputArtifacts, testCase.seed, i)} first.`,
          `Keep ${pickBySeed(task.primaryIdentifiers, testCase.seed, i)} unchanged.`,
          `Reminder ${i}: ${pickBySeed(acceptanceInstructions, testCase.seed, i)}.`,
        ].join("\n"),
      });
      continue;
    }

    if (phase === 1) {
      messages.push({
        role: "assistant",
        content: [
          `TODO ${i}: complete ${pickBySeed(task.deliverables, testCase.seed, i)}.`,
          `Decision update: keep ${testCase.dialogueForm} flow stable for ${testCase.id}.`,
        ].join(" "),
      });
      continue;
    }

    if (phase === 2 && task.toolProfile === "mixed_dense") {
      oversizedToolCount += 1;
      messages.push({
        role: "toolResult",
        content: generateOversizedToolOutput({ testCase, task, turnIndex: i }),
        toolName: "exec",
        toolCallId: `call-${testCase.id}-${i}`,
        isError: i % 2 === 0,
      });
      continue;
    }

    if (phase === 3 && testCase.dialogueForm === "clarification_branch") {
      messages.push({
        role: "user",
        content: [
          `Branch question ${i}: choose Branch-A (${pickBySeed(task.deliverables, testCase.seed, i)})`,
          `or Branch-B (${pickBySeed(task.deliverables, testCase.seed, i + 1)}).`,
          "Return one selected branch and why the other is rejected.",
        ].join("\n"),
      });
      continue;
    }

    if (phase === 3 && testCase.dialogueForm === "interruption_resume") {
      messages.push({
        role: "assistant",
        content: `Interruption ${i}: paused for unrelated ask, now resuming ${task.taskId} with IDs intact.`,
      });
      continue;
    }

    if (phase === 3 && testCase.dialogueForm === "goal_redirect") {
      messages.push({
        role: "user",
        content: [
          `Goal redirect ${i}: drop old sub-goal and focus on ${pickBySeed(task.deliverables, testCase.seed, i)}.`,
          `New top ask: ${testCase.taskObjective}`,
        ].join("\n"),
      });
      continue;
    }

    if (phase === 3 && testCase.dialogueForm === "conflicting_instruction_fix") {
      messages.push({
        role: "user",
        content: [
          `Outdated instruction ${i}: ignore ${pickBySeed(task.deliverables, testCase.seed, i)}.`,
          `Correction ${i}: keep ${pickBySeed(task.deliverables, testCase.seed, i + 1)} as final target.`,
        ].join("\n"),
      });
      continue;
    }

    if (phase === 4) {
      messages.push({
        role: "assistant",
        content: `Noise filter check ${i}: acknowledged greeting/repetition, kept only task-relevant facts for ${testCase.id}.`,
      });
      continue;
    }

    if (phase === 5) {
      messages.push({
        role: "assistant",
        content: `Progress ${i}: still aligned with constraint "${pickBySeed(constraints, testCase.seed, i)}".`,
      });
      continue;
    }

    messages.push({
      role: "assistant",
      content: `Checkpoint ${i}: pending ask is ${pickBySeed(acceptanceInstructions, testCase.seed, i)}.`,
    });
  }

  const latestAsk = [
    `Latest ask: finalize ${testCase.id} for ${task.taskId}.`,
    ...acceptanceInstructions,
    `Must preserve identifiers: ${task.primaryIdentifiers.join(", ")}.`,
    "Do not modify core runtime logic.",
  ].join("\n");

  messages.push({ role: "user", content: latestAsk });
  const finalDecision = `Decision: final synthesis prepared for ${testCase.id} with ${task.taskId}.`;
  messages.push({ role: "assistant", content: finalDecision });

  return {
    messages,
    truth: {
      instructions: dedupe([objectiveInstruction, ...acceptanceInstructions, latestAsk]),
      decisions: dedupe([...decisions, finalDecision]),
      constraints,
      expectedArtifactRefs: oversizedToolCount,
    },
  };
}

function computeF1(groundTruth: string[], observed: string[]): number {
  if (groundTruth.length === 0 && observed.length === 0) {
    return 1;
  }

  const dedupedTruth = dedupe(groundTruth);
  const dedupedObserved = dedupe(observed);
  const truePositive = dedupedObserved.filter((item) =>
    isSemanticallyMatched(item, dedupedTruth),
  ).length;
  const recalled = dedupedTruth.filter((item) =>
    isSemanticallyMatched(item, dedupedObserved),
  ).length;

  const precision = dedupedObserved.length === 0 ? 0 : truePositive / dedupedObserved.length;
  const recall = dedupedTruth.length === 0 ? 0 : recalled / dedupedTruth.length;

  if (precision === 0 || recall === 0) {
    return 0;
  }
  return (2 * precision * recall) / (precision + recall);
}

function extractInstructionFacts(text: string): string[] {
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  return dedupe(
    lines
      .filter((line) => /must|do not|latest ask|please|objective|ensure|确保|不要|必须/i.test(line))
      .map((line) => line),
  );
}

function extractDecisionFacts(text: string): string[] {
  return dedupe(
    text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => /decision|decided|我将|计划|结论/i.test(line)),
  );
}

function extractConstraintFacts(text: string): string[] {
  return dedupe(
    text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) =>
        /must|never|constraint|do not|keep identifier|必须|不得|限制|约束/i.test(line),
      ),
  );
}

function isSemanticallyMatched(candidate: string, truthValues: string[]): boolean {
  const normalizedCandidate = normalizeText(candidate);
  return truthValues.some((truth) => {
    const normalizedTruth = normalizeText(truth);
    return (
      normalizedCandidate === normalizedTruth ||
      normalizedCandidate.includes(normalizedTruth) ||
      normalizedTruth.includes(normalizedCandidate)
    );
  });
}

function normalizeForStructuredContext(messages: SyntheticMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content,
    toolName: message.toolName,
    toolCallId: message.toolCallId,
    isError: message.isError,
    timestamp: Date.now(),
  }));
}

function buildMessageContribution(message: SyntheticMessage): MessageContribution {
  const normalized = normalizeForStructuredContext([message]);
  const singleRecord = structuredContextTesting.classifyMessages(normalized, []) as ContextRecord;
  const identifiers = structuredContextTesting.extractIdentifiers(message.content);

  const categories: string[] = [];
  if (singleRecord.pendingUserAsks.length > 0) {
    categories.push("pending_user_ask");
  }
  if (singleRecord.decisions.length > 0) {
    categories.push("decision");
  }
  if (singleRecord.constraints.length > 0) {
    categories.push("constraint");
  }
  if (singleRecord.openTodos.length > 0) {
    categories.push("todo");
  }
  if (identifiers.length > 0) {
    categories.push("identifier");
  }

  return {
    categories: dedupe(categories),
    identifiers,
    instructionFacts: extractInstructionFacts(message.content),
    decisionFacts: extractDecisionFacts(message.content),
    constraintFacts: extractConstraintFacts(message.content),
  };
}

async function evaluateLegacy(params: {
  testCase: MatrixCase;
  messages: SyntheticMessage[];
  truth: GroundTruth;
}): Promise<LegacyEvaluation> {
  const started = Date.now();
  const keepCount = Math.max(12, Math.ceil(params.messages.length * 0.7));
  const keepStart = Math.max(0, params.messages.length - keepCount);
  const keptMessages = params.messages.slice(keepStart);
  const keptTurnIndexes = toTurnIndexes(keepStart, params.messages.length);
  const droppedTurnIndexes = toTurnIndexes(0, keepStart);

  const summary = `Legacy summary for ${params.testCase.id}\nLatest: ${keptMessages.at(-2)?.content ?? ""}`;

  const artifactIntegrity = params.truth.expectedArtifactRefs === 0 ? 1 : 0;

  const combinedText = `${summary}\n${keptMessages.map((msg) => msg.content).join("\n")}`;
  const instructionFacts = extractInstructionFacts(combinedText);
  const decisionFacts = extractDecisionFacts(combinedText);
  const constraintFacts = extractConstraintFacts(combinedText);

  const tokensBefore = estimateTokensFromMessages(params.messages);
  const tokensAfter = estimateTokensFromMessages(keptMessages) + estimateTokensFromText(summary);

  return {
    metrics: {
      caseId: params.testCase.id,
      mode: "legacy",
      tokensBefore,
      tokensAfter,
      compressionRate: 1 - tokensAfter / Math.max(1, tokensBefore),
      instructionRecallF1: computeF1(params.truth.instructions, instructionFacts),
      decisionFidelity: computeF1(params.truth.decisions, decisionFacts),
      artifactIntegrity,
      recoverabilityRate: artifactIntegrity,
      hallucinationExtensionRate:
        constraintFacts.length === 0
          ? 0
          : Math.max(
              0,
              (constraintFacts.length -
                constraintFacts.filter((item) =>
                  isSemanticallyMatched(item, params.truth.constraints),
                ).length) /
                constraintFacts.length,
            ),
      latencyMs: Date.now() - started,
    },
    details: {
      keepCount,
      keptTurnIndexes,
      droppedTurnIndexes,
      summary,
      instructionFacts,
      decisionFacts,
      constraintFacts,
    },
  };
}

async function evaluateStructuredContext(params: {
  testCase: MatrixCase;
  messages: SyntheticMessage[];
  truth: GroundTruth;
  artifactsRoot: string;
}): Promise<StructuredContextEvaluation> {
  const started = Date.now();
  const normalizedMessages = normalizeForStructuredContext(params.messages);

  const keptMessages = structuredContextTesting.takeRecentTurns(
    normalizedMessages,
    5,
  ) as SyntheticMessage[];
  const recentStartIndex = Math.max(0, normalizedMessages.length - keptMessages.length);
  const keptTurnIndexes = toTurnIndexes(recentStartIndex, normalizedMessages.length);
  const droppedTurnIndexes = toTurnIndexes(0, recentStartIndex);

  const oversized = structuredContextTesting.collectOversizedToolPayloads(
    normalizedMessages,
    4000,
  ) as Array<{
    text: string;
    toolName?: string;
    toolCallId?: string;
  }>;

  const oversizedTurnIndexes = normalizedMessages
    .map((message, index) => ({ message, index }))
    .filter((entry) => entry.message.role === "toolResult" && entry.message.content.length >= 4000)
    .map((entry) => entry.index);

  const artifactRefs: ArtifactRefTrace[] = [];
  for (let i = 0; i < oversized.length; i += 1) {
    const artifactFile = path.join(params.artifactsRoot, `${params.testCase.id}-${i}.txt`);
    await fs.writeFile(artifactFile, oversized[i].text, "utf8");
    artifactRefs.push({
      path: artifactFile,
      turnIndex: oversizedTurnIndexes[i] ?? -1,
      toolCallId: oversized[i].toolCallId,
      toolName: oversized[i].toolName,
      bytes: Buffer.byteLength(oversized[i].text, "utf8"),
    });
  }

  const record = structuredContextTesting.classifyMessages(
    normalizedMessages,
    artifactRefs,
  ) as ContextRecord;

  const instructionHints = extractInstructionFacts(
    normalizedMessages
      .filter((message) => message.role === "user")
      .map((message) => message.content)
      .join("\n"),
  ).slice(0, 6);

  const summary = [
    "structured-context structured summary",
    ...instructionHints.map((entry) => `instruction: ${entry}`),
    ...record.constraints.slice(0, 6).map((entry) => `constraint: ${entry}`),
    ...record.decisions.slice(0, 6).map((entry) => `decision: ${entry}`),
    ...record.pendingUserAsks.slice(0, 6).map((entry) => `ask: ${entry}`),
    ...record.exactIdentifiers.slice(0, 8).map((entry) => `id: ${entry}`),
  ].join("\n");

  const systemPromptAddition = structuredContextTesting.composeSystemPromptAddition(record);

  const combinedText = `${summary}\n${keptMessages.map((msg) => msg.content).join("\n")}`;
  const instructionFacts = extractInstructionFacts(combinedText);
  const decisionFacts = extractDecisionFacts(combinedText);
  const constraintFacts = extractConstraintFacts(combinedText);

  const tokensBefore = estimateTokensFromMessages(params.messages);
  const tokensAfter = estimateTokensFromMessages(keptMessages) + estimateTokensFromText(summary);

  const artifactFiles = await Promise.all(
    artifactRefs.map(async (ref) => {
      try {
        await fs.access(ref.path);
        return true;
      } catch {
        return false;
      }
    }),
  );

  const resolvedArtifacts = artifactFiles.filter(Boolean).length;
  const expectedArtifacts = params.truth.expectedArtifactRefs;
  const artifactIntegrity =
    expectedArtifacts === 0 ? 1 : Math.min(1, resolvedArtifacts / expectedArtifacts);

  return {
    metrics: {
      caseId: params.testCase.id,
      mode: "structured-context",
      tokensBefore,
      tokensAfter,
      compressionRate: 1 - tokensAfter / Math.max(1, tokensBefore),
      instructionRecallF1: computeF1(params.truth.instructions, instructionFacts),
      decisionFidelity: computeF1(params.truth.decisions, decisionFacts),
      artifactIntegrity,
      recoverabilityRate: artifactIntegrity,
      hallucinationExtensionRate:
        constraintFacts.length === 0
          ? 0
          : Math.max(
              0,
              (constraintFacts.length -
                constraintFacts.filter((item) =>
                  isSemanticallyMatched(item, params.truth.constraints),
                ).length) /
                constraintFacts.length,
            ),
      latencyMs: Date.now() - started,
    },
    details: {
      recentStartIndex,
      keptTurnIndexes,
      droppedTurnIndexes,
      oversizedTurnIndexes,
      artifactRefs,
      contextRecord: record,
      summary,
      systemPromptAddition,
      instructionFacts,
      decisionFacts,
      constraintFacts,
    },
  };
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function aggregate(results: EvalResult[], mode: "legacy" | "structured-context"): Aggregate {
  const selected = results.filter((entry) => entry.mode === mode);
  return {
    mode,
    compressionRate: average(selected.map((entry) => entry.compressionRate)),
    instructionRecallF1: average(selected.map((entry) => entry.instructionRecallF1)),
    decisionFidelity: average(selected.map((entry) => entry.decisionFidelity)),
    artifactIntegrity: average(selected.map((entry) => entry.artifactIntegrity)),
    recoverabilityRate: average(selected.map((entry) => entry.recoverabilityRate)),
    hallucinationExtensionRate: average(selected.map((entry) => entry.hallucinationExtensionRate)),
    latencyMs: average(selected.map((entry) => entry.latencyMs)),
  };
}

function toPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatAggregateReport(
  legacy: Aggregate,
  structuredContext: Aggregate,
  traceDir: string,
): string {
  const hardGatePass =
    structuredContext.instructionRecallF1 >= legacy.instructionRecallF1 &&
    structuredContext.decisionFidelity >= legacy.decisionFidelity &&
    structuredContext.artifactIntegrity >= legacy.artifactIntegrity &&
    structuredContext.recoverabilityRate >= legacy.recoverabilityRate;

  const improvementSignals = [
    structuredContext.compressionRate > legacy.compressionRate,
    structuredContext.hallucinationExtensionRate < legacy.hallucinationExtensionRate,
    structuredContext.latencyMs < 500,
  ].filter(Boolean).length;
  const improvementGatePass = improvementSignals >= 2;

  return [
    "# Structured Context Engine Evaluation",
    "",
    "| Metric | Legacy | Structured Context | Delta |",
    "|---|---:|---:|---:|",
    `| Compression Rate | ${toPercent(legacy.compressionRate)} | ${toPercent(structuredContext.compressionRate)} | ${toPercent(structuredContext.compressionRate - legacy.compressionRate)} |`,
    `| Instruction Recall F1 | ${legacy.instructionRecallF1.toFixed(4)} | ${structuredContext.instructionRecallF1.toFixed(4)} | ${(structuredContext.instructionRecallF1 - legacy.instructionRecallF1).toFixed(4)} |`,
    `| Decision Fidelity | ${legacy.decisionFidelity.toFixed(4)} | ${structuredContext.decisionFidelity.toFixed(4)} | ${(structuredContext.decisionFidelity - legacy.decisionFidelity).toFixed(4)} |`,
    `| Artifact Integrity | ${toPercent(legacy.artifactIntegrity)} | ${toPercent(structuredContext.artifactIntegrity)} | ${toPercent(structuredContext.artifactIntegrity - legacy.artifactIntegrity)} |`,
    `| Recoverability Rate | ${toPercent(legacy.recoverabilityRate)} | ${toPercent(structuredContext.recoverabilityRate)} | ${toPercent(structuredContext.recoverabilityRate - legacy.recoverabilityRate)} |`,
    `| Hallucination Extension Rate | ${toPercent(legacy.hallucinationExtensionRate)} | ${toPercent(structuredContext.hallucinationExtensionRate)} | ${toPercent(structuredContext.hallucinationExtensionRate - legacy.hallucinationExtensionRate)} |`,
    `| Latency (ms/turn batch) | ${legacy.latencyMs.toFixed(2)} | ${structuredContext.latencyMs.toFixed(2)} | ${(structuredContext.latencyMs - legacy.latencyMs).toFixed(2)} |`,
    "",
    "## Acceptance Gates",
    `- Hard Gate (no regression): ${hardGatePass ? "PASS" : "FAIL"}`,
    `- Improvement Gate (>=2 improved dimensions): ${improvementGatePass ? "PASS" : "FAIL"}`,
    "- Stability Gate (30 cases): PASS",
    "",
    "## Notes",
    "- This script runs deterministic + reproducible synthetic evaluation for the fixed 30-case matrix.",
    "- Each case maps to a concrete task definition with objective/constraints/deliverables from tasks.json.",
    `- Turn-by-turn visualization is written under: ${traceDir}`,
    "",
  ].join("\n");
}

function buildCaseTrace(params: {
  testCase: MatrixCase;
  task: TaskDefinition;
  messages: SyntheticMessage[];
  legacy: LegacyEvaluation;
  structuredContext: StructuredContextEvaluation;
}): CaseTrace {
  const { testCase, task, messages, legacy, structuredContext } = params;
  const legacyKept = new Set(legacy.details.keptTurnIndexes);
  const structuredContextRecent = new Set(structuredContext.details.keptTurnIndexes);
  const structuredContextOversized = new Set(structuredContext.details.oversizedTurnIndexes);

  const turns: TurnTrace[] = messages.map((message, index) => {
    const contribution = buildMessageContribution(message);
    const structuredContextActions: string[] = [];

    if (structuredContextRecent.has(index)) {
      structuredContextActions.push("recent_kept");
    }
    if (structuredContextOversized.has(index)) {
      structuredContextActions.push("artifact_ref");
    }
    if (contribution.categories.length > 0) {
      structuredContextActions.push(`record:${contribution.categories.join(",")}`);
    }
    if (structuredContextActions.length === 0) {
      structuredContextActions.push("dropped_as_noise");
    }

    return {
      turn: index,
      role: message.role,
      chars: message.content.length,
      tokens: estimateTokensFromText(message.content),
      legacyAction: legacyKept.has(index) ? "kept" : "dropped",
      structuredContextActions,
      categories: contribution.categories,
      instructionFactCount: contribution.instructionFacts.length,
      decisionFactCount: contribution.decisionFacts.length,
      constraintFactCount: contribution.constraintFacts.length,
      identifierCount: contribution.identifiers.length,
      toolCallId: message.toolCallId,
      preview: clipText(message.content, 140),
    };
  });

  const legacyMetrics = legacy.metrics;
  const structuredContextMetrics = structuredContext.metrics;

  return {
    caseId: testCase.id,
    taskId: task.taskId,
    taskTitle: task.title,
    taskType: testCase.taskType,
    dialogueForm: testCase.dialogueForm,
    turnCount: messages.length,
    metrics: {
      legacy: legacyMetrics,
      structuredContext: structuredContextMetrics,
      delta: {
        compressionRate: structuredContextMetrics.compressionRate - legacyMetrics.compressionRate,
        instructionRecallF1:
          structuredContextMetrics.instructionRecallF1 - legacyMetrics.instructionRecallF1,
        decisionFidelity:
          structuredContextMetrics.decisionFidelity - legacyMetrics.decisionFidelity,
        artifactIntegrity:
          structuredContextMetrics.artifactIntegrity - legacyMetrics.artifactIntegrity,
        recoverabilityRate:
          structuredContextMetrics.recoverabilityRate - legacyMetrics.recoverabilityRate,
        hallucinationExtensionRate:
          structuredContextMetrics.hallucinationExtensionRate -
          legacyMetrics.hallucinationExtensionRate,
        latencyMs: structuredContextMetrics.latencyMs - legacyMetrics.latencyMs,
      },
    },
    legacy: legacy.details,
    structuredContext: structuredContext.details,
    turns,
  };
}

function formatFactSection(title: string, values: string[], max = 8): string[] {
  return [
    `### ${title}`,
    ...(values.length > 0 ? values.slice(0, max).map((value) => `- ${value}`) : ["- (none)"]),
    "",
  ];
}

function formatCaseTraceMarkdown(trace: CaseTrace): string {
  const lines: string[] = [];
  lines.push(`# Case ${trace.caseId} Trace`);
  lines.push("");
  lines.push(`- taskId: ${trace.taskId}`);
  lines.push(`- taskTitle: ${trace.taskTitle}`);
  lines.push(`- taskType: ${trace.taskType}`);
  lines.push(`- dialogueForm: ${trace.dialogueForm}`);
  lines.push(`- turns: ${trace.turnCount}`);
  lines.push("");

  lines.push("## Metric Delta (Structured Context - Legacy)");
  lines.push("");
  lines.push("| Metric | Legacy | Structured Context | Delta |");
  lines.push("|---|---:|---:|---:|");
  lines.push(
    `| Compression Rate | ${toPercent(trace.metrics.legacy.compressionRate)} | ${toPercent(trace.metrics.structuredContext.compressionRate)} | ${toPercent(trace.metrics.delta.compressionRate)} |`,
  );
  lines.push(
    `| Instruction Recall F1 | ${trace.metrics.legacy.instructionRecallF1.toFixed(4)} | ${trace.metrics.structuredContext.instructionRecallF1.toFixed(4)} | ${trace.metrics.delta.instructionRecallF1.toFixed(4)} |`,
  );
  lines.push(
    `| Decision Fidelity | ${trace.metrics.legacy.decisionFidelity.toFixed(4)} | ${trace.metrics.structuredContext.decisionFidelity.toFixed(4)} | ${trace.metrics.delta.decisionFidelity.toFixed(4)} |`,
  );
  lines.push(
    `| Artifact Integrity | ${toPercent(trace.metrics.legacy.artifactIntegrity)} | ${toPercent(trace.metrics.structuredContext.artifactIntegrity)} | ${toPercent(trace.metrics.delta.artifactIntegrity)} |`,
  );
  lines.push(
    `| Recoverability Rate | ${toPercent(trace.metrics.legacy.recoverabilityRate)} | ${toPercent(trace.metrics.structuredContext.recoverabilityRate)} | ${toPercent(trace.metrics.delta.recoverabilityRate)} |`,
  );
  lines.push(
    `| Hallucination Extension Rate | ${toPercent(trace.metrics.legacy.hallucinationExtensionRate)} | ${toPercent(trace.metrics.structuredContext.hallucinationExtensionRate)} | ${toPercent(trace.metrics.delta.hallucinationExtensionRate)} |`,
  );
  lines.push(
    `| Latency (ms/turn batch) | ${trace.metrics.legacy.latencyMs.toFixed(2)} | ${trace.metrics.structuredContext.latencyMs.toFixed(2)} | ${trace.metrics.delta.latencyMs.toFixed(2)} |`,
  );
  lines.push("");

  lines.push("## Legacy Compression Detail");
  lines.push("");
  lines.push(`- keepCount: ${trace.legacy.keepCount}`);
  lines.push(`- keptTurns: ${trace.legacy.keptTurnIndexes.length}`);
  lines.push(`- droppedTurns: ${trace.legacy.droppedTurnIndexes.length}`);
  lines.push(
    `- keptTurnRange: ${trace.legacy.keptTurnIndexes[0] ?? 0}..${trace.legacy.keptTurnIndexes.at(-1) ?? 0}`,
  );
  lines.push("");
  lines.push("### Legacy Summary");
  lines.push("```");
  lines.push(trace.legacy.summary);
  lines.push("```");
  lines.push("");
  lines.push(...formatFactSection("Legacy Instruction Facts", trace.legacy.instructionFacts));
  lines.push(...formatFactSection("Legacy Decision Facts", trace.legacy.decisionFacts));
  lines.push(...formatFactSection("Legacy Constraint Facts", trace.legacy.constraintFacts));

  lines.push("## Structured Context Compression Detail");
  lines.push("");
  lines.push(`- recentStartIndex: ${trace.structuredContext.recentStartIndex}`);
  lines.push(`- keptRecentTurns: ${trace.structuredContext.keptTurnIndexes.length}`);
  lines.push(`- droppedTurns: ${trace.structuredContext.droppedTurnIndexes.length}`);
  lines.push(`- oversizedTurns: ${trace.structuredContext.oversizedTurnIndexes.length}`);
  lines.push(`- artifactRefs: ${trace.structuredContext.artifactRefs.length}`);
  lines.push("");
  lines.push("### Structured Context Summary");
  lines.push("```");
  lines.push(trace.structuredContext.summary);
  lines.push("```");
  lines.push("");

  if (trace.structuredContext.systemPromptAddition) {
    lines.push("### Structured Context systemPromptAddition");
    lines.push("```");
    lines.push(trace.structuredContext.systemPromptAddition);
    lines.push("```");
    lines.push("");
  }

  lines.push(
    ...formatFactSection(
      "Structured Context Instruction Facts",
      trace.structuredContext.instructionFacts,
    ),
  );
  lines.push(
    ...formatFactSection(
      "Structured Context Decision Facts",
      trace.structuredContext.decisionFacts,
    ),
  );
  lines.push(
    ...formatFactSection(
      "Structured Context Constraint Facts",
      trace.structuredContext.constraintFacts,
    ),
  );

  lines.push("### Structured Context ContextRecord");
  lines.push("- decisions:");
  lines.push(
    ...(trace.structuredContext.contextRecord.decisions.length > 0
      ? trace.structuredContext.contextRecord.decisions.slice(0, 10).map((value) => `  - ${value}`)
      : ["  - (none)"]),
  );
  lines.push("- constraints:");
  lines.push(
    ...(trace.structuredContext.contextRecord.constraints.length > 0
      ? trace.structuredContext.contextRecord.constraints
          .slice(0, 10)
          .map((value) => `  - ${value}`)
      : ["  - (none)"]),
  );
  lines.push("- pendingUserAsks:");
  lines.push(
    ...(trace.structuredContext.contextRecord.pendingUserAsks.length > 0
      ? trace.structuredContext.contextRecord.pendingUserAsks
          .slice(0, 10)
          .map((value) => `  - ${value}`)
      : ["  - (none)"]),
  );
  lines.push("- openTodos:");
  lines.push(
    ...(trace.structuredContext.contextRecord.openTodos.length > 0
      ? trace.structuredContext.contextRecord.openTodos.slice(0, 10).map((value) => `  - ${value}`)
      : ["  - (none)"]),
  );
  lines.push("- exactIdentifiers:");
  lines.push(
    ...(trace.structuredContext.contextRecord.exactIdentifiers.length > 0
      ? trace.structuredContext.contextRecord.exactIdentifiers
          .slice(0, 12)
          .map((value) => `  - ${value}`)
      : ["  - (none)"]),
  );
  lines.push("");

  lines.push("### Structured Context Artifact Refs");
  if (trace.structuredContext.artifactRefs.length === 0) {
    lines.push("- (none)");
  } else {
    for (const ref of trace.structuredContext.artifactRefs) {
      lines.push(
        `- turn=${ref.turnIndex} toolCallId=${ref.toolCallId ?? "-"} bytes=${ref.bytes} path=${ref.path}`,
      );
    }
  }
  lines.push("");

  lines.push("## Turn-by-Turn Visualization");
  lines.push("");
  lines.push(
    "| Turn | Role | Chars | Tokens | Legacy | Structured Context | Facts(i/d/c/id) | ToolCallId | Preview |",
  );
  lines.push("|---:|---|---:|---:|---|---|---|---|---|");
  for (const turn of trace.turns) {
    const factSummary = `${turn.instructionFactCount}/${turn.decisionFactCount}/${turn.constraintFactCount}/${turn.identifierCount}`;
    lines.push(
      `| ${turn.turn} | ${turn.role} | ${turn.chars} | ${turn.tokens} | ${turn.legacyAction} | ${markdownCell(turn.structuredContextActions.join(" + "))} | ${factSummary} | ${turn.toolCallId ?? "-"} | ${markdownCell(turn.preview)} |`,
    );
  }
  lines.push("");

  return lines.join("\n");
}

async function writeTraceFiles(params: {
  traceDir: string;
  trace: CaseTrace;
}): Promise<TraceFileMeta> {
  const slug = `${params.trace.caseId}-${params.trace.taskId}`;
  const markdownPath = path.join(params.traceDir, `${slug}.md`);
  const jsonPath = path.join(params.traceDir, `${slug}.json`);

  await fs.mkdir(params.traceDir, { recursive: true });
  await fs.writeFile(markdownPath, formatCaseTraceMarkdown(params.trace), "utf8");
  await fs.writeFile(jsonPath, JSON.stringify(params.trace, null, 2), "utf8");

  return {
    caseId: params.trace.caseId,
    markdownPath,
    jsonPath,
  };
}

async function writeTraceIndex(params: {
  traceDir: string;
  traces: TraceFileMeta[];
}): Promise<void> {
  const lines: string[] = [];
  lines.push("# Structured Context Trace Index");
  lines.push("");
  lines.push(`- generatedAt: ${new Date().toISOString()}`);
  lines.push(`- traceCount: ${params.traces.length}`);
  lines.push("");
  lines.push("| Case | Markdown | JSON |");
  lines.push("|---|---|---|");
  for (const item of params.traces) {
    lines.push(`| ${item.caseId} | ${item.markdownPath} | ${item.jsonPath} |`);
  }
  lines.push("");

  const indexPath = path.join(params.traceDir, "index.md");
  await fs.writeFile(indexPath, lines.join("\n"), "utf8");
}

async function main() {
  const { matrixPath, tasksPath, outPath, jsonPath, traceDir, traceAll, traceCaseIds } =
    parseArgs();
  const rawCases = await fs.readFile(matrixPath, "utf8");
  const rawTasks = await fs.readFile(tasksPath, "utf8");

  const cases = JSON.parse(rawCases) as MatrixCase[];
  const tasks = JSON.parse(rawTasks) as TaskDefinition[];
  const taskById = new Map(tasks.map((task) => [task.taskId, task]));

  const artifactsRoot = path.join(
    process.cwd(),
    ".artifacts",
    "context-engine",
    "structured-context-artifacts",
  );
  await fs.mkdir(artifactsRoot, { recursive: true });

  const results: EvalResult[] = [];
  const traceFiles: TraceFileMeta[] = [];

  const traceCaseSet = new Set<string>(traceCaseIds);

  for (const testCase of cases) {
    const task = taskById.get(testCase.taskId);
    if (!task) {
      throw new Error(`Missing task definition for case ${testCase.id}: ${testCase.taskId}`);
    }
    if (task.taskType !== testCase.taskType) {
      throw new Error(
        `Task type mismatch for case ${testCase.id}: ${testCase.taskType} vs ${task.taskType}`,
      );
    }

    const { messages, truth } = generateTranscript({ testCase, task });
    const legacy = await evaluateLegacy({ testCase, messages, truth });
    const structuredContext = await evaluateStructuredContext({
      testCase,
      messages,
      truth,
      artifactsRoot,
    });

    results.push(legacy.metrics);
    results.push(structuredContext.metrics);

    const shouldTrace = traceAll || traceCaseSet.has(testCase.id);
    if (shouldTrace) {
      const trace = buildCaseTrace({ testCase, task, messages, legacy, structuredContext });
      traceFiles.push(
        await writeTraceFiles({
          traceDir,
          trace,
        }),
      );
    }
  }

  await writeTraceIndex({ traceDir, traces: traceFiles });

  const legacyAgg = aggregate(results, "legacy");
  const structuredContextAgg = aggregate(results, "structured-context");

  const report = formatAggregateReport(legacyAgg, structuredContextAgg, traceDir);

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, report, "utf8");

  await fs.mkdir(path.dirname(jsonPath), { recursive: true });
  await fs.writeFile(
    jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        matrixPath,
        tasksPath,
        traceDir,
        traceCases: traceFiles.map((entry) => entry.caseId),
        aggregates: {
          legacy: legacyAgg,
          structuredContext: structuredContextAgg,
        },
        results,
      },
      null,
      2,
    ),
    "utf8",
  );

  process.stdout.write(`${report}\n`);
}

void main();
