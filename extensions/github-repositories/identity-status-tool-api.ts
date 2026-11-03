import type { ToolsGitHubStatusResult } from "@openclaw/gateway-protocol";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { bindAgentToolAvailability } from "openclaw/plugin-sdk/tool-plugin";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";

const GITHUB_IDENTITY_STATUS_PARAMETERS = Type.Object({}, { additionalProperties: false });

export function createGitHubIdentityStatusTool(
  gateway: NonNullable<OpenClawPluginToolContext<2>["gateway"]>,
): AnyAgentTool {
  let githubIdentitySettingsAvailable = gateway.clientCaps.includes("ui-agent-github-settings");
  const tool: AnyAgentTool = {
    label: "GitHub Identity Status",
    name: "github_identity_status",
    description: githubIdentityStatusDescription(githubIdentitySettingsAvailable),
    parameters: GITHUB_IDENTITY_STATUS_PARAMETERS,
    execute: async () => {
      const status = await gateway.call<ToolsGitHubStatusResult>("tools.github.status", {
        agentId: gateway.agentId,
        selectedScope: "agent",
      });
      const reconnect =
        status.effective.credentialState !== "available" ||
        ["expired", "failed", "unavailable"].includes(status.effective.refreshState);
      return jsonResult({
        ...status,
        ...(reconnect
          ? {
              nextAction: githubIdentitySettingsAvailable
                ? "Use screen action github_identity_settings to open the masked operator reconnect flow, then check github_identity_status again."
                : "Ask the operator to open Settings → Agents → Tools, reconnect GitHub, then check github_identity_status again.",
            }
          : {}),
      });
    },
  };
  return bindAgentToolAvailability(tool, {
    prepare(preparedTool, callableTools, offeredTools) {
      const callableScreen = callableTools.get("screen");
      const offeredScreen = offeredTools.get("screen");
      githubIdentitySettingsAvailable =
        gateway.clientCaps.includes("ui-agent-github-settings") &&
        callableScreen !== undefined &&
        schemaIncludesAction(callableScreen.parameters, "github_identity_settings");
      const githubIdentitySettingsOffered =
        offeredScreen !== undefined &&
        schemaIncludesAction(offeredScreen.parameters, "github_identity_settings");
      preparedTool.description = githubIdentityStatusDescription(githubIdentitySettingsOffered);
    },
  });
}

function githubIdentityStatusDescription(settingsAvailable: boolean): string {
  return `Inspect the secret-free effective GitHub account, credential health, Git author, expiry, and scopes for this agent.${settingsAvailable ? " If setup or reconnection is needed, open github_identity_settings so the operator can reconnect in the masked Control UI flow." : ""}`;
}

function schemaIncludesAction(schema: unknown, expected: string): boolean {
  const properties = isRecord(schema) ? schema.properties : undefined;
  const action = isRecord(properties) ? properties.action : undefined;
  return isRecord(action) && Array.isArray(action.enum) && action.enum.includes(expected);
}
