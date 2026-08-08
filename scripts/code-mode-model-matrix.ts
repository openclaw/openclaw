#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  isCloudModelRef,
  parseModelCatalogRef,
} from "@openclaw/model-catalog-core/model-catalog-refs";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import JSON5 from "json5";
import {
  buildScriptEvidenceSummary,
  QA_EVIDENCE_FILENAME,
  validateQaEvidenceSummaryJson,
  type QaEvidenceStatus,
  type QaEvidenceSummaryJson,
} from "../extensions/qa-lab/api.js";
import { resolveDefaultAgentDir, resolveDefaultAgentId } from "../src/agents/agent-scope-config.js";
import { resolveAgentEffectiveModelPrimary } from "../src/agents/agent-scope.js";
import { ensureAuthProfileStoreWithoutExternalProfiles } from "../src/agents/auth-profiles.js";
import type { ApiKeyCredential } from "../src/agents/auth-profiles.js";
import {
  computeFrontierEvidenceDigest,
  deriveFrontierEvidencePromptCacheKey,
} from "../src/agents/frontier-evidence-policy.js";
import { hasAuthoredProviderRequestParams } from "../src/agents/model-extra-params.js";
import { isLocalProviderBaseUrl } from "../src/agents/model-provider-local.js";
import { splitTrailingAuthProfile } from "../src/agents/model-ref-profile.js";
import { resolveModelRuntimePolicy } from "../src/agents/model-runtime-policy.js";
import { resolveConfiguredModelFallbacks } from "../src/agents/model-selection-resolve.js";
import type { AgentExecEnvelope } from "../src/commands/agent-exec.ts";
import { createConfigIO } from "../src/config/io.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { isSecretRef, isValidEnvSecretRefId } from "../src/config/types.secrets.js";
import { isValidSecretRef } from "../src/secrets/ref-contract.js";
import {
  isFrontierCodeModeCapabilityReceipt,
  isFrontierQualificationCandidateModel,
  resolveFrontierModelQualification,
  type FrontierCodeModeCapabilityReceipt,
} from "./lib/code-mode-frontier-model-qualification.js";
import {
  runCodeModeMatrixConversationProof,
  validateCodeModeConversationProofSummary,
  type CodeModeConversationProofPolicy,
} from "./lib/code-mode-model-matrix-conversation-proof.js";
import { previewForDevToolLog, redactJsonValueForDevToolLog } from "./lib/dev-tooling-safety.ts";

export { validateQaEvidenceSummaryJson };

const execFileAsync = promisify(execFile);
const SOURCE_PATH = "scripts/code-mode-model-matrix.ts";
const MATRIX_SCHEMA_VERSION = 4;
const DEFAULT_REPETITIONS = 2;
const DEFAULT_TIMEOUT_SECONDS = 180;
const MAX_REPETITIONS = 10;
const MAX_DIAGNOSTIC_CHARS = 8_000;
export type CodeModeMatrixMode = "direct" | "auto" | "code";
export type CodeModeMatrixTask = "read" | "dependent-read-write";

export type CodeModeMatrixOptions = {
  allowFailures: boolean;
  conversationProof: boolean;
  dryRun: boolean;
  keepState: boolean;
  models: string[];
  modes: CodeModeMatrixMode[];
  config?: string;
  outputDir?: string;
  repetitions: number;
  repoRoot: string;
  tasks: CodeModeMatrixTask[];
  thinking: string;
  timeoutSeconds: number;
};

type MatrixCell = {
  id: string;
  mode: CodeModeMatrixMode;
  model: string;
  repetition: number;
  task: CodeModeMatrixTask;
};

type MatrixTaskFixture = {
  expected: string;
  fixtureSha256: string;
  prompt: string;
  promptSha256: string;
  resultPath?: string;
  workspaceIdentitySha256: string;
  workspaceSeedSha256: string;
};

type MatrixConversationProofSummary = Record<string, unknown> & {
  betaGateRole?: string;
  behaviorGateValidated?: boolean;
  blockedReasons?: string[];
  cells?: Array<Record<string, unknown> & { elapsedMs?: number }>;
  counts?: { failed: number; passed: number; total: number };
  distinctSessionIds?: boolean;
  evidenceClass?: string;
  failureCode?: string;
  gitSha?: string;
  observedStatus?: "blocked" | "fail" | "pass";
  schemaVersion?: number;
  status: "blocked" | "fail" | "pass";
};

type MatrixEvidenceClass = "diagnostic_only" | "frontier_beta_qualification";

type MatrixQualification = {
  state: "diagnostic_only" | "not_eligible" | "ready_for_frozen_benchmark";
  betaRecommendation: "not_eligible";
  reason:
    | "abba_incomplete"
    | "beta_gate_blocked"
    | "beta_gate_inconclusive"
    | "conversation_proof_not_requested"
    | "conversation_proof_not_completed"
    | "code_mode_activation_unattested"
    | "code_mode_capability_unattested"
    | "frontier_receipts_invalid"
    | "unsupported_frontier_model"
    | "requires_frozen_representative_benchmark";
  blockingBars?: string[];
};

function matrixEvidenceClass(conversationProof: boolean): MatrixEvidenceClass {
  return conversationProof ? "frontier_beta_qualification" : "diagnostic_only";
}

function matrixQualification(params: {
  betaGate?: ReturnType<typeof buildCodeModeMatrixBetaGate>;
  conversationProof: boolean;
  conversationProofAttested?: boolean;
  conversationProofStatus?: MatrixConversationProofSummary["status"];
  codeModeActivationAttested?: boolean;
  codeModeCapabilityAttested?: boolean;
  expectedCells?: number;
  frontierEvidenceValid?: boolean;
  model: string;
  resultsExecuted?: number;
}): MatrixQualification {
  if (!params.conversationProof) {
    return {
      state: "diagnostic_only",
      betaRecommendation: "not_eligible",
      reason: "conversation_proof_not_requested",
    };
  }
  if (!isFrontierQualificationCandidateModel(params.model)) {
    return {
      state: "not_eligible",
      betaRecommendation: "not_eligible",
      reason: "unsupported_frontier_model",
    };
  }
  if (params.codeModeCapabilityAttested !== true) {
    return {
      state: "not_eligible",
      betaRecommendation: "not_eligible",
      reason: "code_mode_capability_unattested",
    };
  }
  if (
    params.expectedCells !== undefined &&
    params.resultsExecuted !== undefined &&
    params.resultsExecuted !== params.expectedCells
  ) {
    return {
      state: "not_eligible",
      betaRecommendation: "not_eligible",
      reason: "abba_incomplete",
    };
  }
  if (params.frontierEvidenceValid === false) {
    return {
      state: "not_eligible",
      betaRecommendation: "not_eligible",
      reason: "frontier_receipts_invalid",
    };
  }
  if (params.betaGate && params.betaGate.state !== "diagnostic_pass") {
    const blockingBars = Object.entries(params.betaGate.bars)
      .filter(([, state]) => state !== "pass")
      .map(([bar, state]) => `${bar}:${state}`)
      .toSorted();
    return {
      state: "not_eligible",
      betaRecommendation: "not_eligible",
      reason: params.betaGate.state === "blocked" ? "beta_gate_blocked" : "beta_gate_inconclusive",
      blockingBars,
    };
  }
  if (params.conversationProofStatus === "pass" && params.conversationProofAttested === true) {
    if (params.codeModeActivationAttested !== true) {
      return {
        state: "not_eligible",
        betaRecommendation: "not_eligible",
        reason: "code_mode_activation_unattested",
      };
    }
    return {
      state: "ready_for_frozen_benchmark",
      betaRecommendation: "not_eligible",
      reason: "requires_frozen_representative_benchmark",
    };
  }
  return {
    state: "not_eligible",
    betaRecommendation: "not_eligible",
    reason: "conversation_proof_not_completed",
  };
}

function isAttestedPassingConversationProof(
  summary: MatrixConversationProofSummary | undefined,
  expected: {
    buildSha256: string;
    configSha256: string;
    executionPolicy: MatrixExecutionPolicy;
    gitSha: string;
    model: string;
  },
): boolean {
  return (
    summary?.behaviorGateValidated === true &&
    validateCodeModeConversationProofSummary(summary, expected).valid
  );
}

type MatrixRuntimeEntrypoint = {
  args: string[];
  cwd: string;
};

type CellFailureCategory =
  | "activation"
  | "agent_error"
  | "answer_mismatch"
  | "effect_mismatch"
  | "harness_error"
  | "model_mismatch"
  | "proof_drift"
  | "provider_auth"
  | "provider_billing"
  | "provider_model_access"
  | "provider_transport"
  | "timeout"
  | "tool_execution";

export type CodeModeMatrixCellResult = {
  assistantTurns?: number;
  bridgeCalls?: AgentExecEnvelope["bridgeCalls"];
  buildSha256: string;
  codeModeEngaged: boolean | null;
  firstLogicalCallCacheStatus: MatrixCacheStatus;
  configSha256: string | null;
  costUsd?: number;
  diagnostics?: string;
  elapsedMs: number;
  evidenceClass?: MatrixEvidenceClass;
  wallLatencyMs?: number;
  wallLatencyMeasurement?: "matrix_monotonic_elapsed";
  error?: AgentExecEnvelope["error"];
  expected: string;
  failureCategory: CellFailureCategory | null;
  final: string;
  frontierEvidence?: AgentExecEnvelope["frontierEvidence"];
  fixtureSha256: string;
  gitSha: string;
  id: string;
  mode: CodeModeMatrixMode;
  model: string;
  observedModel: string | null;
  observedProvider: string | null;
  oracle: {
    answer: boolean;
    effect: boolean;
    engagement: boolean;
    identity: boolean;
    toolExecution: boolean;
  };
  passed: boolean;
  promptSha256: string;
  repetition: number;
  sourceDirty: boolean;
  sourcePatchSha256: string | null;
  status: AgentExecEnvelope["status"];
  task: CodeModeMatrixTask;
  timestamp: string;
  toolSummary?: AgentExecEnvelope["toolSummary"];
  trace?: AgentExecEnvelope["trace"];
  usage?: AgentExecEnvelope["usage"];
  workspaceIdentitySha256?: string;
  workspaceSeedSha256?: string;
};

export type MatrixCacheStatus = "cold" | "warm" | "unknown";
type BetaGateBar = "pass" | "fail" | "unknown";

type RunCellParams = {
  buildSha256: string;
  campaignRoot: string;
  cell: MatrixCell;
  config?: unknown;
  configPath?: string;
  configSha256: string | null;
  frozenEnv: NodeJS.ProcessEnv;
  gitSha: string;
  keepState: boolean;
  outputDir: string;
  repoRoot: string;
  runtime?: MatrixRuntimeEntrypoint;
  frontierEvidencePolicy?: {
    path: string;
    sha256: string;
  };
  frontierEvidenceRunNonce?: string;
  sourceDirty: boolean;
  sourcePatchSha256: string | null;
  thinking: string;
  timeoutSeconds: number;
};

type MatrixRunDependencies = {
  buildCliArtifacts?: (repoRoot: string) => Promise<void>;
  now?: () => Date;
  nowMs?: () => number;
  readBuildSha256?: (repoRoot: string) => Promise<string>;
  readGitSha?: (repoRoot: string) => Promise<string>;
  readPolicySha256?: (policyPath: string) => Promise<string>;
  readSourceIdentity?: (repoRoot: string) => Promise<SourceIdentity>;
  readAuthProfile?: (params: {
    config: unknown;
    profileId: string;
    provider: string;
  }) => Promise<MatrixAuthProfileObservation>;
  runCell?: (params: RunCellParams) => Promise<CodeModeMatrixCellResult>;
  runConversationProof?: (
    params: Parameters<typeof runCodeModeMatrixConversationProof>[0],
  ) => Promise<MatrixConversationProofSummary>;
};

type SourceIdentity = {
  gitSha: string;
  sourceDirty: boolean;
  sourcePatchSha256: string | null;
};

async function auditFrozenMatrixIdentity(params: {
  expected: {
    buildSha256: string;
    configSha256: string | null;
    policySha256: string;
    source: SourceIdentity;
  };
  readBuildSha256: () => Promise<string>;
  readConfigSha256: () => Promise<string | null>;
  readPolicySha256: () => Promise<string>;
  readSourceIdentity: () => Promise<SourceIdentity>;
}): Promise<string[]> {
  const reasons = new Set<string>();
  const [source, config, build, policy] = await Promise.allSettled([
    params.readSourceIdentity(),
    params.readConfigSha256(),
    params.readBuildSha256(),
    params.readPolicySha256(),
  ]);
  if (
    source.status === "fulfilled" &&
    (source.value.gitSha !== params.expected.source.gitSha ||
      source.value.sourceDirty !== params.expected.source.sourceDirty ||
      source.value.sourcePatchSha256 !== params.expected.source.sourcePatchSha256)
  ) {
    reasons.add("source_mismatch");
  }
  if (config.status === "fulfilled" && config.value !== params.expected.configSha256) {
    reasons.add("config_mismatch");
  }
  if (build.status === "fulfilled" && build.value !== params.expected.buildSha256) {
    reasons.add("build_mismatch");
  }
  if (policy.status === "fulfilled" && policy.value !== params.expected.policySha256) {
    reasons.add("policy_mismatch");
  }
  if ([source, config, build, policy].some((result) => result.status === "rejected")) {
    reasons.add("identity_recheck_failed");
  }
  return [...reasons].toSorted();
}

type PinnedConfigSnapshot = {
  effective: OpenClawConfig | undefined;
  parsed: unknown;
  sha256: string | null;
};

type MatrixAuthProfileObservation = {
  credentialEnvName?: string;
  credentialValue?: string;
  mode?: ApiKeyCredential["type"];
  present: boolean;
  provider?: string;
};

type MatrixExecutionPolicy = CodeModeConversationProofPolicy;
type PublicMatrixExecutionPolicy = Omit<MatrixExecutionPolicy, "defaultAgentId"> & {
  defaultAgentIdSha256: string;
};

type MatrixPreflight = {
  blockedReasons: string[];
  credentialValue?: string;
  executionPolicy?: MatrixExecutionPolicy;
};

function publicMatrixExecutionPolicy(policy: MatrixExecutionPolicy): PublicMatrixExecutionPolicy {
  const { defaultAgentId, ...publicPolicy } = policy;
  return {
    ...publicPolicy,
    defaultAgentIdSha256: createHash("sha256").update(defaultAgentId).digest("hex"),
  };
}

const LOCAL_MODEL_PROVIDER_IDS = new Set([
  "lmstudio",
  "local",
  "mlx",
  "ollama",
  "omlx-local",
  "vllm",
]);
const LOCAL_PROVIDER_HOST_ALIASES = new Set([
  "docker.orb.internal",
  "host.docker.internal",
  "host.orb.internal",
]);

function usage() {
  return `Usage: pnpm qa:code-mode-models -- --model <provider/model> [options]

Runs repeated Code Mode acceptance cells through the normal embedded agent path.

Options:
  --model <provider/model>  Assertion for the one configured frontier model
  --config <path>           Pin one self-contained config file for auditable runs
  --mode <mode>             direct | auto | code; repeat to select modes
  --task <task>             read | dependent-read-write; repeat to select tasks
  --repetitions <n>         Runs per model/mode/task cell (default: ${DEFAULT_REPETITIONS}, max: ${MAX_REPETITIONS})
  --timeout <seconds>       Per-run agent deadline (default: ${DEFAULT_TIMEOUT_SECONDS})
  --thinking <level>        Agent thinking level (default: off; frontier evidence requires high)
  --output-dir <path>       Repo-relative artifact directory
  --keep-state              Retain per-cell state and workspace directories
  --allow-failures          Exit zero after writing evidence even when cells fail
  --dry-run                 Write the manifest without calling models
  --conversation-proof      Run three real OpenAI model cells on isolated QA Gateways/channels
  -h, --help                Show this help

The frozen config selects one model@profile. Credential values are never written to artifacts.
`;
}

function readOptionValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseIntegerOption(raw: string, flag: string, max?: number): number {
  if (!/^\d+$/u.test(raw)) {
    throw new Error(`${flag} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || (max !== undefined && value > max)) {
    const suffix = max === undefined ? "" : ` from 1 to ${max}`;
    throw new Error(`${flag} must be an integer${suffix}`);
  }
  return value;
}

function collectUnique<T extends string>(values: T[], value: T, flag: string): void {
  if (values.includes(value)) {
    throw new Error(`Duplicate ${flag} value: ${value}`);
  }
  values.push(value);
}

function parseMode(raw: string): CodeModeMatrixMode {
  if (raw === "direct" || raw === "auto" || raw === "code") {
    return raw;
  }
  throw new Error(`--mode must be one of direct, auto, code; got ${JSON.stringify(raw)}`);
}

function parseTask(raw: string): CodeModeMatrixTask {
  if (raw === "read" || raw === "dependent-read-write") {
    return raw;
  }
  throw new Error(`--task must be one of read, dependent-read-write; got ${JSON.stringify(raw)}`);
}

export function parseCodeModeMatrixOptions(
  argv: readonly string[],
  cwd = process.cwd(),
): CodeModeMatrixOptions {
  const models: string[] = [];
  const modes: CodeModeMatrixMode[] = [];
  const tasks: CodeModeMatrixTask[] = [];
  let allowFailures = false;
  let conversationProof = false;
  let dryRun = false;
  let keepState = false;
  let config: string | undefined;
  let outputDir: string | undefined;
  let repetitions = DEFAULT_REPETITIONS;
  let thinking = "off";
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  const seen = new Set<string>();
  const recordOnce = (flag: string) => {
    if (seen.has(flag)) {
      throw new Error(`${flag} was provided more than once`);
    }
    seen.add(flag);
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--model") {
      const value = readOptionValue(argv, index, arg).trim();
      if (!value.includes("/")) {
        throw new Error(
          `--model must use a provider/model reference; got ${JSON.stringify(value)}`,
        );
      }
      collectUnique(models, value, arg);
      index += 1;
      continue;
    }
    if (arg === "--mode") {
      collectUnique(modes, parseMode(readOptionValue(argv, index, arg)), arg);
      index += 1;
      continue;
    }
    if (arg === "--config") {
      recordOnce(arg);
      config = path.resolve(cwd, readOptionValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--task") {
      collectUnique(tasks, parseTask(readOptionValue(argv, index, arg)), arg);
      index += 1;
      continue;
    }
    if (arg === "--repetitions") {
      recordOnce(arg);
      repetitions = parseIntegerOption(readOptionValue(argv, index, arg), arg, MAX_REPETITIONS);
      index += 1;
      continue;
    }
    if (arg === "--timeout") {
      recordOnce(arg);
      timeoutSeconds = parseIntegerOption(readOptionValue(argv, index, arg), arg);
      index += 1;
      continue;
    }
    if (arg === "--thinking") {
      recordOnce(arg);
      thinking = readOptionValue(argv, index, arg).trim();
      index += 1;
      continue;
    }
    if (arg === "--output-dir") {
      recordOnce(arg);
      outputDir = readOptionValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--allow-failures") {
      recordOnce(arg);
      allowFailures = true;
      continue;
    }
    if (arg === "--keep-state") {
      recordOnce(arg);
      keepState = true;
      continue;
    }
    if (arg === "--dry-run") {
      recordOnce(arg);
      dryRun = true;
      continue;
    }
    if (arg === "--conversation-proof") {
      recordOnce(arg);
      conversationProof = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw Object.assign(new Error(usage()), { code: "HELP" });
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (models.length !== 1) {
    throw new Error("Exactly one --model <provider/model> is required");
  }
  return {
    allowFailures,
    config,
    conversationProof,
    dryRun,
    keepState,
    models,
    modes: modes.length > 0 ? modes : ["direct", "code"],
    outputDir,
    repetitions,
    repoRoot: path.resolve(cwd),
    tasks: tasks.length > 0 ? tasks : ["read", "dependent-read-write"],
    thinking,
    timeoutSeconds,
  };
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

function defaultOutputDir(now: Date): string {
  return path.join(
    ".artifacts",
    "qa-e2e",
    "code-mode-model-matrix",
    now.toISOString().replaceAll(":", "-"),
  );
}

export function resolveCodeModeMatrixOutputDir(
  repoRoot: string,
  configured: string | undefined,
  now = new Date(),
): string {
  const raw = configured?.trim() || defaultOutputDir(now);
  if (path.isAbsolute(raw)) {
    throw new Error("--output-dir must be repo-relative");
  }
  const resolvedRoot = path.resolve(repoRoot);
  const resolved = path.resolve(resolvedRoot, raw);
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("--output-dir must stay within the repository");
  }
  return resolved;
}

function pathsOverlap(left: string, right: string, caseInsensitive: boolean): boolean {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return caseInsensitive ? resolved.toLowerCase() : resolved;
  };
  const resolvedLeft = normalize(left);
  const resolvedRight = normalize(right);
  return (
    resolvedLeft === resolvedRight ||
    resolvedLeft.startsWith(`${resolvedRight}${path.sep}`) ||
    resolvedRight.startsWith(`${resolvedLeft}${path.sep}`)
  );
}

async function filesystemUsesCaseInsensitivePaths(repoRoot: string): Promise<boolean> {
  const canonicalRoot = await fs.realpath(repoRoot);
  const rootName = path.basename(canonicalRoot);
  const letterIndex = rootName.search(/[a-z]/iu);
  if (letterIndex < 0) {
    return process.platform === "win32";
  }
  const letter = rootName[letterIndex] ?? "";
  const alternateLetter =
    letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase();
  const alternateRoot = path.join(
    path.dirname(canonicalRoot),
    `${rootName.slice(0, letterIndex)}${alternateLetter}${rootName.slice(letterIndex + 1)}`,
  );
  return await fs.realpath(alternateRoot).then(
    (resolved) => resolved === canonicalRoot,
    () => false,
  );
}

async function canonicalizeExistingPathPrefix(value: string): Promise<string> {
  let current = path.resolve(value);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...missingSegments.toReversed());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw error;
      }
      missingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

async function runtimeArtifactDirectories(repoRoot: string, outputDir: string): Promise<string[]> {
  const packagesRoot = path.join(repoRoot, "packages");
  const packageEntries = await fs
    .readdir(packagesRoot, { withFileTypes: true })
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    });
  const artifacts = [
    path.join(repoRoot, "dist"),
    ...packageEntries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(packagesRoot, entry.name, "dist")),
  ];
  const outputSegments = path
    .relative(path.resolve(repoRoot), path.resolve(outputDir))
    .split(path.sep);
  const outputPackage = outputSegments[0]?.toLowerCase() === "packages" && outputSegments[1];
  if (outputPackage) {
    artifacts.push(path.join(packagesRoot, outputPackage, "dist"));
  }
  return artifacts;
}

async function assertOutputOutsideRuntimeArtifacts(
  repoRoot: string,
  outputDir: string,
): Promise<void> {
  const caseInsensitive = await filesystemUsesCaseInsensitivePaths(repoRoot);
  const canonicalOutput = await canonicalizeExistingPathPrefix(outputDir);
  for (const artifactDir of await runtimeArtifactDirectories(repoRoot, outputDir)) {
    const canonicalArtifact = await canonicalizeExistingPathPrefix(artifactDir);
    if (pathsOverlap(canonicalOutput, canonicalArtifact, caseInsensitive)) {
      throw new Error(
        `--output-dir must not overlap runtime artifacts: ${path.relative(repoRoot, artifactDir)}`,
      );
    }
  }
}

async function assertOutputOutsideGitMetadata(repoRoot: string, outputDir: string): Promise<void> {
  const gitDirectories = [path.join(repoRoot, ".git")];
  const discovered = await execFileAsync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  ).catch(() => null);
  if (discovered) {
    gitDirectories.push(
      ...discovered.stdout
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .filter(Boolean),
    );
  }

  const caseInsensitive = await filesystemUsesCaseInsensitivePaths(repoRoot);
  const canonicalOutput = await canonicalizeExistingPathPrefix(outputDir);
  for (const gitDirectory of new Set(gitDirectories)) {
    const canonicalGitDirectory = await canonicalizeExistingPathPrefix(gitDirectory);
    if (pathsOverlap(canonicalOutput, canonicalGitDirectory, caseInsensitive)) {
      throw new Error("--output-dir must not overlap Git metadata");
    }
  }
}

export async function reserveCodeModeMatrixOutputDir(
  repoRoot: string,
  outputDir: string,
): Promise<void> {
  const resolvedRoot = path.resolve(repoRoot);
  const resolvedOutput = path.resolve(outputDir);
  const relative = path.relative(resolvedRoot, resolvedOutput);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("--output-dir must stay within the repository");
  }
  let current = resolvedRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    for (;;) {
      try {
        const stats = await fs.lstat(current);
        if (stats.isSymbolicLink()) {
          throw new Error(`--output-dir must not traverse symlinks: ${relative}`);
        }
        if (current === resolvedOutput) {
          throw new Error(`--output-dir must not already exist: ${relative}`);
        }
        if (!stats.isDirectory()) {
          throw new Error(
            `--output-dir parent must be a directory: ${path.relative(repoRoot, current)}`,
          );
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        try {
          await fs.mkdir(current);
          break;
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
            throw mkdirError;
          }
          // A concurrent creator won the race. Inspect its path before proceeding.
        }
      }
    }
  }
}

export function buildCodeModeMatrixCells(options: CodeModeMatrixOptions): MatrixCell[] {
  if (
    options.modes.length === 2 &&
    options.modes[0] === "direct" &&
    options.modes[1] === "code" &&
    options.repetitions % 2 === 0
  ) {
    return options.models.flatMap((model) =>
      options.tasks.flatMap((task) =>
        Array.from({ length: options.repetitions / 2 }, (_, pairIndex) => {
          const first = pairIndex * 2 + 1;
          const second = first + 1;
          return [
            { mode: "direct" as const, repetition: first },
            { mode: "code" as const, repetition: first },
            { mode: "code" as const, repetition: second },
            { mode: "direct" as const, repetition: second },
          ].map(({ mode, repetition }) => ({
            id: `${modelCellPrefix(model)}-${mode}-${task}-${repetition}`,
            mode,
            model,
            repetition,
            task,
          }));
        }).flat(),
      ),
    );
  }
  return options.models.flatMap((model) =>
    options.tasks.flatMap((task) =>
      Array.from({ length: options.repetitions }, (_, index) => {
        const repetition = index + 1;
        const modes = repetition % 2 === 1 ? options.modes : options.modes.toReversed();
        return modes.map((mode) => {
          return {
            id: `${modelCellPrefix(model)}-${mode}-${task}-${repetition}`,
            mode,
            model,
            repetition,
            task,
          };
        });
      }).flat(),
    ),
  );
}

export function modelCellPrefix(model: string): string {
  const modelHash = createHash("sha256").update(model).digest("hex").slice(0, 10);
  return `${slug(model)}-${modelHash}`;
}

function verificationCode(cell: MatrixCell): string {
  return `CM-${createHash("sha256")
    .update(`${cell.model}\0${cell.task}`)
    .digest("hex")
    .slice(0, 12)
    .toUpperCase()}`;
}

function taskFixtureText(cell: MatrixCell): string {
  return `project=openclaw\nverification_code=${verificationCode(cell)}\n`;
}

function taskPrompt(task: CodeModeMatrixTask): string {
  return task === "read"
    ? "Read facts.txt using tools. Reply with only the verification_code value, with no prose or formatting."
    : "Read facts.txt using tools. Write only its verification_code value to result.txt, then read result.txt and reply with only that value. Do not guess or skip verification.";
}

function workspaceIdentitySha256(cell: MatrixCell): string {
  return createHash("sha256")
    .update("openclaw-code-mode-workspace-v1\0")
    .update(cell.id)
    .digest("hex");
}

function workspaceSeedSha256(entries: ReadonlyArray<readonly [string, Buffer]>): string {
  const hash = createHash("sha256").update("openclaw-code-mode-workspace-seed-v1\0");
  for (const [relativePath, contents] of entries.toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    hash.update(relativePath).update("\0");
    hash.update(String(contents.byteLength)).update("\0");
    hash.update(contents);
  }
  return hash.digest("hex");
}

async function readWorkspaceSeedSha256(workspace: string): Promise<string> {
  const entries: Array<readonly [string, Buffer]> = [];
  const visit = async (directory: string): Promise<void> => {
    const children = (await fs.readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const child of children) {
      const childPath = path.join(directory, child.name);
      const relativePath = path.relative(workspace, childPath).split(path.sep).join("/");
      if (child.isDirectory()) {
        await visit(childPath);
      } else if (child.isFile()) {
        entries.push([relativePath, await fs.readFile(childPath)]);
      } else {
        throw new Error(`unsupported workspace seed entry: ${relativePath}`);
      }
    }
  };
  await visit(workspace);
  return workspaceSeedSha256(entries);
}

export async function prepareCodeModeMatrixTaskFixture(
  workspace: string,
  cell: MatrixCell,
): Promise<MatrixTaskFixture> {
  const expected = verificationCode(cell);
  const facts = taskFixtureText(cell);
  await fs.rm(workspace, { force: true, recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "facts.txt"), facts, "utf8");
  const fixtureSha256 = createHash("sha256").update(facts).digest("hex");
  const prompt = taskPrompt(cell.task);
  const workspaceIdentity = workspaceIdentitySha256(cell);
  const workspaceSeed = await readWorkspaceSeedSha256(workspace);
  if (cell.task === "read") {
    return {
      expected,
      fixtureSha256,
      prompt,
      promptSha256: createHash("sha256").update(prompt).digest("hex"),
      workspaceIdentitySha256: workspaceIdentity,
      workspaceSeedSha256: workspaceSeed,
    };
  }
  const resultPath = path.join(workspace, "result.txt");
  await fs.rm(resultPath, { force: true });
  return {
    expected,
    fixtureSha256,
    prompt,
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
    resultPath,
    workspaceIdentitySha256: workspaceIdentity,
    workspaceSeedSha256: workspaceSeed,
  };
}

async function readGitSha(repoRoot: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return stdout.trim();
}

function pathIsWithin(relativePath: string, relativeParent: string): boolean {
  return relativePath === relativeParent || relativePath.startsWith(`${relativeParent}/`);
}

async function readSourceIdentity(repoRoot: string, outputDir?: string): Promise<SourceIdentity> {
  const gitSha = await readGitSha(repoRoot);
  const [{ stdout: patch }, { stdout: untrackedOutput }] = await Promise.all([
    execFileAsync("git", ["diff", "--binary", "HEAD", "--", "."], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }),
    execFileAsync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    }),
  ]);
  const outputRelative = outputDir
    ? path.relative(path.resolve(repoRoot), path.resolve(outputDir)).split(path.sep).join("/")
    : undefined;
  const untracked = untrackedOutput
    .split("\0")
    .filter(Boolean)
    .filter((relativePath) => !outputRelative || !pathIsWithin(relativePath, outputRelative))
    .toSorted();
  const sourceDirty = patch.length > 0 || untracked.length > 0;
  if (!sourceDirty) {
    return { gitSha, sourceDirty: false, sourcePatchSha256: null };
  }

  const hash = createHash("sha256").update(patch);
  for (const relativePath of untracked) {
    const filePath = path.join(repoRoot, relativePath);
    const stat = await fs.lstat(filePath);
    hash.update(`\0${relativePath}\0${stat.mode}\0`);
    if (stat.isSymbolicLink()) {
      hash.update(await fs.readlink(filePath));
    } else if (stat.isFile()) {
      hash.update(await fs.readFile(filePath));
    }
  }
  return {
    gitSha,
    sourceDirty: true,
    sourcePatchSha256: hash.digest("hex"),
  };
}

async function readPinnedConfigSnapshot(
  configPath: string | undefined,
): Promise<PinnedConfigSnapshot> {
  if (!configPath) {
    return { effective: undefined, parsed: undefined, sha256: null };
  }
  const stat = await fs.stat(configPath).catch((error: unknown) => {
    throw new MatrixPreflightError("config_missing", { cause: error });
  });
  if (!stat.isFile()) {
    throw new MatrixPreflightError("config_not_regular_file");
  }
  const raw = await fs.readFile(configPath);
  let parsed: unknown;
  try {
    parsed = JSON5.parse(raw.toString("utf8"));
  } catch (error) {
    throw new MatrixPreflightError("config_parse_failed", { cause: error });
  }
  const inspectRaw = (
    value: unknown,
  ): {
    envSubstitution: boolean;
    include: boolean;
  } => {
    if (Array.isArray(value)) {
      return value.reduce<{
        envSubstitution: boolean;
        include: boolean;
      }>(
        (result, entry) => {
          const nested = inspectRaw(entry);
          return {
            envSubstitution: result.envSubstitution || nested.envSubstitution,
            include: result.include || nested.include,
          };
        },
        { envSubstitution: false, include: false },
      );
    }
    if (isRecord(value)) {
      return Object.entries(value).reduce<{
        envSubstitution: boolean;
        include: boolean;
      }>(
        (result, [key, entry]) => {
          const nested = inspectRaw(entry);
          return {
            envSubstitution: result.envSubstitution || nested.envSubstitution,
            include: result.include || key === "$include" || nested.include,
          };
        },
        { envSubstitution: false, include: false },
      );
    }
    return {
      envSubstitution: typeof value === "string" && /\$\{[^}]+\}|\$[A-Z][A-Z0-9_]*/u.test(value),
      include: false,
    };
  };
  const rawInspection = inspectRaw(parsed);
  if (rawInspection.include) {
    throw new MatrixPreflightError("config_include_present");
  }
  if (
    isRecord(parsed) &&
    isRecord(parsed.env) &&
    isRecord(parsed.env.shellEnv) &&
    parsed.env.shellEnv.enabled === true
  ) {
    throw new MatrixPreflightError("config_shell_env_enabled");
  }
  if (isRecord(parsed) && isRecord(parsed.env)) {
    const runtimeEnvEntries = Object.entries(parsed.env).filter(
      ([key, value]) =>
        (key === "vars" && isRecord(value) && Object.keys(value).length > 0) ||
        (key !== "vars" && key !== "shellEnv" && typeof value === "string"),
    );
    if (runtimeEnvEntries.length > 0) {
      throw new MatrixPreflightError("config_runtime_env_present");
    }
  }
  if (rawInspection.envSubstitution) {
    throw new MatrixPreflightError("config_env_substitution_present");
  }
  const configEnv = buildFrozenOperationalEnv(process.env);
  let effective: OpenClawConfig;
  try {
    const snapshot = await createConfigIO({
      configPath,
      env: { ...configEnv },
      observe: false,
      shellEnvFallback: "defer",
    }).readConfigFileSnapshot();
    if (!snapshot.valid) {
      throw new Error("pinned matrix config validation failed");
    }
    effective = snapshot.runtimeConfig;
  } catch (error) {
    throw new MatrixPreflightError("config_effective_load_failed", { cause: error });
  }
  return {
    effective,
    parsed,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}

class MatrixPreflightError extends Error {
  readonly code: string;

  constructor(code: string, options?: ErrorOptions) {
    super(code, options);
    this.name = "MatrixPreflightError";
    this.code = code;
  }
}

const MATRIX_OPERATIONAL_ENV_NAMES = [
  "HOME",
  "LANG",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
] as const;

const MATRIX_BLOCKED_ROUTE_ENV_NAMES = [
  "ALL_PROXY",
  "ANTHROPIC_BASE_URL",
  "CODEX_API_KEY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "OPENAI_API_BASE",
  "OPENAI_BASE_URL",
  "OPENAI_OAUTH_TOKEN",
  "all_proxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

function sha256Domain(label: string, value: string): string {
  return createHash("sha256").update(`${label}\0${value}`).digest("hex");
}

function matrixCellRunNonce(contentDigestKey: string, cellId: string): string {
  return createHmac("sha256", Buffer.from(contentDigestKey, "hex"))
    .update("openclaw-code-mode-matrix-cell-nonce-v1\0")
    .update(cellId, "utf8")
    .digest("hex");
}

function promptCacheKeyDigest(contentDigestKey: string, runNonce: string): string {
  return computeFrontierEvidenceDigest(
    contentDigestKey,
    "prompt-cache-key",
    deriveFrontierEvidencePromptCacheKey(contentDigestKey, runNonce),
  );
}

function buildFrozenOperationalEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of MATRIX_OPERATIONAL_ENV_NAMES) {
    if (baseEnv[name] !== undefined) {
      env[name] = baseEnv[name];
    }
  }
  for (const [name, value] of Object.entries(baseEnv)) {
    if (name.startsWith("LC_") && value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

async function createFrontierEvidencePolicyFile(params: {
  contentDigestKey: string;
  configSha256: string;
  executionPolicy: MatrixExecutionPolicy;
}): Promise<{
  cleanup: () => Promise<void>;
  path: string;
  sha256: string;
}> {
  const parsedModel = parseModelCatalogRef(params.executionPolicy.model);
  if (!parsedModel) {
    throw new MatrixPreflightError("configured_model_mismatch");
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-frontier-policy-"));
  const policyPath = path.join(root, "policy.json");
  const policy = {
    version: 1,
    configSha256: params.configSha256,
    defaultAgentId: params.executionPolicy.defaultAgentId,
    provider: "openai",
    model: parsedModel.modelId,
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    runtime: "openclaw",
    authBindingId: params.executionPolicy.authBindingId,
    contentDigestKey: params.contentDigestKey,
    credentialState: "frozen_in_memory",
    credentialEnvName: params.executionPolicy.credentialEnvName,
    fallbacks: "disabled",
    proxy: "disabled",
    tls: "default",
    localService: "disabled",
    endpoint: {
      origin: "https://api.openai.com",
      pathname: "/v1/responses",
      method: "POST",
      transport: "responses-sdk",
    },
    thinking: params.executionPolicy.thinking,
    seed: "absent",
    authoredRequestParams: "absent",
    maxLogicalCalls: 64,
    expectedReasoning: { effort: "high", summary: "auto" },
    expectedInclude: ["reasoning.encrypted_content"],
    expectedMetadata: {
      source: "openai_transport_turn_state",
      keys: [
        "openclaw_session_id",
        "openclaw_transport",
        "openclaw_turn_attempt",
        "openclaw_turn_id",
      ],
      valueClass: "volatile_execution_metadata",
    },
    expectedToolChoice: "absent",
    expectedPromptCacheKey: "session_boundary",
    expectedPromptCacheRetention: "absent",
    expectedMaxRetries: 2,
  };
  const raw = `${JSON.stringify(policy)}\n`;
  await fs.writeFile(policyPath, raw, { encoding: "utf8", flag: "wx", mode: 0o600 });
  await fs.chmod(policyPath, 0o600);
  return {
    cleanup: async () => await fs.rm(root, { recursive: true, force: true }),
    path: policyPath,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}

function readConfigPath(value: unknown, keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

async function readMatrixAuthProfile(params: {
  config: unknown;
  profileId: string;
  provider: string;
}): Promise<MatrixAuthProfileObservation> {
  if (!isRecord(params.config)) {
    return { present: false };
  }
  const agentDir = resolveDefaultAgentDir(params.config);
  const store = ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
    allowKeychainPrompt: false,
    readOnly: true,
    syncExternalCli: false,
  });
  const credential = store.profiles[params.profileId];
  if (!credential) {
    return { present: false };
  }
  if (
    credential.type !== "api_key" ||
    credential.provider !== "openai" ||
    credential.key !== undefined ||
    !isSecretRef(credential.keyRef) ||
    !isValidSecretRef(credential.keyRef) ||
    credential.keyRef.source !== "env" ||
    credential.keyRef.provider !== "default" ||
    !isValidEnvSecretRefId(credential.keyRef.id) ||
    credential.keyRef.id !== "OPENAI_API_KEY"
  ) {
    return {
      mode: credential.type === "api_key" ? credential.type : undefined,
      present: true,
      provider: credential.provider,
    };
  }
  const credentialValue = process.env[credential.keyRef.id];
  return {
    credentialEnvName: credential.keyRef.id,
    credentialValue,
    mode: credential.type,
    present: true,
    provider: credential.provider,
  };
}

function configuredAgentModel(config: unknown, model: string): Record<string, unknown> | undefined {
  const models = readConfigPath(config, ["agents", "defaults", "models"]);
  if (!isRecord(models)) {
    return undefined;
  }
  const entry = models[model];
  return isRecord(entry) ? entry : undefined;
}

function hasOnlyKeys(value: Record<string, unknown> | undefined, allowed: Set<string>): boolean {
  return !value || Object.keys(value).every((key) => allowed.has(key));
}

function hasSelectedRouteMetadata(params: {
  agentModel: Record<string, unknown> | undefined;
  provider: Record<string, unknown> | undefined;
  providerModel: Record<string, unknown> | undefined;
}): boolean {
  const runtime = isRecord(params.agentModel?.agentRuntime)
    ? params.agentModel.agentRuntime
    : undefined;
  return (
    !hasOnlyKeys(params.provider, new Set(["api", "auth", "baseUrl", "models"])) ||
    !hasOnlyKeys(params.providerModel, new Set(["api", "baseUrl", "id"])) ||
    !hasOnlyKeys(params.agentModel, new Set(["agentRuntime", "alias"])) ||
    !hasOnlyKeys(runtime, new Set(["id"]))
  );
}

async function evaluateFrontierMatrixPreflight(params: {
  config: OpenClawConfig | undefined;
  configSha256: string | null;
  model: string;
  modes: CodeModeMatrixMode[];
  repetitions: number;
  thinking: string;
  authBindingId: string;
  requireCredentialValue?: boolean;
  readAuthProfile: NonNullable<MatrixRunDependencies["readAuthProfile"]>;
}): Promise<MatrixPreflight> {
  const reasons = new Set<string>();
  let codeModeCapability: FrontierCodeModeCapabilityReceipt | undefined;
  if (!params.configSha256 || !isRecord(params.config)) {
    reasons.add("config_missing");
    return { blockedReasons: [...reasons] };
  }
  const parsedModel = parseModelCatalogRef(params.model);
  const qualification = await resolveFrontierModelQualification(params.model);
  if (!qualification.ok) {
    reasons.add(
      qualification.reason === "candidate_out_of_scope"
        ? "frontier_model_unsupported"
        : qualification.reason === "code_mode_unsupported"
          ? "frontier_model_code_mode_unsupported"
          : "frontier_model_capability_unavailable",
    );
  } else {
    codeModeCapability = qualification.receipt;
  }
  if (!parsedModel || parsedModel.provider !== "openai") {
    reasons.add("configured_model_mismatch");
  }
  if (
    params.modes.length !== 2 ||
    params.modes[0] !== "direct" ||
    params.modes[1] !== "code" ||
    params.repetitions % 2 !== 0
  ) {
    reasons.add("frontier_schedule_invalid");
  }
  if (params.thinking !== "high") {
    reasons.add("thinking_level_not_comparable");
  }
  let defaultAgentId: string | undefined;
  try {
    defaultAgentId = resolveDefaultAgentId(params.config);
  } catch {
    reasons.add("default_agent_ambiguous");
  }
  const primaryValue = defaultAgentId
    ? (resolveAgentEffectiveModelPrimary(params.config, defaultAgentId)?.trim() ?? "")
    : "";
  const qualified = splitTrailingAuthProfile(primaryValue);
  if (!qualified.profile) {
    reasons.add("auth_profile_unpinned");
  }
  if (qualified.model !== params.model) {
    reasons.add("configured_model_mismatch");
  }
  const fallbacks = defaultAgentId
    ? resolveConfiguredModelFallbacks({ cfg: params.config, agentId: defaultAgentId })
    : [];
  if (fallbacks.length !== 0) {
    reasons.add("model_fallbacks_enabled");
  }
  const modelEntry = configuredAgentModel(params.config, params.model);
  const providerConfig = configuredProvider(params.config, "openai");
  const providerModels = Array.isArray(providerConfig?.models) ? providerConfig.models : [];
  const providerModelEntry = providerModels.find(
    (entry) => isRecord(entry) && entry.id === parsedModel?.modelId,
  );
  const resolvedProviderModel = isRecord(providerModelEntry) ? providerModelEntry : undefined;
  const baseUrl = resolvedProviderModel?.baseUrl ?? providerConfig?.baseUrl;
  if (baseUrl !== undefined && baseUrl !== "https://api.openai.com/v1") {
    reasons.add("endpoint_not_canonical");
  }
  const api = resolvedProviderModel?.api ?? providerConfig?.api ?? "openai-responses";
  if (api !== "openai-responses") {
    reasons.add("api_not_openai_responses");
  }
  if (providerConfig?.auth !== undefined && providerConfig.auth !== "api-key") {
    reasons.add("provider_auth_not_api_key");
  }
  if (
    hasSelectedRouteMetadata({
      agentModel: modelEntry,
      provider: providerConfig,
      providerModel: resolvedProviderModel,
    })
  ) {
    reasons.add("selected_route_override_present");
  }
  if (
    [providerConfig, resolvedProviderModel, modelEntry].some(
      (entry) =>
        entry &&
        ["authHeader", "headers", "localService", "params", "proxy", "request", "tls"].some(
          (key) => entry[key] !== undefined,
        ),
    )
  ) {
    reasons.add("provider_route_override_present");
  }
  if (
    defaultAgentId &&
    hasAuthoredProviderRequestParams({
      config: params.config,
      provider: "openai",
      modelId: parsedModel?.modelId,
      agentId: defaultAgentId,
    })
  ) {
    reasons.add("request_params_present");
  }
  const containsSeed = (value: unknown): boolean =>
    isRecord(value) && (Object.hasOwn(value, "seed") || Object.values(value).some(containsSeed));
  if (containsSeed(params.config.agents?.defaults?.params) || containsSeed(providerConfig)) {
    reasons.add("seed_present");
  }
  if (defaultAgentId && parsedModel) {
    const runtimePolicy = resolveModelRuntimePolicy({
      provider: "openai",
      modelId: parsedModel.modelId,
      config: params.config,
      agentId: defaultAgentId,
    });
    if (runtimePolicy.policy?.id !== "openclaw") {
      reasons.add("runtime_policy_not_openclaw");
    }
  }
  const profileConfig = qualified.profile
    ? readConfigPath(params.config, ["auth", "profiles", qualified.profile])
    : undefined;
  if (
    !isRecord(profileConfig) ||
    profileConfig.provider !== "openai" ||
    profileConfig.mode !== "api_key"
  ) {
    reasons.add("configured_auth_profile_mismatch");
  }

  let authObservation: MatrixAuthProfileObservation = {
    present: false,
  };
  let authReadFailed = false;
  if (qualified.profile) {
    try {
      authObservation = await params.readAuthProfile({
        config: params.config,
        profileId: qualified.profile,
        provider: "openai",
      });
    } catch {
      authReadFailed = true;
      reasons.add("auth_profile_read_failed");
    }
    if (!authReadFailed) {
      if (!authObservation.present) {
        reasons.add("stored_auth_profile_missing");
      }
      if (authObservation.provider !== "openai" || authObservation.mode !== "api_key") {
        reasons.add("stored_auth_profile_mismatch");
      }
      if (authObservation.credentialEnvName !== "OPENAI_API_KEY") {
        reasons.add("auth_profile_not_env_keyref");
      }
      if (params.requireCredentialValue !== false && !authObservation.credentialValue?.trim()) {
        reasons.add("credential_environment_missing");
      }
    }
  }

  const allowedCredentials = new Set(
    authObservation.credentialEnvName ? [authObservation.credentialEnvName] : [],
  );
  for (const name of MATRIX_BLOCKED_ROUTE_ENV_NAMES) {
    if (process.env[name]?.trim() && !allowedCredentials.has(name)) {
      reasons.add("provider_route_override_present");
    }
  }
  if (
    reasons.size > 0 ||
    !qualified.profile ||
    !parsedModel ||
    !defaultAgentId ||
    !codeModeCapability ||
    authObservation.credentialEnvName !== "OPENAI_API_KEY" ||
    (params.requireCredentialValue !== false && !authObservation.credentialValue)
  ) {
    return { blockedReasons: [...reasons].toSorted() };
  }

  const environmentPolicy = {
    credentialEnvName: "OPENAI_API_KEY",
    operationalEnvNames: [...MATRIX_OPERATIONAL_ENV_NAMES],
  };
  return {
    blockedReasons: [],
    credentialValue: authObservation.credentialValue,
    executionPolicy: {
      api: "openai-responses",
      authMode: "api_key",
      authBindingId: params.authBindingId,
      cachePolicy: {
        build: "shared_immutable",
        os: "uncontrolled",
        provider: "uncontrolled",
      },
      candidateRuntime: "embedded",
      codeModeActivation: "explicit_frozen_run_config",
      codeModeCapability: codeModeCapability!,
      concurrency: 1,
      credentialEnvName: "OPENAI_API_KEY",
      defaultAgentId,
      endpoint: "https://api.openai.com/v1",
      environmentPolicySha256: sha256Domain(
        "openclaw-code-mode-matrix-env-v2",
        JSON.stringify(environmentPolicy),
      ),
      fallbacks: "disabled",
      harnessRetries: 0,
      model: params.model,
      processState: "fresh_per_cell",
      provider: "openai",
      providerRetryPolicy: "openai-responses-runtime-default",
      runtime: "openclaw",
      schedule: "serial_abba",
      seed: "unsupported_unset",
      selectorSource: "config",
      thinking: "high",
    },
  };
}

function configuredProvider(
  config: unknown,
  providerId: string,
): Record<string, unknown> | undefined {
  if (!isRecord(config) || !isRecord(config.models) || !isRecord(config.models.providers)) {
    return undefined;
  }
  const provider = config.models.providers[providerId];
  return isRecord(provider) ? provider : undefined;
}

function isLocalEndpoint(value: unknown): boolean {
  return typeof value === "string" && isLocalProviderBaseUrl(value, LOCAL_PROVIDER_HOST_ALIASES);
}

function hasLocalProviderProvenance(provider: Record<string, unknown> | undefined): boolean {
  if (!provider) {
    return false;
  }
  return isRecord(provider.localService) || isLocalEndpoint(provider.baseUrl);
}

export function classifyCodeModeMatrixModel(
  model: string,
  config?: unknown,
): { localModelLean: boolean } {
  const parsed = parseModelCatalogRef(model);
  if (!parsed) {
    return { localModelLean: false };
  }
  const providerConfig = configuredProvider(config, parsed.provider);
  const ollamaCloud = parsed.provider === "ollama" && isCloudModelRef(model);
  const configuredRemoteEndpoint =
    typeof providerConfig?.baseUrl === "string" && !isLocalEndpoint(providerConfig.baseUrl);
  const localRoute =
    !ollamaCloud &&
    (hasLocalProviderProvenance(providerConfig) ||
      (LOCAL_MODEL_PROVIDER_IDS.has(parsed.provider) && !configuredRemoteEndpoint));
  const localModelLean =
    localRoute && (parsed.provider === "lmstudio" || parsed.provider === "ollama");
  return { localModelLean };
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, filePath);
      hash.update(`\0${relativePath}\0`);
      if (entry.isDirectory()) {
        await visit(filePath);
      } else if (entry.isSymbolicLink()) {
        hash.update(await fs.readlink(filePath));
      } else if (entry.isFile()) {
        hash.update(await fs.readFile(filePath));
      }
    }
  };
  await visit(root);
  return hash.digest("hex");
}

async function hashRuntimeArtifacts(repoRoot: string): Promise<string> {
  const artifacts = [{ label: "dist", root: path.join(repoRoot, "dist") }];
  const packagesRoot = path.join(repoRoot, "packages");
  const packageEntries = await fs.readdir(packagesRoot, { withFileTypes: true });
  for (const entry of packageEntries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageDist = path.join(packagesRoot, entry.name, "dist");
    const stat = await fs.stat(packageDist).catch(() => null);
    if (stat?.isDirectory()) {
      artifacts.push({ label: `packages/${entry.name}/dist`, root: packageDist });
    }
  }

  const hash = createHash("sha256");
  for (const artifact of artifacts) {
    hash.update(`\0${artifact.label}\0${await hashDirectory(artifact.root)}`);
  }
  return hash.digest("hex");
}

async function buildMatrixCliArtifacts(repoRoot: string): Promise<void> {
  for (const args of [
    ["scripts/bundled-plugin-assets.mjs", "--phase", "build"],
    ["scripts/tsdown-build.mjs", "--no-clean"],
    ["scripts/runtime-postbuild.mjs"],
  ]) {
    const { stderr, stdout } = await execFileAsync(process.execPath, args, {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENCLAW_BUILD_ALL_NO_PNPM: "1",
        OPENCLAW_RUN_NODE_SKIP_DTS_BUILD: "1",
      },
      maxBuffer: 8 * 1024 * 1024,
      timeout: 10 * 60 * 1_000,
    });
    const output = `${stdout}\n${stderr}`.trim();
    if (output) {
      console.log(output);
    }
  }
}

function expectedEngagement(mode: CodeModeMatrixMode, engaged: boolean | undefined): boolean {
  if (mode === "auto") {
    return typeof engaged === "boolean";
  }
  return engaged === (mode === "code");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isProviderModelAccessFailure(text: string, requestedModel: string): boolean {
  // embedded-agent-helpers intentionally removes provider status/detail from
  // model-not-found errors before the terminal envelope reaches this runner.
  if (
    text
      .trimStart()
      .startsWith(
        "The selected model was not found by the provider. Check the model id or choose a different model.",
      )
  ) {
    return true;
  }
  if (!/\b(?:400|404)\b/u.test(text)) {
    return false;
  }
  if (/\bmodel(?:_|-)(?:not(?:_|-)found|unavailable)\b/iu.test(text)) {
    return true;
  }

  const requestedModelSlug = requestedModel.trim();
  const exactModelRef = requestedModelSlug
    ? `(?:model\\s+)?["'\`]?${escapeRegExp(requestedModelSlug)}["'\`]?`
    : "(?!)";
  const qualifiedModelRef = "(?:(?:requested|specified|selected)\\s+model)";
  const modelRef = `(?:${qualifiedModelRef}|${exactModelRef})`;
  const modelFailure = new RegExp(
    `(?:^|[\\s:,(])${modelRef}\\s+(?:(?:is|was)\\s+)?(?:unavailable|not found|does not exist)\\b`,
    "iu",
  );
  const modelNoAccess = new RegExp(
    `\\b(?:(?:do(?:es)? not|doesn't|don't) have access|no access)\\s+to\\s+(?:the\\s+)?${modelRef}(?:$|[\\s.,;)])`,
    "iu",
  );
  return modelFailure.test(text) || modelNoAccess.test(text);
}

function classifyProviderFailure(text: string, requestedModel: string): CellFailureCategory | null {
  if (
    /\b402\b|billing|credits? (?:depleted|exhausted|insufficient)|payment required/iu.test(text)
  ) {
    return "provider_billing";
  }
  if (/\b401\b|\b403\b|unauthorized|forbidden|invalid (?:api )?key|authentication/iu.test(text)) {
    return "provider_auth";
  }
  if (isProviderModelAccessFailure(text, requestedModel)) {
    return "provider_model_access";
  }
  if (
    /connection refused|connect timeout|fetch failed|network|socket|stream.*(?:closed|ended)|http 5\d\d/iu.test(
      text,
    )
  ) {
    return "provider_transport";
  }
  return null;
}

export function classifyCodeModeMatrixCell(params: {
  diagnostics: string;
  effectPassed: boolean;
  envelope: Readonly<AgentExecEnvelope>;
  expected: string;
  mode: CodeModeMatrixMode;
  model: string;
  stdoutContractValid?: boolean;
  task: CodeModeMatrixTask;
}): {
  failureCategory: CellFailureCategory | null;
  oracle: CodeModeMatrixCellResult["oracle"];
  passed: boolean;
} {
  const engagement = expectedEngagement(params.mode, params.envelope.codeModeEngaged);
  const answer = params.envelope.final.trim() === params.expected;
  const effect = params.effectPassed;
  const separator = params.model.indexOf("/");
  const requestedProvider = params.model.slice(0, separator);
  const requestedModel = params.model.slice(separator + 1);
  const identity =
    params.envelope.provider === requestedProvider && params.envelope.model === requestedModel;
  const outerToolExecution = (params.envelope.toolSummary?.calls ?? 0) > 0;
  // Direct and auto evaluate the model-visible outer tool surface. Forced Code
  // Mode additionally proves that the exec cell reached a nested catalog tool.
  const toolExecution =
    outerToolExecution && (params.mode !== "code" || (params.envelope.bridgeCalls?.call ?? 0) > 0);
  const oracle = { answer, effect, engagement, identity, toolExecution };
  if (params.stdoutContractValid === false) {
    return { failureCategory: "harness_error", oracle, passed: false };
  }
  if (params.envelope.status === "timeout") {
    return { failureCategory: "timeout", oracle, passed: false };
  }
  if (!params.envelope.ok) {
    const providerFailure = classifyProviderFailure(
      params.envelope.error?.message ?? "",
      requestedModel,
    );
    if (providerFailure) {
      return { failureCategory: providerFailure, oracle, passed: false };
    }
    return { failureCategory: "agent_error", oracle, passed: false };
  }
  if (!identity) {
    return { failureCategory: "model_mismatch", oracle, passed: false };
  }
  if (!engagement) {
    return { failureCategory: "activation", oracle, passed: false };
  }
  if (!toolExecution) {
    return { failureCategory: "tool_execution", oracle, passed: false };
  }
  if (!effect) {
    return { failureCategory: "effect_mismatch", oracle, passed: false };
  }
  if (!answer) {
    return { failureCategory: "answer_mismatch", oracle, passed: false };
  }
  return { failureCategory: null, oracle, passed: true };
}

function parseAgentExecOutput(stdout: string): {
  envelope: AgentExecEnvelope;
  trailing: string;
} {
  const value = stdout.trimStart();
  if (!value) {
    throw new Error("agent exec produced no JSON envelope");
  }
  if (value[0] !== "{") {
    throw new Error("agent exec stdout did not begin with a JSON envelope");
  }
  let depth = 0;
  let escaped = false;
  let inString = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        const envelope = JSON.parse(value.slice(0, index + 1)) as AgentExecEnvelope;
        return { envelope, trailing: value.slice(index + 1).trim() };
      }
    }
  }
  throw new Error("agent exec produced an incomplete JSON envelope");
}

async function pathIsDirectory(value: string): Promise<boolean> {
  return await fs
    .stat(value)
    .then((stats) => stats.isDirectory())
    .catch(() => false);
}

async function cloneTreeWithHardlinks(source: string, destination: string): Promise<void> {
  await fs.mkdir(destination, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await cloneTreeWithHardlinks(sourcePath, destinationPath);
    } else if (entry.isSymbolicLink()) {
      await fs.symlink(await fs.readlink(sourcePath), destinationPath);
    } else {
      try {
        await fs.link(sourcePath, destinationPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
          throw error;
        }
        await fs.copyFile(sourcePath, destinationPath);
      }
    }
  }
}

async function prepareRuntimeEntrypoint(
  repoRoot: string,
  runtimeRoot: string,
): Promise<MatrixRuntimeEntrypoint> {
  const entrypoint = path.join(repoRoot, "dist", "entry.js");
  try {
    await fs.access(entrypoint);
  } catch (error) {
    throw new Error("dist/entry.js is missing; run pnpm build before the matrix", { cause: error });
  }

  const nodeModules = path.join(repoRoot, "node_modules");
  const physicalNodeModules = await fs.realpath(nodeModules);
  if (physicalNodeModules === path.resolve(nodeModules)) {
    return { args: [entrypoint], cwd: repoRoot };
  }

  const overlayDist = path.join(runtimeRoot, "dist");
  const overlayNodeModules = path.join(runtimeRoot, "node_modules");
  await cloneTreeWithHardlinks(path.join(repoRoot, "dist"), overlayDist);
  await fs.mkdir(overlayNodeModules);
  await fs.copyFile(path.join(repoRoot, "package.json"), path.join(runtimeRoot, "package.json"));

  const entries = await fs.readdir(physicalNodeModules, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "@openclaw") {
      continue;
    }
    await fs.symlink(
      path.join(physicalNodeModules, entry.name),
      path.join(overlayNodeModules, entry.name),
      process.platform === "win32" ? "junction" : "dir",
    );
  }

  const overlayOpenClaw = path.join(overlayNodeModules, "@openclaw");
  const physicalOpenClaw = path.join(physicalNodeModules, "@openclaw");
  await fs.mkdir(overlayOpenClaw);
  for (const entry of await fs.readdir(physicalOpenClaw, { withFileTypes: true })) {
    const worktreePackage = path.join(repoRoot, "packages", entry.name);
    const target = (await pathIsDirectory(path.join(worktreePackage, "dist")))
      ? worktreePackage
      : path.join(physicalOpenClaw, entry.name);
    await fs.symlink(
      target,
      path.join(overlayOpenClaw, entry.name),
      process.platform === "win32" ? "junction" : "dir",
    );
  }

  return {
    args: [path.join(runtimeRoot, "dist", "entry.js")],
    cwd: runtimeRoot,
  };
}

export function buildCodeModeMatrixAgentEnv(
  model: string,
  runtimeCwd: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  config?: unknown,
  credentialEnvNames: readonly string[] = [],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...buildFrozenOperationalEnv(baseEnv),
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(runtimeCwd, "dist", "extensions"),
    OPENCLAW_LOAD_SHELL_ENV: "0",
  };
  for (const name of credentialEnvNames) {
    if (baseEnv[name] !== undefined) {
      env[name] = baseEnv[name];
    }
  }
  // The local Ollama provider uses a non-secret opt-in marker. Keep cloud and
  // custom credentials caller-owned, but make the local acceptance path work.
  if (
    model.startsWith("ollama/") &&
    classifyCodeModeMatrixModel(model, config).localModelLean &&
    !env.OLLAMA_API_KEY
  ) {
    env.OLLAMA_API_KEY = baseEnv.OLLAMA_API_KEY ?? "ollama-local";
  }
  delete env.NODE_COMPILE_CACHE;
  return env;
}

function usesLocalModelLean(model: string, config?: unknown): boolean {
  return classifyCodeModeMatrixModel(model, config).localModelLean;
}

export function buildCodeModeMatrixAgentExecArgs(params: {
  configPath?: string;
  frontierEvidencePolicy?: {
    path: string;
    sha256: string;
  };
  frontierEvidenceRunNonce?: string;
  fixture: Pick<MatrixTaskFixture, "prompt">;
  matrix: Pick<RunCellParams, "cell" | "config" | "thinking" | "timeoutSeconds">;
  runtime: MatrixRuntimeEntrypoint;
  stateDir: string;
  workspace: string;
}): string[] {
  if (!params.frontierEvidencePolicy && params.frontierEvidenceRunNonce) {
    throw new Error("frontier evidence run nonce requires a frontier evidence policy");
  }
  if (
    params.frontierEvidencePolicy &&
    !/^[a-f0-9]{64}$/u.test(params.frontierEvidenceRunNonce ?? "")
  ) {
    throw new Error("frontier evidence run nonce is missing or invalid");
  }
  return [
    ...params.runtime.args,
    "agent",
    "exec",
    params.fixture.prompt,
    "--cwd",
    params.workspace,
    "--state-dir",
    params.stateDir,
    ...(!params.frontierEvidencePolicy ? ["--model", params.matrix.cell.model] : []),
    "--code-mode",
    params.matrix.cell.mode,
    ...(usesLocalModelLean(params.matrix.cell.model, params.matrix.config)
      ? ["--local-model-lean"]
      : []),
    ...(params.configPath ? ["--config", params.configPath] : []),
    ...(params.frontierEvidencePolicy
      ? [
          "--frontier-evidence-policy",
          params.frontierEvidencePolicy.path,
          "--frontier-evidence-policy-sha256",
          params.frontierEvidencePolicy.sha256,
          "--frontier-evidence-run-nonce",
          params.frontierEvidenceRunNonce ?? "",
        ]
      : []),
    "--thinking",
    params.matrix.thinking,
    "--timeout",
    String(params.matrix.timeoutSeconds),
    "--json",
  ];
}

async function executeAgentExec(params: {
  fixture: MatrixTaskFixture;
  matrix: RunCellParams;
  stateDir: string;
  workspace: string;
}): Promise<{
  diagnostics: string;
  envelope: AgentExecEnvelope;
  stdoutContractValid: boolean;
}> {
  const runtime = params.matrix.runtime;
  if (!runtime) {
    throw new Error("matrix runtime entrypoint was not prepared");
  }
  const args = buildCodeModeMatrixAgentExecArgs({
    configPath: params.matrix.configPath,
    frontierEvidencePolicy: params.matrix.frontierEvidencePolicy,
    frontierEvidenceRunNonce: params.matrix.frontierEvidenceRunNonce,
    fixture: params.fixture,
    matrix: params.matrix,
    runtime,
    stateDir: params.stateDir,
    workspace: params.workspace,
  });
  try {
    const env = {
      ...params.matrix.frozenEnv,
      NODE_DISABLE_COMPILE_CACHE: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(runtime.cwd, "dist", "extensions"),
      OPENCLAW_LOAD_SHELL_ENV: "0",
    };
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      cwd: runtime.cwd,
      encoding: "utf8",
      env,
      maxBuffer: 4 * 1024 * 1024,
      timeout: (params.matrix.timeoutSeconds + 30) * 1_000,
    });
    const parsed = parseAgentExecOutput(stdout);
    return {
      diagnostics:
        `${stderr}\n${parsed.trailing ? `unexpected stdout after JSON: ${parsed.trailing}` : ""}`
          .trim()
          .slice(-MAX_DIAGNOSTIC_CHARS),
      envelope: parsed.envelope,
      stdoutContractValid: parsed.trailing.length === 0,
    };
  } catch (error) {
    const commandError = error as Error & {
      code?: string;
      killed?: boolean;
      stderr?: string;
      stdout?: string;
    };
    if (commandError.killed || commandError.code === "ETIMEDOUT") {
      return {
        diagnostics: previewForDevToolLog(commandError.stderr ?? commandError.message, 2_000),
        envelope: {
          ok: false,
          status: "timeout",
          final: "",
          payloads: [],
          model: null,
          provider: null,
          sessionId: "",
          error: { kind: "timeout", message: "agent exec process deadline elapsed" },
        },
        stdoutContractValid: true,
      };
    }
    if (commandError.stdout?.trim()) {
      const parsed = parseAgentExecOutput(commandError.stdout);
      return {
        diagnostics:
          `${commandError.stderr ?? ""}\n${parsed.trailing ? `unexpected stdout after JSON: ${parsed.trailing}` : ""}`
            .trim()
            .slice(-MAX_DIAGNOSTIC_CHARS),
        envelope: parsed.envelope,
        stdoutContractValid: parsed.trailing.length === 0,
      };
    }
    throw error;
  }
}

async function runMatrixCell(params: RunCellParams): Promise<CodeModeMatrixCellResult> {
  const workspaceIdentity = workspaceIdentitySha256(params.cell);
  const root = path.join(params.campaignRoot, "cells", workspaceIdentity);
  const retainedRoot = path.join(params.outputDir, "state", params.cell.id);
  await fs.rm(root, { force: true, recursive: true });
  await fs.rm(retainedRoot, { force: true, recursive: true });
  const stateDir = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(stateDir, { recursive: true });
  const fixture = await prepareCodeModeMatrixTaskFixture(workspace, params.cell);
  const startedAt = Date.now();
  try {
    const command = await executeAgentExec({
      fixture,
      matrix: params,
      stateDir,
      workspace,
    });
    const effectPassed = fixture.resultPath
      ? (await fs.readFile(fixture.resultPath, "utf8").catch(() => "")).trim() === fixture.expected
      : true;
    const diagnosticText = command.diagnostics;
    const classification = classifyCodeModeMatrixCell({
      diagnostics: diagnosticText,
      effectPassed,
      envelope: command.envelope,
      expected: fixture.expected,
      mode: params.cell.mode,
      model: params.cell.model,
      stdoutContractValid: command.stdoutContractValid,
      task: params.cell.task,
    });
    return {
      ...(command.envelope.assistantTurns !== undefined
        ? { assistantTurns: command.envelope.assistantTurns }
        : {}),
      ...(command.envelope.bridgeCalls ? { bridgeCalls: command.envelope.bridgeCalls } : {}),
      buildSha256: params.buildSha256,
      firstLogicalCallCacheStatus: classifyMatrixCacheStatus(command.envelope.trace),
      codeModeEngaged: command.envelope.codeModeEngaged ?? null,
      configSha256: params.configSha256,
      ...(command.envelope.costUsd !== undefined ? { costUsd: command.envelope.costUsd } : {}),
      ...(diagnosticText ? { diagnostics: diagnosticText } : {}),
      elapsedMs: Date.now() - startedAt,
      ...(command.envelope.error ? { error: command.envelope.error } : {}),
      expected: fixture.expected,
      failureCategory: classification.failureCategory,
      final: command.envelope.final,
      ...(command.envelope.frontierEvidence
        ? { frontierEvidence: command.envelope.frontierEvidence }
        : {}),
      fixtureSha256: fixture.fixtureSha256,
      gitSha: params.gitSha,
      id: params.cell.id,
      mode: params.cell.mode,
      model: params.cell.model,
      observedModel: command.envelope.model,
      observedProvider: command.envelope.provider,
      oracle: classification.oracle,
      passed: classification.passed,
      promptSha256: fixture.promptSha256,
      repetition: params.cell.repetition,
      sourceDirty: params.sourceDirty,
      sourcePatchSha256: params.sourcePatchSha256,
      status: command.envelope.status,
      task: params.cell.task,
      timestamp: new Date().toISOString(),
      ...(command.envelope.toolSummary ? { toolSummary: command.envelope.toolSummary } : {}),
      ...(command.envelope.trace ? { trace: command.envelope.trace } : {}),
      ...(command.envelope.usage ? { usage: command.envelope.usage } : {}),
      workspaceIdentitySha256: fixture.workspaceIdentitySha256,
      workspaceSeedSha256: fixture.workspaceSeedSha256,
    };
  } finally {
    if (params.keepState) {
      await fs.mkdir(path.dirname(retainedRoot), { recursive: true });
      await fs.cp(root, retainedRoot, { recursive: true });
    }
    await fs.rm(root, { force: true, recursive: true });
  }
}

function harnessFailureResult(
  cell: MatrixCell,
  provenance: Pick<
    RunCellParams,
    "buildSha256" | "configSha256" | "gitSha" | "sourceDirty" | "sourcePatchSha256"
  >,
  elapsedMs: number,
  error: unknown,
): CodeModeMatrixCellResult {
  const message = previewForDevToolLog(
    error instanceof Error ? error.message : String(error),
    2_000,
  );
  return {
    buildSha256: provenance.buildSha256,
    firstLogicalCallCacheStatus: "unknown",
    codeModeEngaged: null,
    configSha256: provenance.configSha256,
    diagnostics: message,
    elapsedMs,
    error: { kind: "harness_error", message },
    expected: verificationCode(cell),
    failureCategory: "harness_error",
    final: "",
    fixtureSha256: createHash("sha256")
      .update(`project=openclaw\nverification_code=${verificationCode(cell)}\n`)
      .digest("hex"),
    gitSha: provenance.gitSha,
    id: cell.id,
    mode: cell.mode,
    model: cell.model,
    observedModel: null,
    observedProvider: null,
    oracle: {
      answer: false,
      effect: false,
      engagement: false,
      identity: false,
      toolExecution: false,
    },
    passed: false,
    promptSha256: createHash("sha256").update(taskPrompt(cell.task)).digest("hex"),
    repetition: cell.repetition,
    sourceDirty: provenance.sourceDirty,
    sourcePatchSha256: provenance.sourcePatchSha256,
    status: "error",
    task: cell.task,
    timestamp: new Date().toISOString(),
  };
}

function proofDriftResult(
  cell: MatrixCell,
  provenance: Pick<
    RunCellParams,
    "buildSha256" | "configSha256" | "gitSha" | "sourceDirty" | "sourcePatchSha256"
  >,
  elapsedMs: number,
  error: MatrixPreflightError,
): CodeModeMatrixCellResult {
  return {
    buildSha256: provenance.buildSha256,
    firstLogicalCallCacheStatus: "unknown",
    codeModeEngaged: null,
    configSha256: provenance.configSha256,
    diagnostics: error.code,
    elapsedMs,
    error: { kind: error.code, message: error.code },
    expected: verificationCode(cell),
    failureCategory: "proof_drift",
    final: "",
    fixtureSha256: createHash("sha256")
      .update(`project=openclaw\nverification_code=${verificationCode(cell)}\n`)
      .digest("hex"),
    gitSha: provenance.gitSha,
    id: cell.id,
    mode: cell.mode,
    model: cell.model,
    observedModel: null,
    observedProvider: null,
    oracle: {
      answer: false,
      effect: false,
      engagement: false,
      identity: false,
      toolExecution: false,
    },
    passed: false,
    promptSha256: createHash("sha256").update(taskPrompt(cell.task)).digest("hex"),
    repetition: cell.repetition,
    sourceDirty: provenance.sourceDirty,
    sourcePatchSha256: provenance.sourcePatchSha256,
    status: "error",
    task: cell.task,
    timestamp: new Date().toISOString(),
  };
}

function preserveResultAsProofDrift(
  result: CodeModeMatrixCellResult,
  elapsedMs: number,
  error: MatrixPreflightError,
): CodeModeMatrixCellResult {
  return {
    ...result,
    diagnostics: error.code,
    elapsedMs,
    error: { kind: error.code, message: error.code },
    failureCategory: "proof_drift",
    passed: false,
  };
}

function summarizeResults(results: CodeModeMatrixCellResult[]) {
  const groups = new Map<
    string,
    {
      codeModeEngaged: number;
      failed: number;
      failures: Record<string, number>;
      firstPassPassed: boolean;
      passed: number;
      total: number;
      wallMs: number[];
    }
  >();
  for (const result of results) {
    const key = `${result.model}\0${result.mode}\0${result.task}`;
    const group = groups.get(key) ?? {
      codeModeEngaged: 0,
      failed: 0,
      failures: {},
      firstPassPassed: false,
      passed: 0,
      total: 0,
      wallMs: [],
    };
    group.total += 1;
    group.wallMs.push(result.wallLatencyMs ?? result.elapsedMs);
    if (result.passed) {
      group.passed += 1;
      if (result.repetition === 1) {
        group.firstPassPassed = true;
      }
    } else {
      group.failed += 1;
      const category = result.failureCategory ?? "unknown";
      group.failures[category] = (group.failures[category] ?? 0) + 1;
    }
    if (result.codeModeEngaged === true) {
      group.codeModeEngaged += 1;
    }
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, group]) => {
    const [model, mode, task] = key.split("\0");
    const sortedWallMs = group.wallMs.toSorted((a, b) => a - b);
    return {
      codeModeEngaged: group.codeModeEngaged,
      failed: group.failed,
      failures: group.failures,
      firstPassPassed: group.firstPassPassed,
      mode,
      model,
      eventualPassed: group.passed > 0,
      p50WallMs: sortedWallMs[Math.floor(sortedWallMs.length / 2)] ?? 0,
      passRate: group.total === 0 ? 0 : group.passed / group.total,
      passed: group.passed,
      task,
      total: group.total,
    };
  });
}

export function classifyMatrixCacheStatus(
  trace: AgentExecEnvelope["trace"] | undefined,
): MatrixCacheStatus {
  if (trace?.schemaVersion !== 4) {
    return "unknown";
  }
  const metric = trace.metrics.tokens.firstLogicalCallCachedInput;
  if (metric?.state !== "exact" || !Number.isFinite(metric.value) || metric.value < 0) {
    return "unknown";
  }
  return metric.value === 0 ? "cold" : "warm";
}

function exactTraceMetric(
  result: CodeModeMatrixCellResult,
  select: (trace: NonNullable<CodeModeMatrixCellResult["trace"]>) => {
    state: string;
    value?: number;
  },
): number | null {
  if (!result.trace) {
    return null;
  }
  const metric = select(result.trace);
  return metric.state === "exact" &&
    typeof metric.value === "number" &&
    Number.isFinite(metric.value) &&
    metric.value >= 0
    ? metric.value
    : null;
}

function sumExactTraceMetrics(
  results: readonly CodeModeMatrixCellResult[],
  select: Parameters<typeof exactTraceMetric>[1],
): number | null {
  let total = 0;
  for (const result of results) {
    const value = exactTraceMetric(result, select);
    if (value === null) {
      return null;
    }
    total += value;
  }
  return total;
}

function sumCellMetric(
  results: readonly CodeModeMatrixCellResult[],
  select: (result: CodeModeMatrixCellResult) => number | undefined,
): number | null {
  let total = 0;
  for (const result of results) {
    const value = select(result);
    if (value === undefined || !Number.isFinite(value) || value < 0) {
      return null;
    }
    total += value;
  }
  return total;
}

function sumNullableMetrics(...values: Array<number | null>): number | null {
  let total = 0;
  for (const value of values) {
    if (value === null) {
      return null;
    }
    total += value;
  }
  return total;
}

function matchedAbbaPairs(results: readonly CodeModeMatrixCellResult[]): {
  pairs: Array<{ direct: CodeModeMatrixCellResult; code: CodeModeMatrixCellResult }>;
  valid: boolean;
} {
  const relevant = results.filter((result) => result.mode === "direct" || result.mode === "code");
  const byTask = new Map<string, CodeModeMatrixCellResult[]>();
  for (const result of relevant) {
    const key = `${result.model}\0${result.task}`;
    const taskResults = byTask.get(key) ?? [];
    taskResults.push(result);
    byTask.set(key, taskResults);
  }
  const pairs: Array<{ direct: CodeModeMatrixCellResult; code: CodeModeMatrixCellResult }> = [];
  for (const taskResults of byTask.values()) {
    const ordered = [...taskResults];
    if (ordered.length === 0 || ordered.length % 4 !== 0) {
      return { pairs: [], valid: false };
    }
    for (let index = 0; index < ordered.length; index += 4) {
      const chunk = ordered.slice(index, index + 4);
      const firstRepetition = chunk[0]?.repetition;
      const secondRepetition = chunk[2]?.repetition;
      if (
        !firstRepetition ||
        !secondRepetition ||
        secondRepetition !== firstRepetition + 1 ||
        chunk[0]?.mode !== "direct" ||
        chunk[0]?.repetition !== firstRepetition ||
        chunk[1]?.mode !== "code" ||
        chunk[1]?.repetition !== firstRepetition ||
        chunk[2]?.mode !== "code" ||
        chunk[2]?.repetition !== secondRepetition ||
        chunk[3]?.mode !== "direct" ||
        chunk[3]?.repetition !== secondRepetition
      ) {
        return { pairs: [], valid: false };
      }
      pairs.push({ direct: chunk[0]!, code: chunk[1]! }, { direct: chunk[3]!, code: chunk[2]! });
    }
  }
  return { pairs, valid: pairs.length > 0 };
}

export function buildCodeModeMatrixBetaGate(results: readonly CodeModeMatrixCellResult[]) {
  const matching = matchedAbbaPairs(results);
  const tracedResults = matching.pairs.flatMap((pair) => [pair.direct, pair.code]);
  const frontierEvidenceClassValid =
    matching.valid &&
    tracedResults.every((result) => result.evidenceClass === "frontier_beta_qualification");
  const auditableMatchedTraces: BetaGateBar =
    frontierEvidenceClassValid &&
    tracedResults.every(
      (result) =>
        result.trace?.schemaVersion === 4 &&
        result.trace.audit.state === "valid" &&
        result.trace.route?.provider === result.observedProvider &&
        result.trace.route?.model === result.observedModel,
    )
      ? "pass"
      : "unknown";
  const matchedCacheStates = tracedResults.map((result) => ({
    recorded: result.firstLogicalCallCacheStatus,
    observed: classifyMatrixCacheStatus(result.trace),
  }));
  const coldInitialPerCell: BetaGateBar = !matching.valid
    ? "unknown"
    : matchedCacheStates.some(
          ({ observed, recorded }) => observed === "unknown" || recorded !== observed,
        )
      ? "unknown"
      : matchedCacheStates.every(({ observed }) => observed === "cold")
        ? "pass"
        : "fail";
  const comparable = auditableMatchedTraces === "pass" && coldInitialPerCell === "pass";
  const direct = matching.pairs.map((pair) => pair.direct);
  const code = matching.pairs.map((pair) => pair.code);
  const comparison = (
    left: number | null,
    right: number | null,
    predicate: (directValue: number, codeValue: number) => boolean,
  ): BetaGateBar =>
    !comparable || left === null || right === null
      ? "unknown"
      : predicate(left, right)
        ? "pass"
        : "fail";
  const directTurns = sumExactTraceMetrics(direct, (trace) => trace.metrics.effectiveTurns);
  const codeTurns = sumExactTraceMetrics(code, (trace) => trace.metrics.effectiveTurns);
  const directTokens = sumExactTraceMetrics(direct, (trace) => trace.metrics.tokens.total);
  const codeTokens = sumExactTraceMetrics(code, (trace) => trace.metrics.tokens.total);
  const directInputTokens = sumExactTraceMetrics(direct, (trace) => trace.metrics.tokens.input);
  const codeInputTokens = sumExactTraceMetrics(code, (trace) => trace.metrics.tokens.input);
  const directOutputTokens = sumExactTraceMetrics(direct, (trace) => trace.metrics.tokens.output);
  const codeOutputTokens = sumExactTraceMetrics(code, (trace) => trace.metrics.tokens.output);
  const directCachedInputTokens = sumExactTraceMetrics(
    direct,
    (trace) => trace.metrics.tokens.cachedInput,
  );
  const codeCachedInputTokens = sumExactTraceMetrics(
    code,
    (trace) => trace.metrics.tokens.cachedInput,
  );
  const directModelCalls = sumExactTraceMetrics(direct, (trace) => trace.metrics.logicalModelCalls);
  const codeModelCalls = sumExactTraceMetrics(code, (trace) => trace.metrics.logicalModelCalls);
  const directProviderAttempts = sumExactTraceMetrics(
    direct,
    (trace) => trace.metrics.providerAttempts.total,
  );
  const codeProviderAttempts = sumExactTraceMetrics(
    code,
    (trace) => trace.metrics.providerAttempts.total,
  );
  const directRetries = sumExactTraceMetrics(
    direct,
    (trace) => trace.metrics.providerAttempts.retries,
  );
  const codeRetries = sumExactTraceMetrics(code, (trace) => trace.metrics.providerAttempts.retries);
  const directAuthRecoveries = sumExactTraceMetrics(
    direct,
    (trace) => trace.metrics.providerAttempts.authRecoveries,
  );
  const codeAuthRecoveries = sumExactTraceMetrics(
    code,
    (trace) => trace.metrics.providerAttempts.authRecoveries,
  );
  const directPayloadRecoveries = sumExactTraceMetrics(
    direct,
    (trace) => trace.metrics.providerAttempts.payloadRecoveries,
  );
  const codePayloadRecoveries = sumExactTraceMetrics(
    code,
    (trace) => trace.metrics.providerAttempts.payloadRecoveries,
  );
  const directTransportFallbacks = sumExactTraceMetrics(
    direct,
    (trace) => trace.metrics.providerAttempts.transportFallbacks,
  );
  const codeTransportFallbacks = sumExactTraceMetrics(
    code,
    (trace) => trace.metrics.providerAttempts.transportFallbacks,
  );
  const directAdditionalProviderAttempts = sumNullableMetrics(
    directRetries,
    directAuthRecoveries,
    directPayloadRecoveries,
    directTransportFallbacks,
  );
  const codeAdditionalProviderAttempts = sumNullableMetrics(
    codeRetries,
    codeAuthRecoveries,
    codePayloadRecoveries,
    codeTransportFallbacks,
  );
  const directPhysicalFetchDispatch = sumExactTraceMetrics(
    direct,
    (trace) => trace.metrics.physicalFetchDispatch,
  );
  const codePhysicalFetchDispatch = sumExactTraceMetrics(
    code,
    (trace) => trace.metrics.physicalFetchDispatch,
  );
  const directOuterToolCalls = sumExactTraceMetrics(
    direct,
    (trace) => trace.metrics.outerToolCalls,
  );
  const codeOuterToolCalls = sumExactTraceMetrics(code, (trace) => trace.metrics.outerToolCalls);
  const directToolOperations = sumExactTraceMetrics(
    direct,
    (trace) => trace.metrics.totalToolOperations,
  );
  const codeToolOperations = sumExactTraceMetrics(
    code,
    (trace) => trace.metrics.totalToolOperations,
  );
  const directCalls = sumExactTraceMetrics(direct, (trace) => trace.metrics.underlyingTotalCalls);
  const codeCalls = sumExactTraceMetrics(code, (trace) => trace.metrics.underlyingTotalCalls);
  const directAgentTime = sumExactTraceMetrics(direct, (trace) => trace.metrics.agentDurationMs);
  const codeAgentTime = sumExactTraceMetrics(code, (trace) => trace.metrics.agentDurationMs);
  const directWallLatency = sumCellMetric(direct, (result) => result.wallLatencyMs);
  const codeWallLatency = sumCellMetric(code, (result) => result.wallLatencyMs);
  const wallLatencyMeasurementValid = tracedResults.every(
    (result) => result.wallLatencyMeasurement === "matrix_monotonic_elapsed",
  );
  const directPassed = direct.filter((result) => result.passed).length;
  const codePassed = code.filter((result) => result.passed).length;
  const callRegression = comparison(directCalls, codeCalls, (a, b) => b <= a);
  const wallLatencyRegression = wallLatencyMeasurementValid
    ? comparison(directWallLatency, codeWallLatency, (a, b) => b <= a)
    : ("unknown" as const);
  const bars = {
    accuracyNonRegression: comparable
      ? codePassed > 0 && codePassed >= directPassed
        ? ("pass" as const)
        : ("fail" as const)
      : ("unknown" as const),
    fewerEffectiveTurns: comparison(directTurns, codeTurns, (a, b) => b < a),
    fewerTokens: comparison(directTokens, codeTokens, (a, b) => b < a),
    noRegressionInCallsOrWallLatency:
      callRegression === "fail" || wallLatencyRegression === "fail"
        ? ("fail" as const)
        : callRegression === "pass" && wallLatencyRegression === "pass"
          ? ("pass" as const)
          : ("unknown" as const),
    auditableMatchedTraces,
    coldInitialPerCell,
  };
  const retryRegression = {
    state:
      directRetries === null || codeRetries === null
        ? ("unknown" as const)
        : codeRetries > directRetries
          ? ("observed" as const)
          : ("not_observed" as const),
    blocking: false,
    confidence: "lower" as const,
    directRetries,
    codeRetries,
  };
  const values = Object.values(bars);
  return {
    state: values.includes("fail")
      ? ("blocked" as const)
      : values.includes("unknown")
        ? ("inconclusive" as const)
        : ("diagnostic_pass" as const),
    bars,
    diagnostics: {
      retry_regression: retryRegression,
    },
    recommendation: "requires_frozen_representative_benchmark" as const,
    matchedPairs: matching.pairs.length,
    totals: {
      direct: {
        passed: direct.filter((result) => result.passed).length,
        cells: direct.length,
        effectiveTurns: directTurns,
        modelFacingCalls: directModelCalls,
        providerAttempts: directProviderAttempts,
        retries: directRetries,
        authRecoveries: directAuthRecoveries,
        payloadRecoveries: directPayloadRecoveries,
        transportFallbacks: directTransportFallbacks,
        additionalProviderAttempts: directAdditionalProviderAttempts,
        physicalFetchDispatch: directPhysicalFetchDispatch,
        outerToolCalls: directOuterToolCalls,
        totalToolOperations: directToolOperations,
        tokens: directTokens,
        inputTokens: directInputTokens,
        cachedInputTokens: directCachedInputTokens,
        outputTokens: directOutputTokens,
        underlyingTotalCalls: directCalls,
        agentTimeMs: directAgentTime,
        wallLatencyMs: directWallLatency,
      },
      code: {
        passed: code.filter((result) => result.passed).length,
        cells: code.length,
        effectiveTurns: codeTurns,
        modelFacingCalls: codeModelCalls,
        providerAttempts: codeProviderAttempts,
        retries: codeRetries,
        authRecoveries: codeAuthRecoveries,
        payloadRecoveries: codePayloadRecoveries,
        transportFallbacks: codeTransportFallbacks,
        additionalProviderAttempts: codeAdditionalProviderAttempts,
        physicalFetchDispatch: codePhysicalFetchDispatch,
        outerToolCalls: codeOuterToolCalls,
        totalToolOperations: codeToolOperations,
        tokens: codeTokens,
        inputTokens: codeInputTokens,
        cachedInputTokens: codeCachedInputTokens,
        outputTokens: codeOutputTokens,
        underlyingTotalCalls: codeCalls,
        agentTimeMs: codeAgentTime,
        wallLatencyMs: codeWallLatency,
      },
    },
  };
}

export function resolveCodeModeMatrixExitCode(params: {
  allowFailures: boolean;
  betaGateState: ReturnType<typeof buildCodeModeMatrixBetaGate>["state"];
  conversationProofAttested?: boolean;
  conversationProofRequired: boolean;
  conversationProofStatus?: "blocked" | "fail" | "pass";
  failed: number;
  frontierEvidenceValid: boolean;
}): 0 | 1 {
  return (params.failed > 0 && !params.allowFailures) ||
    !params.frontierEvidenceValid ||
    params.betaGateState !== "diagnostic_pass" ||
    (params.conversationProofRequired &&
      (params.conversationProofStatus !== "pass" || params.conversationProofAttested !== true))
    ? 1
    : 0;
}

function auditFrontierEvidenceReceipts(
  results: readonly CodeModeMatrixCellResult[],
  contentDigestKey: string,
  expectedPromptCacheKeyDigests?: ReadonlyMap<string, string>,
  expectedPolicy?: {
    authBindingId: string;
    credentialState: "frozen_in_memory";
    policySha256: string;
  },
): { valid: boolean; reasons: string[] } {
  const reasons = new Set<string>();
  const taskByPair = new Map<string, string>();
  const comparableInputByMode = new Map<string, string>();
  const schemaByMode = new Map<string, string>();
  const cellByPromptCacheKeyDigest = new Map<string, string>();
  for (const result of results) {
    const receipts = result.frontierEvidence;
    if (receipts?.length !== 1 || !receipts[0]?.valid) {
      reasons.add("frontier_receipt_missing_or_invalid");
      continue;
    }
    const receipt = receipts[0];
    if (
      expectedPolicy &&
      (receipt.policySha256 !== expectedPolicy.policySha256 ||
        receipt.authBindingId !== expectedPolicy.authBindingId ||
        receipt.credentialState !== expectedPolicy.credentialState)
    ) {
      reasons.add("frontier_policy_binding_mismatch");
    }
    if (
      receipt.version !== 1 ||
      receipt.truncated ||
      receipt.mismatchCodes.length > 0 ||
      receipt.logicalCalls < 1 ||
      receipt.callSequences.length !== receipt.logicalCalls
    ) {
      reasons.add("frontier_receipt_structure_invalid");
    }
    const logicalCallBindingIds = receipt.callSequences.map(
      (sequence) => sequence.logicalCallBindingId,
    );
    if (
      logicalCallBindingIds.some((bindingId) => !/^[a-f0-9]{64}$/u.test(bindingId)) ||
      new Set(logicalCallBindingIds).size !== logicalCallBindingIds.length
    ) {
      reasons.add("frontier_logical_call_binding_invalid");
    }
    if (!/^[a-f0-9]{64}$/u.test(receipt.promptCacheKeyDigest)) {
      reasons.add("frontier_prompt_cache_key_digest_missing");
    } else {
      const expectedDigest = expectedPromptCacheKeyDigests?.get(result.id);
      if (expectedDigest && receipt.promptCacheKeyDigest !== expectedDigest) {
        reasons.add("frontier_prompt_cache_key_digest_mismatch");
      }
      const priorCell = cellByPromptCacheKeyDigest.get(receipt.promptCacheKeyDigest);
      if (priorCell && priorCell !== result.id) {
        reasons.add("frontier_prompt_cache_key_reused");
      }
      cellByPromptCacheKeyDigest.set(receipt.promptCacheKeyDigest, result.id);
    }
    let observedRequestCount = 0;
    let observedFetchDispatchCount = 0;
    let observedPayloadRecoveries = 0;
    const observedPayloadVariants = new Set<"initial" | "encrypted-content-retry">();
    for (const [callIndex, sequence] of receipt.callSequences.entries()) {
      const requestFetchDispatchCount = sequence.requests.reduce(
        (total, request) => total + request.fetchDispatchCount,
        0,
      );
      if (
        sequence.logicalCallOrdinal !== callIndex + 1 ||
        sequence.requestCount < 1 ||
        sequence.requestCount > 2 ||
        sequence.requestCount !== sequence.requests.length ||
        sequence.fetchDispatchCount !== requestFetchDispatchCount ||
        sequence.payloadVariants.length !== sequence.requests.length
      ) {
        reasons.add("frontier_receipt_structure_invalid");
      }
      for (const [requestIndex, request] of sequence.requests.entries()) {
        const expectedVariant =
          requestIndex === 0 ? "initial" : ("encrypted-content-retry" as const);
        if (
          request.requestOrdinal !== requestIndex + 1 ||
          request.payloadVariant !== expectedVariant ||
          sequence.payloadVariants[requestIndex] !== request.payloadVariant ||
          !Number.isInteger(request.fetchDispatchCount) ||
          request.fetchDispatchCount < 1
        ) {
          reasons.add("frontier_receipt_structure_invalid");
        }
        if (request.payloadVariant === "encrypted-content-retry") {
          observedPayloadRecoveries += 1;
        }
        observedPayloadVariants.add(request.payloadVariant);
        observedRequestCount += 1;
        observedFetchDispatchCount += request.fetchDispatchCount;
      }
    }
    if (
      observedRequestCount !== receipt.requestObservations ||
      observedFetchDispatchCount !== receipt.fetchDispatchObservations ||
      JSON.stringify([...observedPayloadVariants].toSorted()) !==
        JSON.stringify(receipt.payloadVariants)
    ) {
      reasons.add("frontier_receipt_structure_invalid");
    }
    const trace = result.trace;
    const sanitizedReceipt = trace?.frontierEvidence;
    const physicalFetchMetric = trace?.metrics.physicalFetchDispatch;
    const logicalCallMetric = trace?.metrics.logicalModelCalls;
    const initialAttemptMetric = trace?.metrics.providerAttempts.initial;
    const retryAttemptMetric = trace?.metrics.providerAttempts.retries;
    const authRecoveryMetric = trace?.metrics.providerAttempts.authRecoveries;
    const payloadRecoveryMetric = trace?.metrics.providerAttempts.payloadRecoveries;
    const transportFallbackMetric = trace?.metrics.providerAttempts.transportFallbacks;
    const providerAttemptMetric = trace?.metrics.providerAttempts.total;
    const toolOperationMetric = trace?.metrics.totalToolOperations;
    const underlyingCallMetric = trace?.metrics.underlyingTotalCalls;
    const expectedSanitizedSequences = receipt.callSequences.map((sequence) => ({
      logicalCallOrdinal: sequence.logicalCallOrdinal,
      requestCount: sequence.requestCount,
      fetchDispatchCount: sequence.fetchDispatchCount,
      payloadVariants: sequence.payloadVariants,
      requests: sequence.requests.map((request) => ({
        requestOrdinal: request.requestOrdinal,
        payloadVariant: request.payloadVariant,
        fetchDispatchCount: request.fetchDispatchCount,
      })),
    }));
    if (
      !sanitizedReceipt ||
      sanitizedReceipt.receiptCount !== 1 ||
      sanitizedReceipt.valid !== receipt.valid ||
      sanitizedReceipt.logicalCalls !== receipt.logicalCalls ||
      sanitizedReceipt.requestObservations !== receipt.requestObservations ||
      sanitizedReceipt.physicalFetchDispatch !== receipt.fetchDispatchObservations ||
      JSON.stringify(sanitizedReceipt.payloadVariants) !==
        JSON.stringify(receipt.payloadVariants) ||
      JSON.stringify(sanitizedReceipt.callSequences) !== JSON.stringify(expectedSanitizedSequences)
    ) {
      reasons.add("frontier_trace_receipt_mismatch");
    }
    if (
      physicalFetchMetric?.state !== "exact" ||
      physicalFetchMetric.value !== receipt.fetchDispatchObservations ||
      logicalCallMetric?.state !== "exact" ||
      logicalCallMetric.value !== receipt.logicalCalls ||
      initialAttemptMetric?.state !== "exact" ||
      initialAttemptMetric.value !== receipt.logicalCalls ||
      retryAttemptMetric?.state !== "exact" ||
      authRecoveryMetric?.state !== "exact" ||
      authRecoveryMetric.value !== 0 ||
      payloadRecoveryMetric?.state !== "exact" ||
      payloadRecoveryMetric.value !== observedPayloadRecoveries ||
      transportFallbackMetric?.state !== "exact" ||
      transportFallbackMetric.value !== 0 ||
      providerAttemptMetric?.state !== "exact" ||
      providerAttemptMetric.value !==
        initialAttemptMetric.value +
          retryAttemptMetric.value +
          authRecoveryMetric.value +
          payloadRecoveryMetric.value +
          transportFallbackMetric.value ||
      providerAttemptMetric.value > receipt.fetchDispatchObservations ||
      toolOperationMetric?.state !== "exact" ||
      underlyingCallMetric?.state !== "exact" ||
      underlyingCallMetric.value !== receipt.fetchDispatchObservations + toolOperationMetric.value
    ) {
      reasons.add("frontier_trace_transport_mismatch");
    }
    const requests = receipt.callSequences.flatMap((call) => call.requests);
    if (requests.length === 0) {
      reasons.add("frontier_request_digest_missing");
      continue;
    }
    const expectedTaskDigest = createHmac("sha256", Buffer.from(contentDigestKey, "hex"))
      .update("openclaw-frontier-task-v1\0")
      .update(taskPrompt(result.task), "utf8")
      .digest("hex");
    if (requests.some((request) => request.taskDigest !== expectedTaskDigest)) {
      reasons.add("frontier_task_digest_mismatch");
    }
    const pairKey = `${result.model}\0${result.task}\0${String(result.repetition)}`;
    const priorTask = taskByPair.get(pairKey);
    if (priorTask && priorTask !== requests[0]!.taskDigest) {
      reasons.add("frontier_cross_mode_task_instability");
    }
    taskByPair.set(pairKey, requests[0]!.taskDigest);
    const modeKey = `${result.model}\0${result.mode}\0${result.task}`;
    if (
      requests.some(
        (request) =>
          !/^[a-f0-9]{64}$/u.test(request.fullInputDigest) ||
          !/^[a-f0-9]{64}$/u.test(request.comparableInputDigest),
      )
    ) {
      reasons.add("frontier_request_digest_missing");
      continue;
    }
    const comparableInput = requests[0]!.comparableInputDigest;
    const priorComparableInput = comparableInputByMode.get(modeKey);
    if (priorComparableInput && priorComparableInput !== comparableInput) {
      reasons.add("frontier_within_mode_comparable_input_instability");
    }
    comparableInputByMode.set(modeKey, comparableInput);
    const schemaDigests = new Set(requests.map((request) => request.toolSchemaDigest));
    if (schemaDigests.size !== 1) {
      reasons.add("frontier_cell_tool_schema_instability");
      continue;
    }
    const schema = requests[0]!.toolSchemaDigest;
    const priorSchema = schemaByMode.get(modeKey);
    if (priorSchema && priorSchema !== schema) {
      reasons.add("frontier_within_mode_tool_schema_instability");
    }
    schemaByMode.set(modeKey, schema);
  }
  return { valid: reasons.size === 0, reasons: [...reasons].toSorted() };
}

function validateCellResultProvenance(params: {
  cell: MatrixCell;
  contentDigestKey: string;
  expectedBuildSha256: string;
  expectedConfigSha256: string | null;
  expectedPromptCacheKeyDigest: string;
  expectedPolicy: {
    authBindingId: string;
    credentialState: "frozen_in_memory";
    policySha256: string;
  };
  expectedSource: SourceIdentity;
  result: CodeModeMatrixCellResult;
}): string[] {
  const reasons = new Set<string>();
  if (params.result.buildSha256 !== params.expectedBuildSha256) {
    reasons.add("build_mismatch");
  }
  if (params.result.configSha256 !== params.expectedConfigSha256) {
    reasons.add("config_mismatch");
  }
  if (
    params.result.gitSha !== params.expectedSource.gitSha ||
    params.result.sourceDirty !== params.expectedSource.sourceDirty ||
    params.result.sourcePatchSha256 !== params.expectedSource.sourcePatchSha256
  ) {
    reasons.add("source_mismatch");
  }
  const expectedFixtureSha256 = createHash("sha256")
    .update(taskFixtureText(params.cell))
    .digest("hex");
  if (params.result.fixtureSha256 !== expectedFixtureSha256) {
    reasons.add("fixture_mismatch");
  }
  const expectedPromptSha256 = createHash("sha256")
    .update(taskPrompt(params.cell.task))
    .digest("hex");
  if (params.result.promptSha256 !== expectedPromptSha256) {
    reasons.add("prompt_mismatch");
  }
  if (params.result.workspaceIdentitySha256 !== workspaceIdentitySha256(params.cell)) {
    reasons.add("workspace_identity_mismatch");
  }
  const expectedWorkspaceSeedSha256 = workspaceSeedSha256([
    ["facts.txt", Buffer.from(taskFixtureText(params.cell), "utf8")],
  ]);
  if (params.result.workspaceSeedSha256 !== expectedWorkspaceSeedSha256) {
    reasons.add("workspace_seed_mismatch");
  }
  if (!params.result.trace) {
    reasons.add("trace_missing");
  } else {
    if (params.result.trace.schemaVersion !== 4) {
      reasons.add("trace_schema_unsupported");
    }
    if (params.result.trace.audit.state !== "valid") {
      reasons.add("trace_audit_invalid");
    }
  }
  if (
    params.result.firstLogicalCallCacheStatus !== classifyMatrixCacheStatus(params.result.trace)
  ) {
    reasons.add("first_logical_call_cache_status_mismatch");
  }
  const traceRoute = params.result.trace?.route;
  if (
    params.result.trace &&
    (!traceRoute ||
      traceRoute.provider !== params.result.observedProvider ||
      traceRoute.model !== params.result.observedModel)
  ) {
    reasons.add("trace_route_provenance_mismatch");
  }
  const receiptAudit = auditFrontierEvidenceReceipts(
    [params.result],
    params.contentDigestKey,
    new Map([[params.result.id, params.expectedPromptCacheKeyDigest]]),
    params.expectedPolicy,
  );
  for (const reason of receiptAudit.reasons) {
    reasons.add(reason);
  }
  return [...reasons].toSorted();
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${JSON.stringify(redactJsonValueForDevToolLog(value), null, 2)}\n`,
    "utf8",
  );
}

function evidenceStatus(result: CodeModeMatrixCellResult): QaEvidenceStatus {
  if (result.passed) {
    return "pass";
  }
  if (
    result.failureCategory === "provider_auth" ||
    result.failureCategory === "provider_billing" ||
    result.failureCategory === "provider_model_access"
  ) {
    return "blocked";
  }
  return "fail";
}

function observedModelRef(result: CodeModeMatrixCellResult): string {
  if (result.observedProvider && result.observedModel) {
    return `${result.observedProvider}/${result.observedModel}`;
  }
  return result.model;
}

export function buildCodeModeMatrixEvidence(params: {
  conversationProof?: MatrixConversationProofSummary;
  evidenceClass: MatrixEvidenceClass;
  generatedAt: string;
  model?: string;
  repoRoot: string;
  results: readonly CodeModeMatrixCellResult[];
}): QaEvidenceSummaryJson {
  if (params.evidenceClass === "diagnostic_only" && params.conversationProof) {
    throw new Error("diagnostic evidence cannot include frontier conversation proof");
  }
  const providerMode =
    params.evidenceClass === "diagnostic_only" ? "diagnostic-only" : "live-frontier";
  const artifactPaths = [
    { kind: "manifest", path: "manifest.json" },
    { kind: "summary", path: "summary.json" },
    { kind: "results", path: "results.jsonl" },
    ...(params.conversationProof
      ? [{ kind: "conversation-proof", path: "conversation-proof/summary.json" }]
      : []),
  ];
  const matrixEntries = params.results.flatMap((result) => {
    const physicalFetchDispatch = result.trace?.metrics.physicalFetchDispatch;
    const providerLive =
      Boolean(result.observedProvider && result.observedModel) &&
      physicalFetchDispatch?.state === "exact" &&
      physicalFetchDispatch.value > 0;
    const summary = buildScriptEvidenceSummary({
      artifactPaths,
      evidenceClass: params.evidenceClass,
      evidenceMode: "full",
      generatedAt: result.timestamp,
      packageSource: { kind: "source-checkout", sha: result.gitSha },
      primaryModel: observedModelRef(result),
      providerLive,
      providerMode,
      repoRoot: params.repoRoot,
      runner: "code-mode-model-matrix",
      targets: [
        {
          id: result.id,
          title: `${result.model} ${result.mode} ${result.task} repetition ${result.repetition}`,
          sourcePath: SOURCE_PATH,
        },
      ],
      results: [
        {
          id: result.id,
          status: evidenceStatus(result),
          durationMs: Math.max(1, result.wallLatencyMs ?? result.elapsedMs),
          failureMessage: result.failureCategory ?? undefined,
        },
      ],
    });
    const entry = summary.entries[0];
    if (!entry) {
      return [];
    }
    if (entry.result.failure && result.failureCategory) {
      entry.result.failure.class = result.failureCategory;
    }
    return [entry];
  });
  const conversationProofEntries = params.conversationProof
    ? (() => {
        const proof = params.conversationProof;
        const summary = buildScriptEvidenceSummary({
          artifactPaths,
          evidenceClass: params.evidenceClass,
          evidenceMode: "full",
          generatedAt: params.generatedAt,
          packageSource: {
            kind: "source-checkout",
            ...(proof.gitSha ? { sha: proof.gitSha } : {}),
          },
          primaryModel: params.model ?? "unknown/unknown",
          providerMode,
          repoRoot: params.repoRoot,
          runner: "code-mode-model-matrix",
          targets: [
            {
              id: "conversation-proof",
              title: "Code Mode conversation authority proof",
              sourcePath: SOURCE_PATH,
            },
          ],
          results: [
            {
              id: "conversation-proof",
              status:
                proof.status === "pass" ? "pass" : proof.status === "blocked" ? "blocked" : "fail",
              durationMs: Math.max(
                1,
                proof.cells?.reduce<number>(
                  (total, cell) =>
                    total + (typeof cell.elapsedMs === "number" ? cell.elapsedMs : 0),
                  0,
                ) ?? 0,
              ),
              failureMessage:
                proof.status === "pass"
                  ? undefined
                  : (proof.failureCode ??
                    proof.blockedReasons?.join(",") ??
                    "conversation_proof_failed"),
            },
          ],
        });
        const entry = summary.entries[0];
        if (entry?.result.failure && proof.failureCode) {
          entry.result.failure.class = proof.failureCode;
        }
        return entry ? [entry] : [];
      })()
    : [];
  const base = buildScriptEvidenceSummary({
    artifactPaths,
    evidenceClass: params.evidenceClass,
    evidenceMode: "full",
    generatedAt: params.generatedAt,
    packageSource: { kind: "source-checkout" },
    primaryModel: "unknown/unknown",
    providerMode,
    repoRoot: params.repoRoot,
    runner: "code-mode-model-matrix",
    targets: [],
    results: [],
  });
  return validateQaEvidenceSummaryJson({
    ...base,
    entries: [...matrixEntries, ...conversationProofEntries],
  });
}

function buildCodeModeMatrixPreflightEvidence(params: {
  conversationProof: boolean;
  generatedAt: string;
  gitSha: string;
  model: string;
  reasons: readonly string[];
  repoRoot: string;
}): QaEvidenceSummaryJson {
  const base = buildScriptEvidenceSummary({
    artifactPaths: [
      { kind: "manifest", path: "manifest.json" },
      { kind: "summary", path: "summary.json" },
      { kind: "results", path: "results.jsonl" },
    ],
    evidenceClass: "frontier_beta_qualification",
    evidenceMode: "full",
    generatedAt: params.generatedAt,
    packageSource: { kind: "source-checkout", sha: params.gitSha },
    primaryModel: params.model,
    providerMode: "live-frontier",
    repoRoot: params.repoRoot,
    runner: "code-mode-model-matrix",
    targets: [
      {
        id: "matrix-preflight",
        title: "Code Mode frontier matrix preflight",
        sourcePath: SOURCE_PATH,
      },
    ],
    results: [
      {
        id: "matrix-preflight",
        status: "blocked",
        durationMs: 1,
        failureMessage: params.reasons.join(","),
      },
    ],
  });
  if (!params.conversationProof) {
    return base;
  }
  const conversation = buildScriptEvidenceSummary({
    artifactPaths: [
      { kind: "manifest", path: "manifest.json" },
      { kind: "summary", path: "summary.json" },
      { kind: "results", path: "results.jsonl" },
      { kind: "conversation-proof", path: "conversation-proof/summary.json" },
    ],
    evidenceClass: "frontier_beta_qualification",
    evidenceMode: "full",
    generatedAt: params.generatedAt,
    packageSource: { kind: "source-checkout", sha: params.gitSha },
    primaryModel: params.model,
    providerMode: "live-frontier",
    repoRoot: params.repoRoot,
    runner: "code-mode-model-matrix",
    targets: [
      {
        id: "conversation-proof",
        title: "Code Mode conversation authority proof",
        sourcePath: SOURCE_PATH,
      },
    ],
    results: [
      {
        id: "conversation-proof",
        status: "blocked",
        durationMs: 1,
        failureMessage: params.reasons.join(","),
      },
    ],
  });
  return validateQaEvidenceSummaryJson({
    ...base,
    entries: [...base.entries, ...conversation.entries],
  });
}

async function readDiagnosticConfigSha256(configPath: string | undefined): Promise<string | null> {
  return (await readPinnedConfigSnapshot(configPath)).sha256;
}

async function auditDiagnosticMatrixIdentity(params: {
  expected: {
    buildSha256: string;
    configSha256: string | null;
    source: SourceIdentity;
  };
  readBuildSha256: () => Promise<string>;
  readConfigSha256: () => Promise<string | null>;
  readSourceIdentity: () => Promise<SourceIdentity>;
}): Promise<string[]> {
  const reasons = new Set<string>();
  const [source, config, build] = await Promise.allSettled([
    params.readSourceIdentity(),
    params.readConfigSha256(),
    params.readBuildSha256(),
  ]);
  if (
    source.status === "fulfilled" &&
    (source.value.gitSha !== params.expected.source.gitSha ||
      source.value.sourceDirty !== params.expected.source.sourceDirty ||
      source.value.sourcePatchSha256 !== params.expected.source.sourcePatchSha256)
  ) {
    reasons.add("source_mismatch");
  }
  if (config.status === "fulfilled" && config.value !== params.expected.configSha256) {
    reasons.add("config_mismatch");
  }
  if (build.status === "fulfilled" && build.value !== params.expected.buildSha256) {
    reasons.add("build_mismatch");
  }
  if ([source, config, build].some((result) => result.status === "rejected")) {
    reasons.add("identity_recheck_failed");
  }
  return [...reasons].toSorted();
}

function validateDiagnosticResultProvenance(params: {
  cell: MatrixCell;
  expected: {
    buildSha256: string;
    configSha256: string | null;
    source: SourceIdentity;
  };
  result: CodeModeMatrixCellResult;
}): string[] {
  const reasons = new Set<string>();
  if (params.result.buildSha256 !== params.expected.buildSha256) {
    reasons.add("build_mismatch");
  }
  if (params.result.configSha256 !== params.expected.configSha256) {
    reasons.add("config_mismatch");
  }
  if (
    params.result.gitSha !== params.expected.source.gitSha ||
    params.result.sourceDirty !== params.expected.source.sourceDirty ||
    params.result.sourcePatchSha256 !== params.expected.source.sourcePatchSha256
  ) {
    reasons.add("source_mismatch");
  }
  if (
    params.result.id !== params.cell.id ||
    params.result.model !== params.cell.model ||
    params.result.mode !== params.cell.mode ||
    params.result.repetition !== params.cell.repetition ||
    params.result.task !== params.cell.task
  ) {
    reasons.add("cell_identity_mismatch");
  }
  return [...reasons].toSorted();
}

async function runDiagnosticCodeModeModelMatrix(params: {
  cells: MatrixCell[];
  deps: MatrixRunDependencies;
  now: Date;
  nowMs: () => number;
  options: CodeModeMatrixOptions;
  outputDir: string;
  readCurrentSourceIdentity: () => Promise<SourceIdentity>;
  resultsPath: string;
  sourceIdentity: SourceIdentity;
}): Promise<{ exitCode: number; outputDir: string; summary: unknown }> {
  const {
    cells,
    deps,
    now,
    nowMs,
    options,
    outputDir,
    readCurrentSourceIdentity,
    resultsPath,
    sourceIdentity,
  } = params;
  const configSnapshot = await readPinnedConfigSnapshot(options.config);
  const configSha256 = configSnapshot.sha256;
  if (!options.dryRun) {
    await (deps.buildCliArtifacts ?? buildMatrixCliArtifacts)(options.repoRoot);
  }
  const readBuildIdentity = deps.readBuildSha256 ?? hashRuntimeArtifacts;
  const buildSha256 = options.dryRun ? null : await readBuildIdentity(options.repoRoot);
  const qualification = matrixQualification({
    conversationProof: false,
    model: options.models[0]!,
  });
  const manifest = {
    schemaVersion: MATRIX_SCHEMA_VERSION,
    status: options.dryRun ? "dry-run" : "ready",
    evidenceClass: "diagnostic_only" as const,
    qualification,
    generatedAt: now.toISOString(),
    source: SOURCE_PATH,
    ...sourceIdentity,
    buildSha256,
    config: configSha256
      ? { state: "pinned" as const, sha256: configSha256 }
      : { state: "ambient" as const, sha256: null },
    models: options.models,
    modes: options.modes,
    tasks: options.tasks,
    repetitions: options.repetitions,
    timeoutSeconds: options.timeoutSeconds,
    thinking: options.thinking,
    keepState: options.keepState,
    plannedExecutions: {
      matrix: cells.length,
      conversationProof: 0,
      total: cells.length,
    },
    cells: cells.map((cell) => cell.id),
  };
  await writeJson(path.join(outputDir, "manifest.json"), manifest);
  if (options.dryRun) {
    const summary = {
      schemaVersion: MATRIX_SCHEMA_VERSION,
      status: "dry-run" as const,
      evidenceClass: "diagnostic_only" as const,
      qualification,
      cellsExecuted: 0,
      plannedExecutions: manifest.plannedExecutions,
      totalPlanned: cells.length,
    };
    await writeJson(path.join(outputDir, "summary.json"), summary);
    await writeJson(
      path.join(outputDir, QA_EVIDENCE_FILENAME),
      buildCodeModeMatrixEvidence({
        evidenceClass: "diagnostic_only",
        generatedAt: now.toISOString(),
        model: options.models[0],
        repoRoot: options.repoRoot,
        results: [],
      }),
    );
    return { exitCode: 0, outputDir, summary };
  }

  const campaignRoot = path.join(outputDir, "runtime", "campaign");
  const runtimeRoot = deps.runCell
    ? undefined
    : await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-runtime-"));
  try {
    const runtime = runtimeRoot
      ? await prepareRuntimeEntrypoint(options.repoRoot, runtimeRoot)
      : undefined;
    if (runtime && buildSha256) {
      const runtimeBuildSha256 = await hashRuntimeArtifacts(options.repoRoot);
      if (runtimeBuildSha256 !== buildSha256) {
        throw new Error(
          `prepared runtime build mismatch: expected ${buildSha256}, observed ${runtimeBuildSha256}`,
        );
      }
    }
    const results: CodeModeMatrixCellResult[] = [];
    const executeCell = deps.runCell ?? runMatrixCell;
    const auditIdentity = async () =>
      await auditDiagnosticMatrixIdentity({
        expected: {
          buildSha256: buildSha256!,
          configSha256,
          source: sourceIdentity,
        },
        readBuildSha256: async () => await readBuildIdentity(options.repoRoot),
        readConfigSha256: async () => await readDiagnosticConfigSha256(options.config),
        readSourceIdentity: readCurrentSourceIdentity,
      });
    for (const cell of cells) {
      const cellStartedAt = nowMs();
      let result: CodeModeMatrixCellResult;
      let proofDrift = false;
      try {
        const identityReasons = await auditIdentity();
        if (identityReasons.length > 0) {
          throw new MatrixPreflightError(identityReasons[0]!);
        }
        result = await executeCell({
          buildSha256: buildSha256 ?? "dry-run",
          campaignRoot,
          cell,
          configPath: options.config,
          configSha256,
          config: configSnapshot.effective,
          frozenEnv: buildCodeModeMatrixAgentEnv(
            cell.model,
            runtime?.cwd ?? options.repoRoot,
            process.env,
            configSnapshot.effective,
            Object.keys(process.env),
          ),
          gitSha: sourceIdentity.gitSha,
          keepState: options.keepState,
          outputDir,
          repoRoot: options.repoRoot,
          runtime,
          sourceDirty: sourceIdentity.sourceDirty,
          sourcePatchSha256: sourceIdentity.sourcePatchSha256,
          thinking: options.thinking,
          timeoutSeconds: options.timeoutSeconds,
        });
      } catch (error) {
        if (error instanceof MatrixPreflightError) {
          proofDrift = true;
          result = proofDriftResult(
            cell,
            {
              buildSha256: buildSha256 ?? "dry-run",
              configSha256,
              ...sourceIdentity,
            },
            nowMs() - cellStartedAt,
            error,
          );
        } else {
          result = harnessFailureResult(
            cell,
            {
              buildSha256: buildSha256 ?? "dry-run",
              configSha256,
              ...sourceIdentity,
            },
            nowMs() - cellStartedAt,
            error,
          );
        }
      }
      const provenanceReasons = validateDiagnosticResultProvenance({
        cell,
        expected: {
          buildSha256: buildSha256 ?? "dry-run",
          configSha256,
          source: sourceIdentity,
        },
        result,
      });
      if (provenanceReasons.length > 0) {
        proofDrift = true;
        result = preserveResultAsProofDrift(
          result,
          nowMs() - cellStartedAt,
          new MatrixPreflightError(provenanceReasons[0]!),
        );
      }
      const postRunReasons = await auditIdentity();
      if (postRunReasons.length > 0) {
        proofDrift = true;
        result = preserveResultAsProofDrift(
          result,
          nowMs() - cellStartedAt,
          new MatrixPreflightError(postRunReasons[0]!),
        );
      }
      result = {
        ...result,
        evidenceClass: "diagnostic_only",
        wallLatencyMs: nowMs() - cellStartedAt,
        wallLatencyMeasurement: "matrix_monotonic_elapsed",
      };
      results.push(result);
      await fs.appendFile(
        resultsPath,
        `${JSON.stringify(redactJsonValueForDevToolLog(result))}\n`,
        "utf8",
      );
      const label = result.passed ? "PASS" : `FAIL ${result.failureCategory ?? "unknown"}`;
      console.log(
        `[code-mode-matrix] ${label} ${result.id} ${result.wallLatencyMs ?? result.elapsedMs}ms`,
      );
      if (proofDrift) {
        console.log("[code-mode-matrix] stopping after diagnostic identity drift");
        break;
      }
    }

    const groups = summarizeResults(results);
    const failed = results.filter((result) => !result.passed).length;
    const summary = {
      schemaVersion: MATRIX_SCHEMA_VERSION,
      status: "complete" as const,
      evidenceClass: "diagnostic_only" as const,
      qualification,
      finishedAt: new Date().toISOString(),
      ...sourceIdentity,
      buildSha256,
      counts: {
        total: results.length,
        passed: results.length - failed,
        failed,
      },
      groupCounts: {
        total: groups.length,
        firstPassPassed: groups.filter((group) => group.firstPassPassed).length,
        eventualPassed: groups.filter((group) => group.eventualPassed).length,
      },
      groups,
    };
    await writeJson(path.join(outputDir, "summary.json"), summary);
    await writeJson(path.join(outputDir, "manifest.json"), {
      ...manifest,
      status: summary.status,
    });
    await writeJson(
      path.join(outputDir, QA_EVIDENCE_FILENAME),
      buildCodeModeMatrixEvidence({
        evidenceClass: "diagnostic_only",
        generatedAt: summary.finishedAt,
        model: options.models[0],
        repoRoot: options.repoRoot,
        results,
      }),
    );
    return {
      exitCode: failed > 0 && !options.allowFailures ? 1 : 0,
      outputDir,
      summary,
    };
  } finally {
    await fs.rm(campaignRoot, { force: true, recursive: true });
    if (runtimeRoot) {
      await fs.rm(runtimeRoot, { force: true, recursive: true });
    }
  }
}

export async function runCodeModeModelMatrix(
  options: CodeModeMatrixOptions,
  deps: MatrixRunDependencies = {},
): Promise<{ exitCode: number; outputDir: string; summary: unknown }> {
  const now = deps.now?.() ?? new Date();
  const nowMs = deps.nowMs ?? performance.now.bind(performance);
  const outputDir = resolveCodeModeMatrixOutputDir(options.repoRoot, options.outputDir, now);
  const resolveSourceIdentity = async (): Promise<SourceIdentity> =>
    deps.readSourceIdentity
      ? await deps.readSourceIdentity(options.repoRoot)
      : deps.readGitSha
        ? {
            gitSha: await deps.readGitSha(options.repoRoot),
            sourceDirty: false,
            sourcePatchSha256: null,
          }
        : await readSourceIdentity(options.repoRoot, outputDir);
  const sourceIdentity = await resolveSourceIdentity();
  const cells = buildCodeModeMatrixCells(options);
  const evidenceClass = matrixEvidenceClass(options.conversationProof);
  await assertOutputOutsideGitMetadata(options.repoRoot, outputDir);
  await assertOutputOutsideRuntimeArtifacts(options.repoRoot, outputDir);
  await reserveCodeModeMatrixOutputDir(options.repoRoot, outputDir);
  const resultsPath = path.join(outputDir, "results.jsonl");
  await fs.writeFile(resultsPath, "", "utf8");
  const authBindingId = randomBytes(16).toString("hex");

  if (!options.conversationProof) {
    return await runDiagnosticCodeModeModelMatrix({
      cells,
      deps,
      now,
      nowMs,
      options,
      outputDir,
      readCurrentSourceIdentity: resolveSourceIdentity,
      resultsPath,
      sourceIdentity,
    });
  }

  let configSnapshot: PinnedConfigSnapshot = {
    effective: undefined,
    parsed: undefined,
    sha256: null,
  };
  let preflight: MatrixPreflight;
  try {
    configSnapshot = await readPinnedConfigSnapshot(options.config);
    preflight =
      options.conversationProof && options.models.length !== 1
        ? { blockedReasons: ["frontier_model_cardinality_invalid"] }
        : await evaluateFrontierMatrixPreflight({
            config: configSnapshot.effective,
            configSha256: configSnapshot.sha256,
            model: options.models[0]!,
            modes: options.modes,
            repetitions: options.repetitions,
            thinking: options.thinking,
            authBindingId,
            requireCredentialValue: true,
            readAuthProfile: deps.readAuthProfile ?? readMatrixAuthProfile,
          });
  } catch (error) {
    preflight = {
      blockedReasons: [
        error instanceof MatrixPreflightError ? error.code : "config_effective_load_failed",
      ],
    };
  }
  if (options.conversationProof) {
    const exactSchedule =
      options.modes.length === 2 &&
      options.modes[0] === "direct" &&
      options.modes[1] === "code" &&
      options.tasks.length === 1 &&
      options.tasks[0] === "dependent-read-write" &&
      options.repetitions === 2 &&
      options.thinking === "high";
    if (!exactSchedule) {
      preflight.blockedReasons = [
        ...preflight.blockedReasons,
        "conversation_proof_schedule_invalid",
      ].toSorted();
    }
  }
  if (sourceIdentity.sourceDirty) {
    preflight.blockedReasons = [...preflight.blockedReasons, "frontier_source_dirty"].toSorted();
  }
  const configSha256 = configSnapshot.sha256;
  if (preflight.blockedReasons.length > 0 || !preflight.executionPolicy) {
    const reasons =
      preflight.blockedReasons.length > 0 ? preflight.blockedReasons : ["proof_policy_changed"];
    const manifest = {
      schemaVersion: MATRIX_SCHEMA_VERSION,
      status: "blocked",
      evidenceClass,
      qualification: matrixQualification({
        conversationProof: options.conversationProof,
        model: options.models[0]!,
      }),
      generatedAt: now.toISOString(),
      source: SOURCE_PATH,
      ...sourceIdentity,
      buildSha256: null,
      config: configSha256
        ? { state: "pinned", sha256: configSha256 }
        : { state: "unavailable", sha256: null },
      model: options.models[0],
      blockedReasons: reasons,
      plannedExecutions: {
        matrix: cells.length,
        conversationProof: options.conversationProof ? 3 : 0,
        total: cells.length + (options.conversationProof ? 3 : 0),
      },
      cells: [],
    };
    const summary = {
      schemaVersion: MATRIX_SCHEMA_VERSION,
      status: "blocked",
      evidenceClass,
      qualification: matrixQualification({
        conversationProof: options.conversationProof,
        model: options.models[0]!,
      }),
      finishedAt: now.toISOString(),
      ...sourceIdentity,
      buildSha256: null,
      cellsExecuted: 0,
      blockedReasons: reasons,
      counts: { total: 0, passed: 0, failed: 0 },
    };
    await writeJson(path.join(outputDir, "manifest.json"), manifest);
    await writeJson(path.join(outputDir, "summary.json"), summary);
    if (options.conversationProof) {
      await writeJson(path.join(outputDir, "conversation-proof", "summary.json"), {
        schemaVersion: 4,
        evidenceClass,
        status: "blocked",
        blockedReasons: reasons,
        counts: { total: 0, passed: 0, failed: 0 },
      });
    }
    await writeJson(
      path.join(outputDir, QA_EVIDENCE_FILENAME),
      buildCodeModeMatrixPreflightEvidence({
        conversationProof: options.conversationProof,
        generatedAt: now.toISOString(),
        gitSha: sourceIdentity.gitSha,
        model: options.models[0]!,
        reasons,
        repoRoot: options.repoRoot,
      }),
    );
    return { exitCode: 1, outputDir, summary };
  }

  if (!options.dryRun) {
    await (deps.buildCliArtifacts ?? buildMatrixCliArtifacts)(options.repoRoot);
  }
  const readBuildIdentity = deps.readBuildSha256 ?? hashRuntimeArtifacts;
  const buildSha256 = options.dryRun ? null : await readBuildIdentity(options.repoRoot);
  const manifest = {
    schemaVersion: MATRIX_SCHEMA_VERSION,
    status: options.dryRun ? "dry-run" : "ready",
    evidenceClass,
    qualification: matrixQualification({
      codeModeCapabilityAttested: isFrontierCodeModeCapabilityReceipt(
        preflight.executionPolicy.codeModeCapability,
        options.models[0]!,
      ),
      conversationProof: options.conversationProof,
      model: options.models[0]!,
    }),
    generatedAt: now.toISOString(),
    source: SOURCE_PATH,
    ...sourceIdentity,
    buildSha256,
    config: configSha256
      ? { state: "pinned", sha256: configSha256 }
      : { state: "ambient", sha256: null },
    executionPolicy: publicMatrixExecutionPolicy(preflight.executionPolicy),
    model: options.models[0],
    modes: options.modes,
    tasks: options.tasks,
    repetitions: options.repetitions,
    timeoutSeconds: options.timeoutSeconds,
    thinking: options.thinking,
    keepState: options.keepState,
    plannedExecutions: {
      matrix: cells.length,
      conversationProof: options.conversationProof ? 3 : 0,
      total: cells.length + (options.conversationProof ? 3 : 0),
    },
    cells: cells.map((cell) => cell.id),
  };
  await writeJson(path.join(outputDir, "manifest.json"), manifest);
  if (options.dryRun) {
    const plannedExecutions = {
      matrix: cells.length,
      conversationProof: options.conversationProof ? 3 : 0,
      total: cells.length + (options.conversationProof ? 3 : 0),
    };
    const summary = {
      schemaVersion: MATRIX_SCHEMA_VERSION,
      status: "dry-run",
      evidenceClass,
      qualification: matrixQualification({
        codeModeCapabilityAttested: isFrontierCodeModeCapabilityReceipt(
          preflight.executionPolicy.codeModeCapability,
          options.models[0]!,
        ),
        conversationProof: options.conversationProof,
        model: options.models[0]!,
      }),
      cellsExecuted: 0,
      plannedExecutions,
      totalPlanned: plannedExecutions.total,
      executionPolicy: publicMatrixExecutionPolicy(preflight.executionPolicy),
    };
    await writeJson(path.join(outputDir, "summary.json"), summary);
    const dryRunConversationProof = options.conversationProof
      ? ({
          status: "blocked",
          blockedReasons: ["conversation_proof_not_executed_dry_run"],
        } satisfies MatrixConversationProofSummary)
      : undefined;
    if (dryRunConversationProof) {
      await writeJson(path.join(outputDir, "conversation-proof", "summary.json"), {
        schemaVersion: 4,
        evidenceClass,
        ...dryRunConversationProof,
        counts: { total: 0, passed: 0, failed: 0 },
      });
    }
    await writeJson(
      path.join(outputDir, QA_EVIDENCE_FILENAME),
      buildCodeModeMatrixEvidence({
        evidenceClass,
        ...(dryRunConversationProof ? { conversationProof: dryRunConversationProof } : {}),
        generatedAt: now.toISOString(),
        model: options.models[0],
        repoRoot: options.repoRoot,
        results: [],
      }),
    );
    return { exitCode: 0, outputDir, summary };
  }

  const frozenEnv = buildFrozenOperationalEnv(process.env);
  frozenEnv[preflight.executionPolicy.credentialEnvName] = preflight.credentialValue;
  delete frozenEnv.NODE_COMPILE_CACHE;
  const contentDigestKey = randomBytes(32).toString("hex");
  const runNonceByCell = new Map(
    cells.map((cell) => [cell.id, matrixCellRunNonce(contentDigestKey, cell.id)]),
  );
  const promptCacheKeyDigestByCell = new Map(
    cells.map((cell) => {
      const runNonce = runNonceByCell.get(cell.id)!;
      return [cell.id, promptCacheKeyDigest(contentDigestKey, runNonce)];
    }),
  );
  const policyFile = await createFrontierEvidencePolicyFile({
    contentDigestKey,
    configSha256: configSha256!,
    executionPolicy: preflight.executionPolicy,
  });
  const readPolicySha256 =
    deps.readPolicySha256 ??
    (async (policyPath: string) =>
      createHash("sha256")
        .update(await fs.readFile(policyPath))
        .digest("hex"));
  const auditFrozenIdentity = async () =>
    await auditFrozenMatrixIdentity({
      expected: {
        buildSha256: buildSha256!,
        configSha256,
        policySha256: policyFile.sha256,
        source: sourceIdentity,
      },
      readBuildSha256: async () => await readBuildIdentity(options.repoRoot),
      readConfigSha256: async () => (await readPinnedConfigSnapshot(options.config)).sha256,
      readPolicySha256: async () => await readPolicySha256(policyFile.path),
      readSourceIdentity: resolveSourceIdentity,
    });
  const campaignRoot = path.join(outputDir, "runtime", "campaign");
  const runtimeRoot = deps.runCell
    ? undefined
    : await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-runtime-"));
  try {
    const runtime = runtimeRoot
      ? await prepareRuntimeEntrypoint(options.repoRoot, runtimeRoot)
      : undefined;
    if (runtime && buildSha256) {
      const runtimeBuildSha256 = await hashRuntimeArtifacts(options.repoRoot);
      if (runtimeBuildSha256 !== buildSha256) {
        throw new Error(
          `prepared runtime build mismatch: expected ${buildSha256}, observed ${runtimeBuildSha256}`,
        );
      }
    }
    const results: CodeModeMatrixCellResult[] = [];
    let runBlockedReason: string | undefined;
    const executeCell = deps.runCell ?? runMatrixCell;
    for (const cell of cells) {
      const frontierEvidenceRunNonce = runNonceByCell.get(cell.id)!;
      const expectedPromptCacheKeyDigest = promptCacheKeyDigestByCell.get(cell.id)!;
      let result: CodeModeMatrixCellResult;
      let proofDrift = false;
      const cellStartedAt = nowMs();
      try {
        const identityReasons = await auditFrozenIdentity();
        if (identityReasons.length > 0) {
          throw new MatrixPreflightError(identityReasons[0]!);
        }
        const observedConfig = await readPinnedConfigSnapshot(options.config);
        const observedPreflight = await evaluateFrontierMatrixPreflight({
          config: observedConfig.effective,
          configSha256: observedConfig.sha256,
          model: options.models[0]!,
          modes: options.modes,
          repetitions: options.repetitions,
          thinking: options.thinking,
          authBindingId,
          requireCredentialValue: false,
          readAuthProfile: deps.readAuthProfile ?? readMatrixAuthProfile,
        });
        if (observedPreflight.blockedReasons.length > 0) {
          throw new MatrixPreflightError(observedPreflight.blockedReasons[0]!);
        }
        if (
          JSON.stringify(observedPreflight.executionPolicy) !==
          JSON.stringify(preflight.executionPolicy)
        ) {
          throw new MatrixPreflightError("proof_policy_changed");
        }
        result = await executeCell({
          buildSha256: buildSha256 ?? "dry-run",
          campaignRoot,
          cell,
          config: configSnapshot.effective,
          configPath: options.config,
          configSha256,
          frozenEnv,
          frontierEvidencePolicy: {
            path: policyFile.path,
            sha256: policyFile.sha256,
          },
          frontierEvidenceRunNonce,
          gitSha: sourceIdentity.gitSha,
          keepState: options.keepState,
          outputDir,
          repoRoot: options.repoRoot,
          runtime,
          sourceDirty: sourceIdentity.sourceDirty,
          sourcePatchSha256: sourceIdentity.sourcePatchSha256,
          thinking: options.thinking,
          timeoutSeconds: options.timeoutSeconds,
        });
      } catch (error) {
        const provenance = {
          buildSha256: buildSha256 ?? "dry-run",
          configSha256,
          ...sourceIdentity,
        };
        if (error instanceof MatrixPreflightError) {
          proofDrift = true;
          result = proofDriftResult(cell, provenance, nowMs() - cellStartedAt, error);
        } else {
          result = harnessFailureResult(cell, provenance, nowMs() - cellStartedAt, error);
        }
      }
      const provenanceReasons = new Set(
        validateCellResultProvenance({
          cell,
          contentDigestKey,
          expectedBuildSha256: buildSha256 ?? "dry-run",
          expectedConfigSha256: configSha256,
          expectedPromptCacheKeyDigest,
          expectedPolicy: {
            authBindingId,
            credentialState: "frozen_in_memory",
            policySha256: policyFile.sha256,
          },
          expectedSource: sourceIdentity,
          result,
        }),
      );
      for (const reason of auditFrontierEvidenceReceipts(
        [...results, result],
        contentDigestKey,
        promptCacheKeyDigestByCell,
        {
          authBindingId,
          credentialState: "frozen_in_memory",
          policySha256: policyFile.sha256,
        },
      ).reasons) {
        provenanceReasons.add(reason);
      }
      if (provenanceReasons.size > 0) {
        proofDrift = true;
        result = preserveResultAsProofDrift(
          result,
          nowMs() - cellStartedAt,
          new MatrixPreflightError([...provenanceReasons].toSorted()[0]!),
        );
      }
      const postRunReasons = await auditFrozenIdentity();
      if (postRunReasons.length > 0) {
        proofDrift = true;
        result = preserveResultAsProofDrift(
          result,
          nowMs() - cellStartedAt,
          new MatrixPreflightError(postRunReasons[0]!),
        );
      }
      result = {
        ...result,
        evidenceClass: matrixEvidenceClass(options.conversationProof),
        wallLatencyMs: nowMs() - cellStartedAt,
        wallLatencyMeasurement: "matrix_monotonic_elapsed",
      };
      results.push(result);
      await fs.appendFile(
        resultsPath,
        `${JSON.stringify(redactJsonValueForDevToolLog(result))}\n`,
        "utf8",
      );
      const label = result.passed ? "PASS" : `FAIL ${result.failureCategory ?? "unknown"}`;
      console.log(
        `[code-mode-matrix] ${label} ${result.id} ${result.wallLatencyMs ?? result.elapsedMs}ms`,
      );
      if (proofDrift) {
        runBlockedReason = result.error?.kind ?? result.failureCategory ?? "proof_drift";
        console.log("[code-mode-matrix] stopping after proof policy drift");
        break;
      }
      if (
        result.failureCategory === "provider_auth" ||
        result.failureCategory === "provider_billing" ||
        result.failureCategory === "provider_model_access"
      ) {
        runBlockedReason = result.failureCategory;
        console.log(`[code-mode-matrix] stopping after ${result.failureCategory}`);
        break;
      }
    }

    const groups = summarizeResults(results);
    const failed = results.filter((result) => !result.passed).length;
    const firstPassPassed = groups.filter((group) => group.firstPassPassed).length;
    const eventualPassed = groups.filter((group) => group.eventualPassed).length;
    const frontierEvidenceAudit = auditFrontierEvidenceReceipts(
      results,
      contentDigestKey,
      promptCacheKeyDigestByCell,
      {
        authBindingId,
        credentialState: "frozen_in_memory",
        policySha256: policyFile.sha256,
      },
    );
    const betaGate = buildCodeModeMatrixBetaGate(results);
    const betaGateBlockingReasons = Object.entries(betaGate.bars)
      .filter(([, state]) => state !== "pass")
      .map(([bar, state]) => `beta_gate_${bar}_${state}`)
      .toSorted();
    let conversationProof: MatrixConversationProofSummary | undefined;
    if (options.conversationProof) {
      const blockedReasons: string[] = [];
      if (runBlockedReason) {
        blockedReasons.push(runBlockedReason);
      }
      if (results.length !== cells.length) {
        blockedReasons.push("abba_incomplete");
      }
      if (!frontierEvidenceAudit.valid) {
        blockedReasons.push("frontier_receipts_invalid");
      }
      blockedReasons.push(...betaGateBlockingReasons);
      blockedReasons.push(...(await auditFrozenIdentity()));
      if (!configSnapshot.effective || !configSha256 || !buildSha256) {
        blockedReasons.push("frozen_identity_unavailable");
      }
      if (blockedReasons.length > 0) {
        conversationProof = { status: "blocked", blockedReasons: blockedReasons.toSorted() };
        await fs.mkdir(path.join(outputDir, "conversation-proof"), { recursive: true });
        await writeJson(
          path.join(outputDir, "conversation-proof", "summary.json"),
          conversationProof,
        );
      } else {
        const runConversationProof =
          deps.runConversationProof ?? runCodeModeMatrixConversationProof;
        conversationProof = await runConversationProof({
          buildSha256: buildSha256!,
          config: configSnapshot.effective!,
          configSha256: configSha256!,
          executionPolicy: preflight.executionPolicy,
          frozenEnv,
          gitSha: sourceIdentity.gitSha,
          model: options.models[0]!,
          outputDir,
          repoRoot: options.repoRoot,
        });
        const postConversationReasons = await auditFrozenIdentity();
        if (postConversationReasons.length > 0) {
          conversationProof = {
            ...conversationProof,
            status: "blocked",
            observedStatus: conversationProof.status,
            blockedReasons: postConversationReasons,
          };
          runBlockedReason ??= postConversationReasons[0];
          await writeJson(
            path.join(outputDir, "conversation-proof", "summary.json"),
            conversationProof,
          );
        }
      }
    }
    let conversationProofAttested = isAttestedPassingConversationProof(conversationProof, {
      buildSha256: buildSha256!,
      configSha256: configSha256!,
      executionPolicy: preflight.executionPolicy,
      gitSha: sourceIdentity.gitSha,
      model: options.models[0]!,
    });
    if (conversationProof?.status === "pass" && !conversationProofAttested) {
      conversationProof = {
        ...conversationProof,
        status: "fail",
        observedStatus: "pass",
        failureCode: "conversation_proof_attestation_invalid",
      };
      await writeJson(
        path.join(outputDir, "conversation-proof", "summary.json"),
        conversationProof,
      );
      conversationProofAttested = false;
    }
    const summaryStatus = runBlockedReason
      ? ("blocked" as const)
      : betaGate.state === "blocked" || conversationProof?.status === "fail"
        ? ("fail" as const)
        : betaGate.state === "inconclusive" || conversationProof?.status === "blocked"
          ? ("blocked" as const)
          : ("complete" as const);
    const qualification = matrixQualification({
      betaGate,
      codeModeActivationAttested:
        preflight.executionPolicy.codeModeActivation === "explicit_frozen_run_config",
      codeModeCapabilityAttested: isFrontierCodeModeCapabilityReceipt(
        preflight.executionPolicy.codeModeCapability,
        options.models[0]!,
      ),
      conversationProof: options.conversationProof,
      conversationProofAttested,
      expectedCells: cells.length,
      frontierEvidenceValid: frontierEvidenceAudit.valid,
      model: options.models[0]!,
      resultsExecuted: results.length,
      ...(conversationProof ? { conversationProofStatus: conversationProof.status } : {}),
    });
    const summaryBlockedReasons = runBlockedReason
      ? [runBlockedReason]
      : conversationProof?.status === "blocked"
        ? (conversationProof.blockedReasons ?? ["conversation_proof_blocked"])
        : betaGateBlockingReasons.length > 0
          ? betaGateBlockingReasons
          : undefined;
    const summary = {
      schemaVersion: MATRIX_SCHEMA_VERSION,
      status: summaryStatus,
      evidenceClass,
      qualification,
      ...(summaryBlockedReasons ? { blockedReasons: summaryBlockedReasons } : {}),
      finishedAt: new Date().toISOString(),
      ...sourceIdentity,
      buildSha256,
      counts: {
        total: results.length,
        passed: results.length - failed,
        failed,
      },
      groupCounts: {
        total: groups.length,
        firstPassPassed,
        eventualPassed,
      },
      groups,
      frontierEvidenceAudit,
      betaGate,
      ...(conversationProof
        ? {
            conversationProof: {
              path: "conversation-proof/summary.json",
              status: conversationProof.status,
              attested: conversationProofAttested,
              ...("counts" in conversationProof ? { counts: conversationProof.counts } : {}),
              ...("failureCode" in conversationProof
                ? { failureCode: conversationProof.failureCode }
                : {}),
              ...("observedStatus" in conversationProof
                ? { observedStatus: conversationProof.observedStatus }
                : {}),
              ...("blockedReasons" in conversationProof
                ? { blockedReasons: conversationProof.blockedReasons }
                : {}),
            },
          }
        : {}),
    };
    await writeJson(path.join(outputDir, "summary.json"), summary);
    await writeJson(path.join(outputDir, "manifest.json"), {
      ...manifest,
      status: summaryStatus,
      qualification,
    });
    await writeJson(
      path.join(outputDir, QA_EVIDENCE_FILENAME),
      buildCodeModeMatrixEvidence({
        evidenceClass,
        ...(conversationProof ? { conversationProof } : {}),
        generatedAt: summary.finishedAt,
        model: options.models[0],
        repoRoot: options.repoRoot,
        results,
      }),
    );
    return {
      exitCode: resolveCodeModeMatrixExitCode({
        allowFailures: options.allowFailures,
        betaGateState: betaGate.state,
        conversationProofAttested,
        conversationProofRequired: options.conversationProof,
        ...(conversationProof ? { conversationProofStatus: conversationProof.status } : {}),
        failed,
        frontierEvidenceValid: frontierEvidenceAudit.valid,
      }),
      outputDir,
      summary,
    };
  } finally {
    await policyFile.cleanup();
    await fs.rm(campaignRoot, { force: true, recursive: true });
    if (runtimeRoot) {
      await fs.rm(runtimeRoot, { force: true, recursive: true });
    }
  }
}

async function main(): Promise<void> {
  try {
    const options = parseCodeModeMatrixOptions(process.argv.slice(2));
    const result = await runCodeModeModelMatrix(options);
    console.log(
      `[code-mode-matrix] artifacts ${path.relative(options.repoRoot, result.outputDir)}`,
    );
    process.exitCode = result.exitCode;
  } catch (error) {
    if ((error as { code?: unknown }).code === "HELP") {
      console.log(error instanceof Error ? error.message : String(error));
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function isCliEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && import.meta.url === pathToFileURL(path.resolve(entrypoint)).href);
}

if (isCliEntrypoint()) {
  await main();
}
