import { realpath } from "node:fs/promises";
import type {
  ChannelDoctorAdapter,
  ChannelDoctorConfigMutation,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readRegularFile } from "openclaw/plugin-sdk/file-access-runtime";
import {
  asObjectRecord,
  collectChannelAccountScopes,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { listWhatsAppAccountIds, resolveWhatsAppAuthDir } from "./accounts.js";

type AckScope = NonNullable<NonNullable<OpenClawConfig["messages"]>["ackReactionScope"]>;

type LegacyAckSource = {
  path: string;
  account: Record<string, unknown>;
  emoji?: string;
  scope?: AckScope;
  unrepresentableScope: boolean;
};

function resolveLegacyAckScope(ack: Record<string, unknown>): AckScope | undefined {
  const direct = ack.direct !== false;
  const group = ack.group ?? "mentions";
  if (direct) {
    return group === "always" ? "all" : group === "never" ? "direct" : undefined;
  }
  return group === "always"
    ? "group-all"
    : group === "mentions"
      ? "group-mentions"
      : group === "never"
        ? "off"
        : undefined;
}

function resolveDefaultAgentEmoji(cfg: unknown): string | undefined {
  // Include-blocked Doctor candidates may retain the legacy marker until their owner repairs it.
  const entries = asObjectRecord(asObjectRecord(asObjectRecord(cfg)?.agents)?.entries);
  const agents = entries
    ? Object.values(entries).flatMap((value) => {
        const entry = asObjectRecord(value);
        return entry ? [entry] : [];
      })
    : [];
  const agent = agents.find((entry) => entry.default === true) ?? agents[0];
  const emoji = asObjectRecord(agent?.identity)?.emoji;
  return typeof emoji === "string" ? emoji : undefined;
}

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const changes: string[] = [];
  const sources: LegacyAckSource[] = [];
  for (const scope of collectChannelAccountScopes({ cfg, channelId: "whatsapp" })) {
    const ack = asObjectRecord(scope.account.ackReaction);
    if (!ack) {
      continue;
    }
    sources.push({
      path: `${scope.prefix}.ackReaction`,
      account: scope.account,
      ...(typeof ack.emoji === "string" ? { emoji: ack.emoji } : {}),
      scope: resolveLegacyAckScope(ack),
      unrepresentableScope: ack.direct !== false && (ack.group ?? "mentions") === "mentions",
    });
  }
  if (sources.length === 0) {
    return { config: cfg, changes };
  }

  const messages = (cfg.messages ??= {});
  const identityEmoji = resolveDefaultAgentEmoji(cfg) ?? "👀";
  for (const source of sources) {
    messages.ackReaction ??= source.emoji ?? identityEmoji;
    messages.ackReactionScope ??= source.scope;
    delete source.account.ackReaction;
    changes.push(`Moved translatable ${source.path} settings to messages ack settings.`);
  }

  const finalEmoji = messages.ackReaction!.trim();
  const finalScope = messages.ackReactionScope ?? "group-mentions";
  const comparableFinalScope = finalScope === "none" ? "off" : finalScope;
  for (const source of sources) {
    // The v2026.7.1 resolver returned explicit emoji.trim(), including "".
    // Only an omitted emoji used the routed agent identity fallback.
    const sourceEmoji = source.emoji?.trim();
    if (source.emoji === undefined) {
      changes.push(
        `${source.path} used a route-dependent agent identity acknowledgement emoji before migration; the final messages.ackReaction is ${JSON.stringify(finalEmoji)}. Review messages.ackReaction.`,
      );
    } else if (sourceEmoji !== finalEmoji) {
      changes.push(
        `${source.path} requested acknowledgement emoji ${JSON.stringify(sourceEmoji)}, but the final messages.ackReaction is ${JSON.stringify(finalEmoji)}. Review messages.ackReaction.`,
      );
    }
    if (source.unrepresentableScope) {
      changes.push(
        `${source.path} migration cannot preserve both direct-message and mentioned-group acknowledgements; the final messages.ackReactionScope is ${JSON.stringify(finalScope)}. Review messages.ackReactionScope.`,
      );
    } else if (source.scope && source.scope !== comparableFinalScope) {
      changes.push(
        `${source.path} requested acknowledgement scope ${JSON.stringify(source.scope)}, but the final messages.ackReactionScope is ${JSON.stringify(finalScope)}. Review messages.ackReactionScope.`,
      );
    }
  }
  return { config: cfg, changes };
}

export const whatsappDoctor: ChannelDoctorAdapter = {
  normalizeCompatibilityConfig,
  async collectPreviewWarnings({ cfg, env }) {
    const warnings: string[] = [];
    const authDirs = new Set(
      listWhatsAppAccountIds(cfg).map(
        (accountId) => resolveWhatsAppAuthDir({ cfg, accountId, env }).authDir,
      ),
    );
    for (const authDir of authDirs) {
      const lockPath = `${await realpath(authDir).catch(() => authDir)}.lock`;
      try {
        const { buffer } = await readRegularFile({ filePath: lockPath, maxBytes: 16_384 });
        const pid = asObjectRecord(JSON.parse(buffer.toString("utf8")))?.pid;
        if (typeof pid === "number" && Number.isInteger(pid) && pid > 0) {
          continue;
        }
      } catch (error) {
        if (asObjectRecord(error)?.code === "ENOENT") {
          continue;
        }
        if (!(error instanceof SyntaxError)) {
          warnings.push(
            `Could not inspect WhatsApp connection lock ${lockPath}. Check its permissions and file type, then rerun openclaw doctor.`,
          );
          continue;
        }
      }
      warnings.push(
        `WhatsApp connection lock has no valid owner PID: ${lockPath}. Doctor leaves it in place, including with --fix, because a live process may still own it. Stop every process using this auth directory, including other hosts sharing it, and verify none is running or suspended. Only then move this lock file aside and start one Gateway. Keep the auth directory and credentials unchanged.`,
      );
    }
    return warnings;
  },
};
