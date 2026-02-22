import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerAll } from "./src/register.js";
import { setFilesRuntime } from "./src/runtime.js";

const plugin = {
  id: "telegram-files",
  name: "Telegram File Manager",
  description: "Telegram Mini App for editing agent workspace files on mobile",
  configSchema: {
    parse(value: unknown) {
      const raw =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      return {
        externalUrl: typeof raw.externalUrl === "string" ? raw.externalUrl : undefined,
        allowedPaths: Array.isArray(raw.allowedPaths)
          ? (raw.allowedPaths as unknown[]).filter((p): p is string => typeof p === "string")
          : [],
      };
    },
  },
  register(api: OpenClawPluginApi) {
    setFilesRuntime(api.runtime);
    registerAll(api);
  },
};

export default plugin;
