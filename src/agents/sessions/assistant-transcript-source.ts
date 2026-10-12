/** Live receipt for one physical assistant append; not part of provider or transcript bytes. */
export type AssistantTranscriptSource = {
  readonly occurrenceId: string;
  readonly messageId?: string;
};
