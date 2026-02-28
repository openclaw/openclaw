import type { OpenClawConfig, DmPolicy, GroupPolicy } from "openclaw/plugin-sdk";
import type { TypeXGroupConfig } from "../types.js";

const firstDefined = <T>(...values: Array<T | undefined>) => {
  for (const value of values) {
    if (typeof value !== "undefined") {
      return value;
    }
  }
  return undefined;
};

export type ResolvedTypeXConfig = {
  enabled: boolean;
  dmPolicy: DmPolicy;
  groupPolicy: GroupPolicy;
  allowFrom: string[];
  groupAllowFrom: string[];
  historyLimit: number;
  dmHistoryLimit: number;
  textChunkLimit: number;
  chunkMode: "length" | "newline";
  blockStreaming: boolean;
  streaming: boolean;
  mediaMaxMb: number;
  groups: Record<string, TypeXGroupConfig>;
};

export function resolveTypeXConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedTypeXConfig {
  const { cfg, accountId } = params;
  const typexCfg = cfg.channels?.typex;
  const accountCfg = accountId ? typexCfg?.accounts?.[accountId] : undefined;
  const defaults = cfg.channels?.defaults;

  return {
    enabled: firstDefined(accountCfg?.enabled, typexCfg?.enabled, true) ?? true,
    dmPolicy: firstDefined(accountCfg?.dmPolicy, typexCfg?.dmPolicy) ?? "pairing",
    groupPolicy:
      firstDefined(accountCfg?.groupPolicy, typexCfg?.groupPolicy, defaults?.groupPolicy) ?? "open",
    allowFrom: (accountCfg?.allowFrom ?? typexCfg?.allowFrom ?? []).map(String),
    groupAllowFrom: (accountCfg?.groupAllowFrom ?? typexCfg?.groupAllowFrom ?? []).map(String),
    historyLimit: firstDefined(accountCfg?.historyLimit, typexCfg?.historyLimit) ?? 10,
    dmHistoryLimit: firstDefined(accountCfg?.dmHistoryLimit, typexCfg?.dmHistoryLimit) ?? 20,
    textChunkLimit: firstDefined(accountCfg?.textChunkLimit, typexCfg?.textChunkLimit) ?? 2000,
    chunkMode: firstDefined(accountCfg?.chunkMode, typexCfg?.chunkMode) ?? "length",
    blockStreaming: firstDefined(accountCfg?.blockStreaming, typexCfg?.blockStreaming) ?? true,
    streaming: firstDefined(accountCfg?.streaming, typexCfg?.streaming) ?? true,
    mediaMaxMb: firstDefined(accountCfg?.mediaMaxMb, typexCfg?.mediaMaxMb) ?? 30,
    groups: { ...typexCfg?.groups, ...accountCfg?.groups },
  };
}
