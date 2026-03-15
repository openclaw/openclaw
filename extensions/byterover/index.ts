import type { OpenClawPluginApi } from "openclaw/plugin-sdk/byterover";
import type { BrvProcessConfig } from "./brv-process.js";
import { ByteRoverContextEngine } from "./context-engine.js";

const byteRoverPlugin = {
  id: "byterover",
  name: "ByteRover",
  description: "ByteRover context engine — curates and queries conversation context via brv CLI",
  kind: "context-engine" as const,
  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as Record<string, unknown>;

    const brvConfig: BrvProcessConfig = {
      brvPath: (pluginConfig.brvPath as string) ?? undefined,
      cwd: (pluginConfig.cwd as string) ?? undefined,
      queryTimeoutMs: (pluginConfig.queryTimeoutMs as number) ?? undefined,
      curateTimeoutMs: (pluginConfig.curateTimeoutMs as number) ?? undefined,
    };

    api.registerContextEngine("byterover", () => new ByteRoverContextEngine(brvConfig, api.logger));
  },
};

export default byteRoverPlugin;
