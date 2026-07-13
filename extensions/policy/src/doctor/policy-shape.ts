import type { HealthFinding } from "openclaw/plugin-sdk/health";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  agentsPolicyShapeFinding,
  execApprovalsPolicyShapeFinding,
  ingressPolicyShapeFinding,
  scopedDataHandlingPolicyShapeFinding,
  scopedToolsPolicyShapeFinding,
} from "./access-shapes.js";
import { SUPPORTED_POLICY_SECTIONS } from "./policy-constants.js";
import { normalizePolicyChannelId } from "./policy-runtime.js";
import { duplicateScopedPolicyFieldFinding } from "./policy-scope.js";
import {
  agentWorkspacePolicyShapeFinding,
  gatewayPolicyShapeFinding,
  sandboxPolicyShapeFinding,
  toolPosturePolicyShapeFinding,
} from "./runtime-shapes.js";
import {
  policyShapeFinding,
  policyStringArrayPropertyShapeFinding,
  policyStringArrayShapeFinding,
  unsupportedPolicyKey,
} from "./shape-helpers.js";
import { ocPathSegment } from "./utils.js";

export function policyContainerShapeFindings(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): readonly HealthFinding[] {
  if (!isRecord(policy)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}`,
        `${policyPath} must contain a policy object.`,
        `Fix ${policyPath} so the top-level policy is an object.`,
      ),
    ];
  }
  const unsupportedTopLevel = unsupportedPolicyKey(policy, SUPPORTED_POLICY_SECTIONS);
  if (unsupportedTopLevel !== undefined) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/${ocPathSegment(unsupportedTopLevel)}`,
        `${policyPath} ${unsupportedTopLevel} is not a supported policy section.`,
        `Remove ${unsupportedTopLevel} or use a supported policy section.`,
      ),
    ];
  }
  if (policy.tools !== undefined && !isRecord(policy.tools)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/tools`,
        `${policyPath} tools must be an object.`,
        `Fix ${policyPath} so tools is an object.`,
      ),
    ];
  }
  if (isRecord(policy.tools)) {
    const postureFinding = toolPosturePolicyShapeFinding(policy.tools, {
      policyDocName,
      policyPath,
    });
    if (postureFinding !== undefined) {
      return [postureFinding];
    }
  }
  if (policy.channels !== undefined && !isRecord(policy.channels)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/channels`,
        `${policyPath} channels must be an object.`,
        `Fix ${policyPath} so channels is an object.`,
      ),
    ];
  }
  if (isRecord(policy.channels)) {
    const unsupportedChannelKey = unsupportedPolicyKey(policy.channels, ["denyRules"]);
    if (unsupportedChannelKey !== undefined) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/channels/${ocPathSegment(unsupportedChannelKey)}`,
          `${policyPath} channels.${unsupportedChannelKey} is not supported in channel policy.`,
          `Remove channels.${unsupportedChannelKey} or use channels.denyRules.`,
        ),
      ];
    }
  }
  if (policy.mcp !== undefined && !isRecord(policy.mcp)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/mcp`,
        `${policyPath} mcp must be an object.`,
        `Fix ${policyPath} so mcp is an object.`,
      ),
    ];
  }
  if (isRecord(policy.mcp)) {
    const unsupportedMcpKey = unsupportedPolicyKey(policy.mcp, ["servers"]);
    if (unsupportedMcpKey !== undefined) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/mcp/${ocPathSegment(unsupportedMcpKey)}`,
          `${policyPath} mcp.${unsupportedMcpKey} is not supported in MCP policy.`,
          `Remove mcp.${unsupportedMcpKey} or use mcp.servers.`,
        ),
      ];
    }
  }
  if (policy.dataHandling !== undefined && !isRecord(policy.dataHandling)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/dataHandling`,
        `${policyPath} dataHandling must be an object.`,
        `Fix ${policyPath} so dataHandling is an object.`,
      ),
    ];
  }
  if (isRecord(policy.mcp)) {
    const finding = policyStringArrayShapeFinding(policy.mcp.servers, {
      property: "mcp.servers",
      policyDocName,
      policyPath,
      target: "mcp/servers",
      valueName: "MCP server id",
    });
    if (finding !== undefined) {
      return [finding];
    }
  }
  if (policy.models !== undefined && !isRecord(policy.models)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/models`,
        `${policyPath} models must be an object.`,
        `Fix ${policyPath} so models is an object.`,
      ),
    ];
  }
  if (isRecord(policy.models)) {
    const unsupportedModelsKey = unsupportedPolicyKey(policy.models, ["providers"]);
    if (unsupportedModelsKey !== undefined) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/models/${ocPathSegment(unsupportedModelsKey)}`,
          `${policyPath} models.${unsupportedModelsKey} is not supported in model policy.`,
          `Remove models.${unsupportedModelsKey} or use models.providers.`,
        ),
      ];
    }
  }
  if (isRecord(policy.models)) {
    const finding = policyStringArrayShapeFinding(policy.models.providers, {
      property: "models.providers",
      policyDocName,
      policyPath,
      target: "models/providers",
      valueName: "model provider id",
    });
    if (finding !== undefined) {
      return [finding];
    }
  }
  if (policy.network !== undefined && !isRecord(policy.network)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/network`,
        `${policyPath} network must be an object.`,
        `Fix ${policyPath} so network is an object.`,
      ),
    ];
  }
  if (isRecord(policy.network)) {
    const unsupportedNetworkKey = unsupportedPolicyKey(policy.network, ["privateNetwork"]);
    if (unsupportedNetworkKey !== undefined) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/network/${ocPathSegment(unsupportedNetworkKey)}`,
          `${policyPath} network.${unsupportedNetworkKey} is not supported in network policy.`,
          `Remove network.${unsupportedNetworkKey} or use network.privateNetwork.`,
        ),
      ];
    }
    if (policy.network.privateNetwork !== undefined && !isRecord(policy.network.privateNetwork)) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/network/privateNetwork`,
          `${policyPath} network.privateNetwork must be an object.`,
          `Fix ${policyPath} so network.privateNetwork is an object.`,
        ),
      ];
    }
    if (isRecord(policy.network.privateNetwork)) {
      const unsupportedPrivateNetworkKey = unsupportedPolicyKey(policy.network.privateNetwork, [
        "allow",
      ]);
      if (unsupportedPrivateNetworkKey !== undefined) {
        return [
          policyShapeFinding(
            policyPath,
            `oc://${policyDocName}/network/privateNetwork/${ocPathSegment(unsupportedPrivateNetworkKey)}`,
            `${policyPath} network.privateNetwork.${unsupportedPrivateNetworkKey} is not supported in network policy.`,
            `Remove network.privateNetwork.${unsupportedPrivateNetworkKey} or use network.privateNetwork.allow.`,
          ),
        ];
      }
    }
    if (
      isRecord(policy.network.privateNetwork) &&
      policy.network.privateNetwork.allow !== undefined &&
      typeof policy.network.privateNetwork.allow !== "boolean"
    ) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/network/privateNetwork/allow`,
          `${policyPath} network.privateNetwork.allow must be a boolean.`,
          `Fix ${policyPath} so network.privateNetwork.allow is true or false.`,
        ),
      ];
    }
  }
  if (policy.secrets !== undefined && !isRecord(policy.secrets)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/secrets`,
        `${policyPath} secrets must be an object.`,
        `Fix ${policyPath} so secrets is an object.`,
      ),
    ];
  }
  if (isRecord(policy.secrets)) {
    const unsupportedSecretsKey = unsupportedPolicyKey(policy.secrets, [
      "allowInsecureProviders",
      "denySources",
      "requireManagedProviders",
    ]);
    if (unsupportedSecretsKey !== undefined) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/secrets/${ocPathSegment(unsupportedSecretsKey)}`,
          `${policyPath} secrets.${unsupportedSecretsKey} is not supported in secrets policy.`,
          `Remove secrets.${unsupportedSecretsKey} or use a supported secrets policy rule.`,
        ),
      ];
    }
  }
  if (policy.auth !== undefined && !isRecord(policy.auth)) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/auth`,
        `${policyPath} auth must be an object.`,
        `Fix ${policyPath} so auth is an object.`,
      ),
    ];
  }
  if (isRecord(policy.auth)) {
    const unsupportedAuthKey = unsupportedPolicyKey(policy.auth, ["profiles"]);
    if (unsupportedAuthKey !== undefined) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/auth/${ocPathSegment(unsupportedAuthKey)}`,
          `${policyPath} auth.${unsupportedAuthKey} is not supported in auth policy.`,
          `Remove auth.${unsupportedAuthKey} or use auth.profiles.`,
        ),
      ];
    }
  }
  if (
    isRecord(policy.auth) &&
    policy.auth.profiles !== undefined &&
    !isRecord(policy.auth.profiles)
  ) {
    return [
      policyShapeFinding(
        policyPath,
        `oc://${policyDocName}/auth/profiles`,
        `${policyPath} auth.profiles must be an object.`,
        `Fix ${policyPath} so auth.profiles is an object.`,
      ),
    ];
  }
  if (isRecord(policy.auth) && isRecord(policy.auth.profiles)) {
    const unsupportedProfilesKey = unsupportedPolicyKey(policy.auth.profiles, [
      "allowModes",
      "requireMetadata",
    ]);
    if (unsupportedProfilesKey !== undefined) {
      return [
        policyShapeFinding(
          policyPath,
          `oc://${policyDocName}/auth/profiles/${ocPathSegment(unsupportedProfilesKey)}`,
          `${policyPath} auth.profiles.${unsupportedProfilesKey} is not supported in auth profile policy.`,
          `Remove auth.profiles.${unsupportedProfilesKey} or use a supported auth profile policy rule.`,
        ),
      ];
    }
  }

  const execApprovalsFinding = execApprovalsPolicyShapeFinding(policy.execApprovals, {
    policyDocName,
    policyPath,
  });
  if (execApprovalsFinding !== undefined) {
    return [execApprovalsFinding];
  }
  const sandboxFinding = sandboxPolicyShapeFinding(policy.sandbox, {
    policyDocName,
    policyPath,
  });
  if (sandboxFinding !== undefined) {
    return [sandboxFinding];
  }
  const ingressFindingValue = ingressPolicyShapeFinding(policy.ingress, {
    policyDocName,
    policyPath,
  });
  if (ingressFindingValue !== undefined) {
    return [ingressFindingValue];
  }
  const gatewayFinding = gatewayPolicyShapeFinding(policy.gateway, {
    policyDocName,
    policyPath,
  });
  if (gatewayFinding !== undefined) {
    return [gatewayFinding];
  }
  const agentsFinding = agentsPolicyShapeFinding(policy.agents, {
    policyDocName,
    policyPath,
  });
  if (agentsFinding !== undefined) {
    return [agentsFinding];
  }
  const scopesFinding = scopedPolicyShapeFinding(policy.scopes, {
    policyDocName,
    policyPath,
    policy,
  });
  if (scopesFinding !== undefined) {
    return [scopesFinding];
  }
  return [];
}

function scopedPolicyShapeFinding(
  value: unknown,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly policy: Record<string, unknown>;
  },
): HealthFinding | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/scopes`,
      `${params.policyPath} scopes must be an object.`,
      `Fix ${params.policyPath} so scopes maps scope names to policy overlays with selectors such as agentIds.`,
    );
  }
  for (const [scopeName, overlay] of Object.entries(value)) {
    const targetPrefix = `scopes/${ocPathSegment(scopeName)}`;
    if (!isRecord(overlay)) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}`,
        `${params.policyPath} scopes.${scopeName} must be an object.`,
        `Fix ${params.policyPath} so the named policy scope is an object.`,
      );
    }
    const hasAgentIds = overlay.agentIds !== undefined;
    const hasChannelIds = overlay.channelIds !== undefined;
    if (!hasAgentIds && !hasChannelIds) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}`,
        `${params.policyPath} scopes.${scopeName} must define at least one selector.`,
        `List agentIds for agent-scoped policy or channelIds for channel-scoped ingress policy.`,
      );
    }
    const agentIdsFinding = scopedSelectorShapeFinding(overlay.agentIds, {
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      property: `scopes.${scopeName}.agentIds`,
      target: `${targetPrefix}/agentIds`,
      valueName: "agent id",
      normalize: normalizeAgentId,
    });
    if (agentIdsFinding !== undefined) {
      return agentIdsFinding;
    }
    const channelIdsFinding = scopedSelectorShapeFinding(overlay.channelIds, {
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      property: `scopes.${scopeName}.channelIds`,
      target: `${targetPrefix}/channelIds`,
      valueName: "channel id",
      normalize: normalizePolicyChannelId,
    });
    if (channelIdsFinding !== undefined) {
      return channelIdsFinding;
    }
    if (overlay.ingress !== undefined && !hasChannelIds) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/ingress`,
        `${params.policyPath} scopes.${scopeName}.ingress requires the channelIds selector.`,
        `Move global ingress rules to top-level ingress, or list channelIds for channel-scoped ingress policy.`,
      );
    }
    if (
      (overlay.agents !== undefined ||
        overlay.dataHandling !== undefined ||
        overlay.execApprovals !== undefined ||
        overlay.tools !== undefined ||
        overlay.sandbox !== undefined) &&
      !hasAgentIds
    ) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}`,
        `${params.policyPath} scopes.${scopeName} uses agent-scoped sections without agentIds.`,
        `List agentIds for agents.workspace, dataHandling.memory, tools, or sandbox policy sections.`,
      );
    }
    const unsupportedKey = Object.keys(overlay).find(
      (key) =>
        key !== "agentIds" &&
        key !== "channelIds" &&
        key !== "agents" &&
        key !== "dataHandling" &&
        key !== "execApprovals" &&
        key !== "tools" &&
        key !== "sandbox" &&
        key !== "ingress",
    );
    if (unsupportedKey !== undefined) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/${ocPathSegment(unsupportedKey)}`,
        `${params.policyPath} scopes.${scopeName}.${unsupportedKey} is not a supported scoped policy section.`,
        `Use agentIds with agents.workspace, dataHandling.memory, execApprovals, tools, or sandbox, and channelIds with ingress.channels.`,
      );
    }
    if (overlay.dataHandling !== undefined && !isRecord(overlay.dataHandling)) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/dataHandling`,
        `${params.policyPath} scopes.${scopeName}.dataHandling must be an object.`,
        `Fix ${params.policyPath} so the scoped dataHandling policy section is an object.`,
      );
    }
    if (isRecord(overlay.dataHandling)) {
      const scopedDataHandlingFinding = scopedDataHandlingPolicyShapeFinding(overlay.dataHandling, {
        policyPath: params.policyPath,
        policyDocName: params.policyDocName,
        targetPrefix,
        scopeName,
      });
      if (scopedDataHandlingFinding !== undefined) {
        return scopedDataHandlingFinding;
      }
    }
    if (overlay.agents !== undefined && !isRecord(overlay.agents)) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/agents`,
        `${params.policyPath} scopes.${scopeName}.agents must be an object.`,
        `Fix ${params.policyPath} so the scoped agents policy section is an object.`,
      );
    }
    const scopedAgents = isRecord(overlay.agents) ? overlay.agents : {};
    const unsupportedAgentKey = Object.keys(scopedAgents).find((key) => key !== "workspace");
    if (unsupportedAgentKey !== undefined) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/agents/${ocPathSegment(unsupportedAgentKey)}`,
        `${params.policyPath} scopes.${scopeName}.agents.${unsupportedAgentKey} is not supported by the agentIds selector.`,
        `Move the rule under agents.workspace or a supported scoped top-level section.`,
      );
    }
    const workspaceFinding = agentWorkspacePolicyShapeFinding(scopedAgents.workspace, {
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      targetPrefix: `${targetPrefix}/agents/workspace`,
      propertyPrefix: `scopes.${scopeName}.agents.workspace`,
    });
    if (workspaceFinding !== undefined) {
      return workspaceFinding;
    }

    const scopedExecApprovalsFinding = execApprovalsPolicyShapeFinding(overlay.execApprovals, {
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      targetPrefix: `${targetPrefix}/execApprovals`,
      propertyPrefix: `scopes.${scopeName}.execApprovals`,
      allowDefaults: false,
    });
    if (scopedExecApprovalsFinding !== undefined) {
      return scopedExecApprovalsFinding;
    }
    if (overlay.tools !== undefined && !isRecord(overlay.tools)) {
      return policyShapeFinding(
        params.policyPath,
        `oc://${params.policyDocName}/${targetPrefix}/tools`,
        `${params.policyPath} scopes.${scopeName}.tools must be an object.`,
        `Fix ${params.policyPath} so the scoped tools policy overlay is an object.`,
      );
    }
    if (isRecord(overlay.tools)) {
      const toolsFinding = scopedToolsPolicyShapeFinding(overlay.tools, {
        policyDocName: params.policyDocName,
        policyPath: params.policyPath,
        targetPrefix: `${targetPrefix}/tools`,
        propertyPrefix: `scopes.${scopeName}.tools`,
      });
      if (toolsFinding !== undefined) {
        return toolsFinding;
      }
    }
    const sandboxFinding = sandboxPolicyShapeFinding(overlay.sandbox, {
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      targetPrefix: `${targetPrefix}/sandbox`,
      propertyPrefix: `scopes.${scopeName}.sandbox`,
    });
    if (sandboxFinding !== undefined) {
      return sandboxFinding;
    }
    const ingressFindingLocal = ingressPolicyShapeFinding(overlay.ingress, {
      policyDocName: params.policyDocName,
      policyPath: params.policyPath,
      targetPrefix: `${targetPrefix}/ingress`,
      propertyPrefix: `scopes.${scopeName}.ingress`,
      allowSession: false,
    });
    if (ingressFindingLocal !== undefined) {
      return ingressFindingLocal;
    }
  }
  return duplicateScopedPolicyFieldFinding(value, {
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    policy: params.policy,
  });
}

function scopedSelectorShapeFinding(
  value: unknown,
  params: {
    readonly policyDocName: string;
    readonly policyPath: string;
    readonly property: string;
    readonly target: string;
    readonly valueName: string;
    readonly normalize: (value: string) => string;
  },
): HealthFinding | undefined {
  const selectorFinding = policyStringArrayPropertyShapeFinding(value, {
    policyDocName: params.policyDocName,
    policyPath: params.policyPath,
    property: params.property,
    target: params.target,
    valueName: params.valueName,
  });
  if (selectorFinding !== undefined) {
    return selectorFinding;
  }
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value) && value.length === 0) {
    return policyShapeFinding(
      params.policyPath,
      `oc://${params.policyDocName}/${params.target}`,
      `${params.policyPath} ${params.property} must include at least one ${params.valueName}.`,
      `Add one or more ${params.valueName}s to ${params.policyPath} ${params.property}.`,
    );
  }
  if (Array.isArray(value)) {
    const seen = new Map<string, number>();
    for (const [index, rawValue] of value.entries()) {
      if (typeof rawValue !== "string") {
        continue;
      }
      const normalized = params.normalize(rawValue);
      const previous = seen.get(normalized);
      if (previous !== undefined) {
        return policyShapeFinding(
          params.policyPath,
          `oc://${params.policyDocName}/${params.target}/#${index}`,
          `${params.policyPath} ${params.property}[${index}] duplicates ${params.property}[${previous}] after normalization.`,
          `List each ${params.valueName} only once per named policy scope.`,
        );
      }
      seen.set(normalized, index);
    }
  }
  return undefined;
}

export function hasValidScopedPolicy(
  policy: unknown,
  policyPath: string,
  policyDocName: string,
): boolean {
  return (
    isRecord(policy) &&
    scopedPolicyShapeFinding(policy.scopes, { policyDocName, policyPath, policy }) === undefined
  );
}
