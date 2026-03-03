import path from "node:path";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

export const DEFAULT_BOOTSTRAP_NEAR_LIMIT_RATIO = 0.85;
export const DEFAULT_BOOTSTRAP_PROMPT_WARNING_MAX_FILES = 3;

export type BootstrapTruncationCause = "per-file-limit" | "total-limit";
export type BootstrapPromptWarningMode = "off" | "once" | "always";

export type BootstrapInjectionStat = {
  name: string;
  path: string;
  missing: boolean;
  rawChars: number;
  injectedChars: number;
  truncated: boolean;
};

export type BootstrapAnalyzedFile = BootstrapInjectionStat & {
  nearLimit: boolean;
  causes: BootstrapTruncationCause[];
};

export type BootstrapBudgetAnalysis = {
  files: BootstrapAnalyzedFile[];
  truncatedFiles: BootstrapAnalyzedFile[];
  nearLimitFiles: BootstrapAnalyzedFile[];
  totalNearLimit: boolean;
  hasTruncation: boolean;
  totals: {
    rawChars: number;
    injectedChars: number;
    truncatedChars: number;
    bootstrapMaxChars: number;
    bootstrapTotalMaxChars: number;
    nearLimitRatio: number;
  };
};

export type BootstrapPromptWarning = {
  signature?: string;
  warningShown: boolean;
  lines: string[];
};

export type BootstrapTruncationReportMeta = {
  warningMode: BootstrapPromptWarningMode;
  warningShown: boolean;
  promptWarningSignature?: string;
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

function formatWarningCause(cause: BootstrapTruncationCause): string {
  return cause === "per-file-limit" ? "max/file" : "max/total";
}

export function buildBootstrapInjectionStats(params: {
  bootstrapFiles: WorkspaceBootstrapFile[];
  injectedFiles: EmbeddedContextFile[];
}): BootstrapInjectionStat[] {
  const injectedByPath = new Map<string, string>();
  const injectedByBaseName = new Map<string, string>();
  for (const file of params.injectedFiles) {
    const pathValue = typeof file.path === "string" ? file.path.trim() : "";
    if (!pathValue) {
      continue;
    }
    if (!injectedByPath.has(pathValue)) {
      injectedByPath.set(pathValue, file.content);
    }
    const normalizedPath = pathValue.replace(/\\/g, "/");
    const baseName = path.posix.basename(normalizedPath);
    if (!injectedByBaseName.has(baseName)) {
      injectedByBaseName.set(baseName, file.content);
    }
  }
  return params.bootstrapFiles.map((file) => {
    const pathValue = typeof file.path === "string" ? file.path.trim() : "";
    const rawChars = file.missing ? 0 : (file.content ?? "").trimEnd().length;
    const injected =
      (pathValue ? injectedByPath.get(pathValue) : undefined) ??
      injectedByPath.get(file.name) ??
      injectedByBaseName.get(file.name);
    const injectedChars = injected ? injected.length : 0;
    const truncated = !file.missing && injectedChars < rawChars;
    return {
      name: file.name,
      path: pathValue || file.name,
      missing: file.missing,
      rawChars,
      injectedChars,
      truncated,
    };
  });
}

export function analyzeBootstrapBudget(params: {
  files: BootstrapInjectionStat[];
  bootstrapMaxChars: number;
  bootstrapTotalMaxChars: number;
  nearLimitRatio?: number;
}): BootstrapBudgetAnalysis {
  const bootstrapMaxChars = normalizePositiveLimit(params.bootstrapMaxChars);
  const bootstrapTotalMaxChars = normalizePositiveLimit(params.bootstrapTotalMaxChars);
  const nearLimitRatio =
    typeof params.nearLimitRatio === "number" &&
    Number.isFinite(params.nearLimitRatio) &&
    params.nearLimitRatio > 0 &&
    params.nearLimitRatio < 1
      ? params.nearLimitRatio
      : DEFAULT_BOOTSTRAP_NEAR_LIMIT_RATIO;
  const nonMissing = params.files.filter((file) => !file.missing);
  const rawChars = nonMissing.reduce((sum, file) => sum + file.rawChars, 0);
  const injectedChars = nonMissing.reduce((sum, file) => sum + file.injectedChars, 0);
  const totalNearLimit = rawChars >= Math.ceil(bootstrapTotalMaxChars * nearLimitRatio);
  const totalOverLimit = rawChars > bootstrapTotalMaxChars;

  const files = params.files.map((file) => {
    if (file.missing) {
      return { ...file, nearLimit: false, causes: [] };
    }
    const perFileOverLimit = file.rawChars > bootstrapMaxChars;
    const nearLimit = file.rawChars >= Math.ceil(bootstrapMaxChars * nearLimitRatio);
    const causes: BootstrapTruncationCause[] = [];
    if (file.truncated) {
      if (perFileOverLimit) {
        causes.push("per-file-limit");
      }
      if (totalOverLimit) {
        causes.push("total-limit");
      }
    }
    return { ...file, nearLimit, causes };
  });

  const truncatedFiles = files.filter((file) => file.truncated);
  const nearLimitFiles = files.filter((file) => file.nearLimit);

  return {
    files,
    truncatedFiles,
    nearLimitFiles,
    totalNearLimit,
    hasTruncation: truncatedFiles.length > 0,
    totals: {
      rawChars,
      injectedChars,
      truncatedChars: Math.max(0, rawChars - injectedChars),
      bootstrapMaxChars,
      bootstrapTotalMaxChars,
      nearLimitRatio,
    },
  };
}

export function buildBootstrapTruncationSignature(
  analysis: BootstrapBudgetAnalysis,
): string | undefined {
  if (!analysis.hasTruncation) {
    return undefined;
  }
  const files = analysis.truncatedFiles
    .map((file) => ({
      path: file.path || file.name,
      rawChars: file.rawChars,
      injectedChars: file.injectedChars,
      causes: [...file.causes].toSorted(),
    }))
    .toSorted((a, b) => {
      const pathCmp = a.path.localeCompare(b.path);
      if (pathCmp !== 0) {
        return pathCmp;
      }
      if (a.rawChars !== b.rawChars) {
        return a.rawChars - b.rawChars;
      }
      if (a.injectedChars !== b.injectedChars) {
        return a.injectedChars - b.injectedChars;
      }
      return a.causes.join("+").localeCompare(b.causes.join("+"));
    });
  return JSON.stringify({
    bootstrapMaxChars: analysis.totals.bootstrapMaxChars,
    bootstrapTotalMaxChars: analysis.totals.bootstrapTotalMaxChars,
    files,
  });
}

export function formatBootstrapTruncationWarningLines(params: {
  analysis: BootstrapBudgetAnalysis;
  maxFiles?: number;
}): string[] {
  if (!params.analysis.hasTruncation) {
    return [];
  }
  const maxFiles =
    typeof params.maxFiles === "number" && Number.isFinite(params.maxFiles) && params.maxFiles > 0
      ? Math.floor(params.maxFiles)
      : DEFAULT_BOOTSTRAP_PROMPT_WARNING_MAX_FILES;
  const lines: string[] = [];
  const topFiles = params.analysis.truncatedFiles.slice(0, maxFiles);
  for (const file of topFiles) {
    const pct =
      file.rawChars > 0
        ? Math.round(((file.rawChars - file.injectedChars) / file.rawChars) * 100)
        : 0;
    const causeText =
      file.causes.length > 0
        ? file.causes.map((cause) => formatWarningCause(cause)).join(", ")
        : "";
    lines.push(
      `${file.name}: ${file.rawChars} raw -> ${file.injectedChars} injected (~${Math.max(0, pct)}% removed${causeText ? `; ${causeText}` : ""}).`,
    );
  }
  if (params.analysis.truncatedFiles.length > topFiles.length) {
    lines.push(
      `+${params.analysis.truncatedFiles.length - topFiles.length} more truncated file(s).`,
    );
  }
  lines.push(
    "If unintentional, raise agents.defaults.bootstrapMaxChars and/or agents.defaults.bootstrapTotalMaxChars.",
  );
  return lines;
}

export function buildBootstrapPromptWarning(params: {
  analysis: BootstrapBudgetAnalysis;
  mode: BootstrapPromptWarningMode;
  previousSignature?: string;
  maxFiles?: number;
}): BootstrapPromptWarning {
  const signature = buildBootstrapTruncationSignature(params.analysis);
  const warningShown =
    params.mode !== "off" &&
    Boolean(signature) &&
    (params.mode === "always" || signature !== params.previousSignature);
  return {
    signature,
    warningShown,
    lines: warningShown
      ? formatBootstrapTruncationWarningLines({
          analysis: params.analysis,
          maxFiles: params.maxFiles,
        })
      : [],
  };
}

export function buildBootstrapTruncationReportMeta(params: {
  analysis: BootstrapBudgetAnalysis;
  warningMode: BootstrapPromptWarningMode;
  warning: BootstrapPromptWarning;
}): BootstrapTruncationReportMeta {
  return {
    warningMode: params.warningMode,
    warningShown: params.warning.warningShown,
    promptWarningSignature: params.warning.signature,
    truncatedFiles: params.analysis.truncatedFiles.length,
    nearLimitFiles: params.analysis.nearLimitFiles.length,
    totalNearLimit: params.analysis.totalNearLimit,
  };
}
