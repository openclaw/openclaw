import path from "node:path";
import { expect, it, vi } from "vitest";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { captureSessionTarget } from "../sessions/session-controller.target.js";
import * as btw from "./btw.test-support.js";
import type { EmbeddedAgentQueueHandle } from "./embedded-agent-runner/run-state.js";

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
