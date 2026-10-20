import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  BootstrapBudgetAnalysis,
  BootstrapInjectionStat,
  BootstrapPromptWarning,
  BootstrapPromptWarningMode,
  BootstrapTruncationCause,
} from "./bootstrap-budget.types.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
  USER_BOOTSTRAP_MAX_CHARS,
} from "./embedded-agent-helpers/bootstrap.js";
import type { EmbeddedContextFile } from "./embedded-agent-helpers/context-file.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

const DEFAULT_BOOTSTRAP_PROMPT_WARNING_SIGNATURE_HISTORY_MAX = 32;

const BOOTSTRAP_TRUNCATION_NOTICE = [
  "[Bootstrap truncation warning]",
  "Some workspace bootstrap files were truncated before Project Context injection.",
  "Treat Project Context as partial and read the relevant files directly if details seem missing.",
].join("\n");

/** Builds the compact truncation notice mirrored into run metadata. */
export function buildBootstrapPromptWarningNotice(warningLines?: string[]): string | undefined {
  return warningLines?.some((line) => line.trim().length > 0)
    ? BOOTSTRAP_TRUNCATION_NOTICE
    : undefined;
}

function appendSeenSignature(signatures: string[], signature: string): string[] {
  if (!signature.trim() || signatures.includes(signature)) {
    return signatures;
  }
  const next = [...signatures, signature];
  return next.length <= DEFAULT_BOOTSTRAP_PROMPT_WARNING_SIGNATURE_HISTORY_MAX
    ? next
    : next.slice(-DEFAULT_BOOTSTRAP_PROMPT_WARNING_SIGNATURE_HISTORY_MAX);
}

function buildBootstrapTruncationSignature(analysis: BootstrapBudgetAnalysis): string | undefined {
  if (!analysis.hasTruncation) {
    return undefined;
  }
  const files = analysis.truncatedFiles
    .map((file) => ({
      path: file.path || file.name,
      rawChars: file.rawChars,
      injectedChars: file.injectedChars,
      causes: file.causes.toSorted(),
    }))
    .toSorted(
      (a, b) =>
        a.path.localeCompare(b.path) ||
        a.rawChars - b.rawChars ||
        a.injectedChars - b.injectedChars ||
        a.causes.join("+").localeCompare(b.causes.join("+")),
    );
  return JSON.stringify({
    bootstrapMaxChars: analysis.totals.bootstrapMaxChars,
    bootstrapTotalMaxChars: analysis.totals.bootstrapTotalMaxChars,
    files,
  });
}

const DEFAULT_BOOTSTRAP_NEAR_LIMIT_RATIO = 0.85;

type BootstrapTruncationReportMeta = {
  warningMode: BootstrapPromptWarningMode;
  warningShown: boolean;
  promptWarningSignature?: string;
  warningSignaturesSeen?: string[];
  truncatedFiles: number;
  nearLimitFiles: number;
  totalNearLimit: boolean;
};

function normalizePositiveLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }
  return Math.floor(value);
}

function effectiveBootstrapFileLimit(name: string, bootstrapMaxChars: number): number {
  return name.toLowerCase() === "user.md"
    ? Math.min(bootstrapMaxChars, USER_BOOTSTRAP_MAX_CHARS)
    : bootstrapMaxChars;
}

/**
 * USER.md carries a deliberate fixed cap: tuning bootstrapMaxChars can only
 * lower it, so per-file remediation must never suggest raising that setting
 * for it. The effective limit equals the fixed cap exactly when the cap (not
 * the configured limit) is the binding constraint.
 */
export function isFixedUserCapFile(file: { name: string; effectiveFileLimit: number }): boolean {
  return (
    file.name.toLowerCase() === "user.md" && file.effectiveFileLimit === USER_BOOTSTRAP_MAX_CHARS
  );
}

/** Restores prompt-warning dedupe state from a previous bootstrap report. */
export function resolveBootstrapWarningSignaturesSeen(report?: {
  bootstrapTruncation?: {
    warningMode?: BootstrapPromptWarningMode;
    warningSignaturesSeen?: string[];
    promptWarningSignature?: string;
  };
}): string[] {
  const truncation = report?.bootstrapTruncation;
  const seenFromReport = normalizeUniqueTrimmedStringList(truncation?.warningSignaturesSeen);
  if (seenFromReport.length > 0) {
    return seenFromReport;
  }
  // In off mode, signature metadata should not seed once-mode dedupe state.
  if (truncation?.warningMode === "off") {
    return [];
  }
  const single = normalizeOptionalString(truncation?.promptWarningSignature);
  return single ? [single] : [];
}

/**
 * Matches injected content by source path, because basenames can repeat even
 * when the total budget drops one of those files. Account before remapping
 * source paths into the prompt workspace.
 */
export function buildBootstrapInjectionStats(params: {
  bootstrapFiles: WorkspaceBootstrapFile[];
  injectedFiles: EmbeddedContextFile[];
}): BootstrapInjectionStat[] {
  const injectedByPath = new Map<string, string>();
  for (const file of params.injectedFiles) {
    const pathValue = normalizeOptionalString(file.path) ?? "";
    if (pathValue && !injectedByPath.has(pathValue)) {
      injectedByPath.set(pathValue, file.content);
    }
  }
  return params.bootstrapFiles.map((file) => {
    const pathValue = normalizeOptionalString(file.path) ?? "";
    const normalizedPath = pathValue.replace(/\\/g, "/");
    // Bootstrap hooks are extension-facing and may provide path/content only.
    // Derive the display name before budget classification so those entries
    // keep working and cannot crash the turn when filename-specific caps run.
    const name =
      normalizeOptionalString(file.name) ??
      (normalizedPath ? path.posix.basename(normalizedPath) : "bootstrap");
    const rawChars = file.missing ? 0 : (file.content ?? "").trimEnd().length;
    const injected = pathValue ? injectedByPath.get(pathValue) : undefined;
    const injectedChars = injected?.length ?? 0;
    const truncated = !file.missing && injectedChars < rawChars;
    return {
      name,
      path: pathValue || name,
      origin: file.origin,
      missing: file.missing,
      rawChars,
      injectedChars,
      truncated,
    };
  });
}

/** Classifies bootstrap truncation and near-limit pressure for prompt/report output. */
export function analyzeBootstrapBudget(params: {
  files: BootstrapInjectionStat[];
  bootstrapMaxChars: number;
  bootstrapTotalMaxChars: number;
}): BootstrapBudgetAnalysis {
  const bootstrapMaxChars = normalizePositiveLimit(params.bootstrapMaxChars);
  const bootstrapTotalMaxChars = normalizePositiveLimit(params.bootstrapTotalMaxChars);
  const nearLimitRatio = DEFAULT_BOOTSTRAP_NEAR_LIMIT_RATIO;
  let rawChars = 0;
  let injectedChars = 0;
  let remainingTotalChars = bootstrapTotalMaxChars;
  const files = params.files.map((file) => {
    const effectiveFileLimit = effectiveBootstrapFileLimit(file.name, bootstrapMaxChars);
    const availableTotalChars = remainingTotalChars;
    remainingTotalChars = Math.max(0, remainingTotalChars - file.injectedChars);
    if (file.missing) {
      return { ...file, effectiveFileLimit, nearLimit: false, causes: [] };
    }
    // Missing-file markers consume budget above but do not enter reported file totals.
    rawChars += file.rawChars;
    injectedChars += file.injectedChars;
    const perFileOverLimit = file.rawChars > effectiveFileLimit;
    const nearLimit = file.rawChars >= Math.ceil(effectiveFileLimit * nearLimitRatio);
    const causes: BootstrapTruncationCause[] = [];
    if (file.truncated) {
      if (perFileOverLimit) {
        causes.push("per-file-limit");
      }
      if (availableTotalChars < effectiveFileLimit && file.rawChars > availableTotalChars) {
        causes.push("total-limit");
      }
    }
    return { ...file, effectiveFileLimit, nearLimit, causes };
  });

  const truncatedFiles = files.filter((file) => file.truncated);
  const nearLimitFiles = files.filter((file) => file.nearLimit);

  return {
    truncatedFiles,
    nearLimitFiles,
    totalNearLimit: injectedChars >= Math.ceil(bootstrapTotalMaxChars * nearLimitRatio),
    hasTruncation: truncatedFiles.length > 0,
    totals: {
      rawChars,
      injectedChars,
      bootstrapMaxChars,
      bootstrapTotalMaxChars,
    },
  };
}

/** Builds the canonical bootstrap budget diagnosis after caller-owned routing. */
export function buildBootstrapBudgetState(params: {
  config?: OpenClawConfig;
  agentId?: string | null;
  files: BootstrapInjectionStat[];
  previousSignature?: string;
  seenSignatures?: string[];
}) {
  const bootstrapMaxChars = resolveBootstrapMaxChars(params.config, params.agentId);
  const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.config, params.agentId);
  const bootstrapAnalysis = analyzeBootstrapBudget({
    files: params.files,
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
  });
  const bootstrapPromptWarningMode: BootstrapPromptWarningMode = "always";
  const signature = buildBootstrapTruncationSignature(bootstrapAnalysis);
  let seenSignatures = normalizeUniqueTrimmedStringList(params.seenSignatures);
  if (params.previousSignature && !seenSignatures.includes(params.previousSignature)) {
    seenSignatures = appendSeenSignature(seenSignatures, params.previousSignature);
  }
  const warningShown = Boolean(signature);
  const bootstrapPromptWarning: BootstrapPromptWarning = {
    signature,
    warningShown,
    lines: warningShown ? [BOOTSTRAP_TRUNCATION_NOTICE] : [],
    warningSignaturesSeen: signature
      ? appendSeenSignature(seenSignatures, signature)
      : seenSignatures,
  };
  return {
    bootstrapAnalysis,
    bootstrapMaxChars,
    bootstrapPromptWarning,
    bootstrapPromptWarningMode,
    bootstrapTotalMaxChars,
  };
}

/** Serializes truncation warning state for run reports and future dedupe. */
export function buildBootstrapTruncationReportMeta(params: {
  analysis: BootstrapBudgetAnalysis;
  warningMode: BootstrapPromptWarningMode;
  warning: BootstrapPromptWarning;
}): BootstrapTruncationReportMeta {
  return {
    warningMode: params.warningMode,
    warningShown: params.warning.warningShown,
    promptWarningSignature: params.warning.signature,
    ...(params.warning.warningSignaturesSeen.length > 0
      ? { warningSignaturesSeen: params.warning.warningSignaturesSeen }
      : {}),
    truncatedFiles: params.analysis.truncatedFiles.length,
    nearLimitFiles: params.analysis.nearLimitFiles.length,
    totalNearLimit: params.analysis.totalNearLimit,
  };
}
