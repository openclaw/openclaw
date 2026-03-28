/** ANI channel configuration stored in openclaw config under channels.ani */
export type AniConfig = {
  enabled?: boolean;
  name?: string;

  /** ANI server base URL, e.g. "https://agent-native.im" */
  serverUrl?: string;

  /** Permanent API key (aim_ prefix). Legacy aimb_ keys are not supported. */
  apiKey?: string;

  /** Legacy numeric entity ID override. Usually leave empty and let ANI auto-detect. */
  entityId?: number;

  /** DM policy — ANI routes all messages through conversations, so "open" is default */
  dm?: {
    policy?: "open" | "disabled";
  };

  /** Max text chunk length for outbound messages */
  textChunkLimit?: number;
};

export type ResolvedAniAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  serverUrl?: string;
  entityId?: number;
  config: AniConfig;
};

export type CoreConfig = {
  channels?: {
    ani?: AniConfig;
    defaults?: {
      groupPolicy?: string;
    };
    [key: string]: unknown;
  };
  session?: {
    store?: string;
  };
  messages?: {
    ackReaction?: string;
    ackReactionScope?: string;
  };
  [key: string]: unknown;
};
