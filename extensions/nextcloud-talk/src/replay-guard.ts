import { createClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";

const DEFAULT_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MEMORY_MAX_SIZE = 1_000;
const DEFAULT_STORAGE_MAX_ENTRIES = 10_000;

function sanitizeSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function buildReplayKey(params: { roomToken: string; messageId: string }): string | null {
  const roomToken = params.roomToken.trim();
  const messageId = params.messageId.trim();
  if (!roomToken || !messageId) {
    return null;
  }
  return `${roomToken}:${messageId}`;
}

type NextcloudTalkReplayGuardOptions = {
  scopeKey?: string;
  ttlMs?: number;
  memoryMaxSize?: number;
  maxEntries?: number;
  onStorageError?: (error: unknown) => void;
};

export type NextcloudTalkReplayGuard = {
  claimMessage: (params: {
    accountId: string;
    roomToken: string;
    messageId: string;
  }) => Promise<"claimed" | "duplicate" | "inflight" | "invalid">;
  commitMessage: (params: {
    accountId: string;
    roomToken: string;
    messageId: string;
  }) => Promise<boolean>;
  releaseMessage: (params: {
    accountId: string;
    roomToken: string;
    messageId: string;
    error?: unknown;
  }) => void;
  shouldProcessMessage: (params: {
    accountId: string;
    roomToken: string;
    messageId: string;
  }) => Promise<boolean>;
};

export function createNextcloudTalkReplayGuard(
  options: NextcloudTalkReplayGuardOptions,
): NextcloudTalkReplayGuard {
  const scopeKey = options.scopeKey?.trim();
  const baseOptions = {
    ttlMs: options.ttlMs ?? DEFAULT_REPLAY_TTL_MS,
    memoryMaxSize: options.memoryMaxSize ?? DEFAULT_MEMORY_MAX_SIZE,
  };
  const dedupe = createClaimableDedupe(
    scopeKey
      ? {
          ...baseOptions,
          maxEntries: options.maxEntries ?? DEFAULT_STORAGE_MAX_ENTRIES,
          resolveScopeKey: (namespace) => `${scopeKey}:${sanitizeSegment(namespace)}`,
          onStorageError: options.onStorageError,
        }
      : baseOptions,
  );

  return {
    claimMessage: async ({ accountId, roomToken, messageId }) => {
      const replayKey = buildReplayKey({ roomToken, messageId });
      if (!replayKey) {
        return "invalid";
      }
      const result = await dedupe.claim(replayKey, {
        namespace: accountId,
      });
      return result.kind;
    },
    commitMessage: async ({ accountId, roomToken, messageId }) => {
      const replayKey = buildReplayKey({ roomToken, messageId });
      if (!replayKey) {
        return true;
      }
      return await dedupe.commit(replayKey, {
        namespace: accountId,
      });
    },
    releaseMessage: ({ accountId, roomToken, messageId, error }) => {
      const replayKey = buildReplayKey({ roomToken, messageId });
      if (!replayKey) {
        return;
      }
      dedupe.release(replayKey, {
        namespace: accountId,
        error,
      });
    },
    shouldProcessMessage: async ({ accountId, roomToken, messageId }) => {
      const replayKey = buildReplayKey({ roomToken, messageId });
      if (!replayKey) {
        return true;
      }
      const result = await dedupe.claim(replayKey, {
        namespace: accountId,
      });
      if (result.kind !== "claimed") {
        return false;
      }
      return await dedupe.commit(replayKey, {
        namespace: accountId,
      });
    },
  };
}
