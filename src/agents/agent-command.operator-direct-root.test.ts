/**
 * Tests the session facts a command turn reads and records: a local operator's root chat type,
 * and a user's Stop, which an `agent` RPC turn states without passing reply admission.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { resolveMemoryAudienceFromEntry } from "../plugins/memory-audience.js";
import {
  agentCommand,
  agentCommandFromGatewayIngress,
  compactionTestRuntime,
  compactionTestState as state,
  GATEWAY_INGRESS_ARGS,
  findCompactionSessionEntry as findStoredSessionEntry,
  makeCompactionResult as makeResult,
  registerAgentCommandCompactionTestHooks,
  requireCompactionStorePath as requireStorePath,
} from "./agent-command.compaction.test-support.js";

// Register hooks for this file, not as a cached support-module side effect.
registerAgentCommandCompactionTestHooks();

// Runs one local command turn the way `openclaw agent exec` does: a fresh
// session id with no key, so the command creates its explicit root row.
async function runLocalRoot(operatorDirectRoot?: boolean) {
  const sessionId = randomUUID();
  let senderIsOwner: boolean | undefined;
  state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
    senderIsOwner = params.opts.senderIsOwner;
    return makeResult({ sessionId, text: "done", runner: "embedded", agentHarnessId: "openclaw" });
  });
  await agentCommand({ message: "hello", sessionId, oneShotCliRun: true, operatorDirectRoot });
  const sessionKey = `agent:main:explicit:${sessionId}`;
  const entry = findStoredSessionEntry(sessionKey);
  if (!entry) {
    throw new Error(`missing stored session ${sessionKey}`);
  }
  return { sessionKey, entry, senderIsOwner };
}

describe("agentCommand operator direct root", () => {
  it("records a created root as the operator's direct chat with owner-private memory", async () => {
    const { sessionKey, entry, senderIsOwner } = await runLocalRoot(true);

    expect(entry.chatType).toBe("direct");
    expect(senderIsOwner).toBe(true);
    const resolution = await resolveMemoryAudienceFromEntry(
      {
        agentId: "main",
        sessionKey,
        sessionId: entry.sessionId,
        senderIsOwner,
        storePath: requireStorePath(),
      },
      entry,
    );
    expect(resolution).toMatchObject({
      status: "granted",
      audience: { kind: "owner-private", agentId: "main" },
    });
    if (resolution.status === "granted") {
      resolution.release();
    }
  });

  it("leaves other local roots without a chat type", async () => {
    const { entry } = await runLocalRoot();

    expect(entry.chatType).toBeUndefined();
  });
});

describe("agentCommand user Stop", () => {
  it.each([
    { name: "says the Stop on an agent turn", says: true, opts: {} },
    { name: "keeps the Stop past a raw model run", says: false, opts: { modelRun: true } },
    // Model selection refuses this turn after its session write, before any model runs.
    { name: "keeps the Stop past a refused model", says: false, opts: { model: "gpt-5.4" } },
  ] as const)("$name", async ({ says, opts }) => {
    const sessionId = "stopped-session";
    const target = { sessionKey: "agent:main:rpc-stop", storePath: requireStorePath() };
    const stop = { userStoppedAt: 5, userStoppedSessionId: sessionId };
    await compactionTestRuntime.replaceSessionEntry(target, { sessionId, updatedAt: 1, ...stop });
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text: "ok" }));
    // An approved exec continuation names its output by prompt range: here, "ask".
    const execApprovalContinuationPromptRange = { start: 5, end: 8 };

    const run = agentCommandFromGatewayIngress(
      {
        ...target,
        sessionId,
        message: "next ask",
        allowModelOverride: false,
        execApprovalContinuationPromptRange,
        ...opts,
      },
      ...GATEWAY_INGRESS_ARGS,
    );
    await ("model" in opts ? expect(run).rejects.toThrow("not authorized") : run);

    const attempt = state.runAgentAttemptMock.mock.calls[0]?.[0];
    const range = attempt?.opts.execApprovalContinuationPromptRange;
    expect(
      attempt?.body.startsWith("Note: The user stopped the previous agent run.") === true,
    ).toBe(says);
    expect(range && attempt?.body.slice(range.start, range.end)).toBe(
      "model" in opts ? undefined : "ask",
    );
    expect(attempt?.transcriptBody).toBe("model" in opts ? undefined : "next ask");
    // A turn that says the Stop retires it; one that cannot leaves it for the next.
    expect(compactionTestRuntime.loadSessionEntry(target)?.userStoppedAt).toBe(
      says ? undefined : 5,
    );
  });
});
