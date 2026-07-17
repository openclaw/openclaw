import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { runWithAgentCommandRecoveryOwner } from "./agent-command-recovery-owner.js";
import type { AgentCommandOpts } from "./command/types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:main";

describe("agent command restart recovery ownership", () => {
  function createTarget() {
    const storePath = path.join(tempDirs.make("openclaw-agent-command-owner-"), "sessions.json");
    return {
      isNewSession: false,
      sessionId: "session-1",
      sessionKey,
      storePath,
    };
  }

  async function write(target: ReturnType<typeof createTarget>, entry: SessionEntry) {
    await replaceSessionEntry({ sessionKey, storePath: target.storePath }, entry);
  }

  it("rejects standalone work when interruption appears during preparation", async () => {
    const target = createTarget();
    await write(target, { sessionId: target.sessionId, updatedAt: 100 });
    const run = vi.fn();

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        mode: "reject_uncoordinated",
        opts: {} as AgentCommandOpts,
        prepare: async () => {
          await write(target, {
            sessionId: target.sessionId,
            updatedAt: 200,
            status: "running",
            abortedLastRun: true,
          });
          return target;
        },
        run,
      }),
    ).rejects.toThrow("interrupted work pending restart recovery");
    expect(run).not.toHaveBeenCalled();
    expect(
      (loadSessionEntry({ sessionKey, storePath: target.storePath }) as SessionEntry | undefined)
        ?.mainRestartRecovery?.foregroundClaims,
    ).toBeUndefined();
  });

  it("allows standalone work when interruption clears during preparation", async () => {
    const target = createTarget();
    await write(target, {
      sessionId: target.sessionId,
      updatedAt: 100,
      status: "running",
      abortedLastRun: true,
    });
    const run = vi.fn(async () => "ran");

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        mode: "reject_uncoordinated",
        opts: {} as AgentCommandOpts,
        prepare: async () => {
          await write(target, { sessionId: target.sessionId, updatedAt: 200 });
          return target;
        },
        run,
      }),
    ).resolves.toBe("ran");
    expect(run).toHaveBeenCalledOnce();
  });

  it("runs a Gateway-admitted recovery without acquiring a foreground owner", async () => {
    const target = createTarget();
    await write(target, {
      sessionId: target.sessionId,
      updatedAt: 200,
      status: "running",
      abortedLastRun: false,
      restartRecoveryRuns: [{ runId: "recovery-run", lifecycleGeneration: "previous" }],
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 3,
        chargedAttempts: 1,
      },
    });
    const run = vi.fn(async () => "recovered");

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        mode: "claim",
        opts: { mainRestartRecoveryAdmitted: true } as AgentCommandOpts,
        prepare: async () => target,
        run,
      }),
    ).resolves.toBe("recovered");
    expect(run).toHaveBeenCalledOnce();
  });

  it("fences the durable predecessor during an automatic freshness rollover", async () => {
    const base = createTarget();
    const target = {
      ...base,
      isNewSession: true,
      previousSessionId: "session-1",
      sessionId: "session-2",
    };
    await write(base, {
      sessionId: target.previousSessionId,
      updatedAt: 100,
      status: "running",
      abortedLastRun: true,
    });
    const run = vi.fn();

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        mode: "reject_uncoordinated",
        opts: {} as AgentCommandOpts,
        prepare: async () => target,
        run,
      }),
    ).rejects.toThrow("interrupted work pending restart recovery");
    expect(run).not.toHaveBeenCalled();
  });

  it("allows a freshness successor after its clean replacement commits", async () => {
    const base = createTarget();
    const target = {
      ...base,
      isNewSession: true,
      previousSessionId: "session-1",
      sessionId: "session-2",
    };
    await write(base, { sessionId: target.sessionId, updatedAt: 200 });
    const run = vi.fn(async () => "successor");

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        mode: "claim",
        opts: {} as AgentCommandOpts,
        prepare: async () => target,
        run,
      }),
    ).resolves.toBe("successor");
    expect(run).toHaveBeenCalledOnce();
  });

  it("allows an explicitly requested fresh session without a predecessor", async () => {
    const target = { ...createTarget(), sessionId: "fresh-session" };
    const run = vi.fn(async () => "fresh");

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        mode: "reject_uncoordinated",
        opts: { sessionId: target.sessionId } as AgentCommandOpts,
        prepare: async () => target,
        run,
      }),
    ).resolves.toBe("fresh");
    expect(run).toHaveBeenCalledOnce();
  });

  it("holds the interrupted predecessor while an explicit replacement runs", async () => {
    const base = createTarget();
    const target = {
      ...base,
      isNewSession: true,
      previousSessionId: base.sessionId,
      sessionId: "fresh-session",
    };
    await write(base, {
      sessionId: base.sessionId,
      updatedAt: 100,
      status: "running",
      abortedLastRun: true,
    });
    const run = vi.fn(async () => "fresh");

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        mode: "reject_uncoordinated",
        opts: { sessionId: target.sessionId } as AgentCommandOpts,
        prepare: async () => target,
        run,
      }),
    ).resolves.toBe("fresh");
    expect(run).toHaveBeenCalledOnce();
  });

  it("revalidates a fresh key when interruption appears during preparation", async () => {
    const base = createTarget();
    const target = { ...base, isNewSession: true, sessionId: "fresh-session" };
    const run = vi.fn();

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        mode: "reject_uncoordinated",
        opts: {} as AgentCommandOpts,
        prepare: async () => {
          await write(base, {
            sessionId: target.sessionId,
            updatedAt: 200,
            status: "running",
            abortedLastRun: true,
          });
          return target;
        },
        run,
      }),
    ).rejects.toThrow("interrupted work pending restart recovery");
    expect(run).not.toHaveBeenCalled();
  });
});
