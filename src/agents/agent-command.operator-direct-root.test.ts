/**
 * Tests the session facts a command turn reads and records: a local operator's root chat type,
 * and a user's Stop, which an `agent` RPC turn leaves recorded for a turn that states it.
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
    { name: "a plain agent turn", opts: {} },
    {
      name: "an exec-approval follow-up",
      opts: {
        inputProvenance: { kind: "inter_session", sourceTool: "exec_approval_followup" },
      },
    },
  ] as const)("leaves a recorded Stop past $name for an admitted reply", async ({ opts }) => {
    const sessionId = "stopped-session";
    const target = { sessionKey: "agent:main:rpc-stop", storePath: requireStorePath() };
    const stop = { userStoppedAt: 5, userStoppedSessionId: sessionId };
    await compactionTestRuntime.replaceSessionEntry(target, { sessionId, updatedAt: 1, ...stop });
    state.runAgentAttemptMock.mockResolvedValueOnce(makeResult({ sessionId, text: "ok" }));

    await agentCommandFromGatewayIngress(
      { ...target, sessionId, message: "next ask", allowModelOverride: false, ...opts },
      ...GATEWAY_INGRESS_ARGS,
    );

    // The turn runs as sent; reply admission or a queued turn states the Stop later.
    const attempt = state.runAgentAttemptMock.mock.calls[0]?.[0];
    expect(attempt?.body).toBe("next ask");
    expect(compactionTestRuntime.loadSessionEntry(target)).toMatchObject(stop);
  });
});
