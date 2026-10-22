import path from "node:path";
import { expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { protectCodexAppServerLiveThread } from "./client-runtime.js";
import { flattenCodexDynamicToolFunctions } from "./protocol.js";
import {
  createParams,
  createCodexRuntimePlanFixture,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import { readCodexThreadToolCatalog } from "./thread-tool-catalog.js";

setupRunAttemptTestHooks();

it("keeps accepted declarations under work protection and applies fresh tools once idle", async () => {
  let threadId = "";
  let starts = 0;
  const harness = createStartedThreadHarness(
    async (method) => {
      if (method === "thread/start") {
        threadId = `synthetic-thread-${++starts}`;
        return threadStartResult(threadId);
      }
      return undefined;
    },
    { persistedThreads: [] },
  );
  const params = createParams(path.join(tempDir, "protected-catalog.jsonl"), tempDir);
  // Real transport and SQLite setup share the attempt budget, as in the tool-event integration test.
  params.timeoutMs = 60_000;
  setCodexTestModelSupportsTools(params, true);
  params.runtimePlan = createCodexRuntimePlanFixture();
  let existingAvailable = true;
  let existingDeclarationChanged = false;
  let addedAvailable = false;
  const existingExecute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "existing synthetic tool ran" }],
    details: {},
  }));
  const addedExecute = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "added synthetic tool ran" }],
    details: {},
  }));
  params.hostCapabilities = {
    ...params.hostCapabilities,
    createToolSurfaceAsync: async (_options, bindingOptions) =>
      params.hostCapabilities.bindToolSurface(
        [
          ...(existingAvailable
            ? [
                {
                  ...createRuntimeDynamicTool("synthetic_existing"),
                  ...(existingDeclarationChanged
                    ? { description: "Changed current declaration." }
                    : {}),
                  execute: existingExecute,
                },
              ]
            : []),
          ...(addedAvailable
            ? [{ ...createRuntimeDynamicTool("synthetic_added"), execute: addedExecute }]
            : []),
        ],
        bindingOptions,
      ),
  };
  const options = { pluginConfig: { dynamicTools: { loading: "searchable" as const } } };
  const finish = async (run: ReturnType<typeof runCodexAppServerAttempt>) => {
    await harness.completeTurn({ threadId, turnId: "turn-1" });
    expect(readAttemptTerminal(await run)).toMatchObject({ aborted: false, timedOut: false });
  };
  let calls = 0;
  const call = (tool: string) =>
    harness.handleServerRequest({
      id: `synthetic-request-${++calls}`,
      method: "item/tool/call",
      params: {
        threadId,
        turnId: "turn-1",
        callId: `synthetic-call-${calls}`,
        namespace: null,
        tool,
        arguments: {},
      },
    });
  let release = () => {};
  try {
    const first = runCodexAppServerAttempt(params, options);
    await first.waitForTurnAccepted();
    const accepted = await readCodexAppServerBinding(params.sessionFile);
    const firstToolResult = await call("synthetic_existing");
    expect(firstToolResult, JSON.stringify(firstToolResult)).toMatchObject({ success: true });
    release = protectCodexAppServerLiveThread(harness.client, threadId);
    await finish(first);

    addedAvailable = true;
    existingDeclarationChanged = true;
    const held = runCodexAppServerAttempt({ ...params, runId: "synthetic-protected" }, options);
    await held.waitForTurnAccepted();
    expect(accepted?.managedToolCatalog).toMatchObject({ version: 3 });
    expect(
      flattenCodexDynamicToolFunctions(readCodexThreadToolCatalog(accepted)).map(
        (tool) => tool.name,
      ),
    ).toContain("synthetic_existing");
    expect(await call("synthetic_added")).toMatchObject({ success: false });
    expect(await call("synthetic_existing")).toMatchObject({ success: false });
    expect(existingExecute).toHaveBeenCalledOnce();
    expect(addedExecute).not.toHaveBeenCalled();
    await finish(held);
    const preserved = await readCodexAppServerBinding(params.sessionFile);
    expect(preserved?.threadId).toBe(accepted?.threadId);
    expect(preserved?.managedToolCatalog).toEqual(accepted?.managedToolCatalog);
    expect(starts).toBe(1);

    release();
    release = () => {};
    existingAvailable = true;
    existingDeclarationChanged = false;
    const idle = runCodexAppServerAttempt({ ...params, runId: "synthetic-idle" }, options);
    await idle.waitForTurnAccepted();
    expect(await call("synthetic_added")).toMatchObject({ success: true });
    expect(addedExecute).toHaveBeenCalledOnce();
    const refreshed = await readCodexAppServerBinding(params.sessionFile);
    expect(refreshed?.threadId).not.toBe(accepted?.threadId);
    expect(
      flattenCodexDynamicToolFunctions(readCodexThreadToolCatalog(refreshed)).map(
        (tool) => tool.name,
      ),
    ).toContain("synthetic_added");
    release = protectCodexAppServerLiveThread(harness.client, threadId);
    await finish(idle);
    expect(starts).toBe(2);

    addedAvailable = false;
    const narrowed = runCodexAppServerAttempt(
      { ...params, runId: "synthetic-executor-removed" },
      options,
    );
    await narrowed.waitForTurnAccepted();
    expect(await call("synthetic_added")).toMatchObject({ success: false });
    expect(await call("synthetic_existing")).toMatchObject({ success: true });
    expect(addedExecute).toHaveBeenCalledOnce();
    await finish(narrowed);
    const retained = await readCodexAppServerBinding(params.sessionFile);
    expect(retained?.threadId).toBe(refreshed?.threadId);
    expect(retained?.managedToolCatalog).toEqual(refreshed?.managedToolCatalog);
    expect(starts).toBe(2);
  } finally {
    release();
    harness.close();
  }
});

it.each(["malformed", "mismatched"] as const)(
  "refuses %s receipts before compatible warm reuse",
  async (kind) => {
    const harness = createStartedThreadHarness(
      async (method) =>
        method === "thread/start" ? threadStartResult("synthetic-receipt-thread") : undefined,
      { persistedThreads: [] },
    );
    const params = createParams(path.join(tempDir, "receipt-reuse.jsonl"), tempDir);
    params.timeoutMs = 60_000;
    setCodexTestModelSupportsTools(params, true);
    params.runtimePlan = createCodexRuntimePlanFixture();
    let release = () => {};
    try {
      const first = runCodexAppServerAttempt(params);
      await first.waitForTurnAccepted();
      await harness.completeTurn({ threadId: "synthetic-receipt-thread", turnId: "turn-1" });
      await first;
      const binding = await readCodexAppServerBinding(params.sessionFile);
      if (!binding) {
        throw new Error("Synthetic binding was not accepted");
      }
      const corrupt = {
        ...binding,
        managedToolCatalog:
          kind === "malformed"
            ? { version: 3, tools: "invalid" }
            : {
                version: 3,
                tools: [
                  {
                    type: "function",
                    name: "synthetic_different",
                    description: "Different receipt",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              },
      };
      await writeCodexAppServerBinding(params.sessionFile, corrupt);
      release = protectCodexAppServerLiveThread(harness.client, binding.threadId);
      const before = harness.requests.filter(({ method }) => method === "turn/start").length;
      const resumed = runCodexAppServerAttempt({ ...params, runId: "synthetic-corrupt-reuse" });
      // Finish an incorrectly admitted turn so the pre-fix regression fails without hanging.
      const settleUnexpectedAdmission = resumed.waitForTurnAccepted().then(
        () => harness.completeTurn({ threadId: binding.threadId, turnId: "turn-1" }),
        () => {},
      );
      await expect(resumed).rejects.toThrow(/saved Codex thread tool catalog.*thread is preserved/);
      await settleUnexpectedAdmission;
      expect(harness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(before);
      expect(await readCodexAppServerBinding(params.sessionFile)).toEqual(corrupt);
    } finally {
      release();
      harness.close();
    }
  },
);
