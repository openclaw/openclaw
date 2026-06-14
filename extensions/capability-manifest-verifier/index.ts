import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveLivePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { buildJsonPluginConfigSchema, definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  CapabilityManifestVerifierConfigSchema,
  resolveCapabilityManifestVerifierConfig,
} from "./src/config.js";
import {
  CapabilityManifestError,
  loadVerifiedCapabilityManifest,
  resolveToolGrantDecision,
  sanitizeToolName,
} from "./src/manifest.js";

export default definePluginEntry({
  id: "capability-manifest-verifier",
  name: "Capability Manifest Verifier",
  description: "Enforces broker-issued capability manifest grants before tool execution.",
  configSchema: buildJsonPluginConfigSchema(
    CapabilityManifestVerifierConfigSchema as unknown as Parameters<
      typeof buildJsonPluginConfigSchema
    >[0],
  ),
  register(api) {
    const resolveCurrentConfig = () => {
      const runtimePluginConfig = resolveLivePluginConfigObject(
        api.runtime.config?.current
          ? () => api.runtime.config.current() as OpenClawConfig
          : undefined,
        "capability-manifest-verifier",
        api.pluginConfig as Record<string, unknown>,
      );
      return resolveCapabilityManifestVerifierConfig(runtimePluginConfig);
    };

    api.registerTrustedToolPolicy({
      id: "capability-manifest-verifier",
      description: "Gate tool calls through a broker-issued capability manifest.",
      async evaluate(event) {
        const config = resolveCurrentConfig();
        if (!config.enabled) {
          return undefined;
        }
        const toolName = sanitizeToolName(event.toolName);
        try {
          const manifest = await loadVerifiedCapabilityManifest(config);
          const decision = resolveToolGrantDecision(
            manifest,
            event.toolName,
            config.defaultDecision,
          );
          if (decision === "allow") {
            return undefined;
          }
          if (decision === "approval") {
            return {
              requireApproval: {
                title: config.approvalTitle,
                description: `Capability manifest requires approval before running ${toolName}.`,
                severity: "warning",
                timeoutBehavior: "deny",
                allowedDecisions: ["allow-once", "deny"],
              },
            };
          }
          if (decision === "deny") {
            return {
              block: true,
              blockReason: `Capability manifest denies tool: ${toolName}.`,
            };
          }
          return {
            block: true,
            blockReason: `Capability manifest has no grant for tool: ${toolName}.`,
          };
        } catch (error) {
          const reason =
            error instanceof CapabilityManifestError ? error.message : "manifest unavailable";
          return {
            block: true,
            blockReason: `Capability manifest check failed: ${reason}.`,
          };
        }
      },
    });
  },
});
