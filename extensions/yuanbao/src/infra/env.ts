import { createRequire } from "module";
import os from "os";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

let _pluginVersion = "";
let _openclawVersion = "";

export const getPluginVersion = () => _pluginVersion;

export const getOpenclawVersion = () => _openclawVersion;

export const getOperationSystem = () => os.type();

export const initEnv = (api: OpenClawPluginApi) => {
  _pluginVersion = api?.version || "";
  _openclawVersion = api?.config?.meta?.lastTouchedVersion || "";

  if (!_pluginVersion || !_openclawVersion) {
    legacyInitEnv();
  }
};

const legacyInitEnv = () => {
  try {
    const _require = createRequire(import.meta.url);
    // Read plugin version (build output in dist/ws/get-env.js, two levels up to root)
    const _pluginPkg = _require("../../../package.json") as { version: string };
    const _openclawJson = _require("../../../../../openclaw.json") as {
      meta: { lastTouchedVersion: string };
    };

    _pluginVersion = _pluginPkg.version;
    _openclawVersion = _openclawJson.meta.lastTouchedVersion;
  } catch {
    // Ignore path resolution errors
  }
};
