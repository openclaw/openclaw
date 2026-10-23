import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { AnyAgentTool, OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import memoryCorePlugin from "../../memory-core/index.js";
import type { OpenClawConfig } from "../api.js";

export function assertToolDetailsRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected tool details object");
  }
  return value as Record<string, unknown>;
}

export function registerMemoryCoreTools(appConfig: OpenClawConfig) {
  const factories = new Map<string, OpenClawPluginToolFactory>();
  memoryCorePlugin.register(
    createTestPluginApi({
      id: "memory-core",
      config: appConfig,
      runtime: createPluginRuntimeMock(),
      registerTool(tool, options) {
        if (typeof tool === "function") {
          for (const name of options?.names ?? []) {
            factories.set(name, tool);
          }
        }
      },
    }),
  );
  return (
    name: "memory_search" | "memory_get",
    agentId: string,
    session: string,
    sandboxed?: boolean,
  ): AnyAgentTool => {
    const factory = factories.get(name);
    if (!factory) {
      throw new Error(`Expected memory-core to register ${name}`);
    }
    const tool = factory({
      config: appConfig,
      runtimeConfig: appConfig,
      getRuntimeConfig: () => appConfig,
      agentId,
      sessionKey: `agent:${agentId}:${session}`,
      ...(sandboxed === undefined ? {} : { sandboxed }),
    });
    if (!tool || Array.isArray(tool)) {
      throw new Error(`Expected one ${name} tool`);
    }
    return tool;
  };
}
