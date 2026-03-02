/**
 * Status adapter for the telegram-userbot channel.
 *
 * Provides account status snapshots, probe checks, and summary builders.
 */

import {
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  collectStatusIssuesFromLastError,
  DEFAULT_ACCOUNT_ID,
  type ChannelStatusAdapter,
} from "openclaw/plugin-sdk";
import type { ResolvedTelegramUserbotAccount } from "./config.js";

// ---------------------------------------------------------------------------
// Probe result type
// ---------------------------------------------------------------------------

export type TelegramUserbotProbe = {
  ok: boolean;
  username?: string;
  userId?: number;
  error?: string;
};

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export const telegramUserbotStatusAdapter: ChannelStatusAdapter<
  ResolvedTelegramUserbotAccount,
  TelegramUserbotProbe
> = {
  defaultRuntime: {
    accountId: DEFAULT_ACCOUNT_ID,
    running: false,
    lastStartAt: null,
    lastStopAt: null,
    lastError: null,
  },

  collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("telegram-userbot", accounts),

  buildChannelSummary: ({ snapshot }) => ({
    ...buildBaseChannelStatusSummary(snapshot),
    connected: snapshot.connected ?? false,
    probe: snapshot.probe,
    lastProbeAt: snapshot.lastProbeAt ?? null,
  }),

  buildAccountSnapshot: ({ account, runtime, probe }) => {
    const probeOk = (probe as TelegramUserbotProbe | undefined)?.ok;
    return {
      ...buildBaseAccountStatusSnapshot({ account, runtime, probe }),
      connected: probeOk ?? runtime?.connected ?? false,
    };
  },
};
