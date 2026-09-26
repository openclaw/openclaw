import { resolveNodeIdFromList } from "openclaw/plugin-sdk/agent-harness-runtime";
/** Shared browser-node selection for agent tools and Gateway requests. */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { BROWSER_PROXY_COMMAND } from "./browser-node-commands.js";

export type BrowserNodeTarget = {
  nodeId: string;
  displayName?: string;
  label?: string;
  connected?: boolean;
  caps?: string[];
  commands?: string[];
  pendingDeclaredCommands?: string[];
};

/** Select the same authorized browser-capable node on every request surface. */
export async function resolveBrowserNodeTarget<T extends BrowserNodeTarget>(params: {
  nodes: () => T[] | Promise<T[]>;
  config: OpenClawConfig;
  profile?: string;
  requestedNode?: string;
  explicitTarget?: boolean;
  requireConnected?: boolean;
}): Promise<T | null> {
  const policy = params.config.gateway?.nodes?.browser;
  const mode = policy?.mode ?? "auto";
  const explicit = params.explicitTarget || Boolean(params.requestedNode?.trim());
  if (mode === "off") {
    if (explicit) {
      throw new Error("Node browser proxy is disabled (gateway.nodes.browser.mode=off).");
    }
    return null;
  }

  const requested = params.requestedNode?.trim() || policy?.node?.trim();
  if (mode === "manual" && !explicit && !requested) {
    return null;
  }
  if (!explicit && !requested) {
    const { isBrowserHostAvailable } = await import("./browser-host-availability.js");
    if (await isBrowserHostAvailable(params.config, params.profile)) {
      return null;
    }
  }

  const browserNodes = (await params.nodes()).filter((node) => {
    if (params.requireConnected && !node.connected) {
      return false;
    }
    return node.caps?.includes("browser") || node.commands?.includes(BROWSER_PROXY_COMMAND);
  });
  if (browserNodes.length === 0) {
    if (explicit || requested) {
      throw new Error("No connected browser-capable nodes.");
    }
    return null;
  }

  if (requested) {
    const nodeId = resolveNodeIdFromList(browserNodes, requested, false, {
      allowCompactDisplayName: true,
    });
    return browserNodes.find((node) => node.nodeId === nodeId) ?? null;
  }

  if (browserNodes.length === 1) {
    return browserNodes[0] ?? null;
  }
  if (explicit) {
    throw new Error(
      `Multiple browser-capable nodes connected (${browserNodes.length}). Set gateway.nodes.browser.node or pass node=<id>.`,
    );
  }
  return null;
}
