import path from "node:path";
import * as agentHarnessRuntime from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { formatSqliteSessionFileMarker } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import {
  createCodexRuntimePlanFixture,
  createParams,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt agent-end context", () => {
  it.each(["completed", "aborted", "provider refusal"] as const)(
    "hands deep-turn context to agent-end without reviewing a refusal: %s",
    async (outcome) => {
      const source = {
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        storePath: path.join(tempDir, "agent-end-context.sqlite"),
      };
      const sessionFile = formatSqliteSessionFileMarker(source);
      await upsertSessionEntry({
        ...source,
        entry: { sessionFile, sessionId: source.sessionId, updatedAt: Date.now() },
      });
      const workspaceDir = path.join(tempDir, "agent-end-context-workspace");
      const turnStarted = createDeferred<void>();
      const responsesProjected = createDeferred<void>();
      let responseCount = 0;
      const harness = createStartedThreadHarness(async (method) => {
        if (method === "turn/start") {
          turnStarted.resolve();
        }
      });
      const runAgentEndSideEffects = vi
        .spyOn(agentHarnessRuntime, "runAgentEndSideEffects")
        .mockImplementation(() => {});
      const params = createParams(sessionFile, workspaceDir);
      params.runtimePlan = createCodexRuntimePlanFixture();
      const abortController = new AbortController();
      params.abortSignal = abortController.signal;
      params.onRunProgress = ({ reason }) => {
        if (reason === "notification:rawResponse/completed" && ++responseCount === 10) {
          responsesProjected.resolve();
        }
      };
      params.sessionTarget = source;
      params.messageChannel = "discord";
      params.memberRoleIds = ["maintainer-role"];
      setCodexTestModelSupportsTools(params, true);
      setCodexTestToolFactory(params, () => [createRuntimeDynamicTool("skill_workshop")]);

      // Protocol events drive these cases; host load must not spend the execution budget.
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const run = runCodexAppServerAttempt(params);
      try {
        await Promise.race([
          turnStarted.promise,
          run.then((result) => {
            throw new Error("Attempt settled before turn/start", { cause: result });
          }),
        ]);
        for (let index = 0; index < 10; index++) {
          await harness.notify({
            method: "rawResponse/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              responseId: `response-${index}`,
            },
          });
        }
        await Promise.race([
          responsesProjected.promise,
          run.then((result) => {
            throw new Error("Attempt settled before model responses were projected", {
              cause: result,
            });
          }),
        ]);
        if (outcome === "aborted") {
          abortController.abort("user cancelled");
        } else {
          const error =
            outcome === "provider refusal"
              ? {
                  message: "Provider declined this request.",
                  codexErrorInfo: "cyberPolicy" as const,
                }
              : undefined;
          if (error) {
            await harness.notify({
              method: "error",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                error,
                willRetry: false,
              },
            });
          }
          await harness.notify({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              turn: {
                id: "turn-1",
                status: error ? "failed" : "completed",
                items: error ? [] : [{ type: "agentMessage", id: "msg-1", text: "final answer" }],
                ...(error ? { error } : {}),
              },
            },
          });
        }
        const result = await run;
        if (outcome === "aborted") {
          expect(result.terminal).toMatchObject({ kind: "aborted" });
        } else {
          expect(result.terminal).toEqual({ kind: "ok" });
        }

        const ctx = runAgentEndSideEffects.mock.calls.at(-1)?.[0]?.ctx;
        expect(ctx?.foregroundPromptContext?.memberRoleIds).toEqual(["maintainer-role"]);
        expect(typeof ctx?.foregroundPromptContext?.agentDir).toBe("string");
        expect(ctx?.modelIterations).toBe(10);
        expect(ctx?.skillWorkshopAvailable).toBe(true);
        const reviewSource =
          runAgentEndSideEffects.mock.calls.at(-1)?.[0]?.skillExperienceReviewSource;
        if (outcome === "provider refusal") {
          expect(result.currentAttemptAssistant).toMatchObject({
            stopReason: "error",
            diagnostics: [
              { type: "provider_refusal", details: { provider: "openai", category: "cyber" } },
            ],
          });
          expect(reviewSource).toBeUndefined();
        } else {
          expect(reviewSource).toMatchObject(source);
        }
      } finally {
        vi.useRealTimers();
        abortController.abort("test_cleanup");
        await run.catch(() => undefined);
      }
    },
  );
});
