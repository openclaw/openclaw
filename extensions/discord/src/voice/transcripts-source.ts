import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { summarizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
// Discord plugin module implements transcripts source behavior.
import type {
  TranscriptSourceProvider,
  TranscriptStartRequest,
} from "openclaw/plugin-sdk/transcripts";
import { listEnabledDiscordAccounts, resolveDiscordAccount } from "../accounts.js";
import { authorizeDiscordVoiceIngress } from "./access.js";
import { resolveDiscordVoiceEnabled } from "./config.js";
import { resolveDiscordVoiceAccess } from "./owner-access.js";
import type { VoiceOperationResult, VoiceSessionEntry } from "./session.js";

type CaptureSource = { accountId: string; guildId: string; channelId: string };
type CaptureTarget = Pick<CaptureSource, "guildId" | "channelId">;
type DiscordTranscriptsManager = {
  resolveAccessTarget: (
    target: CaptureTarget,
  ) => Promise<
    | Pick<
        Parameters<typeof authorizeDiscordVoiceIngress>[0],
        "guild" | "channelName" | "channelSlug" | "parentId" | "parentName" | "parentSlug" | "scope"
      >
    | undefined
  >;
  startTranscriptsCapture: (target: CaptureTarget) => Promise<VoiceOperationResult>;
  stopTranscriptsCapture: (target: CaptureTarget) => Promise<void>;
};
const managersByAccountId = new Map<string, DiscordTranscriptsManager>();
type CaptureRegistration = NonNullable<VoiceSessionEntry["transcripts"]> & {
  source: CaptureSource;
  started: boolean;
};
const captures = new Map<string, CaptureRegistration>();
const logger = createSubsystemLogger("discord/voice");

function captureKey(source: CaptureSource): string {
  return JSON.stringify([source.accountId, source.guildId, source.channelId]);
}

export function resolveDiscordTranscriptsCapture(
  source: CaptureSource,
  manager: DiscordTranscriptsManager,
): CaptureRegistration | undefined {
  return managersByAccountId.get(source.accountId) === manager
    ? captures.get(captureKey(source))
    : undefined;
}
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

export function setDiscordTranscriptsVoiceManager(
  params: { accountId: string } & (
    | { manager: DiscordTranscriptsManager }
    | { manager: null; expectedManager: DiscordTranscriptsManager }
  ),
): void {
  if (managersByAccountId.get(params.accountId) === params.manager) {
    return;
  }
  if (params.manager) {
    const manager = params.manager;
    managersByAccountId.set(params.accountId, manager);
    // Account restart replaces transport authority, not an explicitly started subscription.
    for (const capture of captures.values()) {
      if (capture.started && capture.source.accountId === params.accountId) {
        void manager
          .startTranscriptsCapture(capture.source)
          .then((result) => {
            if (
              !result.ok &&
              resolveDiscordTranscriptsCapture(capture.source, manager) === capture
            ) {
              logger.warn(`discord voice: transcripts reattach failed: ${result.message}`);
            }
          })
          .catch((error: unknown) =>
            logger.warn(`discord voice: transcripts reattach failed: ${formatErrorMessage(error)}`),
          );
      }
    }
    for (const waiter of managerWaiters) {
      if (!waiter.accountId || waiter.accountId === params.accountId) {
        waiter.resolve();
      }
    }
  } else if (managersByAccountId.get(params.accountId) === params.expectedManager) {
    managersByAccountId.delete(params.accountId);
  }
}

const resolveDiscordTranscriptsAccountId: NonNullable<
  NonNullable<TranscriptSourceProvider["accessControl"]>["resolveAccountId"]
> = ({ cfg, source }) => {
  const requestedAccountId = source.accountId?.trim();
  const configuredVoiceAccounts = cfg
    ? listEnabledDiscordAccounts(cfg).filter((account) =>
        resolveDiscordVoiceEnabled(account.config.voice),
      )
    : [];
  // Configuration owns capability; the manager map is transient readiness state.
  // Falling back to it only supports direct provider calls that have no config.
  const capableAccountIds = (
    cfg
      ? configuredVoiceAccounts
          .filter((account) => account.tokenStatus === "available")
          .map((account) => account.accountId)
      : [...managersByAccountId.keys()]
  ).toSorted();

  if (requestedAccountId) {
    // A provider can be called directly without config while its manager is starting.
    // With config, reject accounts that can never register a voice manager.
    if (!cfg || capableAccountIds.includes(requestedAccountId)) {
      return { ok: true, value: requestedAccountId };
    }
    if (
      resolveDiscordAccount({ cfg, accountId: requestedAccountId }).tokenStatus ===
      "configured_unavailable"
    ) {
      return {
        ok: false,
        error: `Discord account ${formatAccountIdForError(requestedAccountId)} has configured credentials that are unavailable in this runtime; resolve its SecretRef before using this account.`,
      };
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
        "No Discord account has available credentials and voice enabled; configure credentials and enable voice for an account.",
    };
  }
  const configuredDefaultAccountId = cfg?.channels?.discord?.defaultAccount?.trim();
  if (configuredDefaultAccountId) {
    const normalizedDefaultAccountId = normalizeAccountId(configuredDefaultAccountId);
    if (capableAccountIds.includes(normalizedDefaultAccountId)) {
      return { ok: true, value: normalizedDefaultAccountId };
    }
  }
  if (capableAccountIds.includes(DEFAULT_ACCOUNT_ID)) {
    return { ok: true, value: DEFAULT_ACCOUNT_ID };
  }
  return {
    ok: false,
    error: `Multiple Discord accounts are enabled for voice (${summarizeAccountIdsForError(capableAccountIds)}); specify accountId.`,
  };
};

async function waitForManager(
  request: TranscriptStartRequest,
): Promise<
  | { ok: true; value: { accountId: string; manager: DiscordTranscriptsManager } | undefined }
  | { ok: false; error: string }
> {
  const accountResolution = resolveDiscordTranscriptsAccountId({
    cfg: request.cfg,
    source: request.session.source,
  });
  if (!accountResolution.ok) {
    return accountResolution;
  }
  const accountId = accountResolution.value;
  const existing = accountId ? managersByAccountId.get(accountId) : undefined;
  if (existing && accountId) {
    return { ok: true, value: { accountId, manager: existing } };
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
  const manager = accountId ? managersByAccountId.get(accountId) : undefined;
  return { ok: true, value: accountId && manager ? { accountId, manager } : undefined };
}

export const discordVoiceTranscriptsSourceProvider: TranscriptSourceProvider = {
  id: "discord-voice",
  aliases: ["discord"],
  accessControl: {
    channelId: "discord",
    resolveAccountId: resolveDiscordTranscriptsAccountId,
    async authorize({ caller, cfg, source }) {
      if (caller.kind === "operator") {
        return { ok: true, value: undefined };
      }
      const guildId = source.guildId?.trim();
      const channelId = source.channelId?.trim();
      const callerAccountId = caller.accountId?.trim();
      const sourceAccountId = source.accountId?.trim();
      if (
        caller.channel !== "discord" ||
        !cfg ||
        !callerAccountId ||
        sourceAccountId !== callerAccountId ||
        !guildId ||
        !channelId ||
        caller.groupSpace !== guildId
      ) {
        return { ok: false, error: "You are not authorized to use this command." };
      }
      const manager = managersByAccountId.get(callerAccountId);
      const target = await manager?.resolveAccessTarget({ guildId, channelId });
      if (!target) {
        return { ok: false, error: "Discord voice access target is unavailable." };
      }
      const account = resolveDiscordAccount({ cfg, accountId: callerAccountId });
      const access = await authorizeDiscordVoiceIngress({
        cfg,
        discordConfig: account.config,
        accountId: account.accountId,
        guild: target.guild,
        guildId,
        channelId,
        ...(target.channelName ? { channelName: target.channelName } : {}),
        channelSlug: target.channelSlug,
        ...(target.parentId ? { parentId: target.parentId } : {}),
        ...(target.parentName ? { parentName: target.parentName } : {}),
        ...(target.parentSlug ? { parentSlug: target.parentSlug } : {}),
        scope: target.scope,
        memberRoleIds: [...caller.roleIds],
        admissionAllowFrom: resolveDiscordVoiceAccess({
          cfg,
          discordConfig: account.config,
          accountId: account.accountId,
        }).admissionAllowFrom,
        sender: { id: caller.senderId },
      });
      return access.ok ? { ok: true, value: undefined } : { ok: false, error: access.message };
    },
  },
  name: "Discord Voice",
  sourceKinds: ["live-audio"],
  async start(request) {
    const managerResolution = await waitForManager(request);
    if (!managerResolution.ok) {
      return managerResolution;
    }
    const binding = managerResolution.value;
    if (!binding) {
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
    const { accountId, manager } = binding;
    const source = { accountId, guildId, channelId };
    const key = captureKey(source);
    const capture: CaptureRegistration = {
      source,
      started: false,
      sessionId: request.session.sessionId,
      isCurrent: () => captures.get(key) === capture,
      onUtterance: (utterance) => {
        // Received audio may finish after transport replacement, but never after source revocation.
        if (capture.isCurrent()) {
          return request.onUtterance(utterance);
        }
      },
    };
    captures.set(key, capture);
    try {
      const joined = await manager.startTranscriptsCapture(source);
      if (!joined.ok) {
        return { ok: false, error: joined.message };
      }
      if (
        request.abortSignal?.aborted ||
        resolveDiscordTranscriptsCapture(source, manager) !== capture
      ) {
        return { ok: false, error: "Discord transcripts start was cancelled." };
      }
      capture.started = true;
      return {
        ok: true,
        session: {
          ...request.session,
          source: { ...request.session.source, accountId, guildId, channelId },
        },
      };
    } finally {
      if (!capture.started && captures.get(key) === capture) {
        captures.delete(key);
        await manager.stopTranscriptsCapture(source);
      }
    }
  },
  async stop(request) {
    const accountId = request.source.accountId?.trim();
    if (!accountId) {
      return {
        ok: false,
        error: "Discord transcripts require accountId to stop a voice session.",
      };
    }
    const guildId = request.source.guildId?.trim();
    const channelId = request.source.channelId?.trim();
    if (!guildId || !channelId) {
      return { ok: false, error: "Discord transcripts require guildId and channelId." };
    }
    const source = { accountId, guildId, channelId };
    const key = captureKey(source);
    if (captures.get(key)?.sessionId !== request.sessionId) {
      return { ok: false, error: "Transcripts session is not active in this voice channel." };
    }
    // Revoke before any await: retained callbacks and pending joins lose this exact capture.
    captures.delete(key);
    await managersByAccountId.get(accountId)?.stopTranscriptsCapture(source);
    return { ok: true, sessionId: request.sessionId, stoppedAt: new Date().toISOString() };
  },
  async status(source) {
    const accountId = source.accountId?.trim();
    if (!accountId) {
      return [];
    }
    return [...captures.values()]
      .filter(
        (capture) =>
          capture.source.accountId === accountId &&
          (!source.guildId || capture.source.guildId === source.guildId.trim()) &&
          (!source.channelId || capture.source.channelId === source.channelId.trim()),
      )
      .map((capture) => ({
        active: capture.started,
        sessionId: capture.sessionId,
        message: "Capture registered; recording while connected to the selected channel.",
        source: { providerId: "discord-voice", ...capture.source },
      }));
  },
};
