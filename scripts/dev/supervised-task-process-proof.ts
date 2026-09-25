/** Real-process SQLite proof; synthetic decisions, no model or live Gateway. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { closeOpenClawStateDatabaseForTest } from "../../src/state/openclaw-state-db.js";
import {
  assertSupervisedAttemptCurrent,
  claimSupervisedTask,
  createSupervisedTask,
  getSupervisedTask,
  heartbeatTaskSupervisor,
  inspectTaskSupervision,
  reconcileSupervisedTasks,
  reserveSupervisedDispatch,
  settleSupervisedDecision,
  stopTaskSupervisor,
} from "../../src/tasks/supervised-task.store.js";
import {
  validateSupervisedTask,
  type SupervisedTask,
} from "../../src/tasks/supervised-task.types.js";

const goal = {
  objective: "Produce one local fixture effect",
  success: [{ id: "effect", description: "Exactly one fixture marker exists" }],
  partial: [],
};
const policy = () => ({
  deadlineAt: Date.now() + 30_000,
  maxAttempts: 5,
  attemptTimeoutMs: 10_000,
});
const success = {
  kind: "succeeded" as const,
  summary: "Fixture effect verified",
  evidence: [{ criterionId: "effect", observation: "One fixture marker" }],
};

if (process.argv[2] === "--child") {
  const [mode, directory, flowId, owner] = process.argv.slice(3);
  if (!mode || !directory || !flowId || !owner || !process.send) {
    throw new Error("Invalid process-proof child arguments");
  }
  const options = { env: { OPENCLAW_STATE_DIR: directory } };
  heartbeatTaskSupervisor(owner, Date.now(), 5000, options);
  process.send({ event: "ready" });
  process.once("message", () => {
    const claim = claimSupervisedTask(flowId, owner, Date.now(), options);
    const task =
      mode === "effect" && claim ? reserveSupervisedDispatch(claim, Date.now(), options) : claim;
    if (task && mode === "effect") {
      appendFileSync(path.join(directory, "effects.txt"), "effect\n");
    }
    process.send!({ event: "claimed", task: task ?? null });
    // Intentionally preserve a real live owner process for SIGKILL. No heartbeat
    // renewal is performed; the proof waits for its durable expiry after death.
    setInterval(() => {}, 1000);
  });
} else {
  const directory = mkdtempSync(path.join(tmpdir(), "openclaw-supervised-proof-"));
  const children: ChildProcess[] = [];
  const options = { env: { OPENCLAW_STATE_DIR: directory } };
  const results: string[] = [];
  const makeTask = () => {
    heartbeatTaskSupervisor("admission", Date.now(), 60_000, options);
    return createSupervisedTask(
      {
        agentId: "poc",
        model: "openai/fixture",
        runtime: "codex",
        prompt: "Write the fixture marker",
        goal,
        policy: policy(),
      },
      "admission",
      Date.now(),
      options,
    );
  };
  const launch = async (mode: string, flowId: string, owner: string) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        fileURLToPath(import.meta.url),
        "--child",
        mode,
        directory,
        flowId,
        owner,
      ],
      { stdio: ["ignore", "ignore", "inherit", "ipc"] },
    );
    children.push(child);
    await receive(child, "ready");
    return child;
  };
  const kill = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  };
  try {
    // Concurrent separate SQLite connections claim the same row. A sequential
    // mocked store test cannot establish this arbitration.
    const raceTask = makeTask();
    const [first, second] = await Promise.all([
      launch("claim", raceTask.flowId, "race-a"),
      launch("claim", raceTask.flowId, "race-b"),
    ]);
    const claims = [receive(first, "claimed"), receive(second, "claimed")];
    first.send("go");
    second.send("go");
    const claimed = await Promise.all(claims);
    assert.equal(claimed.filter((message) => message.task !== null).length, 1);
    await Promise.all([kill(first), kill(second)]);
    await delay(5100);
    reconcileSupervisedTasks(Date.now(), options);
    assert.equal(getSupervisedTask(raceTask.flowId, options)?.phase, "ready");
    const recovered = reserveSupervisedDispatch(
      claimSupervisedTask(raceTask.flowId, "admission", Date.now(), options)!,
      Date.now(),
      options,
    );
    appendFileSync(path.join(directory, "safe-effect.txt"), "effect\n");
    settleSupervisedDecision(recovered, success, Date.now(), options);
    assert.equal(readFileSync(path.join(directory, "safe-effect.txt"), "utf8"), "effect\n");
    results.push(
      "concurrent claim: one winner; pre-dispatch SIGKILL: safe fresh attempt and success",
    );

    const effectTask = makeTask();
    const effectChild = await launch("effect", effectTask.flowId, "effect-owner");
    const effectClaim = receive(effectChild, "claimed");
    effectChild.send("go");
    const interrupted = (await effectClaim).task!;
    assert.equal(readFileSync(path.join(directory, "effects.txt"), "utf8"), "effect\n");
    await kill(effectChild);
    await delay(5100);
    closeOpenClawStateDatabaseForTest();
    reconcileSupervisedTasks(Date.now(), options);
    assert.equal(getSupervisedTask(effectTask.flowId, options)?.endpoint?.effects, "unknown");
    assert.equal(getSupervisedTask(effectTask.flowId, options)?.phase, "input_required");
    assert.equal(
      claimSupervisedTask(effectTask.flowId, "admission", Date.now(), options),
      undefined,
    );
    assert.throws(() => assertSupervisedAttemptCurrent(interrupted, Date.now(), options));
    assert.equal(readFileSync(path.join(directory, "effects.txt"), "utf8"), "effect\n");
    results.push(
      "post-effect SIGKILL and database reopen: explicit input endpoint, no replay, stale source rejected",
    );

    const timerTask = makeTask();
    const timerAttempt = reserveSupervisedDispatch(
      claimSupervisedTask(timerTask.flowId, "admission", Date.now(), options)!,
      Date.now(),
      options,
    );
    const wakeAt = Date.now() + 500;
    settleSupervisedDecision(
      timerAttempt,
      { kind: "wait", next: "Verify the marker after the timer", wakeAt },
      Date.now(),
      options,
    );
    stopTaskSupervisor("admission", Date.now(), options);
    closeOpenClawStateDatabaseForTest();
    assert.equal(
      inspectTaskSupervision(timerTask.flowId, Date.now(), options)?.continuation,
      "unknown",
    );
    heartbeatTaskSupervisor("restarted", Date.now(), 10_000, options);
    assert.equal(
      claimSupervisedTask(timerTask.flowId, "restarted", Date.now(), options),
      undefined,
    );
    await delay(Math.max(0, wakeAt - Date.now()) + 10);
    const timerClaim = claimSupervisedTask(timerTask.flowId, "restarted", Date.now(), options)!;
    assert.equal(timerClaim.attempts, 2);
    settleSupervisedDecision(
      reserveSupervisedDispatch(timerClaim, Date.now(), options),
      success,
      Date.now(),
      options,
    );
    assert.equal(getSupervisedTask(timerTask.flowId, options)?.phase, "succeeded");
    results.push("durable timer: unknown while owner absent, resumed after reopen at due time");
    console.log(
      JSON.stringify(
        {
          proof: "supervised-task-process",
          runtime: "synthetic decision runner, real processes and SQLite",
          results,
          passed: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.all(children.map(kill));
    closeOpenClawStateDatabaseForTest();
    rmSync(directory, { recursive: true, force: true });
  }
}

function receive(child: ChildProcess, event: string): Promise<{ task: SupervisedTask | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Child did not report ${event}`)), 15_000);
    const onExit = () => finish(new Error(`Child exited before ${event}`));
    const onError = (error: Error) => finish(error);
    const onMessage = (message: unknown) => {
      if (message && typeof message === "object" && "event" in message && message.event === event) {
        try {
          finish(undefined, {
            task:
              "task" in message && message.task !== null
                ? validateSupervisedTask(message.task)
                : null,
          });
        } catch {
          finish(new Error("Child returned an invalid supervised task record"));
        }
      }
    };
    const finish = (error?: Error, message?: { task: SupervisedTask | null }) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onError);
      child.off("message", onMessage);
      if (error) {
        reject(error);
      } else {
        resolve(message!);
      }
    };
    child.once("exit", onExit);
    child.once("error", onError);
    child.on("message", onMessage);
  });
}
