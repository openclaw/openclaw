import { readInterSessionPromptEnvelope } from "../sessions/input-provenance.js";

type CliSessionContentDriftReason = "system-prompt" | "prompt-tools";

const CLI_SESSION_DRIFT_NOTE_PREFIX =
  "OpenClaw resumed this CLI session after prompt content changed.";

export function buildCliSessionDriftNote(reasons: readonly CliSessionContentDriftReason[]): string {
  return `${CLI_SESSION_DRIFT_NOTE_PREFIX} Follow the current turn's instructions; changed=${reasons.join(",")}.`;
}

const CLI_SESSION_DRIFT_NOTES = [
  buildCliSessionDriftNote(["system-prompt"]),
  // Older native transcripts still contain tool-drift notes; strip them on display.
  buildCliSessionDriftNote(["prompt-tools"]),
  buildCliSessionDriftNote(["system-prompt", "prompt-tools"]),
];

// Match only complete notes the producer emits; similar native user text is not context.
// Inter-session prompts move their envelope above the note, joined by single newlines.
export function stripCliSessionDriftNote(text: string): string {
  const envelopeLength = readInterSessionPromptEnvelope(text)?.length ?? 0;
  const separator = envelopeLength > 0 ? "\n" : "\n\n";
  for (const note of CLI_SESSION_DRIFT_NOTES) {
    const prefix = `${note}${separator}`;
    if (text.startsWith(prefix, envelopeLength)) {
      return text.slice(0, envelopeLength) + text.slice(envelopeLength + prefix.length);
    }
  }
  return text;
}
