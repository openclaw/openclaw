import path from "node:path";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it } from "vitest";
import { isCodexAppServerLiveThreadProtected } from "./client-runtime.js";
import { ownCodexInferenceClient } from "./inference-routing.js";
import { itemNotification } from "./protocol.test-helpers.js";
import {
  answerCompleted,
  readManagedInstructions,
  retainSourceAuthority,
  runningCommand,
} from "./run-attempt-continuity.test-support.js";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

it("delivers fresh prompt-hook parent context on the same protected thread", async () => {
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
  const command = runningCommand("background-listener", "synthetic-callback-listener", "12345");
  const harness = createStartedThreadHarness(
    async (method, request) => {
      if (method === "account/read") {
        return { account: { type: "apiKey" } };
      }
      if (method === "thread/backgroundTerminals/list") {
        return { data: [{ itemId: command.id, processId: command.processId }], nextCursor: null };
      }
      if (method === "turn/start") {
        received.push(readManagedInstructions(harness.client, request));
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
        prompt: "<available_skills><skill><name>synthetic-skill</name></skill></available_skills>",
        skills: [],
      };
      params.hostCapabilities = {
        ...params.hostCapabilities,
        retainSourceAuthority: retainSourceAuthority(source.signal),
      };
      const run = runCodexAppServerAttempt(params);
      await run.waitForTurnAccepted();
      if (index === 0) {
        await harness.notify(itemNotification("item/started", command));
      }
      await harness.notify(answerCompleted("Ready."));
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
