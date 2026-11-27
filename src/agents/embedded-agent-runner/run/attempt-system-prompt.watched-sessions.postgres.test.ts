import { join } from "node:path";
import { threadId } from "node:worker_threads";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../../config/io.runtime.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import {
  preparePhysicalSessionStorePath,
  publishSystemEventStoreConfig,
} from "../../../config/sessions/session-store-path.js";
import * as databaseAdmission from "../../../infra/database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  mixedAgentPairs,
  useMixedAgentPair,
} from "../../../infra/database-engine/mixed-agent.conformance.test-support.js";
import { prepareBundledDiscoveryMode } from "../../../plugins/bundled-discovery-state.js";
import { setGatewayPluginMetadataSnapshot } from "../../../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../../../plugins/current-plugin-metadata-state.js";
import { createEmptyPluginMetadataSnapshot } from "../../../plugins/plugin-metadata-empty.test-support.js";
import {
  handleSessionStateSessionReset,
  registerMainSessionGroupWatch,
} from "../../../sessions/session-state-events.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { createAttemptSetupFixture } from "./attempt-setup.test-support.js";
import { prepareEmbeddedAttemptSystemPrompt } from "./attempt-system-prompt-prepare.js";
import { createEmptyPromptBootstrap } from "./attempt-system-prompt.test-support.js";

const assertEngineStoreExecutionAllowed = databaseAdmission.assertEngineStoreExecutionAllowed;
// The Gateway guard must run on the main thread, not inside an admitted DB worker.
expect(threadId).toBe(0);
databaseAdmission.installDatabaseProcessRole("gateway");

describe.skipIf(!mixedAgentConnection)("attempt watched-session prompt refresh", () => {
  for (const { stateEngine, agentEngine } of mixedAgentPairs.filter(
    (pair) => pair.stateEngine === "postgres" || pair.agentEngine === "postgres",
  )) {
    describe(`${stateEngine} state / ${agentEngine} agent`, () => {
      const fixture = useMixedAgentPair(stateEngine, agentEngine);

      it("publishes accepted watch snapshots and rejects refresh after run closure", async () => {
        const deniedDatabaseCalls: string[] = [];
        const guard = vi
          .spyOn(databaseAdmission, "assertEngineStoreExecutionAllowed")
          .mockImplementation(() => {
            try {
              assertEngineStoreExecutionAllowed();
            } catch (error) {
              deniedDatabaseCalls.push(String(error));
              throw error;
            }
          });
        onTestFinished(() => guard.mockRestore());
        onTestFinished(() => clearCurrentPluginMetadataSnapshot());
        const config = await captureRuntimeConfigAsyncReader()();
        publishSystemEventStoreConfig(config);
        setRuntimeConfigSnapshot(config);
        const watcher = "agent:main:main";
        const watched = "agent:main:telegram:group:watched";
        const sessionId = "attempt-watcher";
        const storePath = await preparePhysicalSessionStorePath(
          { agentId: "main", sessionKey: watcher },
          config,
        );
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: watcher, storePath },
          { sessionId, updatedAt: 1 },
        );
        const rename = (displayName: string, updatedAt: number) =>
          upsertSessionEntryCore(
            { agentId: "main", sessionKey: watched, storePath },
            { sessionId: "watched-session", displayName, updatedAt },
          );
        await rename("Original room", 1);

        // Prompt preparation consumes the inventory published by Gateway startup.
        const workspaceDir = join(fixture.root, "workspace");
        const activateDiscovery = await prepareBundledDiscoveryMode();
        activateDiscovery();
        setGatewayPluginMetadataSnapshot(createEmptyPluginMetadataSnapshot(workspaceDir), {
          config,
          env: process.env,
          workspaceDir,
        });
        const admission = prepareSystemAgentRunAdmission(config, sessionId, "main", "prompt-test");
        onTestFinished(() => admission.close());
        const capabilities = new Set(["sessions_history", "sessions_list"]);
        const prepared = await prepareEmbeddedAttemptSystemPrompt({
          attempt: {
            provider: "openai",
            modelId: "fixture",
            model: makeProviderModelFixture({
              id: "fixture",
              provider: "openai",
              api: "openai-responses",
              baseUrl: "https://provider.example/v1",
            }),
            config,
            admittedRunContext: await admission.admit("embedded"),
            sessionId,
            sessionKey: watcher,
            runId: sessionId,
            promptMode: "full",
          },
          activeContextEngine: undefined,
          bootstrap: createEmptyPromptBootstrap(),
          setup: createAttemptSetupFixture({
            effectiveCwd: workspaceDir,
            effectiveWorkspace: workspaceDir,
            sandboxSessionKey: watcher,
            getProviderRuntimeHandle: () => ({
              provider: "openai",
              modelId: "fixture",
              prepared: true,
            }),
          }),
          capabilityToolNames: capabilities,
          effectiveTools: [createStubTool("read")],
          isRawModelRun: false,
          modelToolsEnabled: true,
          skillsPrompt: "",
          toolSearchDirectoryEnabled: false,
          toolSearchRuntimeConfig: config,
        });
        const emptySnapshot = [{ kind: "conversation-data", text: "## Watched Sessions\nnone" }];
        expect(prepared.runtimeContextFragments).toEqual(emptySnapshot);
        const systemPrompt = prepared.systemPromptText;
        const prepareRefresh = () => prepared.prepareToolPrompt!([createStubTool("read")]);
        const expectRoom = (title: string) =>
          expect(prepared.runtimeContextFragments).toEqual([
            { kind: "conversation-data", text: expect.stringContaining(`${watched} — ${title}`) },
          ]);
        expect(await registerMainSessionGroupWatch({ sessionKey: watched, agentId: "main" })).toBe(
          true,
        );
        const addWatch = await prepareRefresh();
        expect(prepared.runtimeContextFragments).toEqual(emptySnapshot);
        expect(addWatch(systemPrompt)).toBe(systemPrompt);
        expectRoom("Original room");
        expect(systemPrompt).not.toContain(watched);
        expect(systemPrompt).not.toContain("Original room");

        await rename("Renamed room", 2);
        const renamed = await prepareRefresh();
        expectRoom("Original room");
        expect(renamed(systemPrompt)).toBe(systemPrompt);
        expectRoom("Renamed room");

        capabilities.clear();
        const revoke = await prepareRefresh();
        expectRoom("Renamed room");
        revoke(systemPrompt);
        expect(prepared.runtimeContextFragments).toEqual([]);
        capabilities.add("sessions_history");
        capabilities.add("sessions_list");
        const restore = await prepareRefresh();
        expect(prepared.runtimeContextFragments).toEqual([]);
        restore(systemPrompt);
        expectRoom("Renamed room");

        await handleSessionStateSessionReset(watcher);
        const reset = await prepareRefresh();
        expectRoom("Renamed room");
        reset(systemPrompt);
        expect(prepared.runtimeContextFragments).toEqual(emptySnapshot);

        expect(await registerMainSessionGroupWatch({ sessionKey: watched, agentId: "main" })).toBe(
          true,
        );
        await rename("Unaccepted room", 3);
        const late = await prepareRefresh();
        admission.close();
        expect(() => late(systemPrompt)).toThrow(
          "This agent run is no longer active. Start a new turn to retry.",
        );
        expect(prepared.runtimeContextFragments).toEqual(emptySnapshot);
        expect(deniedDatabaseCalls).toEqual([]);
      });
    });
  }
});
