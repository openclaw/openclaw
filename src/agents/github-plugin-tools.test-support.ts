import path from "node:path";
import { onTestFinished } from "vitest";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "../plugin-sdk/plugin-test-contracts.js";
import { isBundledPluginEnabled } from "../plugins/config-state.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import type { OpenClawPluginDefinition } from "../plugins/plugin-definition.types.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createPluginToolFactoryContext } from "../plugins/tool-factory-context.js";
import { bindPluginToolCallbacks } from "../plugins/tool-factory-runtime.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import {
  loadBundledPluginFacade,
  resolveBundledPluginPublicModulePath,
} from "../test-utils/bundled-plugin-public-surface.js";
import { resolveOpenClawPluginToolInputs } from "./openclaw-tools.plugin-context.js";
import { preparePluginToolExecutionCapabilities } from "./plugin-tool-execution.js";
import { preparePluginToolGatewayCapability } from "./plugin-tool-gateway.js";
import type { ResolveOpenClawPluginToolFixtureOptions } from "./test-helpers/github-plugin-tools.js";

const entry = resolveBundledPluginPublicModulePath({
  pluginId: "github-repositories",
  artifactBasename: "index.ts",
});
const loadedManifest = loadPluginManifest(path.dirname(entry));
if (!loadedManifest.ok) {
  throw new Error(loadedManifest.error);
}
const manifest = loadedManifest.manifest;
const { default: repositoryPlugin } = await loadBundledPluginFacade<{
  default: OpenClawPluginDefinition;
}>({ pluginId: "github-repositories", artifactBasename: "index.ts" });
const declaredRegister = repositoryPlugin.register;
if (!declaredRegister) {
  throw new Error("The GitHub repository entry did not declare its register operation");
}
const registerRepositoryPlugin = declaredRegister;

/** Policy tests mock only discovery and external RPC I/O; the plugin factories and callbacks run. */
export function resolveGitHubPluginToolsFixture(params: ResolveOpenClawPluginToolFixtureOptions) {
  const config = params.resolvedConfig ?? params.options?.config ?? {};
  if (!isBundledPluginEnabled(config, manifest.id)) {
    return [];
  }
  const fixture = createPluginRegistryFixture(config);
  const record = createPluginRecord({
    id: manifest.id,
    source: entry,
    origin: "bundled",
    contracts: manifest.contracts,
    repositorySources: manifest.repositorySources,
    dashboard: manifest.dashboard,
  });
  registerTestPlugin({ ...fixture, record, register: registerRepositoryPlugin });
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
      manifestToolMetadata: manifest.toolMetadata,
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
      const metadata = manifest.toolMetadata?.[tool.name];
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
