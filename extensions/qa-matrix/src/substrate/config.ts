import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { MatrixQaProvisionedTopology } from "./topology.js";

export type MatrixQaReplyToMode = "off" | "first" | "all" | "batched";
export type MatrixQaThreadRepliesMode = "off" | "inbound" | "always";
export type MatrixQaDmPolicy = "allowlist" | "disabled" | "open" | "pairing";
export type MatrixQaGroupPolicy = "allowlist" | "disabled" | "open";
export type MatrixQaAutoJoinMode = "allowlist" | "always" | "off";
export type MatrixQaStreamingMode = "off" | "partial" | "quiet";

export type MatrixQaGroupConfigOverrides = {
  enabled?: boolean;
  requireMention?: boolean;
};

export type MatrixQaDmConfigOverrides = {
  allowFrom?: string[];
  enabled?: boolean;
  policy?: MatrixQaDmPolicy;
  sessionScope?: "per-room" | "per-user";
  threadReplies?: MatrixQaThreadRepliesMode;
};

export type MatrixQaConfigOverrides = {
  autoJoin?: MatrixQaAutoJoinMode;
  autoJoinAllowlist?: string[];
  blockStreaming?: boolean;
  dm?: MatrixQaDmConfigOverrides;
  encryption?: boolean;
  groupAllowFrom?: string[];
  groupPolicy?: MatrixQaGroupPolicy;
  groupsByKey?: Record<string, MatrixQaGroupConfigOverrides>;
  replyToMode?: MatrixQaReplyToMode;
  streaming?: "off" | "partial" | "quiet" | boolean;
  threadReplies?: MatrixQaThreadRepliesMode;
};

export type MatrixQaConfigSnapshot = {
  autoJoin: MatrixQaAutoJoinMode;
  autoJoinAllowlist: string[];
  blockStreaming: boolean;
  dm: {
    allowFrom: string[];
    enabled: boolean;
    policy: MatrixQaDmPolicy;
    sessionScope: "per-room" | "per-user";
    threadReplies: MatrixQaThreadRepliesMode;
  };
  encryption: boolean;
  groupAllowFrom: string[];
  groupPolicy: MatrixQaGroupPolicy;
  groupsByKey: Record<
    string,
    {
      enabled: boolean;
      requireMention: boolean;
      roomId: string;
    }
  >;
  replyToMode: MatrixQaReplyToMode;
  streaming: MatrixQaStreamingMode;
  threadReplies: MatrixQaThreadRepliesMode;
};

type MatrixQaAccountDmConfig =
  | { enabled: false }
  | {
      allowFrom: string[];
      enabled: true;
      policy: MatrixQaDmPolicy;
      sessionScope?: "per-room" | "per-user";
      threadReplies?: MatrixQaThreadRepliesMode;
    };

function normalizeMatrixQaAllowlist(entries?: string[]) {
  return [...new Set((entries ?? []).map((entry) => entry.trim()).filter(Boolean))];
}

function resolveMatrixQaGroupSnapshots(params: {
  overrides?: MatrixQaConfigOverrides;
  topology: MatrixQaProvisionedTopology;
}) {
  const groupRooms = params.topology.rooms.filter((room) => room.kind === "group");
  const groupsByKey = params.overrides?.groupsByKey ?? {};
  const knownGroupKeys = new Set(groupRooms.map((room) => room.key));

  for (const key of Object.keys(groupsByKey)) {
    if (!knownGroupKeys.has(key)) {
      throw new Error(`Matrix QA group override references unknown room key "${key}"`);
    }
  }

  return Object.fromEntries(
    groupRooms.map((room) => {
      const override = groupsByKey[room.key];
      return [
        room.key,
        {
          roomId: room.roomId,
          enabled: override?.enabled ?? true,
          requireMention: override?.requireMention ?? room.requireMention,
        },
      ];
    }),
  );
}

function buildMatrixQaGroupEntries(
  groupsByKey: MatrixQaConfigSnapshot["groupsByKey"],
): Record<string, { enabled: boolean; requireMention: boolean }> {
  return Object.fromEntries(
    Object.values(groupsByKey).map((group) => [
      group.roomId,
      {
        enabled: group.enabled,
        requireMention: group.requireMention,
      },
    ]),
  );
}

function resolveMatrixQaDmAllowFrom(params: {
  driverUserId: string;
  overrides?: MatrixQaConfigOverrides;
  sutUserId: string;
  topology: MatrixQaProvisionedTopology;
}) {
  if (params.overrides?.dm?.allowFrom) {
    return normalizeMatrixQaAllowlist(params.overrides.dm.allowFrom);
  }
  const dmParticipantUserIds = params.topology.rooms
    .filter((room) => room.kind === "dm")
    .flatMap((room) => room.memberUserIds.filter((userId) => userId !== params.sutUserId));
  const dmAllowFrom = [...new Set(dmParticipantUserIds)];
  return dmAllowFrom.length > 0 ? dmAllowFrom : [params.driverUserId];
}

function resolveMatrixQaDmConfigSnapshot(params: {
  driverUserId: string;
  overrides?: MatrixQaConfigOverrides;
  sutUserId: string;
  topology: MatrixQaProvisionedTopology;
}) {
  const hasDmRooms = params.topology.rooms.some((room) => room.kind === "dm");
  const dmOverrides = params.overrides?.dm;
  const enabled = hasDmRooms || dmOverrides?.enabled === true;
  return {
    allowFrom: enabled ? resolveMatrixQaDmAllowFrom(params) : [],
    enabled,
    policy: dmOverrides?.policy ?? "allowlist",
    sessionScope: dmOverrides?.sessionScope ?? "per-user",
    threadReplies: dmOverrides?.threadReplies ?? params.overrides?.threadReplies ?? "inbound",
  };
}

function resolveMatrixQaStreamingMode(
  value: MatrixQaConfigOverrides["streaming"],
): MatrixQaStreamingMode {
  if (value === true || value === "partial") {
    return "partial";
  }
  if (value === "quiet") {
    return "quiet";
  }
  return "off";
}

function resolveMatrixQaAutoJoinAllowlist(params: { overrides?: MatrixQaConfigOverrides }) {
  if (params.overrides?.autoJoin !== "allowlist") {
    return [];
  }
  return normalizeMatrixQaAllowlist(params.overrides.autoJoinAllowlist);
}

function formatMatrixQaBoolean(value: boolean) {
  return value ? "true" : "false";
}

function buildMatrixQaAccountDmConfig(params: {
  dmOverrides?: MatrixQaConfigOverrides["dm"];
  snapshot: MatrixQaConfigSnapshot;
}): MatrixQaAccountDmConfig {
  if (!params.snapshot.dm.enabled) {
    return { enabled: false };
  }

  return {
    allowFrom: params.snapshot.dm.allowFrom,
    enabled: true,
    policy: params.snapshot.dm.policy,
    ...(params.dmOverrides?.sessionScope ? { sessionScope: params.snapshot.dm.sessionScope } : {}),
    ...(params.dmOverrides?.threadReplies
      ? { threadReplies: params.snapshot.dm.threadReplies }
      : {}),
  };
}

export function buildMatrixQaConfigSnapshot(params: {
  driverUserId: string;
  overrides?: MatrixQaConfigOverrides;
  sutUserId: string;
  topology: MatrixQaProvisionedTopology;
}): MatrixQaConfigSnapshot {
  return {
    autoJoin: params.overrides?.autoJoin ?? "off",
    autoJoinAllowlist: resolveMatrixQaAutoJoinAllowlist(params),
    blockStreaming: params.overrides?.blockStreaming ?? false,
    dm: resolveMatrixQaDmConfigSnapshot(params),
    encryption: params.overrides?.encryption ?? false,
    groupAllowFrom: normalizeMatrixQaAllowlist(
      params.overrides?.groupAllowFrom ?? [params.driverUserId],
    ),
    groupPolicy: params.overrides?.groupPolicy ?? "allowlist",
    groupsByKey: resolveMatrixQaGroupSnapshots({
      overrides: params.overrides,
      topology: params.topology,
    }),
    replyToMode: params.overrides?.replyToMode ?? "off",
    streaming: resolveMatrixQaStreamingMode(params.overrides?.streaming),
    threadReplies: params.overrides?.threadReplies ?? "inbound",
  };
}

export function summarizeMatrixQaConfigSnapshot(snapshot: MatrixQaConfigSnapshot) {
  return [
    `replyToMode=${snapshot.replyToMode}`,
    `threadReplies=${snapshot.threadReplies}`,
    `dm.enabled=${formatMatrixQaBoolean(snapshot.dm.enabled)}`,
    `dm.policy=${snapshot.dm.policy}`,
    `dm.sessionScope=${snapshot.dm.sessionScope}`,
    `dm.threadReplies=${snapshot.dm.threadReplies}`,
    `streaming=${snapshot.streaming}`,
    `blockStreaming=${formatMatrixQaBoolean(snapshot.blockStreaming)}`,
    `autoJoin=${snapshot.autoJoin}`,
    `encryption=${formatMatrixQaBoolean(snapshot.encryption)}`,
  ].join(", ");
}

export function buildMatrixQaConfig(
  baseCfg: OpenClawConfig,
  params: {
    driverUserId: string;
    homeserver: string;
    overrides?: MatrixQaConfigOverrides;
    sutAccessToken: string;
    sutAccountId: string;
    sutDeviceId?: string;
    sutUserId: string;
    topology: MatrixQaProvisionedTopology;
  },
): OpenClawConfig {
  const pluginAllow = [...new Set([...(baseCfg.plugins?.allow ?? []), "matrix"])];
  const snapshot = buildMatrixQaConfigSnapshot({
    driverUserId: params.driverUserId,
    overrides: params.overrides,
    sutUserId: params.sutUserId,
    topology: params.topology,
  });
  const groups = buildMatrixQaGroupEntries(snapshot.groupsByKey);
  const dmOverrides = params.overrides?.dm;
  const dm = buildMatrixQaAccountDmConfig({
    dmOverrides,
    snapshot,
  });

  return {
    ...baseCfg,
    plugins: {
      ...baseCfg.plugins,
      allow: pluginAllow,
      entries: {
        ...baseCfg.plugins?.entries,
        matrix: { enabled: true },
      },
    },
    channels: {
      ...baseCfg.channels,
      matrix: {
        ...baseCfg.channels?.matrix,
        enabled: true,
        defaultAccount: params.sutAccountId,
        accounts: {
          ...baseCfg.channels?.matrix?.accounts,
          [params.sutAccountId]: {
            accessToken: params.sutAccessToken,
            ...(params.sutDeviceId ? { deviceId: params.sutDeviceId } : {}),
            dm,
            enabled: true,
            encryption: snapshot.encryption,
            groupAllowFrom: snapshot.groupAllowFrom,
            groupPolicy: snapshot.groupPolicy,
            ...(Object.keys(groups).length > 0 ? { groups } : {}),
            homeserver: params.homeserver,
            network: {
              dangerouslyAllowPrivateNetwork: true,
            },
            replyToMode: snapshot.replyToMode,
            threadReplies: snapshot.threadReplies,
            userId: params.sutUserId,
            ...(snapshot.autoJoin !== "off" ? { autoJoin: snapshot.autoJoin } : {}),
            ...(snapshot.autoJoin === "allowlist" && snapshot.autoJoinAllowlist.length > 0
              ? { autoJoinAllowlist: snapshot.autoJoinAllowlist }
              : {}),
            ...(params.overrides?.blockStreaming !== undefined
              ? { blockStreaming: snapshot.blockStreaming }
              : {}),
            ...(params.overrides?.streaming !== undefined
              ? { streaming: params.overrides.streaming }
              : {}),
          },
        },
      },
    },
  };
}
