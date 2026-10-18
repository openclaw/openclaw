import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type {
  BootstrapBudgetAnalysis,
  BootstrapPromptWarning,
  BootstrapPromptWarningMode,
} from "./bootstrap-budget.types.js";

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

/** Decides whether to show a prompt warning and returns the updated dedupe state. */
export function buildBootstrapPromptWarning(params: {
  analysis: BootstrapBudgetAnalysis;
  mode: BootstrapPromptWarningMode;
  previousSignature?: string;
  seenSignatures?: string[];
}): BootstrapPromptWarning {
  const signature = buildBootstrapTruncationSignature(params.analysis);
  let seenSignatures = normalizeUniqueTrimmedStringList(params.seenSignatures);
  if (params.previousSignature && !seenSignatures.includes(params.previousSignature)) {
    seenSignatures = appendSeenSignature(seenSignatures, params.previousSignature);
  }
  const hasSeenSignature = Boolean(signature && seenSignatures.includes(signature));
  const warningShown =
    params.mode !== "off" && Boolean(signature) && (params.mode === "always" || !hasSeenSignature);
  const warningSignaturesSeen =
    signature && params.mode !== "off"
      ? appendSeenSignature(seenSignatures, signature)
      : seenSignatures;
  return {
    signature,
    warningShown,
    lines: warningShown ? [BOOTSTRAP_TRUNCATION_NOTICE] : [],
    warningSignaturesSeen,
  };
}
