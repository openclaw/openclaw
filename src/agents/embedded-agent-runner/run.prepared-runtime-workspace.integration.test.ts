import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createAssistantMessageEventStream, type Context } from "openclaw/plugin-sdk/llm";
import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
} from "../../plugins/loader.test-fixtures.js";
import { pluginInstanceInvocation } from "../../plugins/plugin-instance-invocation.js";
import { getPluginInstanceOwner } from "../../plugins/plugin-instance-scope.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../prepared-model-runtime.test-support.js";
import type { StreamFn } from "../runtime/index.js";
import { completionModelDefinition } from "../simple-completion.test-support.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { runEmbeddedAgent } from "./run.js";
import { clearEmbeddedSessionPromptStates } from "./session-prompt-state.js";

const providerPluginId = "scripted-anthropic";
const siblingPluginId = "registration-rollback";
const sessionId = "prepared-runtime-workspace";

it("admits a second workspace turn through real prepared runtime after registration rollback", async () => {
  await withOpenClawTestState({ label: "prepared-workspace-turns" }, async (state) => {
    const bundled = state.path("bundled");
    await fs.mkdir(bundled);
    type Owner = NonNullable<ReturnType<typeof getPluginInstanceOwner>>;
    const registrations: Array<{
      owner: Owner;
      instance: NonNullable<Owner["instance"]>;
      disposals: number;
      turn: number;
    }> = [];
    let activeTurn = 0;
    const requests: Array<Context["systemPrompt"]> = [];
    const stream: StreamFn = (model, context) => {
      requests.push(context.systemPrompt);
      const message = makeAgentAssistantMessage({
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: "text", text: `SCRIPTED-${requests.length}` }],
      });
      const events = createAssistantMessageEventStream();
      queueMicrotask(() => {
        events.push({ type: "done", reason: "stop", message });
        events.end();
      });
      return events;
    };
    const bridge = {
      stream,
      capture: () => {
        const instance = expectDefined(
          pluginInstanceInvocation.getStore()?.instance,
          "registering instance",
        );
        const owner = expectDefined(getPluginInstanceOwner(instance), "registration owner");
        const registration = {
          owner,
          instance: expectDefined(owner.instance, "owned plugin instance"),
          disposals: 0,
          turn: activeTurn,
        };
        registrations.push(registration);
        return registration;
      },
    };
    const bridgeKey = `__prepared_workspace_${path.basename(state.root)}`;
    Object.defineProperty(globalThis, bridgeKey, { configurable: true, value: bridge });
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Scripted prepared-runtime fixture must not perform network I/O");
    });
    try {
      for (const pluginId of [providerPluginId, siblingPluginId]) {
        const rootDir = path.join(bundled, pluginId);
        await fs.mkdir(rootDir);
        const fixture = createColdPluginFixture({
          rootDir,
          pluginId,
          providerId: "anthropic",
          manifest: {
            channels: [],
            channelConfigs: {},
            providerAuthChoices: [],
            providers: pluginId === providerPluginId ? ["anthropic"] : [],
          },
        });
        await fs.writeFile(
          fixture.runtimeSource,
          `
module.exports = { id: ${JSON.stringify(pluginId)}, register(api) {
  const bridge = globalThis[${JSON.stringify(bridgeKey)}];
  const registration = bridge.capture();
  api.lifecycle.registerRuntimeLifecycle({ id: "fixture", dispose() { registration.disposals++; } });
  ${
    pluginId === siblingPluginId
      ? 'if (registration.turn === 1) throw new Error("Synthetic registration rollback");'
      : 'api.registerProvider({ id: "anthropic", label: "Scripted Anthropic", auth: [], wrapStreamFn: () => (model, context, options) => bridge.stream(model, context, options) });'
  }
} };
`,
        );
      }
      const config: OpenClawConfig = {
        agents: {
          entries: { main: { agentDir: state.agentDir(), workspace: state.workspaceDir } },
          defaults: { workspace: state.workspaceDir, model: "anthropic/claude-opus-5" },
        },
        models: {
          mode: "replace",
          providers: {
            anthropic: {
              api: "anthropic-messages",
              auth: "api-key",
              apiKey: "synthetic-workspace-key",
              baseUrl: "https://api.anthropic.com",
              models: [completionModelDefinition({ id: "claude-opus-5", contextWindow: 200_000 })],
            },
          },
        },
        plugins: {
          allow: [providerPluginId, siblingPluginId],
          slots: { memory: "none" },
          entries: {
            [providerPluginId]: { enabled: true },
            [siblingPluginId]: { enabled: true },
          },
        },
        skills: { load: { watch: false } },
      };
      await state.writeConfig(config);
      await withEnvAsync(
        { OPENCLAW_BUNDLED_PLUGINS_DIR: bundled, OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined },
        async () => {
          await resetPreparedModelRuntimeSnapshotsForTest();
          clearPluginMetadataLifecycleCaches();
          setRuntimeConfigSnapshot(config);
          try {
            for (const [index, rule] of [
              "Original workspace instruction.",
              "Updated workspace instruction.",
            ].entries()) {
              activeTurn = index;
              await fs.writeFile(
                path.join(state.workspaceDir, "AGENTS.md"),
                `## Workspace rule\n${rule}\n`,
              );
              const runId = `${sessionId}-${index}`;
              const admission = prepareSystemAgentRunAdmission(
                config,
                runId,
                "main",
                "scripted-workspace",
              );
              try {
                const result = await runEmbeddedAgent({
                  preparedRunAdmission: admission,
                  config,
                  runId,
                  sessionId,
                  agentDir: state.agentDir(),
                  workspaceDir: state.workspaceDir,
                  sessionTarget: {
                    agentId: "main",
                    sessionId,
                    sessionKey: `agent:main:${sessionId}`,
                    storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
                  },
                  provider: "anthropic",
                  model: "claude-opus-5",
                  prompt: `Reply for workspace turn ${index + 1}.`,
                  disableTools: true,
                  cleanupBundleMcpOnRunEnd: true,
                  timeoutMs: 30_000,
                });
                expect(result.meta.error).toBeUndefined();
              } finally {
                admission.close();
              }
            }
            expect(network).not.toHaveBeenCalled();
            const siblingRegistrations = registrations
              .filter(({ owner }) => owner.record.id === siblingPluginId)
              .map(({ owner, turn }) => ({ status: owner.record.status, turn }));
            expect(siblingRegistrations).toContainEqual({ status: "loaded", turn: 0 });
            expect(siblingRegistrations.map(({ status }) => status)).toContain("error");
            expect(requests).toEqual([
              expect.stringContaining("Original workspace instruction."),
              expect.stringContaining("Updated workspace instruction."),
            ]);
          } finally {
            await resetPreparedModelRuntimeSnapshotsForTest();
            resetPluginLoaderTestStateForTest();
            cleanupPluginLoaderFixturesForTest();
            clearPluginMetadataLifecycleCaches();
            for (const { owner, instance, disposals, turn } of registrations) {
              expect(
                { disposals, acceptingCalls: instance.acceptingCalls },
                `${owner.record.id} turn ${turn}`,
              ).toEqual({ disposals: 1, acceptingCalls: false });
            }
          }
        },
      );
    } finally {
      network.mockRestore();
      clearEmbeddedSessionPromptStates([sessionId]);
      Reflect.deleteProperty(globalThis, bridgeKey);
    }
  });
});
