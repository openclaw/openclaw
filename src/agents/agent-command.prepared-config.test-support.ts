import { expect, it, vi, type Mock } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { resolveAgentRuntimeConfig } from "./agent-runtime-config.js";
import * as agentScope from "./agent-scope.js";
import type { prepareAgentCommandExecution } from "./command/prepare.js";

export function registerAgentCommandPreparedConfigCases(params: {
  prepare: typeof prepareAgentCommandExecution;
  getConfig: () => OpenClawConfig;
  setAmbientConfig: (config: OpenClawConfig) => void;
  getMetadataSnapshot: () => PluginMetadataSnapshot;
  metadataLookups: { skillCommands: Mock; resolution: Mock };
}) {
  it.each([false, true])(
    "uses the admitted Gateway config and metadata (deliver=%s)",
    async (deliver) => {
      const metadataSnapshot = params.getMetadataSnapshot();
      const pluginGeneration = { pluginMetadataSnapshot: metadataSnapshot } as never;
      const defaults = params.getConfig();
      const config = {
        ...defaults,
        agents: {
          ...defaults.agents,
          defaults: {
            ...defaults.agents?.defaults,
            workspace: "/tmp/admitted-workspace",
          },
        },
      };
      params.setAmbientConfig({
        ...config,
        agents: {
          ...config.agents,
          defaults: { ...config.agents.defaults, workspace: "/tmp/replaced-workspace" },
        },
      });
      vi.spyOn(agentScope, "resolveAgentWorkspaceDir").mockImplementation(
        (cfg) => cfg.agents?.defaults?.workspace ?? "/tmp/workspace",
      );

      const prepared = await params.prepare(
        { message: "/demo", to: "+1234567890", deliver },
        {} as never,
        { config, pluginGeneration },
      );

      expect(prepared.cfg).toBe(config);
      expect(prepared.workspaceDir).toBe("/tmp/admitted-workspace");
      expect(resolveAgentRuntimeConfig).not.toHaveBeenCalled();
      expect(prepared.manifestMetadataSnapshot).toBe(metadataSnapshot);
      expect(prepared.commandRuntimeContext?.pluginGeneration).toBe(pluginGeneration);
      expect(params.metadataLookups.skillCommands).toHaveBeenCalledWith(
        expect.objectContaining({ pluginMetadataSnapshot: metadataSnapshot }),
      );
      expect(params.metadataLookups.resolution).not.toHaveBeenCalled();
    },
  );
}
