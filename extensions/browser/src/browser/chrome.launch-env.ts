import os from "node:os";
import path from "node:path";
import { stripGatewayAllocatorEnv } from "openclaw/plugin-sdk/process-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { omitChromeProxyEnv } from "./browser-proxy-mode.js";

export function buildChromeLaunchEnv(): NodeJS.ProcessEnv {
  const env = omitChromeProxyEnv(process.env);
  env.HOME = os.homedir();
  stripGatewayAllocatorEnv(env);
  if (process.platform === "linux") {
    const chromiumStateDir = path.join(resolvePreferredOpenClawTmpDir(), ".chromium");
    env.XDG_CONFIG_HOME ??= chromiumStateDir;
    env.XDG_CACHE_HOME ??= chromiumStateDir;
  }
  return env;
}
