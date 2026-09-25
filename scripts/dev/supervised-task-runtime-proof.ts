/** Opt-in real-adapter proof. Run in a new process with host-managed authentication. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [runtime, model, outputPath] = process.argv.slice(2);
if ((runtime !== "codex" && runtime !== "claude-cli") || !model?.includes("/") || !outputPath) {
  throw new Error(
    "Usage: supervised-task-runtime-proof.ts <codex|claude-cli> <provider/model> <report.json>",
  );
}
const root = mkdtempSync(path.join(tmpdir(), "openclaw-supervised-runtime-"));
const stateDir = path.join(root, "state");
const workspace = path.join(root, "workspace");
mkdirSync(workspace, { recursive: true });
mkdirSync(stateDir, { recursive: true });
// Set isolation before importing any OpenClaw module. Do not alter native login
// homes or copy credentials; the existing runtime auth owners retain that job.
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
const marker = `fixture-${randomUUID()}`;
writeFileSync(path.join(workspace, "fixture.txt"), `${marker}\n`);
writeFileSync(
  path.join(workspace, "AGENTS.md"),
  "Use only the task's accepted goal. The fixture is read-only. Never create detached work.\n",
);
writeFileSync(
  process.env.OPENCLAW_CONFIG_PATH,
  JSON.stringify({
    agents: {
      defaults: {
        model,
        models: { [model]: { agentRuntime: { id: runtime } } },
        thinkingDefault: "low",
        timeoutSeconds: 90,
      },
      entries: {
        poc: { workspace, cwd: workspace, agentDir: path.join(stateDir, "agents", "poc", "agent") },
      },
    },
    plugins: { allow: ["anthropic", "codex", "openai"] },
    tools: { fs: { workspaceOnly: true } },
  }),
  { mode: 0o600 },
);

const { createSupervisedTask, getSupervisedTask, resumeSupervisedTask } =
  await import("../../src/tasks/supervised-task.store.js");
const { startSupervisedTaskWorker } = await import("../../src/tasks/supervised-task.worker.js");
const { prepareSupervisedAgentRuntime, runSupervisedAgentAttempt } =
  await import("../../src/tasks/supervised-task.agent.js");
const { closeOpenClawStateDatabaseForTest } = await import("../../src/state/openclaw-state-db.js");
const { redactSensitiveText } = await import("../../src/logging/redact.js");
type Task = NonNullable<ReturnType<typeof getSupervisedTask>>;
const completed: Array<{ scenario: string; task: Task }> = [];
const errors: string[] = [];
const attempts: Array<{ id: string; runtime: string; decision: string }> = [];
const pending = new Set<Promise<unknown>>();
await prepareSupervisedAgentRuntime();
const worker = startSupervisedTaskWorker({
  runAttempt: async (task, context) => {
    const execution = runSupervisedAgentAttempt(task, context);
    pending.add(execution);
    let decision;
    try {
      decision = await execution;
    } finally {
      pending.delete(execution);
    }
    // The real adapter checks actual returned harness/backend attribution before
    // accepting a decision. A requested model name alone does not satisfy this.
    attempts.push({ id: task.attempt!.id, runtime, decision: decision.kind });
    return decision;
  },
  onError: (error) => {
    errors.push(
      redactSensitiveText(error instanceof Error ? error.message : String(error), {
        mode: "tools",
      }).slice(0, 2000),
    );
  },
  onChange: (task) =>
    console.log(
      JSON.stringify({
        flowId: task.flowId,
        episode: task.episode,
        phase: task.phase,
        attempts: task.attempts,
      }),
    ),
});
const policy = () => ({
  deadlineAt: Date.now() + 240_000,
  maxAttempts: 4,
  attemptTimeoutMs: 90_000,
});
const goal: NonNullable<Task["goal"]> = {
  objective: "Report the fixture marker",
  success: [
    { id: "marker", description: "Read fixture.txt and report its exact contents as evidence" },
  ],
  partial: [],
};
const admit = (prompt: string, acceptedGoal?: typeof goal) =>
  createSupervisedTask(
    { agentId: "poc", model, runtime, prompt, goal: acceptedGoal, policy: policy() },
    worker.ownerId,
    Date.now(),
  );
const finish = async (task: Task, scenario: string) => {
  while (Date.now() <= task.policy.deadlineAt + 5000 && !worker.stopped) {
    const current = getSupervisedTask(task.flowId);
    if (current?.endpoint) {
      completed.push({ scenario, task: current });
      return current;
    }
    await delay(250);
  }
  throw new Error("Supervisor did not record an endpoint within the bounded proof deadline");
};
let passed = false;
try {
  const inferred = await finish(
    admit(
      "Read fixture.txt in the workspace and report the exact marker. No writes are requested.",
    ),
    "inferred-goal-and-success",
  );
  assert.equal(inferred.phase, "succeeded");
  assert.equal(inferred.goalSource, "model");
  assert.ok(
    inferred.attempts >= 2,
    "Goal definition must cause a separate supervised work attempt",
  );
  assert.ok(
    JSON.stringify(inferred.endpoint?.evidence).includes(marker),
    "Host verifier must see the independently generated fixture marker",
  );

  const input = await finish(
    admit(
      "The operator must choose between file A and file B. Ask which one to use and return input_required; do not guess or read either file.",
      goal,
    ),
    "input-required",
  );
  assert.equal(input.phase, "input_required");
  const resumed = resumeSupervisedTask(
    input.flowId,
    input.episode,
    "Use fixture.txt. Read and report its exact marker, satisfying the accepted marker criterion.",
    policy(),
    worker.ownerId,
    Date.now(),
  );
  const resumedResult = await finish(resumed, "operator-response-and-resume");
  assert.equal(resumedResult.phase, "succeeded");
  assert.equal(getSupervisedTask(input.flowId, {}, input.episode)?.phase, "input_required");
  assert.ok(JSON.stringify(resumedResult.endpoint?.evidence).includes(marker));

  const partialGoal = {
    ...goal,
    success: [
      ...goal.success,
      {
        id: "unavailable",
        description:
          "Obtain an operator-owned external approval which is unavailable in this proof",
      },
    ],
    partial: ["marker"],
  };
  const partial = await finish(
    admit(
      "Read fixture.txt and report the marker. The operator explicitly accepts marker-only partial success; the external approval is unavailable. Return partial with marker evidence.",
      partialGoal,
    ),
    "preaccepted-partial",
  );
  assert.equal(partial.phase, "partial");
  assert.ok(JSON.stringify(partial.endpoint?.evidence).includes(marker));

  const failed = await finish(
    admit(
      "This fixture task has a known unrecoverable failure: its requested input was permanently deleted. Do not call tools. Return failed with that reason.",
      goal,
    ),
    "explicit-failure",
  );
  assert.equal(failed.phase, "failed");
  assert.equal(readFileSync(path.join(workspace, "fixture.txt"), "utf8"), `${marker}\n`);
  assert.equal(errors.length, 0);
  passed = true;
} finally {
  worker.stop();
  // This is a dedicated proof process. Stopping task custody must not require a
  // hung backend to cooperate; separately require bounded runtime cleanup here.
  const cleanup = async () => {
    await Promise.allSettled(pending);
    const { disposeRegisteredAgentHarnesses } =
      await import("../../src/agents/harness/registry.js");
    await disposeRegisteredAgentHarnesses();
    const { disposeAllSessionMcpRuntimes } =
      await import("../../src/agents/agent-bundle-mcp-manager-api.js");
    await disposeAllSessionMcpRuntimes();
    const { closeMcpLoopbackServer } = await import("../../src/gateway/mcp-http.js");
    await closeMcpLoopbackServer();
  };
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      cleanup(),
      new Promise<never>((_, reject) => {
        cleanupTimer = setTimeout(
          () => reject(new Error("Runtime cleanup exceeded 30 seconds")),
          30_000,
        );
      }),
    ]);
  } catch {
    errors.push("Runtime cleanup failed or exceeded its deadline");
    passed = false;
    process.exitCode = 1;
  } finally {
    clearTimeout(cleanupTimer);
  }
  closeOpenClawStateDatabaseForTest();
  mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        proof: "supervised-task-real-runtime",
        runtime,
        model,
        passed,
        isolatedRoot: root,
        attempts,
        errors,
        completed,
      },
      null,
      2,
    ),
  );
  // Preserve task-owned transcripts/state for proof inspection. No native login
  // state is copied or removed. One-shot runtime cleanup is owned by the adapter.
}
