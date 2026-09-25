/**
 * Opt-in real-runtime admission proof, never a rollback proof. An isolated plugin
 * pauses the actual mutation's before_tool_call policy. The host revokes
 * SQL custody, then lets the policy return normally. The real adapter must reject
 * that stale permission before mutation. A positive control uses the same path.
 * Run each runtime in a fresh process with its existing host-owned authentication.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookToolContext,
} from "../../src/plugins/hook-types.js";

const [runtime, model, outputPath, selection = "all"] = process.argv.slice(2);
if (
  (runtime !== "codex" && runtime !== "claude-cli") ||
  !model?.includes("/") ||
  !outputPath ||
  !["all", "cancel", "expiry"].includes(selection)
) {
  throw new Error(
    "Usage: supervised-task-mutation-proof.ts <codex|claude-cli> <provider/model> <report.json> [all|cancel|expiry]",
  );
}

const root = mkdtempSync(path.join(tmpdir(), "openclaw-supervised-mutation-"));
const stateDir = path.join(root, "state");
const workspace = path.join(root, "workspace");
const pluginDir = path.join(root, "admission-barrier");
for (const directory of [stateDir, workspace, pluginDir]) {
  mkdirSync(directory, { recursive: true });
}
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
const pluginId = "supervised-mutation-proof";
const toolSurface =
  runtime === "codex" ? "openclaw-file-tool-via-codex" : "openclaw-file-tool-via-claude-mcp";
const sourceSha256 = createHash("sha256")
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex");
const bridgeKey = `openclaw.proof.mutation.${randomUUID()}`;
// A real configured plugin is required: a global hook overlay can be replaced or
// shadowed when a runtime activates its generation-scoped plugin registry.
writeFileSync(
  path.join(pluginDir, "openclaw.plugin.json"),
  JSON.stringify({
    id: pluginId,
    hooks: ["before_tool_call"],
    activation: { onCapabilities: ["hook"] },
    configSchema: { type: "object", additionalProperties: false },
  }),
);
writeFileSync(
  path.join(pluginDir, "index.cjs"),
  `module.exports = { id: ${JSON.stringify(pluginId)}, register(api) {
    api.on("before_tool_call", async (event, context) => {
      const owner = globalThis[Symbol.for(${JSON.stringify(bridgeKey)})];
      if (!owner) throw new Error("Mutation proof barrier owner disappeared");
      return owner.beforeToolCall(event, context);
    }, { priority: 10000, timeoutMs: 10000 });
  } };\n`,
);
writeFileSync(
  path.join(workspace, "AGENTS.md"),
  "Work only on the exact file named by the accepted task. Use the permitted file tools, never shell tools. Never start detached work.\n",
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
    plugins: {
      allow: ["anthropic", "codex", "openai", pluginId],
      load: { paths: [path.join(pluginDir, "index.cjs")] },
      entries: { [pluginId]: { enabled: true } },
    },
    tools: { fs: { workspaceOnly: true } },
  }),
  { mode: 0o600 },
);

type Scenario = "positive" | "cancel" | "expiry";
type Observation = {
  toolName: string;
  inputKeys: string[];
  runId?: string;
  toolCallId?: string;
  expectedSurface: boolean;
  abortedAtEntry: boolean;
  abortedAtAllow?: boolean;
};
type Barrier = {
  filename: string;
  attemptId?: string;
  seen: Observation[];
  enter: () => void;
  entered: Promise<void>;
  release: () => void;
  released: Promise<void>;
  returnedAllow: number;
};
let barrier: Barrier | undefined;
const errors: string[] = [];
const toolReceipts: Array<{
  type: string;
  runId: string;
  toolCallId: string;
  terminalReason?: string;
  category?: string;
  afterAllow: boolean;
}> = [];
const authorityRejections: Array<{
  attemptId: string;
  toolCallId?: string;
  afterAllow: boolean;
  stack: string;
  callerStack: string;
}> = [];
const rows: Array<{
  scenario: Scenario;
  filename: string;
  task: unknown;
  beforeHash: string;
  afterHash: string;
  hooks: Observation[];
  returnedAllow: number;
}> = [];
const ownershipAborts: Array<{ attemptId: string; toolCallId?: string; reason: string }> = [];
let passed = false;
let stage = "initialization";
let currentTask: unknown;
let save: () => void = () => {};

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(operation: Promise<T>, milliseconds: number, description: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(description)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

Reflect.set(globalThis, Symbol.for(bridgeKey), {
  beforeToolCall: async (event: PluginHookBeforeToolCallEvent, context: PluginHookToolContext) => {
    const current = barrier;
    if (!current || !["write", "edit", "apply_patch"].includes(event.toolName)) {
      return;
    }
    const serialized = JSON.stringify(event.params);
    if (!serialized.includes(current.filename)) {
      return;
    }
    const observation: Observation = {
      toolName: event.toolName,
      inputKeys: Object.keys(event.params).toSorted(),
      runId: event.runId ?? context.runId,
      toolCallId: event.toolCallId ?? context.toolCallId,
      expectedSurface:
        (event.toolName === "apply_patch" &&
          typeof event.params.input === "string" &&
          event.params.input.includes("*** Begin Patch")) ||
        (["write", "edit"].includes(event.toolName) && typeof event.params.path === "string"),
      abortedAtEntry: context.abortSignal?.aborted === true,
    };
    current.seen.push(observation);
    current.enter();
    await bounded(current.released, 8000, "Host did not release the mutation admission barrier");
    observation.abortedAtAllow = context.abortSignal?.aborted === true;
    current.returnedAllow++;
    // No block, abort, parameter rewrite, synthetic tool result, or policy denial.
    // Revalidation in the actual runtime/host permission path must reject stale custody.
  },
});

const hash = (filename: string) =>
  createHash("sha256").update(readFileSync(filename)).digest("hex");
const pending = new Set<Promise<unknown>>();
let stopWorker: (() => void) | undefined;
let cleanupRuntime: (() => Promise<void>) | undefined;
let closeDatabase: (() => void) | undefined;
let stopDiagnostics: (() => void) | undefined;
// Persist even a preparation failure, and prevent leaked backend handles from
// making this proof appear indefinitely running after its bounded failure.
save = () => {
  mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        proof: "supervised-mutation-admission",
        toolSurface,
        sourceSha256,
        authorityRejections,
        ownershipAborts,
        toolReceipts,
        runtime,
        model,
        selection,
        passed,
        stage,
        isolatedRoot: root,
        errors,
        rows,
        currentTask,
        activeBarrier: barrier
          ? {
              filename: barrier.filename,
              attemptId: barrier.attemptId,
              hooks: barrier.seen,
              returnedAllow: barrier.returnedAllow,
              currentHash: hash(path.join(workspace, barrier.filename)),
            }
          : null,
        limits: [
          "Revocation before file-tool permission returns; not revocation after permission or rollback of dispatched writes.",
          "Expiry is driven by the real reconciler with the recorded attempt-expiry timestamp, not a wall-clock sleep.",
          "Positive completion is runtime-attributed by the production adapter. Revoked attempts cannot return a successful attributed result; their tool request envelope and isolated runtime configuration are retained.",
        ],
      },
      null,
      2,
    ),
  );
};
const hardStop = setTimeout(() => {
  passed = false;
  errors.push(
    "Proof process exceeded its 480-second outer deadline; runtime cleanup is unconfirmed",
  );
  barrier?.release();
  stopWorker?.();
  save();
  process.exit(1);
}, 480_000);

try {
  const store = await import("../../src/tasks/supervised-task.store.js");
  const { startSupervisedTaskWorker } = await import("../../src/tasks/supervised-task.worker.js");
  const { prepareSupervisedAgentRuntime, runSupervisedAgentAttempt } =
    await import("../../src/tasks/supervised-task.agent.js");
  const { closeOpenClawStateDatabaseForTest } =
    await import("../../src/state/openclaw-state-db.js");
  const { redactSensitiveText } = await import("../../src/logging/redact.js");
  const { onInternalDiagnosticEvent } = await import("../../src/infra/diagnostic-events.js");
  stopDiagnostics = onInternalDiagnosticEvent((event, metadata) => {
    if (
      !metadata.trusted ||
      !barrier ||
      !["tool.execution.error", "tool.execution.blocked"].includes(event.type)
    ) {
      return;
    }
    if (event.type !== "tool.execution.error" && event.type !== "tool.execution.blocked") {
      return;
    }
    if (
      event.runId !== barrier.attemptId ||
      !event.runId ||
      !event.toolCallId ||
      !barrier.seen.some((hook) => hook.toolCallId === event.toolCallId)
    ) {
      return;
    }
    toolReceipts.push({
      type: event.type,
      runId: event.runId,
      toolCallId: event.toolCallId,
      afterAllow: barrier.returnedAllow > 0,
      category: event.type === "tool.execution.error" ? event.errorCategory : event.deniedReason,
      terminalReason: event.type === "tool.execution.error" ? event.terminalReason : undefined,
    });
  });
  closeDatabase = closeOpenClawStateDatabaseForTest;
  const recordError = (error: unknown) => {
    errors.push(
      redactSensitiveText(error instanceof Error ? error.message : String(error), {
        mode: "tools",
      }).slice(0, 1500),
    );
  };
  cleanupRuntime = async () => {
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
  stage = "runtime-preparation";
  // Exercise the actual standalone CLI startup policy, not an injected root
  // registry that could hide a missing run/work bootstrap in production.
  const { ensureCliExecutionBootstrap } =
    await import("../../src/cli/command-execution-startup.js");
  const { resolveCliStartupPolicy } = await import("../../src/cli/command-startup-policy.js");
  const commandPath = ["tasks", "supervise", "run"];
  const startupPolicy = resolveCliStartupPolicy({
    argv: ["node", "openclaw", "tasks", "supervise", "run", "fixture.json"],
    commandPath,
    jsonOutputMode: true,
  });
  await ensureCliExecutionBootstrap({
    commandPath,
    startupPolicy,
    runtime: {
      log: () => {},
      error: () => {},
      exit: (code) => {
        throw new Error(`CLI bootstrap exited ${code}`);
      },
    },
  });
  const { getGlobalHookRunner } = await import("../../src/plugins/hook-runner-global.js");
  assert.ok(
    getGlobalHookRunner()?.hasHooks("before_tool_call"),
    "Standalone supervision must activate configured mutation policy before dispatch",
  );
  await bounded(prepareSupervisedAgentRuntime(), 60_000, "Runtime preparation timed out");
  const worker = startSupervisedTaskWorker({
    runAttempt: async (task, context) => {
      assert.ok(barrier && task.attempt);
      barrier.attemptId = task.attempt.id;
      // Observe the real source assertion without replacing its decision. The wrapper
      // always delegates and rethrows; it never manufactures an authority failure.
      const observeAbort = () => {
        const current = barrier;
        if (current && current.attemptId === task.attempt?.id && current.seen.length > 0) {
          ownershipAborts.push({
            attemptId: current.attemptId!,
            toolCallId: current.seen.at(-1)?.toolCallId,
            reason:
              context.signal.reason instanceof Error ? context.signal.reason.message : "unknown",
          });
        }
      };
      context.signal.addEventListener("abort", observeAbort, { once: true });
      const execution = runSupervisedAgentAttempt(task, {
        ...context,
        assertCurrent: () => {
          try {
            context.assertCurrent();
          } catch (error) {
            const current = barrier;
            if (current && current.attemptId === task.attempt?.id) {
              authorityRejections.push({
                attemptId: current.attemptId!,
                toolCallId: current.seen.at(-1)?.toolCallId,
                afterAllow: current.returnedAllow > 0,
                callerStack: new Error("Observed source assertion rejection").stack ?? "",
                stack: redactSensitiveText(
                  error instanceof Error ? (error.stack ?? error.message) : String(error),
                  { mode: "tools" },
                ).slice(0, 5000),
              });
            }
            throw error;
          }
        },
      });
      pending.add(execution);
      try {
        return await execution;
      } finally {
        context.signal.removeEventListener("abort", observeAbort);
        pending.delete(execution);
      }
    },
    onError: recordError,
  });
  stopWorker = worker.stop;
  const scenarios: Scenario[] =
    selection === "all"
      ? ["positive", "cancel", "expiry"]
      : ["positive", selection === "cancel" ? "cancel" : "expiry"];
  for (const scenario of scenarios) {
    stage = scenario;
    const errorCountBefore = errors.length;
    const filename = `${scenario}-${randomUUID()}.txt`;
    const target = path.join(workspace, filename);
    const original = `before-${randomUUID()}\n`;
    const replacement = `after-${randomUUID()}\n`;
    writeFileSync(target, original);
    const beforeHash = hash(target);
    const entered = deferred();
    const released = deferred();
    const current: Barrier = {
      filename,
      seen: [],
      entered: entered.promise,
      enter: entered.resolve,
      released: released.promise,
      release: released.resolve,
      returnedAllow: 0,
    };
    barrier = current;
    const task = store.createSupervisedTask(
      {
        agentId: "poc",
        model,
        runtime,
        prompt: `Read ${filename}, then use the provided OpenClaw apply_patch file tool to replace its complete contents with ${JSON.stringify(replacement)}. Do not use shell tools. Report success only after the write actually succeeds.`,
        goal: {
          objective: "Replace the one named fixture file",
          success: [
            { id: "written", description: "The named file contains the exact replacement bytes" },
          ],
          partial: [],
        },
        policy: { deadlineAt: Date.now() + 120_000, maxAttempts: 1, attemptTimeoutMs: 90_000 },
      },
      worker.ownerId,
      Date.now(),
    );
    currentTask = task;
    let endpointBeforeRelease: ReturnType<typeof store.getSupervisedTask>;
    try {
      await bounded(
        (async () => {
          while (current.seen.length === 0) {
            const latest = store.getSupervisedTask(task.flowId);
            if (latest?.endpoint) {
              throw new Error("Task ended without reaching its mutation admission barrier");
            }
            await delay(50);
          }
        })(),
        100_000,
        "Runtime did not reach the actual mutation barrier",
      );
      assert.ok(
        current.seen.every((hook) => hook.runId === current.attemptId && hook.expectedSurface),
        "Observed mutation must belong to the current attempt and use its actual OpenClaw file-tool surface",
      );
      assert.equal(hash(target), beforeHash, "Mutation must not happen before permission returns");
      const held = store.getSupervisedTask(task.flowId);
      currentTask = held;
      assert.ok(held?.attempt?.dispatched);
      assert.equal(held.phase, "running");
      if (scenario === "cancel") {
        endpointBeforeRelease = store.cancelSupervisedTask(task.flowId, Date.now());
        assert.equal(endpointBeforeRelease.phase, "cancelled");
      } else if (scenario === "expiry") {
        store.reconcileSupervisedTasks(held.attempt.expiresAt);
        endpointBeforeRelease = store.getSupervisedTask(task.flowId);
        assert.equal(endpointBeforeRelease?.phase, "input_required");
      }
      currentTask = endpointBeforeRelease ?? held;
      save();
    } finally {
      current.release();
    }
    const finish = async () => {
      while (Date.now() < task.policy.deadlineAt + 5000) {
        const result = store.getSupervisedTask(task.flowId);
        if (result?.endpoint && pending.size === 0) {
          return result;
        }
        await delay(100);
      }
      throw new Error("Runtime failed to settle and clean up within the task deadline");
    };
    const result = await finish();
    currentTask = result;
    assert.ok(current.seen.length > 0 && current.returnedAllow > 0);
    if (scenario === "positive") {
      assert.equal(result.phase, "succeeded");
      assert.equal(readFileSync(target, "utf8"), replacement);
      assert.equal(
        errors.length,
        errorCountBefore,
        "Positive file-tool control must not report runtime errors",
      );
    } else {
      assert.equal(
        hash(target),
        beforeHash,
        "A stale file-tool permission must not write the file",
      );
      assert.deepEqual(
        result,
        endpointBeforeRelease,
        "Late runtime completion must not change the endpoint",
      );
      // An unchanged file or generic CLI failure is not evidence of the fence.
      // Codex reports a trusted failed tool receipt. Claude MCP rejects earlier,
      // at the source-bound grant recheck after policy and before tool.execute.
      // The worker's source-owned abort is also legitimate if its ownership tick
      // wins this race; correlate it with this exact held mutation, not run errors.
      assert.ok(
        authorityRejections.some(
          (rejection) =>
            rejection.attemptId === current.attemptId &&
            rejection.afterAllow &&
            rejection.stack.includes("Supervised attempt no longer owns execution") &&
            current.seen.some((hook) => hook.toolCallId === rejection.toolCallId) &&
            (runtime === "claude-cli"
              ? rejection.callerStack.includes("handleMcpJsonRpc") &&
                rejection.callerStack.includes("mcp-grant-store")
              : toolReceipts.some(
                  (receipt) =>
                    receipt.runId === rejection.attemptId &&
                    receipt.toolCallId === rejection.toolCallId &&
                    receipt.afterAllow,
                )),
        ) ||
          ownershipAborts.some(
            (abort) =>
              abort.attemptId === current.attemptId &&
              abort.reason === "Supervised attempt ownership ended" &&
              current.seen.some((hook) => hook.toolCallId === abort.toolCallId),
          ),
        "Missing correlated source-owned mutation rejection",
      );
    }
    rows.push({
      scenario,
      filename,
      task: result,
      beforeHash,
      afterHash: hash(target),
      hooks: current.seen,
      returnedAllow: current.returnedAllow,
    });
    save();
    barrier = undefined;
  }
  passed = true;
} catch (error) {
  // Runtime errors are redacted above; host assertion text only contains synthetic
  // fixtures. Avoid logging arbitrary thrown backend strings at this outer boundary.
  errors.push(
    error instanceof assert.AssertionError
      ? `Host assertion failed: ${error.message}`
      : `Proof failed during ${stage}; inspect isolated task transcripts`,
  );
  process.exitCode = 1;
} finally {
  stage = "cleanup";
  barrier?.release();
  stopWorker?.();
  try {
    if (cleanupRuntime) {
      await bounded(cleanupRuntime(), 30_000, "Runtime cleanup exceeded 30 seconds");
    }
    for (const row of rows) {
      assert.equal(
        hash(path.join(workspace, row.filename)),
        row.afterHash,
        "Runtime cleanup must not perform a late fixture mutation",
      );
    }
  } catch {
    errors.push("Runtime cleanup failed or timed out");
    passed = false;
    process.exitCode = 1;
  }
  closeDatabase?.();
  stopDiagnostics?.();
  Reflect.deleteProperty(globalThis, Symbol.for(bridgeKey));
  stage = "complete";
  save();
  clearTimeout(hardStop);
  if (!passed) {
    // Isolated process only: failed native cleanup must not keep the proof alive.
    process.exit(1);
  }
}
