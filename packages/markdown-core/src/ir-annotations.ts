import type {
  AssistantTranscriptRoleImageMeta,
  AssistantTranscriptRoleTokenMeta,
} from "./assistant-transcript.js";
import type { MarkdownAnnotationSpan } from "./ir-spans.js";

type AnnotationTarget = {
  text: string;
  annotations: MarkdownAnnotationSpan[];
};

export function appendAssistantTranscriptRoleText(
  target: AnnotationTarget,
  value: string,
  meta: AssistantTranscriptRoleTokenMeta["assistantTranscriptRoleHeader"],
): void {
  if (!value) {
    return;
  }
  const start = target.text.length;
  target.text += value;
  target.annotations.push({
    start,
    end: target.text.length,
    type: "assistant_transcript_role",
    kind: meta.kind,
    role: meta.role,
  });
}

export function appendAssistantTranscriptRoleImage(
  target: AnnotationTarget,
  meta: AssistantTranscriptRoleImageMeta["assistantTranscriptRoleImage"],
): void {
  if (!meta.text) {
    return;
  }
  const offset = target.text.length;
  target.text += meta.text;
  for (const span of meta.spans) {
    target.annotations.push({
      ...span,
      start: offset + span.start,
      end: offset + span.end,
      type: "assistant_transcript_role",
    });
  }
}
