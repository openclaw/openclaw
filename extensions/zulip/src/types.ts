export type ZulipReactionConfig = {
  enabled?: boolean;
  onStart?: string;
  onSuccess?: string;
  onFailure?: string;
  /**
   * Whether to remove the `onStart` reaction after responding (default: true).
   * Set to false to leave the `onStart` reaction (e.g. ":eyes:") on the message.
   */
  clearOnFinish?: boolean;
};

export type ZulipAccountConfig = {
  name?: string;
  enabled?: boolean;
  configWrites?: boolean;

  baseUrl?: string;
  email?: string;
  apiKey?: string;

  /** Stream allowlist to monitor (names; without leading "#"). */
  streams?: string[];

  /**
   * Reply to every message in monitored streams/topics (default: true).
   *
   * When false, OpenClaw may act "trigger-only" depending on global group policy
   * and mention detection.
   */
  alwaysReply?: boolean;

  /**
   * Default topic when target omits a topic.
   */
  defaultTopic?: string;

  /** Reaction indicators while responding. */
  reactions?: ZulipReactionConfig;

  /** Maximum chars before chunking. */
  textChunkLimit?: number;

  /** Maximum inbound/outbound media size in MB (default: 5MB). */
  mediaMaxMb?: number;
};
