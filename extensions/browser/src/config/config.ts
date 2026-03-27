import {
  createConfigIO as createConfigIORuntime,
  getRuntimeConfigSnapshot as getRuntimeConfigSnapshotRuntime,
  loadConfig as loadConfigRuntime,
  readConfigFileSnapshotForWrite as readConfigFileSnapshotForWriteRuntime,
  writeConfigFile as writeConfigFileRuntime,
} from "openclaw/plugin-sdk/config-runtime";

export const createConfigIO = createConfigIORuntime;
export const getRuntimeConfigSnapshot = getRuntimeConfigSnapshotRuntime;
export const loadConfig = loadConfigRuntime;
export const readConfigFileSnapshotForWrite = readConfigFileSnapshotForWriteRuntime;
export const writeConfigFile = writeConfigFileRuntime;
export type {
  BrowserConfig,
  BrowserProfileConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/config-runtime";
