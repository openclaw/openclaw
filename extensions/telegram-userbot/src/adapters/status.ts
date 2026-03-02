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
import { probeConnection, type ProbeResult } from "../monitor.js";
import type { ResolvedTelegramUserbotAccount } from "./config.js";

// ---------------------------------------------------------------------------
// Probe result type
// ---------------------------------------------------------------------------

export type TelegramUserbotProbe = ProbeResult;

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

  probeAccount: async ({ account, timeoutMs }) => {
    if (!account.configured || !account.enabled) {
      return { ok: false, error: "Account is not configured or disabled" };
    }
    return probeConnection(account.accountId, timeoutMs);
  },

  buildAccountSnapshot: ({ account, runtime, probe }) => {
    const probeOk = (probe as TelegramUserbotProbe | undefined)?.ok;
    return {
      ...buildBaseAccountStatusSnapshot({ account, runtime, probe }),
      connected: probeOk ?? runtime?.connected ?? false,
    };
  },
};
