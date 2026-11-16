import { dirname, join } from "node:path";
import { threadId } from "node:worker_threads";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  acquireAgentRunPreparedModelRuntimeMock,
  attemptServerEndpointCompactionMock,
  buildConfiguredAgentSystemPromptMock,
  createOpenClawCodingToolsMock,
  loadCompactHooksHarness,
  resetCompactHooksHarnessMocks,
} from "./compact.hooks.harness.js";

// Load the harness before database owners: its module reset must not split their admission state.
const { compactEmbeddedAgentSessionDirect } = await loadCompactHooksHarness();
const { mixedAgentConnection, mixedAgentPairs, useMixedAgentPair } =
  await import("../../infra/database-engine/mixed-agent.conformance.test-support.js");
const databaseAdmission = await import("../../infra/database-engine/admission-scope.js");
const assertEngineStoreExecutionAllowed = databaseAdmission.assertEngineStoreExecutionAllowed;
const { prepareBundledDiscoveryMode } = await import("../../plugins/bundled-discovery-state.js");
const acquirePreparedRuntime = acquireAgentRunPreparedModelRuntimeMock.getMockImplementation()!;
const { captureRuntimeConfigAsyncReader } = await import("../../config/io.runtime.js");
const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
const { preparePhysicalSessionStorePath, publishSystemEventStoreConfig } =
  await import("../../config/sessions/session-store-path.js");
const { upsertSessionEntryCore } = await import("../../config/sessions/session-accessor.js");
const { handleSessionStateSessionReset, registerMainSessionGroupWatch } =
  await import("../../sessions/session-state-events.js");
const { buildConfiguredAgentSystemPrompt } = await vi.importActual<
  typeof import("../system-prompt-config.js")
>("../system-prompt-config.js");

// A worker thread would bypass the Gateway's PostgreSQL synchronous-access guard.
expect(threadId).toBe(0);
databaseAdmission.installDatabaseProcessRole("gateway");

describe.skipIf(!mixedAgentConnection)("compaction watched-session prompts", () => {
  for (const { stateEngine, agentEngine } of mixedAgentPairs.filter(
    (pair) => pair.stateEngine === "postgres" || pair.agentEngine === "postgres",
  )) {
    describe(`${stateEngine} state / ${agentEngine} agent`, () => {
      const fixture = useMixedAgentPair(stateEngine, agentEngine);

      it("renders persisted watches, respects tool restrictions, and observes reset", async () => {
        const config = await captureRuntimeConfigAsyncReader()();
        publishSystemEventStoreConfig(config);
        setRuntimeConfigSnapshot(config);
        const watcher = "agent:main:main";
        const watched = "agent:main:telegram:group:watched";
        const sessionId = "compaction-watcher";
        const storePath = await preparePhysicalSessionStorePath(
          { agentId: "main", sessionKey: watcher },
          config,
        );
        const sessionTarget = { agentId: "main", sessionId, sessionKey: watcher, storePath };
        await upsertSessionEntryCore(sessionTarget, { sessionId, updatedAt: 1 });
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: watched, storePath },
          { sessionId: "watched-session", displayName: "Watched room", updatedAt: 1 },
        );
        expect(await registerMainSessionGroupWatch({ sessionKey: watched, agentId: "main" })).toBe(
          true,
        );

        const workspaceDir = join(fixture.root, "workspace");
        resetCompactHooksHarnessMocks(workspaceDir, sessionId);
        // Compaction projects failures into a result; keep the denied caller visible.
        const deniedDatabaseCalls: string[] = [];
        const admissionGuard = vi
          .spyOn(databaseAdmission, "assertEngineStoreExecutionAllowed")
          .mockImplementation(() => {
            const stackTraceLimit = Error.stackTraceLimit;
            Error.stackTraceLimit = 40;
            try {
              assertEngineStoreExecutionAllowed();
            } catch (error) {
              deniedDatabaseCalls.push(
                error instanceof Error ? (error.stack ?? error.message) : String(error),
              );
              throw error;
            } finally {
              Error.stackTraceLimit = stackTraceLimit;
            }
          });
        onTestFinished(() => admissionGuard.mockRestore());
        // The synthetic lease skips metadata discovery. Restore its async preparation so
        // auth planning consumes the same machine-state fact as a real prepared runtime.
        acquireAgentRunPreparedModelRuntimeMock.mockImplementation(async (...args) => {
          const activateDiscovery = await prepareBundledDiscoveryMode(args[0].env);
          activateDiscovery();
          return await acquirePreparedRuntime(...args);
        });
        onTestFinished(() => {
          acquireAgentRunPreparedModelRuntimeMock.mockImplementation(acquirePreparedRuntime);
        });
        buildConfiguredAgentSystemPromptMock.mockImplementation(buildConfiguredAgentSystemPrompt);
        createOpenClawCodingToolsMock.mockReturnValue(
          ["sessions_history", "sessions_list", "read"].map((name) => ({
            name,
            label: name,
            description: name,
            parameters: { type: "object", properties: {} },
            execute: vi.fn(),
          })),
        );
        const prompts: string[] = [];
        attemptServerEndpointCompactionMock.mockImplementation(async (input) => {
          prompts.push(input.context.systemPrompt ?? "");
          input.onCompactionCommitted?.(1_000);
          return {
            item: { type: "compaction", encrypted_content: "opaque" },
            usage: { input_tokens: 1_000, output_tokens: 200 },
          };
        });
        const compact = async (toolsAllow?: string[]) => {
          const result = await compactEmbeddedAgentSessionDirect({
            agentId: "main",
            agentDir: dirname(storePath),
            sessionId,
            sessionKey: watcher,
            sessionTarget,
            workspaceDir,
            config,
            provider: "openai",
            model: "fake",
            trigger: "manual",
            toolsAllow,
          });
          expect(result, JSON.stringify({ result, deniedDatabaseCalls })).toMatchObject({
            compacted: true,
            compactionKind: "server-endpoint",
          });
        };

        await compact();
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain(
          [
            "## Watched Sessions",
            "Group/topic sessions this session ambiently watches. Readable now (read-only) via sessions_history; rows appear in sessions_list.",
            "- agent:main:telegram:group:watched — Watched room",
          ].join("\n"),
        );

        await compact(["read"]);
        await handleSessionStateSessionReset(watcher);
        await compact();
        expect(prompts).toHaveLength(3);
        for (const prompt of prompts.slice(1)) {
          expect(prompt).not.toContain("## Watched Sessions");
          expect(prompt).not.toContain(watched);
          expect(prompt).not.toContain("Watched room");
        }
      });
    });
  }
});
