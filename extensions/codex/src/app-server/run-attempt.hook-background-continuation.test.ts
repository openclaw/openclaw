import path from "node:path";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import { isCodexAppServerLiveThreadProtected } from "./client-runtime.js";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import { getCodexInferenceThread, ownCodexInferenceClient } from "./inference-routing.js";
import { isJsonObject } from "./protocol.js";
import { itemNotification, turnCompleted } from "./protocol.test-helpers.js";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("prompt hook context with native background commands", () => {
  it("delivers fresh parent context on the same protected thread", async () => {
    const contexts = ["Synthetic first-turn recall", "Synthetic second-turn recall"];
    let context = contexts[0];
    let systemPrompt: string | undefined;
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: async () => ({
            systemPrompt,
            prependSystemContext: context,
            appendSystemContext: `${context} clock`,
          }),
        },
      ]),
    );
    const source = new AbortController();
    const received: string[] = [];
    const command = {
      type: "commandExecution",
      id: "background-listener",
      command: "synthetic-callback-listener",
      cwd: "/workspace",
      processId: "12345",
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
    const harness = createStartedThreadHarness(
      async (method, request) => {
        if (method === "account/read") {
          return { account: { type: "apiKey" } };
        }
        if (method === "thread/backgroundTerminals/list") {
          return { data: [{ itemId: command.id, processId: command.processId }], nextCursor: null };
        }
        if (method === "turn/start") {
          const route = getCodexInferenceThread(harness.client, "thread-1");
          if (
            !route ||
            !isJsonObject(request) ||
            !isJsonObject(request.responsesapiClientMetadata)
          ) {
            throw new Error("Missing managed turn registration");
          }
          const generation = request.responsesapiClientMetadata[CODEX_INFERENCE_GENERATION_KEY];
          if (typeof generation !== "string") {
            throw new Error("Missing managed generation");
          }
          const nativeBody = { instructions: "Native model-owned policy", input: [] };
          const metadata = { requestKind: "turn", threadId: "thread-1", generation };
          const parent = route.context.prepare(nativeBody, metadata);
          parent.assertCurrent();
          const instructions = parent.body.instructions;
          if (typeof instructions !== "string") {
            throw new Error("Expected parent instructions");
          }
          received.push(instructions);
          // Repeated parent requests refresh context without accumulating copies.
          expect(route.context.prepare(nativeBody, metadata).body).toEqual(parent.body);
          expect(
            route.context.prepare(nativeBody, { ...metadata, requestKind: "compaction" }).body,
          ).toBe(nativeBody);
          expect(
            route.context.prepare(nativeBody, {
              ...metadata,
              threadId: "child",
              parentThreadId: "thread-1",
            }).body,
          ).toBe(nativeBody);
        }
        return undefined;
      },
      { persistedThreads: [] },
    );
    ownCodexInferenceClient(harness.client);
    const unsubscribe = { method: "thread/unsubscribe", params: { threadId: "thread-1" } };
    try {
      for (const [index, hookContext] of contexts.entries()) {
        context = hookContext;
        const params = createParams(path.join(tempDir, "session.jsonl"), tempDir, {
          runId: `run-${index}`,
          prompt: index === 0 ? "Start a callback listener" : "Explain the callback setup",
        });
        params.skillsSnapshot = {
          prompt:
            "<available_skills><skill><name>synthetic-skill</name></skill></available_skills>",
          skills: [],
        };
        params.hostCapabilities = {
          ...params.hostCapabilities,
          retainSourceAuthority: () => ({
            signal: source.signal,
            modelPolicyRequired: false,
            bindModelExecution: () => ({
              signal: source.signal,
              assertCurrent: () => source.signal.throwIfAborted(),
              release: () => {},
            }),
            assertCurrent: () => source.signal.throwIfAborted(),
            release: () => {},
          }),
        };
        const run = runCodexAppServerAttempt(params);
        await run.waitForTurnAccepted();
        if (index === 0) {
          await harness.notify(itemNotification("item/started", command));
        }
        await harness.notify(
          turnCompleted({
            id: "turn-1",
            status: "completed",
            items: [{ id: "answer", type: "agentMessage", phase: "final_answer", text: "Ready." }],
          }),
        );
        const result = await run;
        expect(result.messagesSnapshot).toContainEqual(
          expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "Ready." }],
          }),
        );
        expect(isCodexAppServerLiveThreadProtected(harness.client, "thread-1")).toBe(true);
        expect(harness.requests).not.toContainEqual(unsubscribe);
      }
      expect(received).toHaveLength(2);
      for (const [index, hookContext] of contexts.entries()) {
        expect(received[index]?.split(`${hookContext} clock`)).toHaveLength(2);
        expect(received[index]?.split(hookContext)).toHaveLength(3);
        expect(received[index]).toMatch(
          /Native model-owned policy[\s\S]*<available_skills>[\s\S]*OpenClaw plugin-injected system context\./,
        );
      }
      expect(received[1]).not.toContain("Synthetic first-turn recall");
      systemPrompt = "Changed persistent thread policy";
      await expect(
        runCodexAppServerAttempt(
          createParams(path.join(tempDir, "session.jsonl"), tempDir, { runId: "changed-policy" }),
        ),
      ).rejects.toThrow("Codex thread thread-1 is claimed by active work; stop it first.");
      expect(isCodexAppServerLiveThreadProtected(harness.client, "thread-1")).toBe(true);
      expect(harness.requests).not.toContainEqual(unsubscribe);
      expect(
        harness.requests
          .filter(({ method }) => ["thread/start", "thread/resume"].includes(method))
          .map(({ method }) => method),
      ).toEqual(["thread/start"]);
      expect(JSON.stringify(harness.requests)).not.toContain("Synthetic first-turn recall");
      expect(JSON.stringify(harness.requests)).not.toContain("Synthetic second-turn recall");
      expect(harness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(2);
    } finally {
      source.abort(new Error("fixture cleanup"));
      harness.close();
    }
  });
});
