import type { OpenClawConfig } from "openclaw/plugin-sdk/bluebubbles";
import { tryGetBlueBubblesRuntime } from "./runtime.js";

export function loadConfig(): OpenClawConfig {
  const runtime = tryGetBlueBubblesRuntime() as {
    config?: { loadConfig?: () => OpenClawConfig };
  } | null;
  const runtimeLoadConfig = runtime?.config?.loadConfig;
  if (typeof runtimeLoadConfig !== "function") {
    return {};
  }
  return runtimeLoadConfig();
}
