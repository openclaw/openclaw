import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asObjectRecord,
  defineChannelAliasMigration,
  defineKeyMoveMigration,
  hasLegacyAccountStreamingAliases,
  normalizeChannelConfigEntries,
  stripRetiredChannelKeys,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { resolveSlackNativeStreaming, resolveSlackStreamingMode } from "./streaming-compat.js";

const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "slack",
  streaming: {
    defaultMode: "partial",
    resolveMode: resolveSlackStreamingMode,
    resolveNativeTransport: resolveSlackNativeStreaming,
  },
  dm: { root: true, accounts: true },
});

const dmReplyModeMigration = defineKeyMoveMigration({
  from: ["dm", "replyToMode"],
  to: ["replyToModeByChatType", "direct"],
});

const threadMentionPolicyMigration = defineKeyMoveMigration({
  from: ["thread", "requireExplicitMention"],
  to: ["implicitMentions", "threadParticipation"],
  // The retired boolean controlled only participated threads; the canonical
  // setting expresses the inverse while reply-to-bot policy stays independent.
  map: (value) => (typeof value === "boolean" ? { value: !value } : null),
  pruneEmptySource: true,
  movedMessage: ({ sourcePath, targetPath, mappedValue }) =>
    `Moved ${sourcePath} → ${targetPath} (${String(mappedValue)}).`,
});

function hasInteractiveRepliesCapability(value: unknown): boolean {
  const capabilities = asObjectRecord(value)?.capabilities;
  if (Array.isArray(capabilities)) {
    return capabilities.some(
      (entry) => typeof entry === "string" && entry.trim().toLowerCase() === "interactivereplies",
    );
  }
  const capabilitiesRecord = asObjectRecord(capabilities);
  return Boolean(
    capabilitiesRecord &&
    (Object.keys(capabilitiesRecord).length === 0 ||
      Object.hasOwn(capabilitiesRecord, "interactiveReplies")),
  );
}

function hasEnterpriseOrgInstall(value: unknown): boolean {
  return Object.hasOwn(asObjectRecord(value) ?? {}, "enterpriseOrgInstall");
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  ...streamingAliasMigration.legacyConfigRules,
  {
    path: ["channels", "slack", "enterpriseOrgInstall"],
    message:
      'channels.slack.enterpriseOrgInstall is retired; Slack now detects org-wide installations automatically. Run "openclaw doctor --fix".',
  },
  {
    path: ["channels", "slack", "accounts"],
    message:
      'channels.slack.accounts.<id>.enterpriseOrgInstall is retired; Slack now detects org-wide installations automatically. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAccountStreamingAliases(value, hasEnterpriseOrgInstall),
  },
  {
    path: ["channels", "slack"],
    message:
      'channels.slack.capabilities.interactiveReplies is retired; use typed presentation actions instead. Run "openclaw doctor --fix".',
    match: hasInteractiveRepliesCapability,
  },
  {
    path: ["channels", "slack", "accounts"],
    message:
      'channels.slack.accounts.<id>.capabilities.interactiveReplies is retired; use typed presentation actions instead. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAccountStreamingAliases(value, hasInteractiveRepliesCapability),
  },
  {
    path: ["channels", "slack"],
    message:
      'channels.slack.dm.replyToMode moved to replyToModeByChatType.direct. Run "openclaw doctor --fix".',
    match: dmReplyModeMigration.hasLegacy,
  },
  {
    path: ["channels", "slack", "accounts"],
    message:
      'channels.slack.accounts.<id>.dm.replyToMode moved to replyToModeByChatType.direct. Run "openclaw doctor --fix".',
    match: (value) => hasLegacyAccountStreamingAliases(value, dmReplyModeMigration.hasLegacy),
  },
  {
    path: ["channels", "slack"],
    message:
      'channels.slack.thread.requireExplicitMention is legacy; use channels.slack.implicitMentions.threadParticipation instead. Run "openclaw doctor --fix".',
    match: threadMentionPolicyMigration.hasLegacy,
  },
  {
    path: ["channels", "slack", "accounts"],
    message:
      'channels.slack.accounts.<id>.thread.requireExplicitMention is legacy; use channels.slack.accounts.<id>.implicitMentions.threadParticipation instead. Run "openclaw doctor --fix".',
    match: (value) =>
      hasLegacyAccountStreamingAliases(value, threadMentionPolicyMigration.hasLegacy),
  },
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const changes: string[] = [];
  const retired = stripRetiredChannelKeys({
    cfg,
    channelId: "slack",
    keys: new Set(["enterpriseOrgInstall"]),
    scope: "root-and-accounts",
    onRemove: ({ key, pathPrefix }) =>
      changes.push(
        `Removed retired ${pathPrefix}.${key}; Slack detects org-wide installations automatically.`,
      ),
  });
  const aliases = streamingAliasMigration.normalizeChannelConfig({
    cfg: retired.config,
    changes,
  });
  return normalizeChannelConfigEntries({
    cfg: aliases.config,
    channelId: "slack",
    changes,
    normalizeEntry: (params) => {
      let { entry } = params;
      let changed = false;
      const capabilities = entry.capabilities;
      let nextCapabilities: unknown[] | Record<string, unknown> | undefined;
      let removedEmptyObject = false;
      if (Array.isArray(capabilities)) {
        const filtered = capabilities.filter(
          (capability) =>
            !(
              typeof capability === "string" &&
              capability.trim().toLowerCase() === "interactivereplies"
            ),
        );
        if (filtered.length !== capabilities.length) {
          nextCapabilities = filtered;
        }
      } else {
        const capabilitiesRecord = asObjectRecord(capabilities);
        if (
          capabilitiesRecord &&
          (Object.keys(capabilitiesRecord).length === 0 ||
            Object.hasOwn(capabilitiesRecord, "interactiveReplies"))
        ) {
          removedEmptyObject = Object.keys(capabilitiesRecord).length === 0;
          const { interactiveReplies: _retired, ...rest } = capabilitiesRecord;
          nextCapabilities = rest;
        }
      }
      if (nextCapabilities !== undefined) {
        entry = { ...entry };
        const isEmpty = Array.isArray(nextCapabilities)
          ? nextCapabilities.length === 0
          : Object.keys(nextCapabilities).length === 0;
        if (isEmpty) {
          delete entry.capabilities;
        } else {
          entry.capabilities = nextCapabilities;
        }
        params.changes.push(
          removedEmptyObject
            ? `Removed retired empty ${params.pathPrefix}.capabilities object; use typed presentation actions instead.`
            : `Removed retired ${params.pathPrefix}.capabilities.interactiveReplies; use typed presentation actions instead.`,
        );
        changed = true;
      }
      const dm = dmReplyModeMigration.normalize({ ...params, entry });
      const thread = threadMentionPolicyMigration.normalize({ ...params, entry: dm.entry });
      return { entry: thread.entry, changed: changed || dm.changed || thread.changed };
    },
  });
}
