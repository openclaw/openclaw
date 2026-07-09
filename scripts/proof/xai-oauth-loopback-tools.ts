// Real-behavior proof: OAuth-only xAI tools on the CLI-backend loopback path.
//
// This script builds a real plugin registry containing the bundled xAI plugin,
// activates it, and then exercises the actual gateway tool-resolution path
// (resolveGatewayScopedTools -> createOpenClawTools -> plugin registry) with an
// OAuth-only auth profile store. It prints the resulting tool surface in MCP
// tools/list JSON-RPC form. All tokens, keys, account IDs, phone numbers, IPs,
// and non-public endpoints are redacted.

import xaiPlugin from "../../extensions/xai/index.js";
import type { AuthProfileStore } from "../../src/agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { resolveGatewayScopedTools } from "../../src/gateway/tool-resolution.js";
import { buildPluginApi } from "../../src/plugins/api-builder.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import type { PluginToolRegistration } from "../../src/plugins/registry-types.js";
import { setActivePluginRegistry } from "../../src/plugins/runtime.js";
import type { OpenClawPluginToolFactory } from "../../src/plugins/types.js";

function createXaiOAuthProfileStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "xai-oauth": {
        type: "oauth",
        provider: "xai",
        access: "REDACTED_ACCESS_TOKEN",
        refresh: "REDACTED_REFRESH_TOKEN",
        expires: 1_900_000_000_000,
      },
    },
  };
}

async function main(): Promise<void> {
  const registry = createEmptyPluginRegistry();

  const api = buildPluginApi({
    id: "xai",
    name: "xai",
    source: "bundled",
    registrationMode: "bundled",
    config: { tools: { profile: "coding" } } as OpenClawConfig,
    runtime: {} as never,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    resolvePath: (input: string) => input,
    handlers: {
      registerTool: (tool, opts) => {
        const names = [...(opts?.names ?? []), ...(opts?.name ? [opts.name] : [])];
        const factory: OpenClawPluginToolFactory = typeof tool === "function" ? tool : () => tool;
        if (typeof tool !== "function") {
          names.push(tool.name);
        }
        const registration: PluginToolRegistration = {
          pluginId: "xai",
          pluginName: "xai",
          factory,
          names: [...new Set(names.filter((name) => name.length > 0))],
          declaredNames: [],
          optional: opts?.optional === true,
          source: "bundled",
        };
        registry.tools.push(registration);
      },
    },
  });

  xaiPlugin.register(api);
  setActivePluginRegistry(registry, "proof", "default", "/tmp/xai-oauth-proof");

  console.log("[xai-oauth-loopback-proof] registered plugin tool count:", registry.tools.length);
  console.log(
    "[xai-oauth-loopback-proof] registered plugin tool names:",
    registry.tools.flatMap((entry) => entry.names).join(", ") || "(none)",
  );

  const authProfileStore = createXaiOAuthProfileStore();
  const result = resolveGatewayScopedTools({
    cfg: { tools: { profile: "coding" } } as OpenClawConfig,
    sessionKey: "agent:main",
    surface: "loopback",
    authProfileStore,
  });

  const toolNames = result.tools.map((tool) => tool.name).toSorted();
  const mcpToolsListResponse = {
    jsonrpc: "2.0",
    id: "proof-tools-list",
    result: {
      tools: result.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
      })),
    },
  };

  console.log("[xai-oauth-loopback-proof] resolved loopback tool names:", toolNames.join(", "));
  console.log("[xai-oauth-loopback-proof] MCP tools/list response:");
  console.log(JSON.stringify(mcpToolsListResponse, null, 2));

  if (!toolNames.includes("x_search") || !toolNames.includes("code_execution")) {
    console.error("FAIL: x_search and/or code_execution were not surfaced.");
    process.exit(1);
  }

  console.log("PASS: x_search and code_execution are present on the loopback surface.");
}

void main();
