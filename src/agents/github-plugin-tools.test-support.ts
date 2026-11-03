import { onTestFinished } from "vitest";
import { registerGitHubAgentTools } from "../../extensions/github-repositories/agent-tools-api.js";
import manifest from "../../extensions/github-repositories/openclaw.plugin.json" with { type: "json" };
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "../plugin-sdk/plugin-test-contracts.js";
import { isBundledPluginEnabled } from "../plugins/config-state.js";
import { normalizePluginToolMetadata } from "../plugins/manifest-capability-normalizers.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createPluginToolFactoryContext } from "../plugins/tool-factory-context.js";
import { bindPluginToolCallbacks } from "../plugins/tool-factory-runtime.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import { resolveOpenClawPluginToolInputs } from "./openclaw-tools.plugin-context.js";
import { preparePluginToolExecutionCapabilities } from "./plugin-tool-execution.js";
import { preparePluginToolGatewayCapability } from "./plugin-tool-gateway.js";
import type { ResolveOpenClawPluginToolFixtureOptions } from "./test-helpers/github-plugin-tools.js";

/** Policy tests mock only discovery and external RPC I/O; the plugin factories and callbacks run. */
export function resolveGitHubPluginToolsFixture(params: ResolveOpenClawPluginToolFixtureOptions) {
  const config = params.resolvedConfig ?? params.options?.config ?? {};
  if (!isBundledPluginEnabled(config, manifest.id)) {
    return [];
  }
  const fixture = createPluginRegistryFixture(config);
  const record = createPluginRecord({
    id: manifest.id,
    origin: "bundled",
    contracts: manifest.contracts,
  });
  registerTestPlugin({ ...fixture, record, register: registerGitHubAgentTools });
  onTestFinished(async () => {
    await getPluginInstance(record)?.dispose();
  });
  const { context } = resolveOpenClawPluginToolInputs({
    options: params.options,
    resolvedConfig: config,
  });
  const bindGateway = preparePluginToolGatewayCapability(params.options, context);
  const bindExecution = preparePluginToolExecutionCapabilities({
    config,
    agentId: context.agentId,
  });
  const registry = fixture.registry.registry;
  const tools = [];
  for (const entry of registry.tools) {
    const factoryContext = createPluginToolFactoryContext({
      entry,
      registry,
      context,
      manifestToolMetadata: normalizePluginToolMetadata(manifest.toolMetadata),
      assertInvocationCurrent: params.options?.assertInvocationCurrent ?? (() => {}),
      bindExecutionCapabilities: (assertCurrent, signal) => ({
        ...bindExecution(assertCurrent, signal),
        // Policy fixtures replace the external RPC transport; native provider-service proof
        // exercises the real host custody family and installed-provider authority separately.
        gateway: bindGateway(assertCurrent, signal, [
          "tools.github.status",
          "sessions.github.action",
          "sessions.github.publish",
        ]),
      }),
    });
    const created = entry.factory(factoryContext);
    for (const tool of !created ? [] : Array.isArray(created) ? created : [created]) {
      const metadata = Object.entries(manifest.toolMetadata).find(
        ([name]) => name === tool.name,
      )?.[1];
      setPluginToolMeta(tool, {
        pluginId: manifest.id,
        optional: false,
        policyGroups: metadata?.policyGroups,
      });
      tools.push(
        bindPluginToolCallbacks(entry, registry, tool, factoryContext.assertInvocationCurrent),
      );
    }
  }
  return tools;
}
