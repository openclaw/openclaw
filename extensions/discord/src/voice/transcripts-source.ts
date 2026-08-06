import { summarizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
// Discord plugin module implements transcripts source behavior.
import type {
  TranscriptSourceProvider,
  TranscriptStartRequest,
} from "openclaw/plugin-sdk/transcripts";
import { listDiscordStartupAccountIds, resolveDiscordAccount } from "../accounts.js";
import { resolveDiscordVoiceEnabled } from "./config.js";
import type { DiscordVoiceManager } from "./manager.js";

const managersByAccountId = new Map<string, DiscordVoiceManager>();
const managerWaiters = new Set<{
  accountId?: string;
  resolve: () => void;
}>();

const ACCOUNT_ID_ERROR_MAX_CHARS = 64;
const ACCOUNT_ID_ERROR_MAX_ENTRIES = 4;

function formatAccountIdForError(accountId: string): string {
  return JSON.stringify(truncateUtf16Safe(accountId, ACCOUNT_ID_ERROR_MAX_CHARS));
}

function summarizeAccountIdsForError(accountIds: readonly string[]): string {
  return summarizeStringEntries({
    entries: accountIds.map(formatAccountIdForError),
    limit: ACCOUNT_ID_ERROR_MAX_ENTRIES,
  });
}

export function setDiscordTranscriptsVoiceManager(params: {
  accountId: string;
  manager: DiscordVoiceManager | null;
}): void {
  if (params.manager) {
    managersByAccountId.set(params.accountId, params.manager);
    for (const waiter of managerWaiters) {
      if (!waiter.accountId || waiter.accountId === params.accountId) {
        waiter.resolve();
      }
    }
  } else {
    managersByAccountId.delete(params.accountId);
  }
}

const resolveDiscordTranscriptsAccountId: NonNullable<
  TranscriptSourceProvider["resolveAccountId"]
> = ({ cfg, source }) => {
  const requestedAccountId = source.accountId?.trim();
  const configuredVoiceAccountIds = cfg
    ? listDiscordStartupAccountIds(cfg).filter((accountId) =>
        resolveDiscordVoiceEnabled(resolveDiscordAccount({ cfg, accountId }).config.voice),
      )
    : [];
  // Configuration owns capability; the manager map is transient readiness state.
  // Falling back to it only supports direct provider calls that have no config.
  const capableAccountIds = (
    cfg ? configuredVoiceAccountIds : [...managersByAccountId.keys()]
  ).toSorted();

  if (requestedAccountId) {
    // A provider can be called directly without config while its manager is starting.
    // With config, reject accounts that can never register a voice manager.
    if (!cfg || capableAccountIds.includes(requestedAccountId)) {
      return { ok: true, value: requestedAccountId };
    }
    return {
      ok: false,
      error: `Discord account ${formatAccountIdForError(requestedAccountId)} is not enabled for voice.`,
    };
  }
  if (capableAccountIds.length === 1) {
    return { ok: true, value: capableAccountIds[0] };
  }
  if (capableAccountIds.length === 0) {
    return {
      ok: false,
      error:
        "No Discord account is enabled for voice; configure credentials and enable voice for an account.",
    };
  }
  return {
    ok: false,
    error: `Multiple Discord accounts are enabled for voice (${summarizeAccountIdsForError(capableAccountIds)}); specify accountId.`,
  };
};

async function waitForManager(
  request: TranscriptStartRequest,
): Promise<{ ok: true; value: DiscordVoiceManager | undefined } | { ok: false; error: string }> {
  const accountResolution = resolveDiscordTranscriptsAccountId({
    cfg: request.cfg,
    source: request.session.source,
  });
  if (!accountResolution.ok) {
    return accountResolution;
  }
  const accountId = accountResolution.value;
  const existing = accountId ? managersByAccountId.get(accountId) : undefined;
  if (existing) {
    return { ok: true, value: existing };
  }
  if (request.abortSignal?.aborted) {
    return { ok: true, value: undefined };
  }
  const startupWaitMs = request.startupWaitMs ?? 0;
  if (startupWaitMs <= 0) {
    return { ok: true, value: undefined };
  }
  await new Promise<void>((resolve) => {
    const waiter = {
      accountId,
      resolve: () => {
        clearTimeout(timer);
        request.abortSignal?.removeEventListener("abort", waiter.resolve);
        managerWaiters.delete(waiter);
        resolve();
      },
    };
    const timer = setTimeout(waiter.resolve, startupWaitMs);
    timer.unref?.();
    request.abortSignal?.addEventListener("abort", waiter.resolve, { once: true });
    managerWaiters.add(waiter);
  });
  if (request.abortSignal?.aborted) {
    return { ok: true, value: undefined };
  }
  return { ok: true, value: accountId ? managersByAccountId.get(accountId) : undefined };
}

export const discordVoiceTranscriptsSourceProvider: TranscriptSourceProvider = {
  id: "discord-voice",
  aliases: ["discord"],
  accountBindingChannels: ["discord"],
  resolveAccountId: resolveDiscordTranscriptsAccountId,
  name: "Discord Voice",
  sourceKinds: ["live-audio"],
  async start(request) {
    const managerResolution = await waitForManager(request);
    if (!managerResolution.ok) {
      return managerResolution;
    }
    const manager = managerResolution.value;
    if (!manager) {
      return { ok: false, error: "Discord voice manager is not available." };
    }
    if (request.abortSignal?.aborted) {
      return { ok: false, error: "Discord transcripts start aborted." };
    }
    const guildId = request.session.source.guildId?.trim();
    const channelId = request.session.source.channelId?.trim();
    if (!guildId || !channelId) {
      return { ok: false, error: "Discord transcripts require guildId and channelId." };
    }
    const joined = await manager.join(
      { guildId, channelId },
      {
        transcripts: {
          sessionId: request.session.sessionId,
          onUtterance: request.onUtterance,
        },
      },
    );
    if (!joined.ok) {
      return { ok: false, error: joined.message };
    }
    return { ok: true, session: request.session };
  },
  async stop(request) {
    const accountId = request.source.accountId?.trim();
    const manager = accountId
      ? managersByAccountId.get(accountId)
      : [...managersByAccountId.values()][0];
    if (!manager) {
      return { ok: false, error: "Discord voice manager is not available." };
    }
    const guildId = request.source.guildId?.trim();
    if (!guildId) {
      return { ok: false, error: "Discord transcripts require guildId." };
    }
    const result = await manager.leave(
      {
        guildId,
        channelId: request.source.channelId,
      },
      {
        transcriptsSessionId: request.sessionId,
      },
    );
    if (!result.ok) {
      return { ok: false, error: result.message };
    }
    return { ok: true, sessionId: request.sessionId, stoppedAt: new Date().toISOString() };
  },
  async status(source) {
    const accountId = source.accountId?.trim();
    const manager = accountId
      ? managersByAccountId.get(accountId)
      : [...managersByAccountId.values()][0];
    return (
      manager?.status().map((entry) => ({
        active: entry.ok,
        message: entry.message,
        source: {
          providerId: "discord-voice",
          accountId,
          guildId: entry.guildId,
          channelId: entry.channelId,
        },
      })) ?? []
    );
  },
};
