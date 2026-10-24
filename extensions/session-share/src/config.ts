import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sessionShareControlUiOrigin } from "./original-url.js";

type SessionShareConfigSnapshot = ReturnType<PluginRuntime["config"]["current"]>;

function sessionShareConfig(config: SessionShareConfigSnapshot): Record<string, unknown> {
  const value = config.plugins?.entries?.["session-share"]?.config;
  return isRecord(value) ? value : {};
}

export function sessionShareGroups(config: SessionShareConfigSnapshot): string[] {
  const share = sessionShareConfig(config).share;
  if (!isRecord(share) || !Array.isArray(share.groups)) {
    return [];
  }
  return share.groups.filter(
    (group): group is string => typeof group === "string" && group.length > 0,
  );
}

export function sessionShareNodeBinding(
  config: SessionShareConfigSnapshot,
  nodeId: string,
): {
  owner?: string;
  controlUiOrigin?: string;
  controlUiBasePath?: unknown;
  linkGitHubIdentities: boolean;
} {
  const nodes = sessionShareConfig(config).nodes;
  const binding = isRecord(nodes) ? nodes[nodeId] : undefined;
  return {
    ...(isRecord(binding) && typeof binding.owner === "string" ? { owner: binding.owner } : {}),
    controlUiOrigin: sessionShareControlUiOrigin(
      isRecord(binding) ? binding.controlUiOrigin : undefined,
    ),
    controlUiBasePath: isRecord(binding) ? binding.controlUiBasePath : undefined,
    linkGitHubIdentities: isRecord(binding) && binding.linkGitHubIdentities === true,
  };
}
