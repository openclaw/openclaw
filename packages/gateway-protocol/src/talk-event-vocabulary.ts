const TURN_LIFECYCLE_EVENT_TYPES = ["turn.started", "turn.ended", "turn.cancelled"] as const;
const TURN_STREAM_EVENT_TYPES = [
  "input.audio.delta",
  "input.audio.committed",
  "transcript.delta",
  "transcript.done",
  "output.text.delta",
  "output.text.done",
  "output.audio.started",
  "output.audio.delta",
  "output.audio.done",
  "tool.call",
  "tool.progress",
  "tool.result",
  "tool.error",
] as const;

/** Capture lifecycle events must include a capture id to avoid cross-turn ambiguity. */
export const TALK_CAPTURE_SCOPED_EVENT_TYPES = [
  "capture.started",
  "capture.stopped",
  "capture.cancelled",
  "capture.once",
] as const;

/** Canonical Talk vocabulary shared by protocol validation and runtime sequencing. */
export const TALK_EVENT_TYPES = [
  "session.started",
  "session.ready",
  "session.closed",
  "session.error",
  "session.replaced",
  ...TURN_LIFECYCLE_EVENT_TYPES,
  ...TALK_CAPTURE_SCOPED_EVENT_TYPES,
  ...TURN_STREAM_EVENT_TYPES,
  "usage.metrics",
  "latency.metrics",
  "health.changed",
] as const;

/** Turn stream events must carry a turn id for client-side correlation. */
export const TALK_TURN_SCOPED_EVENT_TYPES = [
  ...TURN_LIFECYCLE_EVENT_TYPES,
  ...TURN_STREAM_EVENT_TYPES,
] as const;
