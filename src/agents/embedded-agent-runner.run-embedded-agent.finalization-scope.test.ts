import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../test/helpers/text-tool-result.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { createDeferredCore } from "../shared/deferred.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { installScriptedRunnerMocks } from "./embedded-agent-runner.mock-test-support.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "./embedded-agent-runner/run/types.js";
import {
  buildEmbeddedRunnerAssistant,
  createEmbeddedAgentRunnerOpenAiConfig,
  makeEmbeddedRunnerAttempt,
} from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { drainScenarioDatabase } from "./test-helpers/embedded-run-scenario.test-support.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "nested-finalization-");
const runAttempt = vi.fn<(params: EmbeddedRunAttemptParams) => Promise<EmbeddedRunAttemptResult>>();
let runtime: Awaited<ReturnType<typeof loadRuntime>>;
beforeAll(async () => {
  runtime = await loadRuntime();
});

async function loadRuntime() {
  // Keep the real harness boundary, including its temporary tool-authority scope.
  installScriptedRunnerMocks({
    runEmbeddedAttempt: (params) => runAttempt(params),
    hookRunner: "full",
    realHarness: true,
    modelsConfig: "mock",
  });
  return {
    run: (await import("./embedded-agent-runner/run.js")).runEmbeddedAgent,
    prepare: (await import("./admitted-run-context.js")).prepareSystemAgentRunAdmission,
    withAuthority: (await import("./harness/tool-authority.runtime.js"))
      .withPreparedEmbeddedRunToolAuthority,
    withTranscript: (await import("../config/sessions/transcript-write-context.js"))
      .withOwnedSessionTranscriptWrites,
    caller: (await import("./tools/gateway-caller-context.js")).getGatewayToolCallerIdentity,
    runs: await import("./embedded-agent-runner/runs.js"),
    handle: (await import("./embedded-agent-runner/runs.test-support.js")).createEmbeddedRunHandle,
    replace: (await import("../config/sessions/session-accessor.js")).replaceSessionEntry,
    transcript: await import("../plugin-sdk/session-transcript-runtime.js"),
  };
}

afterEach(() => {
  runAttempt.mockReset();
  clearRuntimeConfigSnapshot();
});

it.each(
  (["physical", "logical"] as const).flatMap((storeLocator) =>
    (["answer", "unavailable", "closed", "empty"] as const).map((finalization) => ({
      storeLocator,
      finalization,
    })),
  ),
)(
  "preserves $storeLocator child ownership when finalization is $finalization after the parent closes",
  async ({ storeLocator, finalization }) => {
    const {
      appendSessionTranscriptMessageByIdentity: appendMessage,
      readVisibleSessionTranscriptMessageEntries: readMessages,
    } = runtime.transcript;
    const root = sessionDirs.make();
    const agentDir = path.join(root, "agents", "test", "agent");
    const workspaceDir = path.join(root, "workspace");
    const databasePath = path.join(agentDir, "openclaw-agent.sqlite");
    await Promise.all([fs.mkdir(agentDir, { recursive: true }), fs.mkdir(workspaceDir)]);
    const config = createEmbeddedAgentRunnerOpenAiConfig(["mock-1"]);
    setRuntimeConfigSnapshot(config);
    const target = {
      agentId: "test",
      sessionId: "child-session",
      sessionKey: "agent:test:child",
      storePath:
        storeLocator === "logical"
          ? path.join(root, "agents", "test", "sessions", "sessions.json")
          : databasePath,
    };
    const parentTarget = {
      ...target,
      sessionId: "parent-session",
      sessionKey: "agent:test:parent",
    };
    const admit = (id: string, boundary: string) => runtime.prepare(config, id, "test", boundary);
    const childAdmission = admit("child-run", "nested-finalization-test");
    const parentAdmission = admit("parent-run", "nested-finalization-parent");
    const completedTool = buildEmbeddedRunnerAssistant({
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "write-once", name: "write", arguments: {} }],
    });
    const messages = [
      { role: "user" as const, content: "Write once and summarize.", timestamp: 1 },
      completedTool,
      makeTextToolResult("write-once", "write", "written", false, 3),
    ];
    let toolRuns = 0;
    let finalizerRuns = 0;
    // Each attempt, including the tool-free finalizer, must arrive under the child's own turn.
    const attemptTurns: Array<EmbeddedRunAttemptParams["replyOperation"]> = [];
    runAttempt.mockImplementation(async (params: EmbeddedRunAttemptParams) => {
      attemptTurns.push(params.replyOperation);
      const handle = runtime.handle({
        runId: params.runId,
        toolAuthorityFingerprint: params.toolAuthorityFingerprint,
      });
      const { sessionId, sessionFile } = params;
      const runIdentity = [sessionId, handle, params.sessionKey, sessionFile] as const;
      const attachment = runtime.runs.attachActiveEmbeddedRun(
        ...runIdentity,
        params.agentId,
        params.replyOperation,
      );
      if (!attachment) {
        throw new Error("Finalization proof requires an attached embedded run");
      }
      try {
        const sessionKey = params.sessionTarget?.sessionKey;
        if (!sessionKey) {
          throw new Error("The runner must prepare a transcript target before dispatch");
        }
        const appendTarget = {
          ...params.sessionTarget,
          sessionId: target.sessionId,
          sessionKey,
        };
        expect(runtime.caller()?.operationalRunInstance).toBe(
          params.admittedRunContext.operationalRunInstance,
        );
        if (params.operation === "settled-tool-finalization") {
          finalizerRuns += 1;
          expect(params.disableTools).toBe(true);
          if (finalization === "closed") {
            childAdmission.close();
          }
          if (finalization !== "answer" && finalization !== "empty") {
            throw new Error("Synthetic summary provider unavailable");
          }
          const answer = finalization === "answer";
          const assistant = buildEmbeddedRunnerAssistant({
            content: answer ? [{ type: "text", text: "The write completed." }] : [],
          });
          if (answer) {
            await appendMessage({ ...appendTarget, message: assistant });
          }
          return makeEmbeddedRunnerAttempt({
            sessionIdUsed: params.sessionId,
            lastAssistant: assistant,
            currentAttemptCompletedAssistant: assistant,
            assistantTexts: answer ? ["The write completed."] : [],
            ...(answer ? { assistantTranscriptOwned: true } : {}),
          });
        }
        toolRuns += 1;
        for (const message of messages) {
          await appendMessage({ ...appendTarget, message });
        }
        return makeEmbeddedRunnerAttempt({
          sessionIdUsed: params.sessionId,
          messagesSnapshot: messages,
          lastAssistant: completedTool,
          currentAttemptCompletedAssistant: undefined,
          toolMetas: [{ toolName: "write", toolCallId: "write-once", replaySafe: false }],
          itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
          codeModeEngaged: true,
          settledTurnFinalizationContext: { source: "openclaw-transcript", messages },
        });
      } finally {
        runtime.runs.detachActiveEmbeddedRun(...runIdentity, undefined, attachment);
      }
    });
    const { promise: released, resolve: release } = createDeferredCore();
    let child: ReturnType<typeof runtime.run> | undefined;
    try {
      await runtime.replace(target, { sessionId: target.sessionId, updatedAt: 1 });
      const parentContext = await parentAdmission.admit("embedded");
      await runtime.withAuthority(
        { admittedRunContext: parentContext },
        {
          ...parentTarget,
          sessionFile: parentTarget.sessionKey,
          config,
          workspaceDir,
          runId: "parent-run",
          provider: "openai",
          modelId: "mock-1",
        },
        undefined,
        async () =>
          runtime.withTranscript(
            {
              sessionTarget: parentTarget,
              assertCommitAllowed: () => {
                throw new Error("The parent writer is closed");
              },
              withTranscriptWrite: async (write) => await write(),
            },
            async () => {
              // Admission happens independently, but the queued promise retains
              // the originating parent ALS scopes just like an in-process send.
              child = released.then(() =>
                runtime.run({
                  preparedRunAdmission: childAdmission,
                  ...target,
                  sessionTarget: target,
                  workspaceDir,
                  agentDir,
                  config,
                  prompt: "Write once and summarize.",
                  provider: "openai",
                  model: "mock-1",
                  agentHarnessRuntimeOverride: "openclaw",
                  runId: "child-run",
                  timeoutMs: 10_000,
                  enqueue: async (task) => await task(),
                }),
              );
            },
          ),
      );
      parentAdmission.close();
      release();
      const result =
        finalization === "closed"
          ? await expect(child)
              .rejects.toThrow("admitted run authority is no longer active")
              .then(() => undefined)
          : await child;
      expect(toolRuns).toBe(1);
      expect(finalizerRuns).toBe(finalization === "empty" ? 2 : 1);
      expect(attemptTurns).toHaveLength(finalization === "empty" ? 3 : 2);
      expect(attemptTurns[0]).toBeDefined();
      expect(new Set(attemptTurns).size).toBe(1);
      const transcript = await readMessages(target);
      if (finalization === "answer") {
        expect(result?.payloads).toEqual([
          expect.objectContaining({ text: "The write completed." }),
        ]);
        expect(transcript).toHaveLength(messages.length + 1);
        expect(transcript.at(-1)?.message).toMatchObject({
          role: "assistant",
          content: [{ type: "text", text: "The write completed." }],
        });
      } else {
        if (finalization !== "closed") {
          expect(result?.payloads).toBeUndefined();
          expect(result?.meta.error).toMatchObject({ kind: "incomplete_turn" });
        }
        expect(transcript).toHaveLength(messages.length);
      }
    } finally {
      release();
      await child?.catch(() => undefined);
      parentAdmission.close();
      childAdmission.close();
      await drainScenarioDatabase(databasePath);
    }
  },
);
