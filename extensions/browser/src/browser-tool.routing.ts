import { hasGatewayToolRoutingContext, listNodes } from "openclaw/plugin-sdk/agent-harness-runtime";
import { readRuntimeConfig as getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveBrowserNodeTarget } from "./browser-node-routing.js";
import { resolveBrowserConfig } from "./browser/config.js";

export async function resolveBrowserToolNodeTarget(params: {
  requestedNode?: string;
  profile?: string;
  target?: "sandbox" | "host" | "node";
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
  signal?: AbortSignal;
}) {
  if (params.allowHostControl === false) {
    if (params.target === "node" || params.requestedNode) {
      throw new Error("Node browser control is disabled by sandbox policy.");
    }
    return null;
  }

  const cfg = getRuntimeConfig();
  const policy = cfg.gateway?.nodes?.browser;
  const explicitTarget = params.target === "node";
  const requestedNode = params.requestedNode?.trim();
  if (policy?.mode === "off") {
    await resolveBrowserNodeTarget({ nodes: () => [], config: cfg, requestedNode, explicitTarget });
    return null;
  }
  if (params.sandboxBridgeUrl?.trim() && !explicitTarget && !requestedNode) {
    return null;
  }
  if (params.target && !explicitTarget) {
    return null;
  }
  // Browser control can create Gateway auth itself. Credentials do not imply
  // node routing; standalone runs use the host unless a Gateway route is selected.
  if (
    !explicitTarget &&
    !requestedNode &&
    !policy?.node?.trim() &&
    (policy?.mode === "manual" ||
      (policy?.mode !== "auto" &&
        !hasGatewayToolRoutingContext() &&
        cfg.gateway?.mode !== "remote" &&
        !cfg.gateway?.remote?.url?.trim() &&
        !process.env.OPENCLAW_GATEWAY_URL?.trim()))
  ) {
    return null;
  }
  const node = await resolveBrowserNodeTarget({
    nodes: () => listNodes({}, params.signal),
    config: cfg,
    profile: params.profile,
    requestedNode,
    explicitTarget,
    requireConnected: true,
  });
  params.signal?.throwIfAborted();
  return node
    ? {
        nodeId: node.nodeId,
        label: node.displayName ?? node.remoteIp ?? node.nodeId,
        commands: node.commands ?? [],
        pendingDeclaredCommands: node.pendingDeclaredCommands ?? [],
      }
    : null;
}

export function resolveBrowserBaseUrl(params: {
  target?: "sandbox" | "host";
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
}): string | undefined {
  const cfg = getRuntimeConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const normalizedSandbox = params.sandboxBridgeUrl?.trim() ?? "";
  const target = params.target ?? (normalizedSandbox ? "sandbox" : "host");

  if (target === "sandbox") {
    if (!normalizedSandbox) {
      throw new Error(
        'Sandbox browser is unavailable. Enable agents.defaults.sandbox.browser.enabled or use target="host" if allowed.',
      );
    }
    return normalizedSandbox.replace(/\/$/, "");
  }

  if (params.allowHostControl === false) {
    throw new Error("Host browser control is disabled by sandbox policy.");
  }
  if (!resolved.enabled) {
    throw new Error(
      "Browser control is disabled. Set browser.enabled=true in ~/.openclaw/openclaw.json.",
    );
  }
  return undefined;
}
