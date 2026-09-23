import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sessionShareControlUiOrigin } from "./original-url.js";

type SessionShareConfigSnapshot = ReturnType<PluginRuntime["config"]["current"]>;

function sessionShareConfig(config: SessionShareConfigSnapshot): Record<string, unknown> {
  const value = config.plugins?.entries?.["session-share"]?.config;
  return isRecord(value) ? value : {};
}

export function sessionShareSelection(
  config: SessionShareConfigSnapshot,
): { groups?: string[]; involvingProfileId?: string } | undefined {
  const share = sessionShareConfig(config).share;
  if (!isRecord(share)) {
    return undefined;
  }
  const { groups, involvingProfileId } = share;
  if (
    (groups === undefined && involvingProfileId === undefined) ||
    (groups !== undefined &&
      (!Array.isArray(groups) ||
        groups.length === 0 ||
        !groups.every((group) => typeof group === "string" && group.length > 0))) ||
    (involvingProfileId !== undefined &&
      (typeof involvingProfileId !== "string" || !/^\S+$/.test(involvingProfileId)))
  ) {
    return undefined;
  }
  return {
    ...(groups !== undefined ? { groups } : {}),
    ...(involvingProfileId !== undefined ? { involvingProfileId } : {}),
  };
}

export function sessionShareNodeBinding(
  config: SessionShareConfigSnapshot,
  nodeId: string,
): {
  owner?: string;
  controlUiOrigin?: string;
  linkGitHubIdentities: boolean;
} {
  const nodes = sessionShareConfig(config).nodes;
  const binding = isRecord(nodes) ? nodes[nodeId] : undefined;
  return {
    ...(isRecord(binding) && typeof binding.owner === "string" ? { owner: binding.owner } : {}),
    controlUiOrigin: sessionShareControlUiOrigin(
      isRecord(binding) ? binding.controlUiOrigin : undefined,
    ),
    linkGitHubIdentities: isRecord(binding) && binding.linkGitHubIdentities === true,
  };
}
