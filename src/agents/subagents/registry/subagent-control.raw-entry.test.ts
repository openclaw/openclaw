// The shared fixture installs registry mocks before these consumers are evaluated.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { enqueueFollowupRun } from "../../../auto-reply/reply/queue.js";
import { createQueueTestRun } from "../../../auto-reply/reply/queue.test-helpers.js";
import {
  clearFollowupQueue,
  getExistingFollowupQueue,
} from "../../../auto-reply/reply/queue/state.js";
import { setRuntimeConfigSnapshot } from "../../../config/config.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { clearCommandLane, enqueueCommandInLane } from "../../../process/command-queue.js";
import { beginSessionWorkAdmission } from "../../../sessions/session-lifecycle-admission.js";
import { resolveSessionAgentId } from "../../agent-scope.js";
import { resolveEmbeddedSessionLane } from "../../embedded-agent-runner/lanes.js";
import { clearActiveEmbeddedRun, setActiveEmbeddedRun } from "../../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../embedded-agent-runner/runs.test-support.js";
import type { AgentToolGatewayRequestCaller } from "../../tools/in-process-gateway.js";
import { createSessionsSendTool } from "../../tools/sessions-send-tool.js";
import { createSubagentsTool } from "../../tools/subagents-tool.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";
import { getSubagentRunByRunId } from "./subagent-registry.test-helpers.js";

const fixture = useSubagentControlFixture();

// sessions.create composition is proven separately. These rows retain its
// spawnedBy/spawnDepth contract; the actual send tool must create the run record.
it.each(["main", "research"] as const)(
  "cancelling a watched %s/global child preserves the other agent's work",
  async (owner) => {
    const foreignAgent = owner === "main" ? "research" : "main";
    const parentKey = `agent:${owner}:dashboard:parent`;
    const childId = `${owner}-global-session`;
    const foreignId = `${foreignAgent}-global-session`;
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }, { id: "research" }],
        defaults: { workspace: fixture.stateDir },
      },
      tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
    };
    setRuntimeConfigSnapshot(cfg);
    const childStorePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: owner,
      sessionKey: "global",
      defaultSessionId: childId,
    });
    await replaceSessionEntry(
      { agentId: owner, storePath: childStorePath, sessionKey: "global" },
      {
        sessionId: childId,
        updatedAt: Date.now(),
        spawnedBy: parentKey,
        parentSessionKey: parentKey,
        spawnDepth: 1,
        createdVia: "spawn",
        createdActor: { type: "agent", id: owner },
      },
    );
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: owner,
      sessionKey: parentKey,
      defaultSessionId: `${owner}-parent-session`,
    });
    const foreignStorePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: foreignAgent,
      sessionKey: "global",
      defaultSessionId: foreignId,
    });
    const dispatched: Record<string, unknown>[] = [];
    const callGateway: AgentToolGatewayRequestCaller = async (request) => {
      if (request.method !== "agent") {
        throw new Error(`Unexpected tool RPC ${request.method}`);
      }
      request.assertDispatchCurrent?.();
      dispatched.push(request.params as Record<string, unknown>);
      return { runId: "watched-global-run", status: "accepted" } as never;
    };
    const sent = await createSessionsSendTool({
      config: cfg,
      agentId: owner,
      agentSessionKey: parentKey,
      requesterTurnRunId: "parent-turn",
      callGateway,
    }).execute("send", {
      sessionKey: "global",
      message: "Continue the child task",
      mode: "followup",
      watch: true,
      timeoutSeconds: 0,
    });
    expect(sent.details).toMatchObject({ status: "accepted", watched: true });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ agentId: owner, sessionKey: "global" });
    expect.soft(getSubagentRunByRunId("watched-global-run")).toMatchObject({
      childSessionKey: "global",
      childAgentId: owner,
      requesterSessionKey: parentKey,
      requesterAgentId: owner,
    });
    expect(resolveSessionAgentId({ config: cfg, sessionKey: "global" })).toBe("main");

    const foreignAbort = vi.fn();
    const foreignHandle = createEmbeddedRunHandle({ runId: "foreign-run", abort: foreignAbort });
    setActiveEmbeddedRun(foreignId, foreignHandle, "global", undefined, foreignAgent);
    const followup = createQueueTestRun({ prompt: "Other agent's queued followup" });
    Object.assign(followup.run, {
      agentId: foreignAgent,
      sessionKey: "global",
      sessionId: foreignId,
    });
    enqueueFollowupRun("global", followup, { mode: "followup" }, "none", undefined, false);
    const lane = resolveEmbeddedSessionLane("global");
    const entered = createDeferred();
    const release = createDeferred();
    const blocker = enqueueCommandInLane(lane, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const foreignCommand = enqueueCommandInLane(lane, async () => "foreign command survived", {
      sessionTarget: { agentId: foreignAgent, sessionKey: "global", sessionId: foreignId },
    });
    const childCommand = enqueueCommandInLane(lane, async () => "child must not start", {
      sessionTarget: { agentId: owner, sessionKey: "global", sessionId: childId },
    });
    const outcome = Promise.allSettled([foreignCommand, childCommand]);
    const interruptChild = vi.fn(() => childAdmission.release());
    const childAdmission = await beginSessionWorkAdmission({
      scope: childStorePath,
      identities: ["global", childId],
      assertAllowed: () => {},
      onInterrupt: interruptChild,
    });
    try {
      const cancelled = await createSubagentsTool({
        config: cfg,
        agentId: owner,
        agentSessionKey: parentKey,
      }).execute("cancel", { action: "cancel", runId: "watched-global-run" });
      expect(cancelled.details).toMatchObject({ found: true, killed: true });
      expect(interruptChild).toHaveBeenCalledOnce();
      expect(
        loadSessionEntry({ agentId: owner, storePath: childStorePath, sessionKey: "global" })
          ?.abortedLastRun,
      ).toBe(true);
      expect.soft(foreignAbort).not.toHaveBeenCalled();
      expect.soft(getExistingFollowupQueue("global")?.items.includes(followup) ?? false).toBe(true);
      release.resolve();
      await blocker;
      const [foreignResult, childResult] = await outcome;
      expect
        .soft(foreignResult)
        .toEqual({ status: "fulfilled", value: "foreign command survived" });
      expect(childResult).toMatchObject({
        status: "rejected",
        reason: { name: "CommandLaneClearedError" },
      });
      expect
        .soft(
          loadSessionEntry({
            agentId: foreignAgent,
            storePath: foreignStorePath,
            sessionKey: "global",
          })?.abortedLastRun,
        )
        .not.toBe(true);
    } finally {
      childAdmission.release();
      release.resolve();
      clearCommandLane(lane);
      clearFollowupQueue("global");
      clearActiveEmbeddedRun(foreignId, foreignHandle, "global");
      await Promise.allSettled([blocker, outcome]);
    }
  },
);
