import { resolveTextChunkLimit } from "../../../src/auto-reply/chunk.js";
import { type OpenClawConfig } from "../../../src/config/config.js";
import { resolveAccountEntry } from "../../../src/routing/account-lookup.js";
import { normalizeAccountId } from "../../../src/routing/session-key.js";
import { TELEGRAM_TEXT_CHUNK_LIMIT } from "./outbound-adapter.js";

const DEFAULT_TELEGRAM_DRAFT_STREAM_MIN = 200;
const DEFAULT_TELEGRAM_DRAFT_STREAM_MAX = 800;

export function resolveTelegramDraftStreamingChunking(
  cfg: OpenClawConfig | undefined,
  accountId?: string | null,
): {
  minChars: number;
  maxChars: number;
  breakPreference: "paragraph" | "newline" | "sentence";
} {
  const textLimit = resolveTextChunkLimit(cfg, "telegram", accountId, {
    fallbackLimit: TELEGRAM_TEXT_CHUNK_LIMIT,
  });
  const normalizedAccountId = normalizeAccountId(accountId);
  const accountCfg = resolveAccountEntry(cfg?.channels?.telegram?.accounts, normalizedAccountId);
  const draftCfg = accountCfg?.draftChunk ?? cfg?.channels?.telegram?.draftChunk;

  const maxRequested = Math.max(
    1,
    Math.floor(draftCfg?.maxChars ?? DEFAULT_TELEGRAM_DRAFT_STREAM_MAX),
  );
  const maxChars = Math.max(1, Math.min(maxRequested, textLimit));
  const minRequested = Math.max(
    1,
    Math.floor(draftCfg?.minChars ?? DEFAULT_TELEGRAM_DRAFT_STREAM_MIN),
  );
  const minChars = Math.min(minRequested, maxChars);
  const breakPreference =
    draftCfg?.breakPreference === "newline" || draftCfg?.breakPreference === "sentence"
      ? draftCfg.breakPreference
      : "paragraph";
  return { minChars, maxChars, breakPreference };
}
