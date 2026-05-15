import { describe, expect, it } from "vitest";
import { withStateDirEnv } from "../../test-helpers/state-dir-env.js";

describe("durable post-turn job state", () => {
  it("persists queued, running, and completed job transitions", async () => {
    await withStateDirEnv("openclaw-post-turn-jobs-", async () => {
      const {
        createPostTurnJob,
        markPostTurnJobCompleted,
        markPostTurnJobRunning,
        readPostTurnJobState,
      } = await import("./durable-job-state.js");

      const job = await createPostTurnJob(
        {
          kind: "context_engine_maintenance",
          label: "Context engine turn maintenance",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          runId: "run-1",
        },
        { bootId: "boot-a", now: 1_000, processId: 111 },
      );

      await markPostTurnJobRunning(job.id, { bootId: "boot-a", now: 1_100, processId: 111 });
      await markPostTurnJobCompleted(job.id, { now: 1_200 });

      const state = await readPostTurnJobState();
      expect(state.jobs).toHaveLength(1);
      expect(state.jobs[0]).toMatchObject({
        id: job.id,
        kind: "context_engine_maintenance",
        label: "Context engine turn maintenance",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        runId: "run-1",
        status: "completed",
        bootId: "boot-a",
        processId: 111,
        createdAt: 1_000,
        startedAt: 1_100,
        completedAt: 1_200,
      });
    });
  });

  it("recovers stale running jobs as crashed and opens the matching circuit breaker", async () => {
    await withStateDirEnv("openclaw-post-turn-jobs-", async () => {
      const {
        createPostTurnJob,
        isPostTurnCircuitBreakerOpen,
        markPostTurnJobRunning,
        readPostTurnJobState,
        recoverStaleRunningPostTurnJobs,
      } = await import("./durable-job-state.js");

      const job = await createPostTurnJob(
        {
          kind: "plugin_hook",
          hookName: "agent_end",
          pluginId: "memory-plugin",
          label: "agent_end hook",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          runId: "run-1",
        },
        { bootId: "old-boot", now: 2_000, processId: 222 },
      );
      await markPostTurnJobRunning(job.id, {
        bootId: "old-boot",
        now: 2_100,
        processId: 222,
      });

      const recovery = await recoverStaleRunningPostTurnJobs({
        bootId: "new-boot",
        now: 3_000,
        processId: 333,
      });

      expect(recovery.crashedJobIds).toEqual([job.id]);
      expect(
        await isPostTurnCircuitBreakerOpen({
          kind: "plugin_hook",
          hookName: "agent_end",
          pluginId: "memory-plugin",
        }),
      ).toBe(true);

      const state = await readPostTurnJobState();
      expect(state.jobs[0]).toMatchObject({
        id: job.id,
        status: "crashed",
        completedAt: 3_000,
        lastError: expect.stringContaining("stale running post-turn job"),
      });
      expect(Object.values(state.circuitBreakers)[0]).toMatchObject({
        kind: "plugin_hook",
        hookName: "agent_end",
        pluginId: "memory-plugin",
        openedAt: 3_000,
        crashCount: 1,
      });
    });
  });
});
