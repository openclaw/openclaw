export type MediaUnderstandingKind =
  | "audio.transcription"
  | "video.description"
  | "image.description";

export type MediaUnderstandingCapability = "image" | "audio" | "video";

export type MediaUnderstandingCapabilityRegistry = Map<
  string,
  {
    capabilities?: MediaUnderstandingCapability[];
    sharedEntryCapabilities?: MediaUnderstandingCapability[];
  }
>;

export type MediaAttachment = {
  path?: string;
  url?: string;
  mime?: string;
  kind?: "image" | "audio" | "video" | "document" | "sticker" | "unknown";
  /**
   * Name the sender gave the file, when the channel recorded one. Channels stage
   * a download under a generated name, so `path` cannot answer "what's in
   * notes.txt?"; this is the only name the user can refer to. Untrusted input:
   * display only, never format detection.
   */
  fileName?: string;
  workspaceDir?: string;
  index: number;
  alreadyTranscribed?: boolean;
};

/** Normalized text output produced by media understanding. */
export type MediaUnderstandingOutput = {
  kind: MediaUnderstandingKind;
  attachmentIndex: number;
  text: string;
  provider: string;
  model?: string;
  requestedBackend?: string;
  observedBackend?: string;
};

export type MediaUnderstandingModelDecision = {
  provider?: string;
  model?: string;
  requestedBackend?: string;
  observedBackend?: string;
  type: "provider" | "cli";
  outcome: "success" | "skipped" | "failed";
  reason?: string;
};

export type MediaAttachmentDisposition =
  | { kind: "handled" }
  | { kind: "handed-to-native-vision" }
  | { kind: "not-selected" }
  | { kind: "capability-disabled" }
  | { kind: "no-model" }
  | { kind: "scope-denied" }
  | { kind: "failed"; reason?: string };

export type MediaAttachmentProcessing = "completed" | "omitted";

export type MediaUnderstandingDecision = {
  capability: MediaUnderstandingCapability;
  outcome: "success" | "failed" | "skipped" | "disabled" | "no-attachment" | "scope-deny";
  attachments: {
    attachmentIndex: number;
    attempts: MediaUnderstandingModelDecision[];
    chosen?: MediaUnderstandingModelDecision;
  }[];
  // Optional on the shipped SDK contract: plugins pass FinalizedMsgContext into
  // inbound-reply dispatch and may hold legacy decision literals. Core producers
  // (runner, apply, runtime) always populate it; absence renders no
  // markers rather than breaking plugin compilation.
  attachmentDispositions?: Record<number, MediaAttachmentDisposition>;
  // CLI/provider completion is independent of usable output or a rendered marker.
  // Optional for shipped SDK decision literals; absence means unknown processing.
  attachmentProcessing?: Record<number, MediaAttachmentProcessing>;
  nativeVisionActive?: boolean;
};
