import path from "node:path";
import type { HarnessContextEngine as ContextEngine } from "openclaw/plugin-sdk/agent-harness-runtime";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { expect, it, vi } from "vitest";
import { requestParams as requireRequestParams } from "./run-attempt-continuity.test-support.js";
import {
  assistantMessage,
  runCodexAppServerAttempt as runUnmodifiedCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  userMessage,
} from "./run-attempt-test-harness.js";
import {
  createContextEngine,
  createParams,
  createStartedThreadHarness,
  getRequestInputText,
  makeThreadBootstrapBinding,
  requireRecord,
  writeCodexAppServerBinding,
} from "./run-attempt.context-engine.test-support.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";

function restrictedHarness(threadId = "thread-1", previousThread?: string, cwd?: string) {
  return createStartedThreadHarness(
    async (method) => {
      if (method === "mcpServerStatus/list") {
        return { data: [], nextCursor: null };
      }
      if (method === "thread/start" || (cwd !== undefined && method === "thread/resume")) {
        return threadStartResult(threadId, cwd === undefined ? undefined : { cwd });
      }
      return undefined;
    },
    previousThread === undefined ? undefined : { persistedThreads: [previousThread] },
  );
}

setupRunAttemptTestHooks();

it.each([false, true])(
  "migrates a browser-denied binding across LCM epochs and late policy rotation (search enabled: %s)",
  async (searchEnabled) => {
    const sessionFile = path.join(tempDir, "session-restricted-continuity.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-restricted-continuity");
    const sessionManager = openFileBackedSessionManagerForTest(sessionFile, {
      sessionId: "session-1",
    });
    await sessionManager.appendMessageAsync(assistantMessage("retained LCM history", 10));
    await writeCodexAppServerBinding(
      sessionFile,
      makeThreadBootstrapBinding({
        threadId: "thread-legacy",
        cwd: workspaceDir,
        policyFingerprint:
          '{"schemaVersion":1,"engineId":"lossless-claw","ownsCompaction":true,"projectionMaxChars":24000}',
        epoch: "epoch-1",
      }),
    );
    let currentEpoch = "epoch-1";
    const attemptParams = createParams(sessionFile, workspaceDir);
    const assemble = vi.fn(async ({ prompt }: Parameters<ContextEngine["assemble"]>[0]) => ({
      messages: [assistantMessage("retained LCM history", 10), userMessage(prompt ?? "", 11)],
      estimatedTokens: 42,
      systemPromptAddition: "context-engine system",
      contextProjection: { mode: "thread_bootstrap" as const, epoch: currentEpoch },
    }));
    attemptParams.contextEngine = createContextEngine({ assemble });
    attemptParams.config = {
      tools: { deny: ["browser"], web: { search: { enabled: searchEnabled } } },
    };
    attemptParams.pluginHarnessToolPolicyRestricted = true;
    attemptParams.pluginHarnessToolPolicyScope = "conversation";

    for (const [previousThread, threadId, epoch, startsFresh] of [
      ["thread-legacy", "thread-restricted", "epoch-1", true],
      ["thread-restricted", "thread-restricted", "epoch-1", false],
      ["thread-restricted", "thread-compacted", "epoch-2", true],
      ["thread-compacted", "thread-compacted", "epoch-2", false],
    ] as const) {
      currentEpoch = epoch;
      const harness = restrictedHarness(threadId, previousThread, workspaceDir);
      const attemptRun = runUnmodifiedCodexAppServerAttempt(attemptParams);
      await attemptRun.waitForTurnAccepted();

      const nativeLifecycleRequests = harness.requests
        .filter(({ method }) => method === "thread/start" || method === "thread/resume")
        .map(({ method }) => method);
      expect(nativeLifecycleRequests).toEqual([startsFresh ? "thread/start" : "thread/resume"]);
      const inputText = getRequestInputText(harness);
      if (startsFresh) {
        expect(inputText).toContain("OpenClaw assembled context for this turn:");
        expect(inputText).toContain("retained LCM history");
        const startParams = requireRequestParams(harness, "thread/start");
        expect(requireRecord(startParams.config, "thread/start config")).toMatchObject({
          "features.code_mode": false,
          "features.code_mode_only": false,
        });
      } else {
        expect(inputText).toBe(attemptParams.prompt);
        expect(requireRequestParams(harness, "thread/resume").threadId).toBe(threadId);
      }
      await harness.completeTurn("completed", threadId);
      await attemptRun;

      expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
        threadId,
        nativeToolPolicyRestricted: true,
        restrictedThreadConfigFingerprint: expect.any(String),
        contextEngine: { projection: { mode: "thread_bootstrap", epoch } },
      });
      await harness.client.closeAndWait();
    }
    const prepared = {
      messages: [assistantMessage("prepared LCM snapshot", 10)],
      estimatedTokens: 42,
      systemPromptAddition: "context-engine system",
      contextProjection: { mode: "thread_bootstrap" as const, epoch: currentEpoch },
    };
    assemble.mockResolvedValueOnce(prepared);
    assemble.mockResolvedValue({
      messages: [assistantMessage("new background LCM snapshot", 20)],
      estimatedTokens: 42,
      systemPromptAddition: "changed background developer instructions",
      contextProjection: { mode: "thread_bootstrap", epoch: "epoch-3" },
    });
    attemptParams.extraSystemPrompt = "Updated conversation tool policy.";
    const successorHarness = restrictedHarness("thread-policy-successor", "thread-compacted");
    const successorRun = runUnmodifiedCodexAppServerAttempt(attemptParams);
    await successorRun.waitForTurnAccepted();
    expect(assemble).toHaveBeenCalledTimes(5);
    expect(successorHarness.requests.map(({ method }) => method)).toContain("thread/start");
    expect(getRequestInputText(successorHarness)).toContain("prepared LCM snapshot");
    expect(getRequestInputText(successorHarness)).not.toContain("new background LCM snapshot");
    const startParams = requireRequestParams(successorHarness, "thread/start");
    expect(startParams.developerInstructions).toContain("context-engine system");
    expect(startParams.developerInstructions).not.toContain(
      "changed background developer instructions",
    );
    await successorHarness.completeTurn("completed", "thread-policy-successor");
    await successorRun;
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({
      threadId: "thread-policy-successor",
      contextEngine: { projection: { mode: "thread_bootstrap", epoch: "epoch-2" } },
    });
  },
);
