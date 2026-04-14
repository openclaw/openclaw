import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { MatrixQaProvisionedTopology } from "./topology.js";

type MatrixQaReplyToMode = "off" | "first" | "all" | "batched";
type MatrixQaThreadRepliesMode = "off" | "inbound" | "always";
type MatrixQaDmPolicy = "allowlist" | "disabled" | "open" | "pairing";
type MatrixQaGroupPolicy = "allowlist" | "disabled" | "open";

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
  autoJoin?: "allowlist" | "always" | "off";
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

function resolveMatrixQaGroupEntries(params: {
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
        room.roomId,
        {
          enabled: override?.enabled ?? true,
          requireMention: override?.requireMention ?? room.requireMention,
        },
      ];
    }),
  );
}

function resolveMatrixQaDmAllowFrom(params: {
  driverUserId: string;
  overrides?: MatrixQaConfigOverrides;
  sutUserId: string;
  topology: MatrixQaProvisionedTopology;
}) {
  if (params.overrides?.dm?.allowFrom) {
    return [...params.overrides.dm.allowFrom];
  }
  const dmAllowFrom = [
    ...new Set(
      params.topology.rooms
        .filter((room) => room.kind === "dm")
        .flatMap((room) => room.memberUserIds.filter((userId) => userId !== params.sutUserId)),
    ),
  ];
  return dmAllowFrom.length > 0 ? dmAllowFrom : [params.driverUserId];
}

function resolveMatrixQaDmConfig(params: {
  driverUserId: string;
  overrides?: MatrixQaConfigOverrides;
  sutUserId: string;
  topology: MatrixQaProvisionedTopology;
}) {
  const hasDmRooms = params.topology.rooms.some((room) => room.kind === "dm");
  const dmOverrides = params.overrides?.dm;

  if (!hasDmRooms && dmOverrides?.enabled !== true) {
    return { enabled: false };
  }

  return {
    allowFrom: resolveMatrixQaDmAllowFrom(params),
    enabled: dmOverrides?.enabled ?? true,
    policy: dmOverrides?.policy ?? "allowlist",
    ...(dmOverrides?.sessionScope ? { sessionScope: dmOverrides.sessionScope } : {}),
    ...(dmOverrides?.threadReplies ? { threadReplies: dmOverrides.threadReplies } : {}),
  };
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
  const groups = resolveMatrixQaGroupEntries({
    overrides: params.overrides,
    topology: params.topology,
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
            dm: resolveMatrixQaDmConfig(params),
            enabled: true,
            encryption: params.overrides?.encryption ?? false,
            groupAllowFrom: params.overrides?.groupAllowFrom ?? [params.driverUserId],
            groupPolicy: params.overrides?.groupPolicy ?? "allowlist",
            ...(Object.keys(groups).length > 0 ? { groups } : {}),
            homeserver: params.homeserver,
            network: {
              dangerouslyAllowPrivateNetwork: true,
            },
            replyToMode: params.overrides?.replyToMode ?? "off",
            threadReplies: params.overrides?.threadReplies ?? "inbound",
            userId: params.sutUserId,
            ...(params.overrides?.autoJoin ? { autoJoin: params.overrides.autoJoin } : {}),
            ...(params.overrides?.blockStreaming !== undefined
              ? { blockStreaming: params.overrides.blockStreaming }
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
