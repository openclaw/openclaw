import path from "node:path";
import { expect, it } from "vitest";
import { resolveCodexAppServerHomeDir } from "./auth-start-options.js";
import {
  isCodexAppServerLiveThreadProtected,
  protectCodexAppServerLiveThread,
} from "./client-runtime.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import { getCodexInferenceThread, ownCodexInferenceClient } from "./inference-routing.js";
import { isJsonObject } from "./protocol.js";
import { retainSourceAuthority } from "./run-attempt-continuity.test-support.js";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";
import { writeNativeCatalogFixture } from "./thread-lifecycle.test-fixtures.js";

setupRunAttemptTestHooks();

it("retains a protected parent through private completion and owner reentry", async () => {
  const agentDir = path.join(tempDir, "wire-agent");
  const codexHome = resolveCodexAppServerHomeDir(agentDir);
  const rolloutPath = path.join(codexHome, "sessions", "continuity-parent.jsonl");
  let creationPolicy = "";
  const harness = createStartedThreadHarness(
    async (method, request) => {
      if (method === "account/read") {
        return { account: { type: "apiKey" } };
      }
      if (method === "thread/start" && isJsonObject(request)) {
        expect(request).toHaveProperty(["config", "hooks.PreToolUse", 0]);
        creationPolicy =
          typeof request.developerInstructions === "string" ? request.developerInstructions : "";
        await writeNativeCatalogFixture(rolloutPath, "thread-1", request.dynamicTools);
        const result = threadStartResult("thread-1");
        return { ...result, thread: { ...result.thread, path: rolloutPath } };
      }
      return undefined;
    },
    { persistedThreads: [], codexHome },
  );
  ownCodexInferenceClient(harness.client);
  let release = () => {};
  const sessionFile = path.join(tempDir, "continuity-parent.jsonl");
  try {
    for (const [index, text] of [
      "Owner conversation context.",
      "Owner conversation context.",
      "Private completion context.",
      "Owner conversation context.",
    ].entries()) {
      const params = createParams(sessionFile, tempDir, { runId: `continuity-${index}` });
      params.agentDir = agentDir;
      params.timeoutMs = 60_000;
      params.extraSystemPrompt = `${text}\n\nPersistent synthetic operator policy.`;
      params.extraSystemPromptTurnContext = { start: 0, text };
      params.privateCompletion = index === 2 ? true : undefined;
      params.hostCapabilities = createCodexTestHostCapabilities({
        ...params.hostCapabilities,
        retainSourceAuthority:
          index === 2 ? () => undefined : retainSourceAuthority(new AbortController().signal),
      });
      const run = runCodexAppServerAttempt(params);
      await run.waitForTurnAccepted();
      if (index === 0) {
        expect(harness.client.getRuntimeIdentity()?.codexHome).toBe(codexHome);
        release = protectCodexAppServerLiveThread(harness.client, "thread-1");
      }
      await expect(readCodexAppServerBinding(sessionFile)).resolves.toMatchObject({
        threadId: "thread-1",
      });
      const request = harness.requests.findLast(({ method }) => method === "turn/start")?.params;
      const route = getCodexInferenceThread(harness.client, "thread-1");
      const metadata =
        isJsonObject(request) && isJsonObject(request.responsesapiClientMetadata)
          ? request.responsesapiClientMetadata
          : undefined;
      const generation = metadata?.[CODEX_INFERENCE_GENERATION_KEY];
      if (!route || typeof generation !== "string") {
        throw new Error("Missing admitted inference context");
      }
      const prepared = route.context.prepare(
        { instructions: `Native model policy.\n${creationPolicy}`, input: [] },
        { requestKind: "turn", threadId: "thread-1", generation },
      );
      prepared.assertCurrent();
      expect(prepared.body.instructions).toContain(text);
      expect(prepared.body.instructions).not.toContain(
        index === 2 ? "Owner conversation context." : "Private completion context.",
      );
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
    }
    const changed = createParams(sessionFile, tempDir, { runId: "changed-policy" });
    changed.agentDir = agentDir;
    changed.extraSystemPrompt = "Changed persistent operator policy.";
    await expect(runCodexAppServerAttempt(changed)).rejects.toMatchObject({
      name: "AgentHarnessPreflightError",
      message:
        "Codex thread thread-1 still has background work after waiting for cleanup; stop its running work and retry.",
    });
    expect(isCodexAppServerLiveThreadProtected(harness.client, "thread-1")).toBe(true);
    expect(harness.requests.filter(({ method }) => method === "thread/unsubscribe")).toEqual([]);
    expect(
      harness.requests
        .filter(({ method }) => ["thread/start", "thread/resume"].includes(method))
        .map(({ method }) => method),
    ).toEqual(["thread/start"]);
  } finally {
    release();
    harness.close();
  }
});
