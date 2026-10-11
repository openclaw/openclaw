import type {
  DmPolicy,
  GroupPolicy,
  OpenClawConfig,
  ReplyToMode,
} from "openclaw/plugin-sdk/config-contracts";
import {
  isRecord,
  normalizeStringEntries,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MatrixQaProvisionedTopology } from "./topology.js";

type MatrixQaThreadRepliesMode = "off" | "inbound" | "always";
type MatrixQaAutoJoinMode = "allowlist" | "always" | "off";
type MatrixQaStreamingMode = "off" | "partial" | "quiet";
type MatrixQaActorRole = "driver" | "observer" | "sut";
type MatrixQaChunkMode = "length" | "newline";
type MatrixQaExecApprovalTarget = "both" | "channel" | "dm";
type MatrixQaExecApprovalsEnabled = boolean | "auto";
type MatrixQaAllowBotsMode = boolean | "mentions";
type MatrixQaStreamingConfig = {
  mode?: MatrixQaStreamingMode;
  progress?: {
    commandText?: "raw" | "status";
  };
  preview?: {
    toolProgress?: boolean;
  };
};
type MatrixQaAgentDefaultsOverrides = Pick<
  NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>,
  "blockStreamingChunk" | "blockStreamingCoalesce"
>;
type MatrixQaToolConfigOverrides = {
  allow?: string[];
  deny?: string[];
};
type MatrixQaAudioConfigOverrides = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["tools"]>["media"]>["audio"]
>;
type MatrixQaMediaModelsOverrides = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["tools"]>["media"]>["models"]
>;
type MatrixQaGroupConfigOverrides = {
  allowBots?: MatrixQaAllowBotsMode;
  enabled?: boolean;
  requireMention?: boolean;
  tools?: MatrixQaToolConfigOverrides;
};
type MatrixQaDmConfigOverrides = {
  allowFrom?: string[];
  enabled?: boolean;
  policy?: DmPolicy;
  sessionScope?: "per-room" | "per-user";
  threadReplies?: MatrixQaThreadRepliesMode;
};
type MatrixQaExecApprovalsConfigOverrides = {
  agentFilter?: string[];
  approvers?: string[];
  enabled?: MatrixQaExecApprovalsEnabled;
  sessionFilter?: string[];
  target?: MatrixQaExecApprovalTarget;
};
export type MatrixQaConfigOverrides = {
  approvalForwarding?: {
    exec?: boolean;
    plugin?: boolean;
  };
  agentDefaults?: MatrixQaAgentDefaultsOverrides;
  allowBots?: MatrixQaAllowBotsMode;
  autoJoin?: MatrixQaAutoJoinMode;
  autoJoinAllowlist?: string[];
  blockStreaming?: boolean;
  chunkMode?: MatrixQaChunkMode;
  dm?: MatrixQaDmConfigOverrides;
  encryption?: boolean;
  execApprovals?: MatrixQaExecApprovalsConfigOverrides;
  groupAllowFrom?: string[];
  groupAllowRoles?: MatrixQaActorRole[];
  groupMentionPatterns?: string[];
  groupPolicy?: GroupPolicy;
  configuredBotRoles?: MatrixQaActorRole[];
  groupsByKey?: Record<string, MatrixQaGroupConfigOverrides>;
  replyToMode?: ReplyToMode;
  startupVerification?: "if-unverified" | "off";
  streaming?: MatrixQaStreamingMode | MatrixQaStreamingConfig | boolean;
  textChunkLimit?: number;
  threadBindings?: NonNullable<OpenClawConfig["session"]>["threadBindings"];
  threadReplies?: MatrixQaThreadRepliesMode;
  audio?: MatrixQaAudioConfigOverrides;
  mediaModels?: MatrixQaMediaModelsOverrides;
  toolProfile?: "coding" | "messaging" | "minimal";
};

type MatrixQaGroupEntry = {
  allowBots?: MatrixQaAllowBotsMode;
  enabled: boolean;
  requireMention: boolean;
  tools?: MatrixQaToolConfigOverrides;
};

type MatrixQaChannelAccountConfig = Record<string, unknown> & {
  groups?: Record<string, MatrixQaGroupEntry & Record<string, unknown>>;
  network?: Record<string, unknown>;
  streaming?: Record<string, unknown>;
};

function restoreOwnedFields(
  current: unknown,
  baseline: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  const result = isRecord(current) ? structuredClone(current) : {};
  const baselineRecord = isRecord(baseline) ? baseline : {};
  for (const field of fields) {
    if (Object.hasOwn(baselineRecord, field)) {
      result[field] = structuredClone(baselineRecord[field]);
    } else {
      delete result[field];
    }
  }
  return result;
}

function normalizeMatrixQaAllowlist(entries?: string[]) {
  return uniqueStrings(normalizeStringEntries(entries ?? []));
}

function buildMatrixQaGroupEntries(
  params: { overrides?: MatrixQaConfigOverrides; topology: MatrixQaProvisionedTopology },
  currentGroups: MatrixQaChannelAccountConfig["groups"],
  baselineGroups: MatrixQaChannelAccountConfig["groups"],
): Record<string, MatrixQaGroupEntry> {
  const roomsByKey = Object.fromEntries(
    params.topology.rooms.filter((room) => room.kind === "group").map((room) => [room.key, room]),
  );
  const groupsByKey = params.overrides?.groupsByKey ?? {};
  for (const key of Object.keys(groupsByKey)) {
    if (!Object.hasOwn(roomsByKey, key)) {
      throw new Error(`Matrix QA group override references unknown room key "${key}"`);
    }
  }
  const result = structuredClone(currentGroups ?? {}) as Record<string, MatrixQaGroupEntry>;
  for (const room of Object.values(roomsByKey)) {
    const override = groupsByKey[room.key];
    const current = currentGroups?.[room.roomId];
    const baseline = baselineGroups?.[room.roomId];
    const entry = restoreOwnedFields(current, baseline, ["allowBots", "enabled", "requireMention"]);
    const tools = restoreOwnedFields(current?.tools, baseline?.tools, ["allow", "deny"]);
    Object.assign(entry, {
      enabled: override?.enabled ?? true,
      requireMention: override?.requireMention ?? room.requireMention,
    });
    if (override && Object.hasOwn(override, "allowBots") && override.allowBots !== undefined) {
      entry.allowBots = override.allowBots;
    }
    if (override?.tools) {
      Object.assign(tools, override.tools);
    }
    delete entry.tools;
    if (Object.keys(tools).length > 0) {
      entry.tools = tools;
    }
    result[room.roomId] = entry as MatrixQaGroupEntry;
  }
  return result;
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
  const dmAllowFrom = uniqueStrings(dmParticipantUserIds);
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
  const enabled = dmOverrides?.enabled ?? hasDmRooms;
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
  if (isRecord(value) && (value.mode === "partial" || value.mode === "quiet")) {
    return value.mode;
  }
  return "off";
}

function resolveMatrixQaGroupAllowFrom(params: {
  driverUserId: string;
  observerUserId: string;
  overrides?: MatrixQaConfigOverrides;
  sutUserId: string;
}) {
  const explicitAllowFrom = params.overrides?.groupAllowFrom;
  const roleAllowFrom = (params.overrides?.groupAllowRoles ?? []).map(
    (role) => params[`${role}UserId`],
  );
  if (explicitAllowFrom !== undefined || params.overrides?.groupAllowRoles !== undefined) {
    return normalizeMatrixQaAllowlist([...(explicitAllowFrom ?? []), ...roleAllowFrom]);
  }
  return [params.driverUserId];
}

const MATRIX_QA_BOT_SOURCE_ACCOUNT_IDS = {
  driver: "qa-driver-bot-source",
  observer: "qa-observer-bot-source",
} as const;

function buildMatrixQaConfiguredBotAccounts(params: {
  driverAccessToken: string | undefined;
  driverUserId: string;
  homeserver: string;
  observerAccessToken: string | undefined;
  observerUserId: string;
  roles: MatrixQaActorRole[];
}): Record<string, MatrixQaChannelAccountConfig> {
  if (params.roles.includes("sut")) {
    throw new Error('Matrix QA configured bot role "sut" would match the SUT account itself');
  }
  const botSources = {
    driver: {
      accessToken: params.driverAccessToken,
      accountId: MATRIX_QA_BOT_SOURCE_ACCOUNT_IDS.driver,
      userId: params.driverUserId,
    },
    observer: {
      accessToken: params.observerAccessToken,
      accountId: MATRIX_QA_BOT_SOURCE_ACCOUNT_IDS.observer,
      userId: params.observerUserId,
    },
  } as const;
  const accounts: Record<string, MatrixQaChannelAccountConfig> = {};
  const roles = params.roles as Array<keyof typeof botSources>;
  for (const role of roles) {
    const source = botSources[role];
    if (!source.accessToken) {
      throw new Error(`Matrix QA configured bot role "${role}" requires an access token`);
    }
    accounts[source.accountId] = {
      accessToken: source.accessToken,
      enabled: false,
      homeserver: params.homeserver,
      userId: source.userId,
    };
  }

  return accounts;
}

function buildMatrixQaChannelAccountConfig(params: {
  baselineAccount: MatrixQaChannelAccountConfig | undefined;
  currentAccount: MatrixQaChannelAccountConfig | undefined;
  groups: Record<string, MatrixQaGroupEntry>;
  homeserver: string;
  overrides?: MatrixQaConfigOverrides;
  dmSnapshot: ReturnType<typeof resolveMatrixQaDmConfigSnapshot>;
  groupAllowFrom: string[];
  sutAccessToken: string;
  sutDeviceId?: string;
  sutUserId: string;
}): MatrixQaChannelAccountConfig {
  const { currentAccount: current, baselineAccount: baseline, overrides, dmSnapshot } = params;
  const streamingOverride = isRecord(overrides?.streaming) ? overrides.streaming : undefined;
  const account = restoreOwnedFields(
    current,
    baseline,
    "allowBots autoJoin autoJoinAllowlist startupVerification".split(" "),
  );
  for (const field of ["execApprovals", "groups", "threadBindings"]) {
    delete account[field];
  }
  const dm = restoreOwnedFields(
    current?.dm,
    dmSnapshot.enabled ? baseline?.dm : undefined,
    "allowFrom enabled policy sessionScope threadReplies".split(" "),
  );
  if (!dmSnapshot.enabled) {
    dm.enabled = false;
  } else {
    Object.assign(dm, {
      allowFrom: dmSnapshot.allowFrom,
      enabled: true,
      policy: dmSnapshot.policy,
      ...(overrides?.dm?.sessionScope !== undefined
        ? { sessionScope: dmSnapshot.sessionScope }
        : {}),
      ...(overrides?.dm?.threadReplies !== undefined
        ? { threadReplies: dmSnapshot.threadReplies }
        : {}),
    });
  }
  const execApprovals = restoreOwnedFields(
    current?.execApprovals,
    baseline?.execApprovals,
    "agentFilter approvers enabled sessionFilter target".split(" "),
  );
  const execOverrides = overrides?.execApprovals;
  Object.assign(execApprovals, {
    ...(execOverrides?.agentFilter ? { agentFilter: execOverrides.agentFilter } : {}),
    ...(execOverrides?.approvers
      ? { approvers: normalizeMatrixQaAllowlist(execOverrides.approvers) }
      : {}),
    ...(execOverrides?.enabled !== undefined ? { enabled: execOverrides.enabled } : {}),
    ...(execOverrides?.sessionFilter ? { sessionFilter: execOverrides.sessionFilter } : {}),
    ...(execOverrides?.target ? { target: execOverrides.target } : {}),
  });
  const streaming = restoreOwnedFields(current?.streaming, baseline?.streaming, [
    "chunkMode",
    "mode",
  ]);
  const block = restoreOwnedFields(current?.streaming?.block, baseline?.streaming?.block, [
    "enabled",
  ]);
  const progress = restoreOwnedFields(current?.streaming?.progress, baseline?.streaming?.progress, [
    "commandText",
  ]);
  const preview = restoreOwnedFields(current?.streaming?.preview, baseline?.streaming?.preview, [
    "toolProgress",
  ]);
  if (streamingOverride?.progress?.commandText) {
    progress.commandText = streamingOverride.progress.commandText;
  }
  Object.assign(streaming, { progress });
  if (Object.keys(progress).length === 0) {
    delete streaming.progress;
  }
  Object.assign(streaming, {
    block: { ...block, enabled: overrides?.blockStreaming ?? false },
    chunkMode: overrides?.chunkMode ?? "length",
    mode: resolveMatrixQaStreamingMode(overrides?.streaming),
    preview: { ...preview, toolProgress: streamingOverride?.preview?.toolProgress ?? true },
  });
  const threadBindings = restoreOwnedFields(
    current?.threadBindings,
    baseline?.threadBindings,
    "enabled idleHours maxAgeHours spawnSessions defaultSpawnContext".split(" "),
  );
  Object.assign(threadBindings, overrides?.threadBindings);
  Object.assign(account, {
    accessToken: params.sutAccessToken,
    ...(params.sutDeviceId ? { deviceId: params.sutDeviceId } : {}),
    dm,
    enabled: true,
    encryption: overrides?.encryption ?? false,
    groupAllowFrom: params.groupAllowFrom,
    groupPolicy: overrides?.groupPolicy ?? "allowlist",
    ...(Object.keys(params.groups).length > 0 ? { groups: params.groups } : {}),
    homeserver: params.homeserver,
    network: {
      ...current?.network,
      dangerouslyAllowPrivateNetwork: true,
    },
    replyToMode: overrides?.replyToMode ?? "off",
    ...(Object.keys(execApprovals).length > 0 ? { execApprovals } : {}),
    ...(overrides?.startupVerification !== undefined
      ? { startupVerification: overrides.startupVerification }
      : {}),
    streaming,
    ...(Object.keys(threadBindings).length > 0 ? { threadBindings } : {}),
    threadReplies: overrides?.threadReplies ?? "inbound",
    userId: params.sutUserId,
    textChunkLimit: overrides?.textChunkLimit ?? 4000,
  });
  if (overrides?.allowBots !== undefined) {
    account.allowBots = overrides.allowBots;
  }
  if (overrides?.autoJoin !== undefined) {
    const autoJoin = overrides.autoJoin ?? "off";
    if (autoJoin === "off") {
      delete account.autoJoin;
      delete account.autoJoinAllowlist;
    } else {
      account.autoJoin = autoJoin;
      if (autoJoin === "allowlist") {
        account.autoJoinAllowlist = normalizeMatrixQaAllowlist(overrides.autoJoinAllowlist);
      } else {
        delete account.autoJoinAllowlist;
      }
    }
  }
  return account as MatrixQaChannelAccountConfig;
}

export function buildMatrixQaConfig(
  baselineCfg: OpenClawConfig,
  params: {
    currentConfig?: OpenClawConfig;
    driverAccessToken?: string;
    driverUserId: string;
    homeserver: string;
    observerAccessToken?: string;
    observerUserId: string;
    overrides?: MatrixQaConfigOverrides;
    sutAccessToken: string;
    sutAccountId: string;
    sutDeviceId?: string;
    sutUserId: string;
    topology: MatrixQaProvisionedTopology;
  },
): OpenClawConfig {
  const currentCfg = params.currentConfig ?? baselineCfg;
  const pluginAllow = uniqueStrings([...(currentCfg.plugins?.allow ?? []), "matrix"]);
  const currentAccount = currentCfg.channels?.matrix?.accounts?.[params.sutAccountId];
  const baselineAccount = baselineCfg.channels?.matrix?.accounts?.[params.sutAccountId];
  const groups = buildMatrixQaGroupEntries(params, currentAccount?.groups, baselineAccount?.groups);
  const configuredBotAccounts = buildMatrixQaConfiguredBotAccounts({
    driverAccessToken: params.driverAccessToken,
    driverUserId: params.driverUserId,
    homeserver: params.homeserver,
    observerAccessToken: params.observerAccessToken,
    observerUserId: params.observerUserId,
    roles: params.overrides?.configuredBotRoles ?? [],
  });
  const matrixAccounts = { ...currentCfg.channels?.matrix?.accounts };
  for (const accountId of Object.values(MATRIX_QA_BOT_SOURCE_ACCOUNT_IDS)) {
    delete matrixAccounts[accountId];
  }
  const approvals = { ...currentCfg.approvals };
  for (const kind of ["exec", "plugin"] as const) {
    const approval = restoreOwnedFields(
      currentCfg.approvals?.[kind],
      baselineCfg.approvals?.[kind],
      ["enabled", "mode"],
    );
    if (
      params.overrides?.approvalForwarding?.[kind] ??
      (kind === "exec" && params.overrides?.execApprovals !== undefined)
    ) {
      Object.assign(approval, { enabled: true, mode: "session" });
    }
    if (Object.keys(approval).length > 0) {
      approvals[kind] = approval;
    } else {
      delete approvals[kind];
    }
  }
  const agentDefaults = restoreOwnedFields(
    currentCfg.agents?.defaults,
    baselineCfg.agents?.defaults,
    ["blockStreamingChunk", "blockStreamingCoalesce"],
  );
  Object.assign(agentDefaults, params.overrides?.agentDefaults);
  const tools = restoreOwnedFields(currentCfg.tools, baselineCfg.tools, ["profile"]);
  const media = restoreOwnedFields(currentCfg.tools?.media, baselineCfg.tools?.media, ["models"]);
  const audio = restoreOwnedFields(
    currentCfg.tools?.media?.audio,
    baselineCfg.tools?.media?.audio,
    "providerOptions baseUrl headers request enabled preferredModel maxBytes maxChars prompt timeoutSeconds language attachments echoTranscript echoFormat".split(
      " ",
    ),
  );
  const audioScope = restoreOwnedFields(
    currentCfg.tools?.media?.audio?.scope,
    baselineCfg.tools?.media?.audio?.scope,
    ["default", "rules"],
  );
  if (params.overrides?.toolProfile) {
    tools.profile = params.overrides.toolProfile;
  }
  if (params.overrides?.audio) {
    Object.assign(audio, params.overrides.audio);
  }
  if (params.overrides?.audio?.scope) {
    Object.assign(audioScope, params.overrides.audio.scope);
  }
  if (Object.keys(audioScope).length > 0) {
    audio.scope = audioScope;
  } else {
    delete audio.scope;
  }
  if (params.overrides?.mediaModels) {
    media.models = params.overrides.mediaModels;
  }
  if (
    currentCfg.tools?.media?.audio ||
    baselineCfg.tools?.media?.audio ||
    params.overrides?.audio
  ) {
    media.audio = audio;
  }
  if (
    currentCfg.tools?.media ||
    baselineCfg.tools?.media ||
    params.overrides?.audio ||
    params.overrides?.mediaModels
  ) {
    tools.media = media;
  }
  const groupChat = restoreOwnedFields(
    currentCfg.messages?.groupChat,
    baselineCfg.messages?.groupChat,
    ["mentionPatterns", "visibleReplies"],
  );
  if (params.overrides?.groupMentionPatterns !== undefined) {
    groupChat.mentionPatterns = normalizeMatrixQaAllowlist(params.overrides.groupMentionPatterns);
  }
  groupChat.visibleReplies = "automatic";
  matrixAccounts[params.sutAccountId] = buildMatrixQaChannelAccountConfig({
    baselineAccount,
    currentAccount,
    groups,
    homeserver: params.homeserver,
    overrides: params.overrides,
    dmSnapshot: resolveMatrixQaDmConfigSnapshot(params),
    groupAllowFrom: resolveMatrixQaGroupAllowFrom(params),
    sutAccessToken: params.sutAccessToken,
    sutDeviceId: params.sutDeviceId,
    sutUserId: params.sutUserId,
  });
  Object.assign(matrixAccounts, configuredBotAccounts);

  const config = structuredClone(currentCfg);
  config.approvals = approvals as OpenClawConfig["approvals"];
  config.agents = {
    ...currentCfg.agents,
    defaults: agentDefaults as NonNullable<OpenClawConfig["agents"]>["defaults"],
  };
  config.tools = tools as OpenClawConfig["tools"];
  config.plugins = {
    ...currentCfg.plugins,
    allow: pluginAllow,
    entries: {
      ...currentCfg.plugins?.entries,
      matrix: { ...currentCfg.plugins?.entries?.matrix, enabled: true },
    },
  };
  config.messages = {
    ...currentCfg.messages,
    groupChat: groupChat as NonNullable<OpenClawConfig["messages"]>["groupChat"],
  };
  config.channels = {
    ...currentCfg.channels,
    matrix: {
      ...currentCfg.channels?.matrix,
      accounts: matrixAccounts,
      defaultAccount: params.sutAccountId,
      enabled: true,
    },
  };
  return config;
}
