import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
//#region src/config/runtime-snapshot.d.ts
type RuntimeConfigSnapshotRefreshParams = {
  sourceConfig: OpenClawConfig;
};
type ConfigWriteAfterWrite = {
  mode: "auto";
} | {
  mode: "restart";
  reason: string;
} | {
  mode: "none";
  reason: string;
};
type ConfigWriteFollowUp = {
  mode: "auto";
  requiresRestart: false;
} | {
  mode: "none";
  reason: string;
  requiresRestart: false;
} | {
  mode: "restart";
  reason: string;
  requiresRestart: true;
};
declare function resolveConfigWriteAfterWrite(afterWrite?: ConfigWriteAfterWrite): ConfigWriteAfterWrite;
declare function resolveConfigWriteFollowUp(afterWrite?: ConfigWriteAfterWrite): ConfigWriteFollowUp;
type RuntimeConfigSnapshotRefreshHandler = {
  refresh: (params: RuntimeConfigSnapshotRefreshParams) => boolean | Promise<boolean>;
  clearOnRefreshFailure?: () => void;
};
type RuntimeConfigWriteNotification = {
  configPath: string;
  sourceConfig: OpenClawConfig;
  runtimeConfig: OpenClawConfig;
  persistedHash: string;
  revision: number;
  fingerprint: string;
  sourceFingerprint: string | null;
  writtenAtMs: number;
  afterWrite?: ConfigWriteAfterWrite;
};
type RuntimeConfigSnapshotMetadata = {
  revision: number;
  fingerprint: string;
  sourceFingerprint: string | null;
  updatedAtMs: number;
};
declare function hashRuntimeConfigValue(value: OpenClawConfig): string;
declare function setRuntimeConfigSnapshot(config: OpenClawConfig, sourceConfig?: OpenClawConfig): void;
declare function resetConfigRuntimeState(): void;
declare function clearRuntimeConfigSnapshot(): void;
declare function getRuntimeConfigSnapshot(): OpenClawConfig | null;
declare function getRuntimeConfigSourceSnapshot(): OpenClawConfig | null;
declare function getRuntimeConfigSnapshotMetadata(): RuntimeConfigSnapshotMetadata | null;
declare function resolveRuntimeConfigCacheKey(config: OpenClawConfig): string;
declare function selectApplicableRuntimeConfig(params: {
  inputConfig?: OpenClawConfig;
  runtimeConfig?: OpenClawConfig | null;
  runtimeSourceConfig?: OpenClawConfig | null;
}): OpenClawConfig | undefined;
declare function setRuntimeConfigSnapshotRefreshHandler(refreshHandler: RuntimeConfigSnapshotRefreshHandler | null): void;
//#endregion
export { clearRuntimeConfigSnapshot as a, getRuntimeConfigSourceSnapshot as c, resolveConfigWriteAfterWrite as d, resolveConfigWriteFollowUp as f, setRuntimeConfigSnapshotRefreshHandler as g, setRuntimeConfigSnapshot as h, RuntimeConfigWriteNotification as i, hashRuntimeConfigValue as l, selectApplicableRuntimeConfig as m, ConfigWriteFollowUp as n, getRuntimeConfigSnapshot as o, resolveRuntimeConfigCacheKey as p, RuntimeConfigSnapshotMetadata as r, getRuntimeConfigSnapshotMetadata as s, ConfigWriteAfterWrite as t, resetConfigRuntimeState as u };