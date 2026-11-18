// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { useSubagentControlFixture } from "./subagent-control.test-support.js";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../../config/config.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { createChatAbortContext } from "../../../gateway/server-methods/chat.abort.test-helpers.js";
import { sessionMutationHandlers } from "../../../gateway/server-methods/sessions-mutations.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import { isPidAlive } from "../../../shared/pid-alive.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { AGENT_RUN_TERMINAL_RETRY_GRACE_MS } from "../../agent-run-terminal-outcome.js";
import { getSession, listRunningSessions } from "../../bash-process-registry.js";
import { createExecTool } from "../../bash-tools.exec-run.js";
import { killAllControlledSubagentRuns } from "./subagent-control-kill.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-pause.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { writeChildSession } from "./subagent-registry.persistence.test-support.js";

const fixture = useSubagentControlFixture();
beforeEach(async () => captureRuntimeConfigAsyncReader()());
const parentKey = "agent:main:main";
const sleeper = `${JSON.stringify(process.execPath)} -e 'setTimeout(() => {}, 60000)'`;

async function resetParent() {
  const respond = vi.fn();
  await sessionMutationHandlers["sessions.reset"]!({
    params: { key: parentKey },
    context: createChatAbortContext({
      getRuntimeConfig,
      getSessionEventSubscriberConnIds: () => new Set(),
    }) as never,
    respond,
    client: { connect: { scopes: ["operator.admin"] } } as never,
    req: { type: "req", id: "reset", method: "sessions.reset" },
    isWebchatConnect: () => false,
  });
  expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
}

const yieldRun = (runId: string) =>
  mutateSubagentRuns([runId], (rows) => {
    const entry = structuredClone(rows.get(runId)!);
    expect(markSubagentRunPausedAfterYield({ entry })).toBe(true);
    return { value: undefined, postimages: new Map([[runId, entry]]) };
  });

function lifecycle(runId: string, childKey: string, data: Record<string, unknown>) {
  emitAgentEvent({ runId, sessionKey: childKey, sessionId: runId, stream: "lifecycle", data });
}

/** Error and timeout wait out the retry grace before their terminal row; skip only that wait. */
function failure(data: Record<string, unknown>) {
  return (runId: string, childKey: string) => {
    const realSetTimeout = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      ms?: number,
      ...rest: unknown[]
    ) =>
      realSetTimeout(
        callback,
        ms === AGENT_RUN_TERMINAL_RETRY_GRACE_MS ? 0 : ms,
        ...rest,
      )) as unknown as typeof setTimeout);
    lifecycle(runId, childKey, data);
  };
}

/** The child's styles of leftover work: a hand-off, a service, a survivor and its later child. */
async function startChildProcesses(childKey: string): Promise<number[]> {
  const pidOf = (text: string | undefined) => Number(/PID=(\d+)/.exec(text ?? "")?.[1]);
  return withEnvAsync(
    {
      OPENCLAW_SERVICE_MARKER: "task-end-test",
      OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
      SHELL: "/bin/sh",
    },
    async () => {
      const cwd = mkdtempSync(path.join(os.tmpdir(), "task-end-exec-"));
      const exec = createExecTool({
        host: "gateway",
        mode: "full",
        ask: "off",
        allowBackground: true,
        notifyOnExit: false,
        scopeKey: childKey,
        cwd,
      });
      const ids: string[] = [];
      for (const args of [
        { command: `echo PID=$$; exec ${sleeper}`, background: true },
        { command: `echo PID=$$; exec ${sleeper}`, yieldMs: 200 },
      ]) {
        ids.push(((await exec.execute("start", args)).details as { sessionId: string }).sessionId);
      }
      await vi.waitFor(() =>
        expect(ids.map((id) => pidOf(getSession(id)?.aggregated))).not.toContain(Number.NaN),
      );
      // The survivor forks its child after the command returned and it was adopted.
      const left = await exec.execute("left", {
        command: `sh -c 'sleep 1; sleep 60 & echo PID=$! > late.pid; wait' >/dev/null 2>&1 & echo PID=$!`,
      });
      const late = path.join(cwd, "late.pid");
      await vi.waitFor(() => expect(readFileSync(late, "utf8")).toMatch(/PID=\d+/), {
        timeout: 10_000,
      });
      return [
        ...ids.map((id) => pidOf(getSession(id)?.aggregated)),
        pidOf((left.details as { aggregated: string }).aggregated),
        pidOf(readFileSync(late, "utf8")),
      ];
    },
  );
}

const liveInScope = (childKey: string) =>
  listRunningSessions().filter((session) => session.scopeKey === childKey);

type EndCause = {
  cause: string;
  keeps?: boolean;
  spawnMode?: "session";
  end: (runId: string, childKey: string) => unknown;
};

// One row per way a subagent's task ends; a new end cause is a new row.
it.each<EndCause>([
  {
    cause: "complete",
    end: (runId: string, key: string) => lifecycle(runId, key, { phase: "end" }),
  },
  { cause: "error", end: failure({ phase: "error", error: "400 scripted model failure" }) },
  { cause: "timeout", end: failure({ phase: "end", stopReason: "timeout" }) },
  {
    cause: "killed",
    end: () =>
      killAllControlledSubagentRuns({
        cfg: getRuntimeConfig(),
        controller: {
          controllerSessionKey: parentKey,
          controllerAgentId: "main",
          callerSessionKey: parentKey,
          callerIsSubagent: false,
          controlScope: "children",
        },
        runs: [...subagentRuns.values()],
      }),
  },
  {
    cause: "parent reset of a yielded child",
    end: async (runId: string) => {
      await yieldRun(runId);
      await resetParent();
    },
  },
  {
    cause: "yielded (keeps)",
    keeps: true,
    end: yieldRun,
  },
  {
    cause: "visible session (keeps)",
    keeps: true,
    spawnMode: "session",
    end: (runId: string, key: string) => lifecycle(runId, key, { phase: "end" }),
  },
])(
  "subagent task end: $cause",
  async ({ cause, end, keeps, spawnMode }) => {
    if (process.platform === "win32") {
      return;
    }
    const runId = cause.replace(/\W+/g, "-");
    const childKey = `agent:main:subagent:${runId}`;
    const storePath = await writeChildSession(fixture.stateDir, parentKey, "parent");
    await writeChildSession(fixture.stateDir, childKey, runId);
    await registerSubagentRun({
      runId,
      childSessionKey: childKey,
      childAgentId: "main",
      sessionEntry: loadSessionEntry({ storePath, sessionKey: childKey }),
      requesterSessionKey: parentKey,
      requesterAgentId: "main",
      requesterDisplayKey: parentKey,
      task: cause,
      cleanup: "keep",
      expectsCompletionMessage: false,
      ...(spawnMode ? { spawnMode } : {}),
    });
    const pids = await startChildProcesses(childKey);
    try {
      expect(pids.every(isPidAlive)).toBe(true);
      await end(runId, childKey);
      await vi.waitFor(() => expect(subagentRuns.get(runId)?.execution.endedAt).toBeDefined(), {
        timeout: 30_000,
      });
      await fixture.settle();
      if (keeps) {
        expect(pids.filter(isPidAlive)).toEqual(pids);
        expect(liveInScope(childKey)).toHaveLength(3);
      } else {
        expect(pids.filter(isPidAlive)).toEqual([]);
        expect(liveInScope(childKey)).toEqual([]);
      }
    } finally {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already stopped.
        }
      }
    }
  },
  60_000,
);

it("a later publication of an ended child's row leaves a replacement session's processes", async () => {
  if (process.platform === "win32") {
    return;
  }
  const runId = "replaced-child";
  const childKey = `agent:main:subagent:${runId}`;
  const storePath = await writeChildSession(fixture.stateDir, parentKey, "parent");
  await writeChildSession(fixture.stateDir, childKey, runId);
  await registerSubagentRun({
    runId,
    childSessionKey: childKey,
    childAgentId: "main",
    sessionEntry: loadSessionEntry({ storePath, sessionKey: childKey }),
    requesterSessionKey: parentKey,
    requesterAgentId: "main",
    requesterDisplayKey: parentKey,
    task: "replaced",
    cleanup: "keep",
    expectsCompletionMessage: false,
  });
  lifecycle(runId, childKey, { phase: "end" });
  await vi.waitFor(() => expect(subagentRuns.get(runId)?.execution.endedAt).toBeDefined(), {
    timeout: 30_000,
  });
  await fixture.settle();
  // The child key now belongs to a reset session whose own work started after that end.
  const pids = await startChildProcesses(childKey);
  try {
    await mutateSubagentRuns([runId], (rows) => ({
      value: undefined,
      postimages: new Map([[runId, { ...structuredClone(rows.get(runId)!), label: "renamed" }]]),
    }));
    await fixture.settle();
    expect(pids.filter(isPidAlive)).toEqual(pids);
  } finally {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already stopped.
      }
    }
  }
}, 60_000);
