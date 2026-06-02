import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { generateSecureToken } from "openclaw/plugin-sdk/secure-random-runtime";

const SLACK_EXTERNAL_ARG_MENU_TOKEN_BYTES = 18;
// Slack echoes external menu option values back as plain strings; keep tokens URL-safe
// and fixed-length so readToken can reject forged or malformed values before lookup.
const SLACK_EXTERNAL_ARG_MENU_TOKEN_LENGTH = Math.ceil(
  (SLACK_EXTERNAL_ARG_MENU_TOKEN_BYTES * 8) / 6,
);
const SLACK_EXTERNAL_ARG_MENU_TOKEN_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{${SLACK_EXTERNAL_ARG_MENU_TOKEN_LENGTH}}$`,
);
const SLACK_EXTERNAL_ARG_MENU_TTL_MS = 10 * 60 * 1000;

export const SLACK_EXTERNAL_ARG_MENU_PREFIX = "openclaw_cmdarg_ext:";

export type SlackExternalArgMenuChoice = { label: string; value: string };
type SlackExternalArgMenuEntry = {
  choices: SlackExternalArgMenuChoice[];
  userId: string;
  expiresAt: number;
};

function pruneSlackExternalArgMenuStore(
  store: Map<string, SlackExternalArgMenuEntry>,
  rawNow: number,
): void {
  const now = asDateTimestampMs(rawNow);
  if (now === undefined) {
    // An invalid clock makes every expiry comparison untrustworthy, so fail closed.
    store.clear();
    return;
  }
  for (const [token, entry] of store.entries()) {
    if (asDateTimestampMs(entry.expiresAt) === undefined || entry.expiresAt <= now) {
      store.delete(token);
    }
  }
}

function createSlackExternalArgMenuToken(store: Map<string, SlackExternalArgMenuEntry>): string {
  let token;
  do {
    token = generateSecureToken(SLACK_EXTERNAL_ARG_MENU_TOKEN_BYTES);
  } while (store.has(token));
  return token;
}

/** Creates the short-lived in-memory store used for Slack external select arguments. */
export function createSlackExternalArgMenuStore() {
  const store = new Map<string, SlackExternalArgMenuEntry>();

  return {
    create(
      params: { choices: SlackExternalArgMenuChoice[]; userId: string },
      now = Date.now(),
    ): string {
      pruneSlackExternalArgMenuStore(store, now);
      const token = createSlackExternalArgMenuToken(store);
      const expiresAt = resolveExpiresAtMsFromDurationMs(SLACK_EXTERNAL_ARG_MENU_TTL_MS, {
        nowMs: now,
      });
      if (expiresAt !== undefined) {
        store.set(token, {
          choices: params.choices,
          userId: params.userId,
          expiresAt,
        });
      }
      return token;
    },
    readToken(raw: unknown): string | undefined {
      if (typeof raw !== "string" || !raw.startsWith(SLACK_EXTERNAL_ARG_MENU_PREFIX)) {
        return undefined;
      }
      const token = raw.slice(SLACK_EXTERNAL_ARG_MENU_PREFIX.length).trim();
      return SLACK_EXTERNAL_ARG_MENU_TOKEN_PATTERN.test(token) ? token : undefined;
    },
    get(token: string, now = Date.now()): SlackExternalArgMenuEntry | undefined {
      pruneSlackExternalArgMenuStore(store, now);
      return store.get(token);
    },
  };
}
