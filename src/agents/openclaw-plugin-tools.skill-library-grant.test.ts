import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { bindPluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-binding.js";
import { resolvePluginRuntimeArtifactSelection } from "../plugins/plugin-runtime-artifact-selection.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { setPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { SkillLibraryAuthoringCapability } from "../skills/library/authoring.js";
import { resolveOpenClawPluginToolsForOptions } from "./openclaw-plugin-tools.js";
import type { AnyAgentTool } from "./tools/common.js";

// A run's personal-library grant governs only plugins that author the agent's own skills
// (manifest `agentSkillsDir`, as skill-workshop declares); other plugins' tools are untouched.
it.each(["personal", "workspace"] as const)(
  "applies the %s library grant only to plugins that author agent skills",
  async (defaultTarget) => {
    const config: OpenClawConfig = {
      agents: { entries: { main: {} } },
      plugins: {
        enabled: true,
        entries: { "skill-author": { enabled: true }, "third-party": { enabled: true } },
      },
      tools: { codeMode: false, toolSearch: false },
    };
    const builder = createTestPluginRegistry();
    const plugins = [
      { id: "skill-author", tool: "author_skill", agentSkillsDir: "author-skills" },
      { id: "third-party", tool: "third_party_note" },
    ];
    const records = plugins.map((plugin) => {
      const artifact = {
        source: `/synthetic/${plugin.id}/index.js`,
        rootDir: `/synthetic/${plugin.id}`,
        origin: "bundled" as const,
        preferBuiltPluginArtifacts: false,
      };
      const record = createPluginRecord({
        id: plugin.id,
        ...artifact,
        contracts: { tools: [plugin.tool] },
      });
      if (plugin.agentSkillsDir) {
        record.agentSkillsDir = plugin.agentSkillsDir;
      }
      bindPluginRuntimeArtifactSelection(record, {
        preferBuiltPluginArtifacts: false,
        runtimeEntry: resolvePluginRuntimeArtifactSelection({ ...artifact, entryKind: "runtime" }),
      });
      builder.registry.plugins.push(record);
      return { record, artifact, tool: plugin.tool };
    });
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: records.map(({ record, artifact }) => ({
        id: record.id,
        ...artifact,
        enabledByDefault: true,
        contracts: record.contracts,
      })),
    });
    setPluginRuntimeLoadContext(builder.registry, {
      rawConfig: config,
      config,
      activationSourceConfig: config,
      autoEnabledReasons: {},
      workspaceDir: "/synthetic",
      env: process.env,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      manifestRegistry: snapshot.manifestRegistry,
      metadataSnapshot: snapshot,
    });
    const executed: string[] = [];
    for (const { record, tool: name } of records) {
      const api = builder.createApi(record, { config, registrationMode: "full" });
      api.registerTool(
        (): AnyAgentTool => ({
          name,
          label: name,
          description: name,
          parameters: { type: "object", properties: {} },
          async execute() {
            executed.push(name);
            return { content: [], details: {} };
          },
        }),
        { name },
      );
    }
    const assertWorkspaceCurrent = vi.fn();
    const grant: SkillLibraryAuthoringCapability = {
      target: "personal",
      defaultTarget,
      multipleProfiles: defaultTarget === "personal",
      assertWorkspaceCurrent,
      bind: () => {},
      invoke: () => Promise.reject(new Error("The grant test performs no library operation")),
    };
    try {
      const tools = withPluginRuntimeRegistryScope(builder.registry, () =>
        resolveOpenClawPluginToolsForOptions({
          options: {
            config,
            workspaceDir: "/synthetic",
            agentSessionKey: "agent:main:dashboard:grant",
            sessionId: "grant-session",
            runId: "grant-run",
            assertInvocationCurrent: () => {},
            skillLibraryAuthoring: grant,
          },
        }),
      );
      const names = tools.map((tool) => tool.name);
      if (defaultTarget === "personal") {
        // A personal-default requester never gets the agent's own skill authoring.
        expect(names).toEqual(["third_party_note"]);
      } else {
        expect(names).toEqual(["author_skill", "third_party_note"]);
      }
      for (const tool of tools) {
        await tool.execute(`${tool.name}-call`, {});
      }
      // Only the skill author's calls recheck the grant's current administrator authority.
      expect(assertWorkspaceCurrent).toHaveBeenCalledTimes(defaultTarget === "workspace" ? 1 : 0);
      expect(executed).toEqual(names);
    } finally {
      await disposePluginRegistryInstances(builder.registry);
    }
  },
);
