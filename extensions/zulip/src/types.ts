export type ZulipReactionConfig = {
  enabled?: boolean;
  onStart?: string;
  onSuccess?: string;
  onFailure?: string;
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
   * Default topic when target omits a topic. On zulip.dreamit.au, sending with an
   * empty topic maps to the topic name "general chat".
   */
  defaultTopic?: string;

  /** Reaction indicators while responding. */
  reactions?: ZulipReactionConfig;

  /** Maximum chars before chunking. */
  textChunkLimit?: number;
};
