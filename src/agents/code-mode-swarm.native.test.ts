import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { createContext } from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "./admitted-run-context.js";
import { codeModeReplayIdForToolCall } from "./code-mode-bridge.js";
import { createSubscribedCodeModeHarness } from "./code-mode.bridge.lifecycle.test-support.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import { resetCodeModeTestState, resultDetails } from "./code-mode.test-support.js";
import { SessionManager } from "./sessions/session-manager.js";
import { loadRequesterSessionEntry } from "./subagents/announce/subagent-announce-delivery.runtime.js";
import {
  loadSubagentRegistryFromSqlite,
  persistRegistryFixture,
} from "./subagents/registry/subagent-registry-state.fixture.test-support.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { createAgentsWaitTool } from "./tools/agents-wait-tool.js";
import { collectorRun } from "./tools/agents-wait-tool.test-support.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";

it.each([
  { mode: "intrinsic", omitted: false },
  { mode: "catalog", omitted: false },
  { mode: "intrinsic", omitted: true },
  { mode: "catalog", omitted: true },
] as const)(
  "consumes only retained $mode collector evidence through its subscribed nested owner (omitted=$omitted)",
  async ({ mode, omitted }) => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async (state) => {
        const name = mode + (omitted ? "-omitted-custody" : "-custody");
        const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
        const target = {
          agentId: "main",
          sessionKey: "agent:main:" + name,
          sessionId: "session-code-mode-" + name,
          storePath,
        };
        await upsertSessionEntryCore(target, {
          sessionId: target.sessionId,
          lifecycleRevision: "consumer-1",
          updatedAt: 1,
        });
        setRuntimeConfigSnapshot({ session: { store: storePath } });
        const manager = await SessionManager.openAsync(target, state.sessionsDir());
        await manager.appendMessageAsync({
          role: "user",
          content: "Recover the previously accepted collector",
          timestamp: 1,
        });
        const harness = createSubscribedCodeModeHarness({
          name,
          sessionManager: manager,
          executor: "node",
          timeoutMs: 10_000,
        });
        Object.assign(harness.config, {
          tools: {
            codeMode: { enabled: true, executor: "node", timeoutMs: 10_000 },
            swarm: { enabled: true },
          },
        });
        const allowedTool = mode === "intrinsic" ? "sessions_spawn" : "agents_wait";
        const ctx = { ...harness, agentId: "main", toolExecutionAllow: [allowedTool] };
        const spawn = createSessionsSpawnTool({
          config: harness.config,
          agentSessionKey: target.sessionKey,
          requesterRunId: harness.runId,
        });
        const collector = createAgentsWaitTool({
          agentId: "main",
          agentSessionKey: target.sessionKey,
        });
        applyCodeModeCatalog({
          ...ctx,
          tools: [...harness.tools, mode === "intrinsic" ? spawn : collector],
        });
        const code =
          mode === "intrinsic"
            ? 'try { return await agents.run("Recover saved collector"); } catch (error) { return { message: error.message, runId: error.runId, status: error.status }; }'
            : `const [wait] = await catalog.search("agents_wait"); const result = await wait({ids:[${JSON.stringify(name + "-failed")}], awaitResults:true}); return result.completed[0];`;
        const requester = await loadRequesterSessionEntry(target.sessionKey, "main");
        const failed = {
          ...collectorRun(name + "-failed", target.sessionKey),
          swarmRunId: name + "-failed",
          requesterStorePath: requester.physicalStorePath,
          completionRequesterSessionId: target.sessionId,
          completionRequesterLifecycleRevision: "consumer-1",
          swarmLaunchReplayKey:
            codeModeReplayIdForToolCall(ctx, "intrinsic", code) + ":bridge:agentSpawn:1",
          swarmLaunchRequestFingerprint:
            "sha256:" +
            createHash("sha256")
              .update(
                stableStringify({
                  task: "Recover saved collector",
                  collect: true,
                  groupId: "swarm:" + target.sessionKey + ":" + harness.runId,
                }),
              )
              .digest("hex"),
          delivery: { status: "not_required" as const },
          execution: {
            status: "terminal" as const,
            endedAt: 8,
            outcome: { status: "error" as const, error: "Intrinsic provider failure" },
          },
          collectorCompletion: { status: "failed" as const },
          completion: {
            required: false,
            resultText: "Intrinsic saved progress" + (omitted ? "P".repeat(40_000) : ""),
          },
        };
        persistRegistryFixture(new Map([[failed.runId, failed]]));
        const admission = prepareSystemAgentRunAdmission(
          {},
          harness.runId,
          "main",
          "intrinsic-test",
        );
        try {
          const admitted = await admission.admit("embedded");
          const caller = createAdmittedGatewayToolCallerIdentity({
            admittedRunContext: admitted,
            agentId: "main",
            sessionKey: target.sessionKey,
          });
          if (!caller) {
            throw new Error("Missing admitted caller");
          }
          const context = createContext();
          const pending: Promise<unknown>[] = [];
          context.trackExecution = (work) => {
            const task = Promise.resolve().then(work);
            pending.push(task);
            return task;
          };
          caller.gatewayContextResolver = () => context;
          caller.assertToolAllowed = (toolName) => {
            if (toolName !== allowedTool) {
              throw new Error("raw collector unavailable");
            }
          };
          await manager.appendMessageAsync(
            makeAgentAssistantMessage({
              content: [
                {
                  type: "toolCall",
                  id: "intrinsic",
                  name: "exec",
                  arguments: { code, awaitResults: true },
                },
              ],
            }),
          );
          const result = await withGatewayToolCallerIdentity(caller, () =>
            harness.tools[0]!.execute(
              "intrinsic",
              { code, awaitResults: true },
              harness.runAbortController.signal,
            ),
          );
          expect(resultDetails(result)).toMatchObject({
            status: "completed",
            value: {
              runId: failed.runId,
              status: "failed",
              ...(mode === "intrinsic"
                ? { message: expect.stringContaining("Intrinsic provider failure") }
                : {
                    error: "Intrinsic provider failure",
                    result: expect.stringContaining("Intrinsic saved progress"),
                  }),
            },
          });
          await manager.appendMessageAsync({
            ...result,
            role: "toolResult",
            toolCallId: "intrinsic",
            toolName: "exec",
            isError: false,
            timestamp: 2,
          });
          expect(JSON.stringify(await loadTranscriptEvents(target))).toContain(
            "Intrinsic provider failure",
          );
          await Promise.all(pending);
          if (!omitted) {
            expect(
              loadSubagentRegistryFromSqlite().get(failed.runId)?.delivery?.failureHandoff,
            ).toMatchObject({
              requesterSessionKey: target.sessionKey,
              requesterSessionId: target.sessionId,
              requesterLifecycleRevision: "consumer-1",
            });
          }
          const transcript = JSON.stringify(await loadTranscriptEvents(target));
          if (omitted) {
            expect(pending).toHaveLength(0);
            expect(
              loadSubagentRegistryFromSqlite().get(failed.runId)?.delivery?.failureHandoff,
            ).toBeUndefined();
            expect(await harness.readNestedActivities()).toMatchObject([
              {
                details: {
                  result: {
                    content: [
                      { type: "text", text: "[Nested tool output omitted: exceeds display limit]" },
                    ],
                  },
                },
              },
            ]);
          } else {
            expect(pending).toHaveLength(1);
            expect(transcript).toContain("Intrinsic saved progress");
            expect(await harness.readNestedActivities()).toMatchObject([
              {
                details: {
                  toolName: mode === "intrinsic" ? "agents.run" : "agents_wait",
                  result: {
                    details:
                      mode === "intrinsic"
                        ? {
                            runId: failed.runId,
                            error: "Intrinsic provider failure",
                            result: expect.stringContaining("Intrinsic saved progress"),
                          }
                        : {
                            completed: [
                              {
                                runId: failed.runId,
                                error: "Intrinsic provider failure",
                                result: expect.stringContaining("Intrinsic saved progress"),
                              },
                            ],
                            pending: [],
                          },
                  },
                },
              },
            ]);
          }
          expect(loadSubagentRegistryFromSqlite().get(failed.runId)?.delivery?.status).toBe(
            "not_required",
          );
        } finally {
          harness.dispose();
          admission.close();
          await resetCodeModeTestState();
        }
      },
    );
  },
);
