import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
} from "openclaw/plugin-sdk/config-mutation";
import {
  loadCronStore,
  resolveCronStorePath,
  saveCronStore,
} from "openclaw/plugin-sdk/cron-store-runtime";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { telegramMessagingTargetsMatch } from "./normalize.js";
import {
  normalizeTelegramChatId,
  normalizeTelegramLookupTarget,
  parseTelegramTarget,
} from "./targets.js";

const writebackLogger = createSubsystemLogger("telegram/target-writeback");
const TELEGRAM_ADMIN_SCOPE = "operator.admin";

function resolveTargetRewrite(params: {
  raw: string;
  resolvedChatId: string;
}): { sourceTarget: string; resolvedTarget: string } | null {
  const parsed = parseTelegramTarget(params.raw);
  if (normalizeTelegramChatId(parsed.chatId) || !normalizeTelegramLookupTarget(parsed.chatId)) {
    return null;
  }
  const { raw, resolvedChatId } = params;
  const resolvedTarget =
    parsed.directMessagesTopicId != null
      ? `${resolvedChatId}:direct-topic:${parsed.directMessagesTopicId}`
      : parsed.messageThreadId == null
        ? resolvedChatId
        : raw.includes(":topic:")
          ? `${resolvedChatId}:topic:${parsed.messageThreadId}`
          : `${resolvedChatId}:${parsed.messageThreadId}`;
  return {
    sourceTarget: params.raw,
    resolvedTarget,
  };
}

function rewriteTargetIfMatch(params: {
  rawValue: unknown;
  sourceTarget: string;
  resolvedTarget: string;
}): string | null {
  if (typeof params.rawValue !== "string" && typeof params.rawValue !== "number") {
    return null;
  }
  const value = String(params.rawValue).trim();
  if (!value) {
    return null;
  }
  if (!telegramMessagingTargetsMatch(value, params.sourceTarget)) {
    return null;
  }
  return params.resolvedTarget;
}

function replaceTelegramDefaultToTargets(params: {
  cfg: OpenClawConfig;
  sourceTarget: string;
  resolvedTarget: string;
}): boolean {
  let changed = false;
  const telegram = asObjectRecord(params.cfg.channels?.telegram);
  if (!telegram) {
    return changed;
  }

  const maybeReplace = (holder: Record<string, unknown>) => {
    const nextTarget = rewriteTargetIfMatch({
      rawValue: holder.defaultTo,
      sourceTarget: params.sourceTarget,
      resolvedTarget: params.resolvedTarget,
    });
    if (!nextTarget) {
      return;
    }
    holder.defaultTo = nextTarget;
    changed = true;
  };

  maybeReplace(telegram);
  for (const value of Object.values(asObjectRecord(telegram.accounts) ?? {})) {
    const account = asObjectRecord(value);
    if (account) {
      maybeReplace(account);
    }
  }
  return changed;
}

export async function maybePersistResolvedTelegramTarget(params: {
  cfg: OpenClawConfig;
  rawTarget: string;
  resolvedChatId: string;
  verbose?: boolean;
  gatewayClientScopes?: readonly string[];
  trustedInternalWriteback?: boolean;
}): Promise<void> {
  const raw = params.rawTarget.trim();
  if (!raw) {
    return;
  }
  const rewrite = resolveTargetRewrite({
    raw,
    resolvedChatId: params.resolvedChatId,
  });
  if (!rewrite) {
    return;
  }
  const { sourceTarget, resolvedTarget } = rewrite;
  const hasGatewayAdminScope = params.gatewayClientScopes?.includes(TELEGRAM_ADMIN_SCOPE) === true;
  const trustedInternalWriteback =
    params.gatewayClientScopes === undefined && params.trustedInternalWriteback === true;
  if (!hasGatewayAdminScope && !trustedInternalWriteback) {
    writebackLogger.warn(
      `skipping Telegram target writeback for ${raw} because gateway caller is missing ${TELEGRAM_ADMIN_SCOPE}`,
    );
    return;
  }

  try {
    const { snapshot, writeOptions } = await readConfigFileSnapshotForWrite();
    const nextConfig = structuredClone(snapshot.config ?? {});
    const configChanged = replaceTelegramDefaultToTargets({
      cfg: nextConfig,
      sourceTarget,
      resolvedTarget,
    });
    if (configChanged) {
      await replaceConfigFile({
        nextConfig,
        snapshot,
        writeOptions,
        afterWrite: { mode: "auto" },
      });
      if (params.verbose) {
        writebackLogger.warn(`resolved Telegram defaultTo target ${raw} -> ${resolvedTarget}`);
      }
    }
  } catch (err) {
    if (params.verbose) {
      writebackLogger.warn(`failed to persist Telegram defaultTo target ${raw}: ${String(err)}`);
    }
  }

  try {
    const storePath = resolveCronStorePath();
    const store = await loadCronStore(storePath);
    let cronChanged = false;
    for (const job of store.jobs) {
      if (job.delivery?.channel !== "telegram") {
        continue;
      }
      const nextTarget = rewriteTargetIfMatch({
        rawValue: job.delivery.to,
        sourceTarget,
        resolvedTarget,
      });
      if (!nextTarget) {
        continue;
      }
      job.delivery.to = nextTarget;
      cronChanged = true;
    }
    if (cronChanged) {
      await saveCronStore(storePath, store);
      if (params.verbose) {
        writebackLogger.warn(`resolved Telegram cron delivery target ${raw} -> ${resolvedTarget}`);
      }
    }
  } catch (err) {
    if (params.verbose) {
      writebackLogger.warn(`failed to persist Telegram cron target ${raw}: ${String(err)}`);
    }
  }
}
