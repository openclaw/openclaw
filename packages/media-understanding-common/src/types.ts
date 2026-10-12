export type MediaUnderstandingKind =
  | "audio.transcription"
  | "video.description"
  | "image.description";

export type MediaUnderstandingCapability = "image" | "audio" | "video";

export type MediaUnderstandingCapabilityRegistry = Map<
  string,
  {
    capabilities?: MediaUnderstandingCapability[];
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
  /**
   * Gateway-recorded input origin. `paste` = text the authenticated gateway
   * client pasted into its composer (Control UI turns long pastes into a file);
   * channels never set it.
   */
  origin?: "paste" | "file";
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
