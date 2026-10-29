import path from "node:path";
import { expect, it } from "vitest";
import { resolveCodexAppServerHomeDir } from "./auth-start-options.js";
import * as clientRuntime from "./client-runtime.js";
import { protectCodexAppServerLiveThread } from "./client-runtime.js";
import {
  createCodexTestHostCapabilities,
  setCodexTestToolFactory,
} from "./host-capability.test-support.js";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import { getCodexInferenceThread, ownCodexInferenceClient } from "./inference-routing.js";
import { isJsonObject } from "./protocol.js";
import {
  createParams,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import { readCodexAppServerBinding } from "./session-binding.test-helpers.js";
import { writeNativeCatalogFixture } from "./thread-lifecycle.test-fixtures.js";

setupRunAttemptTestHooks();

function retainSourceAuthority(signal: AbortSignal) {
  const assertCurrent = () => signal.throwIfAborted();
  return () => ({
    signal,
    modelPolicyRequired: false,
    bindModelExecution: () => ({ signal, assertCurrent, release: () => {} }),
    assertCurrent,
    release: () => {},
  });
}

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
  const bindings = [];
  const tool = createRuntimeDynamicTool("continuation_probe");
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
      setCodexTestToolFactory(params, () => [{ ...tool }]);
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
      if (index === 1) {
        const beforeConcurrent = harness.requests.length;
        await expect(
          runCodexAppServerAttempt({ ...params, runId: "concurrent-claim" }),
        ).rejects.toThrow("Codex session became active in another runner");
        expect(
          harness.requests
            .slice(beforeConcurrent)
            .some(({ method }) =>
              ["thread/start", "thread/resume", "turn/start", "turn/interrupt"].includes(method),
            ),
        ).toBe(false);
        expect(clientRuntime.isCodexAppServerLiveThreadClaimed(harness.client, "thread-1")).toBe(
          true,
        );
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
      if (index === 2) {
        await expect(
          harness.handleServerRequest({
            id: "private-no-effects",
            method: "item/tool/call",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              callId: "private-no-effects",
              namespace: null,
              tool: tool.name,
              arguments: {},
            },
          }),
        ).resolves.toMatchObject({ success: false });
        expect(tool.execute).not.toHaveBeenCalled();
      }
      const compacted = route.context.prepare(
        { instructions: "Native compaction policy.", input: [] },
        { requestKind: "compaction", threadId: "thread-1", generation },
      );
      expect(compacted.body.instructions).toBe("Native compaction policy.");
      const afterCompaction = route.context.prepare(
        { input: [] },
        { requestKind: "turn", threadId: "thread-1", generation },
      );
      expect(afterCompaction.body.instructions).toContain(text);
      expect(() =>
        route.context.prepare(
          { input: [] },
          { requestKind: "turn", threadId: "thread-1", generation: "retired-generation" },
        ),
      ).toThrow("no current admitted parent generation");
      expect(prepared.body.instructions).toContain(text);
      expect(prepared.body.instructions).not.toContain(
        index === 2 ? "Owner conversation context." : "Private completion context.",
      );
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
      expect(() => afterCompaction.assertCurrent()).toThrow();
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

it("fails closed without a relay, then applies changed context through an idle native handoff", async () => {
  const sessionFile = path.join(tempDir, "no-relay-parent.jsonl");
  let starts = 0;
  const agentDir = path.join(tempDir, "wire-agent");
  const codexHome = resolveCodexAppServerHomeDir(agentDir);
  const harness = createStartedThreadHarness(
    async (method, request) => {
      if (!isJsonObject(request) || !["thread/start", "thread/resume"].includes(method)) {
        return undefined;
      }
      const threadId =
        method === "thread/start"
          ? "thread-" + ++starts
          : typeof request.threadId === "string"
            ? request.threadId
            : "missing-thread";
      const rolloutPath = path.join(codexHome, "sessions", threadId + ".jsonl");
      if (method === "thread/start") {
        await writeNativeCatalogFixture(rolloutPath, threadId, request.dynamicTools);
      }
      const result = threadStartResult(threadId);
      return { ...result, thread: { ...result.thread, path: rolloutPath } };
    },
    { persistedThreads: [], codexHome },
  );
  const params = createParams(sessionFile, tempDir);
  params.agentDir = agentDir;
  params.extraSystemPrompt = "First conversation context.\n\nPersistent policy.";
  params.extraSystemPromptTurnContext = { start: 0, text: "First conversation context." };
  params.timeoutMs = 60_000;
  const first = runCodexAppServerAttempt(params);
  await first.waitForTurnAccepted().catch((error: unknown) => {
    throw new Error("No-relay initial turn failed before acceptance", { cause: error });
  });
  const release = protectCodexAppServerLiveThread(harness.client, "thread-1");
  try {
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await first;
    const initialBinding = await readCodexAppServerBinding(sessionFile);
    const request = harness.requests.find(({ method }) => method === "thread/start")?.params;
    expect(request).toMatchObject({
      developerInstructions: expect.stringContaining("First conversation context."),
    });
    const beforeUnchanged = harness.requests.length;
    await expect(
      runCodexAppServerAttempt({ ...params, runId: "unchanged-no-relay" }),
    ).rejects.toThrow("requires a current parent-local inference relay");
    expect(
      harness.requests
        .slice(beforeUnchanged)
        .some(({ method }) =>
          [
            "thread/start",
            "thread/resume",
            "turn/start",
            "turn/interrupt",
            "thread/unsubscribe",
          ].includes(method),
        ),
    ).toBe(false);
    expect(await readCodexAppServerBinding(sessionFile)).toEqual(initialBinding);
    expect(clientRuntime.isCodexAppServerLiveThreadProtected(harness.client, "thread-1")).toBe(
      true,
    );
    const changed = {
      ...params,
      runId: "changed-context",
      extraSystemPrompt: "Second conversation context.\n\nPersistent policy.",
      extraSystemPromptTurnContext: { start: 0, text: "Second conversation context." },
    };
    const before = harness.requests.length;
    await expect(runCodexAppServerAttempt(changed)).rejects.toThrow(/claimed by active work/);
    expect(
      harness.requests
        .slice(before)
        .some(({ method }) =>
          ["thread/start", "thread/resume", "turn/start", "thread/unsubscribe"].includes(method),
        ),
    ).toBe(false);
    expect(await readCodexAppServerBinding(sessionFile)).toEqual(initialBinding);
    release();
    const successor = runCodexAppServerAttempt({ ...changed, runId: "idle-successor" });
    await successor.waitForTurnAccepted().catch((error: unknown) => {
      throw new Error("Idle successor failed before acceptance", { cause: error });
    });
    expect(starts).toBe(1);
    const resumed = harness.requests.filter(({ method }) => method === "thread/resume");
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.params).toMatchObject({
      threadId: "thread-1",
      developerInstructions: expect.stringContaining("Second conversation context."),
    });
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await successor;
    expect(await readCodexAppServerBinding(sessionFile)).toMatchObject({ threadId: "thread-1" });
  } finally {
    release();
    harness.close();
  }
});
