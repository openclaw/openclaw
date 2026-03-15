/**
 * Core types for cross-platform identity linking and multi-layer memory.
 */

/** A unified identity that links a person across multiple messaging platforms. */
export type UnifiedIdentity = {
  /** Unique identity ID (UUID v4). */
  id: string;
  /** Display name. */
  name: string;
  /** Optional email. */
  email?: string;
  /** Optional phone. */
  phone?: string;
  /** Platform links: platform → platform-specific user ID. */
  links: Record<string, string>;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last update timestamp. */
  updatedAt: string;
  /** Free-form notes. */
  notes?: string;
};

/** Reverse index entry: maps a platform+userId pair to an identity. */
export type PlatformLink = {
  platform: string;
  platformUserId: string;
  identityId: string;
};

/** Pending verification code for identity linking. */
export type VerificationEntry = {
  code: string;
  identityId: string;
  fromPlatform: string;
  fromPlatformUserId: string;
  targetPlatform: string;
  targetPlatformUserId: string;
  createdAt: number;
  attempts: number;
};

/** A single episodic memory entry (journal/diary). */
export type EpisodicEntry = {
  /** Entry ID. */
  id: string;
  /** Identity ID this entry belongs to. */
  identityId: string;
  /** Summary of the interaction. */
  summary: string;
  /** Tags for retrieval. */
  tags: string[];
  /** Extracted user preferences or insights. */
  insights?: string[];
  /** The platform where interaction occurred. */
  platform?: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
};

/** Semantic user profile built over time. */
export type UserProfile = {
  /** Identity ID. */
  identityId: string;
  /** Detected display name. */
  name: string;
  /** User preferences extracted from conversations. */
  preferences: string[];
  /** Detected expertise areas. */
  expertise: string[];
  /** Recent conversation topics. */
  recentTopics: string[];
  /** Total interaction count. */
  interactionCount: number;
  /** ISO 8601 first interaction. */
  firstSeen: string;
  /** ISO 8601 last interaction. */
  lastSeen: string;
};

/** Plugin configuration schema. */
export type IdentityMemoryConfig = {
  /** Enable/disable the plugin. */
  enabled: boolean;
  /** Maximum episodic entries before compression. */
  maxEpisodicEntries: number;
  /** Verification code TTL in seconds. */
  verificationTtlSec: number;
  /** Maximum verification attempts before lockout. */
  maxVerificationAttempts: number;
  /** Whether to inject memory context into agent prompts. */
  injectMemoryContext: boolean;
  /** Maximum memory context length in characters. */
  maxContextLength: number;
};
