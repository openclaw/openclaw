/**
 * Shared shape for a sampled inbound Microsoft Teams video frame (camera or screen-share).
 *
 * Lives in its own module so both the provider (`providers/msteams.ts`, which buffers frames) and
 * the realtime path (`msteams-realtime.ts`, whose `look_at_screen` tool consumes them) reference the
 * SAME type — avoiding the structural-duplicate drift while keeping a type-only dependency (no
 * runtime import cycle between the provider and the realtime module).
 */
export interface MsteamsVideoFrame {
  /** Base64-encoded image (JPEG) ready to attach to a vision model. */
  dataBase64: string;
  /** MIME type, e.g. "image/jpeg". */
  mime: string;
  width: number;
  height: number;
  /** Worker capture timestamp (epoch ms). */
  ts: number;
}
