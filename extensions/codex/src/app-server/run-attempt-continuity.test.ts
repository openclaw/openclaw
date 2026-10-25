import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveCodexAppServerHomeDir } from "./auth-start-options.js";
import * as clientRuntime from "./client-runtime.js";
import { protectCodexAppServerLiveThread } from "./client-runtime.js";
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
  const ownershipTransfers = vi.spyOn(clientRuntime, "consumeCodexAppServerLiveThread");
  let release = () => {};
  const sessionFile = path.join(tempDir, "continuity-parent.jsonl");
  const bindings = [];
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
      bindings.push(await readCodexAppServerBinding(sessionFile));
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
    const ownerships = await Promise.all(ownershipTransfers.mock.results.map(({ value }) => value));
    expect(ownerships).toHaveLength(3);
    expect(ownerships[0]?.configFingerprint).toEqual(expect.stringMatching(/\S+/));
    for (const ownership of ownerships) {
      expect(ownership?.configFingerprint).toBe(ownerships[0]?.configFingerprint);
    }
    expect(bindings[0]?.dynamicToolsFingerprint).toEqual(expect.stringMatching(/\S+/));
    for (const binding of bindings) {
      expect(binding?.threadId).toBe("thread-1");
      expect(binding?.dynamicToolsFingerprint).toBe(bindings[0]?.dynamicToolsFingerprint);
    }
    expect(
      harness.requests
        .filter(({ method }) => ["thread/start", "thread/resume"].includes(method))
        .map(({ method }) => method),
    ).toEqual(["thread/start"]);
    const changed = createParams(sessionFile, tempDir, { runId: "changed-policy" });
    changed.agentDir = agentDir;
    changed.extraSystemPrompt = "Changed persistent operator policy.";
    await expect(runCodexAppServerAttempt(changed)).rejects.toThrow(/claimed by active work/);
  } finally {
    release();
    harness.close();
  }
});
