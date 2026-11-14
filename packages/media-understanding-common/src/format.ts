import type {
  MediaUnderstandingDecision,
  MediaUnderstandingModelDecision,
  MediaUnderstandingOutput,
} from "./types.js";

/** Formats a compact operator-facing summary of a media-understanding decision. */
export function formatDecisionSummary(decision: MediaUnderstandingDecision): string {
  const { attachments } = decision;
  const total = attachments.length;
  const success = attachments.filter((entry) => entry.chosen?.outcome === "success").length;
  const chosen = attachments.find((entry) => entry.chosen)?.chosen;
  const provider = chosen?.provider?.trim();
  const model = chosen?.model?.trim();
  const modelLabel = provider
    ? model && model !== provider
      ? `${provider}/${model}`
      : provider
    : undefined;
  const backendLabel = chosen?.observedBackend
    ? ` observed=${chosen.observedBackend}`
    : chosen?.requestedBackend
      ? ` requested=${chosen.requestedBackend}`
      : "";
  const reason = findDecisionReason(decision, decision.outcome === "failed" ? "failed" : undefined);
  // Same selection as the attachment disposition: the last classified attempt explains the outcome.
  const cause = decision.attachments
    .flatMap((entry) => entry.attempts)
    .findLast((attempt) => attempt.cause);
  const shortReason = cause?.cause ?? summarizeDecisionReason(reason);
  const countLabel = total > 0 ? ` (${success}/${total})` : "";
  const viaLabel = modelLabel ? ` via ${modelLabel}${backendLabel}` : "";
  const reasonLabel = shortReason ? ` reason=${shortReason}` : "";
  return `${decision.capability}: ${decision.outcome}${countLabel}${viaLabel}${reasonLabel}`;
}

/** Returns the first non-empty attempt reason, optionally filtered by outcome. */
export function findDecisionReason(
  decision: MediaUnderstandingDecision,
  outcome?: MediaUnderstandingModelDecision["outcome"],
): string | undefined {
  for (const attachment of decision.attachments) {
    for (const attempt of attachment.attempts) {
      if (outcome && attempt.outcome !== outcome) {
        continue;
      }
      if (!attempt.reason?.trim()) {
        continue;
      }
      return attempt.reason;
    }
  }
  return undefined;
}

/** Trims provider/runtime error prefixes into a stable human-readable reason. */
export function normalizeDecisionReason(reason?: string): string | undefined {
  const trimmed = reason?.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.replace(/^(?:Error|ProviderHttpError):\s*/i, "").trim();
  return normalized || undefined;
}

/** Produces the short reason token used in status and decision summary output. */
export function summarizeDecisionReason(reason?: string): string | undefined {
  const normalized = normalizeDecisionReason(reason);
  if (!normalized) {
    return undefined;
  }
  return normalized.split(/:|\s+\[request_id=/)[0]?.trim() || undefined;
}

const sectionByKind = {
  "audio.transcription": { title: "Audio", label: "Transcript" },
  "image.description": { title: "Image", label: "Description" },
  "video.description": { title: "Video", label: "Description" },
} satisfies Record<
  MediaUnderstandingOutput["kind"],
  { title: string; label: "Transcript" | "Description" }
>;

/** Formats media-understanding outputs into the chat body sent back to the model. */
export function formatMediaUnderstandingBody(params: {
  body?: string;
  outputs: MediaUnderstandingOutput[];
}): string {
  const outputs = params.outputs.filter((output) => output.text.trim());
  if (outputs.length === 0) {
    return params.body ?? "";
  }

  const userText = params.body?.trim() || undefined;
  const sections: string[] = [];
  if (userText && outputs.length > 1) {
    sections.push(`User text:\n${userText}`);
  }

  const counts = new Map<MediaUnderstandingOutput["kind"], number>();
  for (const output of outputs) {
    counts.set(output.kind, (counts.get(output.kind) ?? 0) + 1);
  }
  const seen = new Map<MediaUnderstandingOutput["kind"], number>();

  for (const output of outputs) {
    const count = counts.get(output.kind) ?? 1;
    const next = (seen.get(output.kind) ?? 0) + 1;
    seen.set(output.kind, next);
    const suffix = count > 1 ? ` ${next}/${count}` : "";
    const section = sectionByKind[output.kind];
    const userSection = outputs.length === 1 && userText ? `User text:\n${userText}\n` : "";
    sections.push(`[${section.title}${suffix}]\n${userSection}${section.label}:\n${output.text}`);
  }

  return sections.join("\n\n").trim();
}

/** Formats one or more audio transcript outputs for legacy transcript-only callers. */
export function formatAudioTranscripts(outputs: MediaUnderstandingOutput[]): string {
  return outputs
    .map((output, index) =>
      outputs.length === 1 ? output.text : `Audio ${index + 1}:\n${output.text}`,
    )
    .join("\n\n");
}
