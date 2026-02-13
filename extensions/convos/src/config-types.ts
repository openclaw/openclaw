/**
 * Convos channel configuration types
 * These mirror the types in src/config/types.convos.ts but are self-contained
 * for the extension to avoid cross-package imports.
 */

export type ConvosReactionLevel = "off" | "ack" | "minimal" | "extensive";
export type DmPolicy = "pairing" | "allowlist" | "open" | "disabled";
export type GroupPolicy = "open" | "disabled" | "allowlist";

export type ConvosAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** If false, do not start this Convos account. Default: true. */
  enabled?: boolean;
  /** CLI-managed identity ID (stored in ~/.convos/identities/). */
  identityId?: string;
  /** XMTP environment: production (default) or dev. */
  env?: "production" | "dev";
  /** Enable debug logging for this account. */
  debug?: boolean;
  /** Sender access policy (default: pairing). Controls who can message the agent in groups. */
  dmPolicy?: DmPolicy;
  /** Allowlist of inbox IDs permitted to message the agent. */
  allowFrom?: Array<string | number>;
  /** Optional allowlist for group senders. */
  groupAllowFrom?: Array<string | number>;
  /** Controls how group messages are handled (default: open). */
  groupPolicy?: GroupPolicy;
  /** Allowlist of conversation IDs the agent listens in (groupPolicy "allowlist"). Include "*" to allow all. */
  groups?: string[];
  /** Max group messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max per-sender turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Action toggles for message tool capabilities. */
  actions?: {
    /** Enable/disable sending reactions via message tool (default: true). */
    reactions?: boolean;
  };
  /** Controls agent reaction behavior. */
  reactionLevel?: ConvosReactionLevel;
  /** The conversation ID where OpenClaw communicates with its owner. */
  ownerConversationId?: string;
};

export type ConvosConfig = {
  /** Optional per-account Convos configuration (multi-account). */
  accounts?: Record<string, ConvosAccountConfig>;
} & ConvosAccountConfig;
