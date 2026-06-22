/**
 * Shared shape for a sampled inbound Microsoft Teams video frame (camera or screen-share).
 *
 * Lives in its own module so both the provider (`providers/msteams.ts`, which buffers frames) and
 * the realtime path (`msteams-realtime.ts`, whose `look_at_screen` tool consumes them) reference the
 * SAME type — avoiding the structural-duplicate drift while keeping a type-only dependency (no
 * runtime import cycle between the provider and the realtime module).
 */
export interface MsteamsVideoFrame {
  /** Which inbound stream this frame came from. */
  source: "camera" | "screenshare";
  /** Base64-encoded image (JPEG) ready to attach to a vision model. */
  dataBase64: string;
  /** MIME type, e.g. "image/jpeg". */
  mime: string;
  width: number;
  height: number;
  /** Worker capture timestamp (epoch ms). */
  ts: number;
  /**
   * Who this frame belongs to (group calls): the subscribed speaker for a camera frame, the sharer
   * for a screen-share. Lets the vision model attribute a face/screen to a named person. Best-effort
   * — undefined for anonymous/guest participants, 1:1 calls, or older workers.
   */
  participantId?: string;
  participantName?: string;
}

/**
 * Human description of whose camera/screen a frame shows — e.g. `"Alice's shared screen"` or
 * `"Bob's camera"` — for attributing an attached image to a person. Returns undefined when the
 * participant is unknown (1:1, guest/anonymous, or an older worker). Shared by the streaming
 * attach (provider) and the realtime `look_at_screen` surface so the wording stays consistent.
 */
export function describeMsteamsVideoFrameOwner(frame: MsteamsVideoFrame): string | undefined {
  if (!frame.participantName) {
    return undefined;
  }
  const kind = frame.source === "screenshare" ? "shared screen" : "camera";
  return `${frame.participantName}'s ${kind}`;
}
