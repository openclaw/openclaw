import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { createAssistantMessageEventStream, type Context } from "openclaw/plugin-sdk/llm";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
} from "../../plugins/loader.test-fixtures.js";
import { pluginInstanceInvocation } from "../../plugins/plugin-instance-invocation.js";
import {
  getPluginInstanceOwner,
  type PluginInstanceHandle,
} from "../../plugins/plugin-instance-scope.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { getPluginRuntimeGenerationRegistry } from "../../plugins/runtime/generation-scope.js";
import { createColdPluginFixture } from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../prepared-model-runtime.test-support.js";
import type { StreamFn } from "../runtime/index.js";
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
      instance: PluginInstanceHandle;
      disposals: number;
      mode: string;
      turn: number;
    }> = [];
    let activeTurn = 0;
    const requests: Context[] = [];
    const requestRegistries: Array<Array<{ id: string; status: string }>> = [];
    const stream: StreamFn = (model, context) => {
      requests.push(structuredClone(context));
      requestRegistries.push(
        getPluginRuntimeGenerationRegistry()?.plugins.map(({ id, status }) => ({ id, status })) ??
          [],
      );
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
      capture: (mode: string) => {
        const instance = expectDefined(
          pluginInstanceInvocation.getStore()?.instance,
          "registering instance",
        );
        const owner = expectDefined(getPluginInstanceOwner(instance), "registration owner");
        const registration = {
          owner,
          instance: expectDefined(owner.instance, "owned plugin instance"),
          disposals: 0,
          mode,
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
  const registration = bridge.capture(api.registrationMode);
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
          entries: {
            main: { agentDir: state.agentDir(), workspace: state.workspaceDir },
          },
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
              models: [
                {
                  id: "claude-opus-5",
                  name: "Scripted Claude",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 200_000,
                  maxTokens: 1024,
                },
              ],
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
          const results: Array<PromiseSettledResult<Awaited<ReturnType<typeof runEmbeddedAgent>>>> =
            [];
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
                results.push({
                  status: "fulfilled",
                  value: await runEmbeddedAgent({
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
                  }),
                });
              } catch (reason) {
                results.push({ status: "rejected", reason });
              } finally {
                admission.close();
              }
            }
            const registryEvidence = JSON.stringify({
              requestRegistries,
              registrations: registrations.map(({ owner, instance, disposals, mode, turn }) => ({
                id: owner.record.id,
                status: owner.record.status,
                acceptingCalls: instance.acceptingCalls,
                disposals,
                mode,
                turn,
              })),
            });
            expect(
              results.map((result) =>
                result.status === "rejected" ? String(result.reason) : result.value.meta.error,
              ),
              registryEvidence,
            ).toEqual([undefined, undefined]);
            expect(requests, registryEvidence).toHaveLength(2);
            expect(network).not.toHaveBeenCalled();
            expect(
              registrations.some(
                ({ owner }) =>
                  owner.record.id === siblingPluginId && owner.record.status === "error",
              ),
              registryEvidence,
            ).toBe(true);
            expect(
              registrations.some(
                ({ owner, turn }) =>
                  owner.record.id === siblingPluginId &&
                  turn === 0 &&
                  owner.record.status === "loaded",
              ),
              registryEvidence,
            ).toBe(true);
            const first = expectDefined(requests[0], "first request");
            const second = expectDefined(requests[1], "second request");
            expect(first.systemPrompt).toContain("Original workspace instruction.");
            expect(second.systemPrompt).toContain("Updated workspace instruction.");
          } finally {
            await resetPreparedModelRuntimeSnapshotsForTest();
            resetPluginLoaderTestStateForTest();
            cleanupPluginLoaderFixturesForTest();
            clearPluginMetadataLifecycleCaches();
            for (const { owner, instance, disposals, turn } of registrations) {
              expect(disposals, `${owner.record.id} turn ${turn} disposal`).toBe(1);
              expect(instance.acceptingCalls, `${owner.record.id} turn ${turn} retired`).toBe(
                false,
              );
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
