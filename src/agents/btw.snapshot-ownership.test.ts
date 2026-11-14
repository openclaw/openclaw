import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { consumeReplyUsageState } from "../auto-reply/reply/reply-usage-state.js";
import { onInternalDiagnosticEvent } from "../infra/diagnostic-events.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { captureSessionTarget } from "../sessions/session-controller.target.js";
import * as btw from "./btw.test-support.js";
import type { EmbeddedAgentQueueHandle } from "./embedded-agent-runner/run-state.js";
import * as modelsConfigState from "./models-config-state.js";

btw.setupBtwTestHooks();

it("BTW live context ownership keeps same-ID conversations separate through native cleanup", async () => {
  const runs = await vi.importActual<typeof import("./embedded-agent-runner/runs.js")>(
    "./embedded-agent-runner/runs.js",
  );
  btw.getActiveEmbeddedRunSnapshotMock.mockImplementation(runs.getActiveEmbeddedRunSnapshot);
  btw.mockDoneAnswer("Side answer.");
  const sessionId = "shared-conversation-id";
  const sessionKey = "agent:main:shared-conversation";
  const cleanups: Array<() => void> = [];
  const attach = (name: string, storePath: string) => {
    const sessionFile = path.join(path.dirname(storePath), `${sessionId}.jsonl`);
    const operation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
      target: captureSessionTarget({
        storeScope: storePath,
        sessionKey,
        incarnation: sessionId,
        agentId: "main",
      }),
    });
    const handle: EmbeddedAgentQueueHandle = {
      kind: "embedded",
      runId: `snapshot-${name}`,
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
    };
    const identity = [sessionId, handle, sessionKey, sessionFile] as const;
    const attachment = runs.attachActiveEmbeddedRun(...identity, "main", operation);
    const detach = () => {
      runs.detachActiveEmbeddedRun(...identity, undefined, attachment);
      operation.complete();
    };
    cleanups.push(detach);
    runs.updateActiveEmbeddedRunSnapshot(attachment, {
      transcriptLeafId: `leaf-${name}`,
      messages: [{ role: "user", content: `${name} private history`, timestamp: 1 }],
      inFlightPrompt: `${name} current task`,
    });
    return { attachment, sessionFile, storePath, detach };
  };
  const ask = async (owner: ReturnType<typeof attach>, index: number, expected: string) => {
    await btw.runSideQuestion({
      sessionKey,
      storePath: owner.storePath,
      sessionEntry: btw.createSessionEntry({ sessionId, sessionFile: owner.sessionFile }),
    });
    const context = JSON.stringify(btw.streamContext(index).messages);
    expect(context).toContain(`${expected} private history`);
    expect(context).toContain(`${expected} current task`);
    expect(context).not.toContain(`${expected === "alpha" ? "beta" : "alpha"} private history`);
    expect(context).not.toContain(`${expected === "alpha" ? "beta" : "alpha"} current task`);
  };
  try {
    const alpha = attach("alpha", btw.state.path("alpha/sessions.json"));
    const beta = attach("beta", btw.state.path("beta/sessions.json"));
    await ask(alpha, 0, "alpha");
    await ask(beta, 1, "beta");
    alpha.detach();
    // A retained producer cannot publish over the surviving physical conversation.
    runs.updateActiveEmbeddedRunSnapshot(alpha.attachment, {
      transcriptLeafId: "stale-alpha-leaf",
      messages: [{ role: "user", content: "alpha private history", timestamp: 2 }],
      inFlightPrompt: "alpha current task",
    });
    await ask(beta, 2, "beta");
  } finally {
    for (const cleanup of cleanups) {
      cleanup();
    }
  }
});

it("exposes block-streamed side-question usage without mutating the parent session", async () => {
  using pricing = vi
    .spyOn(modelsConfigState, "captureModelsJsonCostSource")
    .mockRejectedValue(new Error("Recorded billing must not prepare fallback pricing"));
  const tokens = { input: 13, output: 9, cacheRead: 7, cacheWrite: 3 };
  const usage = { ...tokens, total: 41 };
  const cost = { input: 0.1, output: 0.1, cacheRead: 0.03, cacheWrite: 0.02, total: 0.25 };
  const text = "Side answer.";
  const onBlockReply = vi.fn().mockResolvedValue(undefined);
  const done = btw.createDoneEvent(text);
  done.message.usage = { ...tokens, totalTokens: 41, cost };
  btw.streamSimpleMock.mockReturnValue(
    btw.makeAsyncEvents([
      { type: "text_delta", delta: text },
      { type: "text_end", content: text, contentIndex: 0 },
      done,
    ]),
  );
  const runId = "btw-usage-reply-direct-block";
  const authorityRunId = "btw-usage-authority-direct-block";
  const sessionEntry = btw.createSessionEntry({ inputTokens: 200, cacheRead: 100 });
  const originalEntry = structuredClone(sessionEntry);
  const diagnostics: unknown[] = [];
  const unsubscribe = onInternalDiagnosticEvent((event) => {
    if (event.type === "model.usage") {
      diagnostics.push(event);
    }
  });
  try {
    await expect(
      btw.runSideQuestion({
        cfg: { diagnostics: { enabled: undefined } },
        sessionEntry,
        authorityRunId,
        blockReplyChunking: { minChars: 1, maxChars: 200, breakPreference: "paragraph" },
        resolvedBlockStreamingBreak: "text_end",
        opts: { runId, onBlockReply },
      }),
    ).resolves.toEqual(undefined);
    expect(onBlockReply).toHaveBeenCalledExactlyOnceWith({
      text,
      btw: { question: btw.DEFAULT_QUESTION },
    });
    expect
      .soft(consumeReplyUsageState(runId))
      .toMatchObject({ usage, sessionId: "session-1", turnUsd: 0.25 });
    expect(consumeReplyUsageState(authorityRunId)).toBeUndefined();
    expect(sessionEntry).toEqual(originalEntry);
    expect(pricing).not.toHaveBeenCalled();
    await nextTurn();
    expect.soft(diagnostics).toEqual([
      expect.objectContaining({
        type: "model.usage",
        sessionId: "session-1",
        usage: { ...usage, promptTokens: 23 },
        costUsd: 0.25,
      }),
    ]);
  } finally {
    unsubscribe();
  }
});
