import path from "node:path";
import type { HarnessContextEngine as ContextEngine } from "openclaw/plugin-sdk/agent-harness-runtime";
import { openFileBackedSessionManagerForTest } from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { describe, expect, it, vi } from "vitest";
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

function requireRequestParams(
  harness: ReturnType<typeof createStartedThreadHarness>,
  method: string,
): Record<string, unknown> {
  const request = harness.requests.find((entry) => entry.method === method);
  return requireRecord(request?.params, `${method} params`);
}

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt restricted context continuity", () => {
  it.each([false, true])(
    "migrates and continues a browser-denied binding across LCM epochs (search enabled: %s)",
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
      const contextEngine = createContextEngine({
        assemble: vi.fn(async ({ prompt }) => ({
          messages: [assistantMessage("retained LCM history", 10), userMessage(prompt ?? "", 11)],
          estimatedTokens: 42,
          systemPromptAddition: "context-engine system",
          contextProjection: { mode: "thread_bootstrap" as const, epoch: currentEpoch },
        })),
      });
      const attemptParams = createParams(sessionFile, workspaceDir);
      attemptParams.contextEngine = contextEngine;
      attemptParams.config = {
        tools: { deny: ["browser"], web: { search: { enabled: searchEnabled } } },
      };
      attemptParams.pluginHarnessToolPolicyRestricted = true;
      attemptParams.pluginHarnessToolPolicyScope = "conversation";

      for (const step of [
        {
          previousThread: "thread-legacy",
          threadId: "thread-restricted",
          epoch: "epoch-1",
          startsFresh: true,
        },
        {
          previousThread: "thread-restricted",
          threadId: "thread-restricted",
          epoch: "epoch-1",
          startsFresh: false,
        },
        {
          previousThread: "thread-restricted",
          threadId: "thread-compacted",
          epoch: "epoch-2",
          startsFresh: true,
        },
        {
          previousThread: "thread-compacted",
          threadId: "thread-compacted",
          epoch: "epoch-2",
          startsFresh: false,
        },
      ]) {
        currentEpoch = step.epoch;
        const harness = createStartedThreadHarness(
          async (method) => {
            if (method === "mcpServerStatus/list") {
              return { data: [], nextCursor: null };
            }
            if (method === "thread/start" || method === "thread/resume") {
              return threadStartResult(step.threadId, { cwd: workspaceDir });
            }
            return undefined;
          },
          { persistedThreads: [step.previousThread] },
        );
        const attemptRun = runUnmodifiedCodexAppServerAttempt(attemptParams);
        await attemptRun.waitForTurnAccepted();

        const nativeLifecycleRequests = harness.requests
          .filter(({ method }) => method === "thread/start" || method === "thread/resume")
          .map(({ method }) => method);
        expect(nativeLifecycleRequests).toEqual([
          step.startsFresh ? "thread/start" : "thread/resume",
        ]);
        const inputText = getRequestInputText(harness);
        if (step.startsFresh) {
          expect(inputText).toContain("OpenClaw assembled context for this turn:");
          expect(inputText).toContain("retained LCM history");
          const startParams = requireRequestParams(harness, "thread/start");
          expect(requireRecord(startParams.config, "thread/start config")).toMatchObject({
            "features.code_mode": false,
            "features.code_mode_only": false,
          });
        } else {
          expect(inputText).toBe(attemptParams.prompt);
          expect(requireRequestParams(harness, "thread/resume").threadId).toBe(step.threadId);
        }
        await harness.completeTurn("completed", step.threadId);
        await attemptRun;

        const savedBinding = await readCodexAppServerBinding(sessionFile);
        expect(savedBinding).toMatchObject({
          threadId: step.threadId,
          nativeToolPolicyRestricted: true,
          restrictedThreadConfigFingerprint: expect.any(String),
          contextEngine: { projection: { mode: "thread_bootstrap", epoch: step.epoch } },
        });
        await harness.client.closeAndWait();
      }
    },
  );

  it("bootstraps the prepared LCM snapshot when creation-time policy rotates a restricted thread", async () => {
    const sessionFile = path.join(tempDir, "session-late-policy-rotation.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-late-policy-rotation");
    const assemble = vi.fn(async ({ prompt }: Parameters<ContextEngine["assemble"]>[0]) => ({
      messages: [assistantMessage("prepared LCM snapshot", 10), userMessage(prompt ?? "", 11)],
      estimatedTokens: 42,
      systemPromptAddition: "context-engine system",
      contextProjection: { mode: "thread_bootstrap" as const, epoch: "epoch-1" },
    }));
    const attemptParams = createParams(sessionFile, workspaceDir);
    attemptParams.contextEngine = createContextEngine({ assemble });
    attemptParams.config = { tools: { deny: ["browser"], web: { search: { enabled: false } } } };
    attemptParams.pluginHarnessToolPolicyRestricted = true;
    attemptParams.pluginHarnessToolPolicyScope = "conversation";
    const firstHarness = createStartedThreadHarness(async (method) =>
      method === "mcpServerStatus/list" ? { data: [], nextCursor: null } : undefined,
    );
    const firstRun = runUnmodifiedCodexAppServerAttempt(attemptParams);
    await firstRun.waitForTurnAccepted();
    await firstHarness.completeTurn();
    await firstRun;

    assemble.mockResolvedValueOnce({
      messages: [assistantMessage("prepared LCM snapshot", 10)],
      estimatedTokens: 42,
      systemPromptAddition: "context-engine system",
      contextProjection: { mode: "thread_bootstrap", epoch: "epoch-1" },
    });
    assemble.mockResolvedValue({
      messages: [assistantMessage("new background LCM snapshot", 20)],
      estimatedTokens: 42,
      systemPromptAddition: "changed background developer instructions",
      contextProjection: { mode: "thread_bootstrap", epoch: "epoch-2" },
    });
    attemptParams.extraSystemPrompt = "Updated conversation tool policy.";
    const successorHarness = createStartedThreadHarness(
      async (method) => {
        if (method === "mcpServerStatus/list") {
          return { data: [], nextCursor: null };
        }
        if (method === "thread/start") {
          return threadStartResult("thread-policy-successor");
        }
        return undefined;
      },
      { persistedThreads: ["thread-1"] },
    );
    const successorRun = runUnmodifiedCodexAppServerAttempt(attemptParams);
    await successorRun.waitForTurnAccepted();
    expect(assemble).toHaveBeenCalledTimes(2);
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
      contextEngine: { projection: { mode: "thread_bootstrap", epoch: "epoch-1" } },
    });
  });
});
