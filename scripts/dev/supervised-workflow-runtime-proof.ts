/**
 * Real local managed-workflow proof; deliberately excludes publication/CI/Gateway ingress.
 * node --import ./scripts/tsx.mjs scripts/dev/supervised-workflow-runtime-proof.ts \
 *   <codex|claude-cli> <provider/model> <report.json>
 *
 * Uses existing runtime-owned authentication without copying credentials or configuring
 * an endpoint. All OpenClaw state, agent directories and model workspaces are isolated.
 * Generated code executes ONLY through the actual detached command sandbox adapter.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { NodeWorkerProcessIdentity } from "../../src/node-host/node-worker-process-identity.js";
import type { DB } from "../../src/state/openclaw-state-db.generated.js";
import type { SupervisedOperation } from "../../src/tasks/supervised-operation.types.js";
import type { SupervisedTask } from "../../src/tasks/supervised-task.types.js";
import {
  expectedArtifact,
  graphStub,
  oracleSource,
  plannerStub,
  specification,
} from "./supervised-workflow-runtime-fixture.js";

type Manifest = {
  root: string;
  configPath: string;
  stateDir: string;
  databasePath: string;
  flowId: string;
};
type Coordinator = {
  child: ChildProcess;
  identity: NodeWorkerProcessIdentity;
  ownerId?: string;
  exited: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  cleanupConfirmed: boolean;
};
type DecisionObservation = {
  ownerId: string;
  attemptId: string;
  kind: string;
  profile?: string;
  key?: string;
};
let bootstrapRoot: string | undefined;

function isolate(manifest: Manifest) {
  // Must precede EVERY source runtime/config import, also in each fresh child.
  process.env.OPENCLAW_STATE_DIR = manifest.stateDir;
  process.env.OPENCLAW_CONFIG_PATH = manifest.configPath;
}
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fileHash = (file: string) => hash(readFileSync(file));
async function waitFor(predicate: () => boolean | Promise<boolean>, until: number, label: string) {
  while (!(await predicate())) {
    if (Date.now() >= until) {
      throw new Error(`Deadline exceeded: ${label}`);
    }
    await delay(100);
  }
}

async function runCoordinator(manifestPath: string) {
  const manifest: Manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  isolate(manifest);
  const { prepareSupervisedAgentRuntime, runSupervisedAgentAttempt } =
    await import("../../src/tasks/supervised-task.agent.js");
  const { startSupervisedTaskWorker } = await import("../../src/tasks/supervised-task.worker.js");
  const { closeOpenClawStateDatabaseForTest } =
    await import("../../src/state/openclaw-state-db.js");
  const { redactSensitiveText } = await import("../../src/logging/redact.js");
  const { SupervisedDecisionFormatError } =
    await import("../../src/tasks/supervised-task.decision.js");
  const { getSupervisedTask } = await import("../../src/tasks/supervised-task.store.js");
  const { listSupervisedOperations } =
    await import("../../src/tasks/supervised-operation.store.js");
  const { getSupervisedWorkflowContract } =
    await import("../../src/tasks/supervised-workflow.store.js");
  const { getSupervisedWorkspaceHead, resolveSupervisedWorkflowWorkspace } =
    await import("../../src/tasks/supervised-workspace-versions.js");
  const { captureSupervisedWorkspace } = await import("../../src/tasks/supervised-workspace.js");
  const dbOptions = { path: manifest.databasePath };
  const failures = new WeakMap<
    Error,
    { task: SupervisedTask; sourceHash: string; operations: string }
  >();
  const pending = new Set<Promise<unknown>>();
  let stopRequested = false;
  let worker: ReturnType<typeof startSupervisedTaskWorker> | undefined;
  const stop = () => {
    stopRequested = true;
    worker?.stop();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  process.once("disconnect", stop);
  const send = (event: object) => {
    if (process.connected) {
      process.send?.(event);
    }
  };
  const error = (value: unknown) => {
    const failed = value instanceof SupervisedDecisionFormatError ? failures.get(value) : undefined;
    if (failed) {
      const recovered = getSupervisedTask(manifest.flowId, dbOptions);
      const head = getSupervisedWorkspaceHead(manifest.flowId, failed.task.episode, dbOptions);
      if (
        recovered?.phase === "ready" &&
        recovered.attempt === null &&
        recovered.lastAttemptId === failed.task.attempt?.id &&
        recovered.revision === failed.task.revision + 1 &&
        recovered.next.includes("Previous terminal response was not a valid task decision") &&
        head?.source_hash === failed.sourceHash &&
        JSON.stringify(
          listSupervisedOperations(dbOptions, manifest.flowId, failed.task.episode),
        ) === failed.operations
      ) {
        send({
          type: "format-recovery",
          attemptId: failed.task.attempt!.id,
          ownerId: failed.task.attempt!.ownerId,
          revision: recovered.revision,
          sourceHash: failed.sourceHash,
          detail: value instanceof SupervisedDecisionFormatError ? value.detail : "",
        });
        return;
      }
    }
    send({
      type: "error",
      message: redactSensitiveText(value instanceof Error ? value.message : String(value), {
        mode: "tools",
      }).slice(0, 2000),
    });
  };
  try {
    await prepareSupervisedAgentRuntime();
    if (!stopRequested) {
      worker = startSupervisedTaskWorker({
        onlyFlowId: manifest.flowId,
        options: { path: manifest.databasePath },
        runAttempt: async (task, context) => {
          const contract = getSupervisedWorkflowContract(task.flowId, task.episode, dbOptions)!;
          const before = await captureSupervisedWorkspace(
            resolveSupervisedWorkflowWorkspace(
              contract.contract,
              task.flowId,
              task.episode,
              dbOptions,
            ),
          );
          const beforeOperations = JSON.stringify(
            listSupervisedOperations(dbOptions, task.flowId, task.episode),
          );
          const execution = runSupervisedAgentAttempt(task, context);
          pending.add(execution);
          try {
            const decision = await execution;
            if (decision.kind === "committed-attempt-candidate") {
              const committed = getSupervisedTask(task.flowId, dbOptions)!;
              const operation = listSupervisedOperations(dbOptions, task.flowId, task.episode).find(
                (item) => item.admissionRevision === task.revision + 1,
              );
              assert.equal(committed.revision, task.revision + 1);
              send({
                type: "decision",
                ownerId: task.attempt!.ownerId,
                attemptId: task.attempt!.id,
                kind: operation ? "operation" : (committed.endpoint?.kind ?? "continue"),
                ...(operation
                  ? { profile: operation.request.profile, key: operation.request.key }
                  : {}),
              });
              return decision;
            }
            send({
              type: "decision",
              ownerId: task.attempt!.ownerId,
              attemptId: task.attempt!.id,
              kind: decision.kind,
              ...(decision.kind === "operation"
                ? { profile: decision.operation.profile, key: decision.operation.key }
                : {}),
            });
            return decision;
          } catch (attemptError) {
            if (attemptError instanceof SupervisedDecisionFormatError) {
              failures.set(attemptError, {
                task,
                sourceHash: before.hash,
                operations: beforeOperations,
              });
            }
            throw attemptError;
          } finally {
            pending.delete(execution);
          }
        },
        onError: error,
        onChange: (task) => send({ type: "phase", phase: task.phase, attempts: task.attempts }),
      });
      send({ type: "ready", ownerId: worker.ownerId });
      await waitFor(() => stopRequested || Boolean(worker?.stopped), Infinity, "coordinator stop");
    }
  } catch (value) {
    error(value);
    process.exitCode = 1;
  } finally {
    worker?.stop();
    try {
      await Promise.allSettled(pending);
      const { disposeRegisteredAgentHarnesses } =
        await import("../../src/agents/harness/registry.js");
      await disposeRegisteredAgentHarnesses();
      const { disposeAllSessionMcpRuntimes } =
        await import("../../src/agents/agent-bundle-mcp-manager-api.js");
      await disposeAllSessionMcpRuntimes();
      const { closeMcpLoopbackServer } = await import("../../src/gateway/mcp-http.js");
      await closeMcpLoopbackServer();
      send({ type: "cleanup-complete" });
    } catch (value) {
      error(value);
      process.exitCode = 1;
    }
    closeOpenClawStateDatabaseForTest();
    if (process.connected) {
      process.disconnect?.();
    }
  }
}

async function runProof() {
  const [runtime, model, reportArgument, faultArgument, ...extra] = process.argv.slice(2);
  const hardCrash = faultArgument === "--hard-crash";
  if (
    (runtime !== "codex" && runtime !== "claude-cli") ||
    !model?.startsWith(runtime === "codex" ? "openai/" : "anthropic/") ||
    model.endsWith("/") ||
    !reportArgument ||
    (faultArgument !== undefined && !hardCrash) ||
    extra.length
  ) {
    throw new Error(
      "Usage: supervised-workflow-runtime-proof.ts <codex|claude-cli> <provider/model> <report.json> [--hard-crash]",
    );
  }
  const reportPath = path.resolve(reportArgument);
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-managed-workflow-proof-"));
  bootstrapRoot = root;
  const workspace = path.join(root, "input");
  const host = path.join(root, "host");
  const stateDir = path.join(root, "state");
  for (const directory of [workspace, host, stateDir]) {
    mkdirSync(directory, { mode: 0o700 });
  }
  const manifest: Manifest = {
    root,
    configPath: path.join(root, "openclaw.json"),
    databasePath: path.join(stateDir, "state", "openclaw.sqlite"),
    stateDir,
    flowId: `runtime-workflow-${randomUUID()}`,
  };
  isolate(manifest);
  writeFileSync(
    manifest.configPath,
    JSON.stringify({
      agents: {
        ownership: "explicit",
        defaults: {
          model,
          models: { [model]: { agentRuntime: { id: runtime } } },
          thinkingDefault: "medium",
          timeoutSeconds: 180,
        },
        entries: {
          poc: {
            workspace,
            cwd: workspace,
            agentDir: path.join(stateDir, "agents", "poc", "agent"),
          },
          reviewer: {
            workspace,
            cwd: workspace,
            agentDir: path.join(stateDir, "agents", "reviewer", "agent"),
          },
        },
      },
      plugins: { allow: ["anthropic", "codex", "openai"] },
      tools: { fs: { workspaceOnly: true } },
    }),
    { mode: 0o600, flag: "wx" },
  );
  const manifestPath = path.join(host, "coordinator.json");
  writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o400, flag: "wx" });
  const oracle = path.join(host, "oracle.mjs");
  writeFileSync(oracle, oracleSource, { mode: 0o400, flag: "wx" });
  const instructions =
    "Read SPEC.md. Only modify graph.mjs, planner.mjs and plan.json. Request accepted operations for execution and independent review.\n";
  for (const [file, content] of Object.entries({
    "SPEC.md": specification,
    "AGENTS.md": instructions,
    "graph.mjs": graphStub,
    "planner.mjs": plannerStub,
  })) {
    writeFileSync(path.join(workspace, file), content, { mode: 0o600, flag: "wx" });
  }

  const options = { path: manifest.databasePath };
  const { createSupervisedTask, getSupervisedTask, cancelSupervisedTask } =
    await import("../../src/tasks/supervised-task.store.js");
  const { listSupervisedOperations, getSupervisedOperationExecution } =
    await import("../../src/tasks/supervised-operation.store.js");
  const { parseSupervisedOperationExecution } =
    await import("../../src/tasks/supervised-operation.types.js");
  const { getSupervisedCommandResources } =
    await import("../../src/tasks/supervised-command-custody.js");
  const { reconcileSupervisedCommandResources } =
    await import("../../src/tasks/supervised-command-recovery.js");
  const { isSupervisedCommandScopeClosed } =
    await import("../../src/tasks/supervised-command-resources.js");
  const { requireNodeWorkerProcessIdentity, inspectNodeWorkerProcessIdentity } =
    await import("../../src/node-host/node-worker-process-identity.js");
  const { readSupervisedWorkflow } =
    await import("../../src/tasks/supervised-workflow.persistence.js");
  const { getSupervisedAttemptResources } =
    await import("../../src/tasks/supervised-attempt-custody.js");
  const { isSupervisedProcessScopeClosed } =
    await import("../../src/tasks/supervised-process-resources.js");
  const { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } =
    await import("../../src/infra/kysely-sync.js");
  const { encodeSupervisedWorkflowContract } =
    await import("../../src/tasks/supervised-workflow.types.js");
  const { getSupervisedWorkflowContract } =
    await import("../../src/tasks/supervised-workflow.store.js");
  const { resolveSupervisedWorkflowWorkspace, getSupervisedWorkspaceHead } =
    await import("../../src/tasks/supervised-workspace-versions.js");
  const { captureSupervisedWorkspace } = await import("../../src/tasks/supervised-workspace.js");
  const { closeOpenClawStateDatabaseForTest } =
    await import("../../src/state/openclaw-state-db.js");
  const { redactSensitiveText } = await import("../../src/logging/redact.js");
  const coordinators: Coordinator[] = [];
  const decisions: DecisionObservation[] = [];
  const formatRecoveries: Array<{
    attemptId: string;
    ownerId: string;
    revision: number;
    sourceHash: string;
    detail: string;
  }> = [];
  const errors: string[] = [];
  const timeline: Array<{ at: string; event: string }> = [];
  const note = (event: string) => {
    const entry = { at: new Date().toISOString(), event };
    timeline.push(entry);
    appendFileSync(path.join(host, "progress.log"), `${entry.at} ${event}\n`);
    console.log(JSON.stringify(entry));
  };
  const recordError = (value: unknown) =>
    errors.push(
      redactSensitiveText(value instanceof Error ? value.message : String(value), {
        mode: "tools",
      }).slice(0, 4000),
    );
  const operations = () => listSupervisedOperations(options, manifest.flowId, 1);
  const executions = () =>
    readSupervisedWorkflow(
      (db) =>
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .selectFrom("task_flow_operation_executions as e")
            .innerJoin("task_flow_operations as o", "o.operation_id", "e.operation_id")
            .select("e.record_json")
            .where("o.flow_id", "=", manifest.flowId),
        ).rows.map((row) => parseSupervisedOperationExecution(JSON.parse(row.record_json))),
      options,
    ) ?? [];
  const attemptResources = () =>
    readSupervisedWorkflow(
      (db) =>
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .selectFrom("task_flow_attempt_resources")
            .select("resource_id")
            .where("flow_id", "=", manifest.flowId),
        ).rows,
      options,
    )?.map((row) => getSupervisedAttemptResources(row.resource_id, options)!) ?? [];
  const acceptance = () =>
    readSupervisedWorkflow(
      (db) =>
        executeSqliteQueryTakeFirstSync(
          db,
          getNodeSqliteKysely<DB>(db)
            .selectFrom("task_flow_acceptance")
            .selectAll()
            .where("flow_id", "=", manifest.flowId)
            .where("episode", "=", 1),
        ),
      options,
    );
  const retired = (identity: NodeWorkerProcessIdentity) =>
    ["dead", "reused"].includes(inspectNodeWorkerProcessIdentity(identity));
  const start = async () => {
    const script = fileURLToPath(import.meta.url);
    const repository = path.resolve(path.dirname(script), "../..");
    const child = spawn(
      process.execPath,
      [
        "--import",
        path.join(repository, "scripts", "tsx.mjs"),
        script,
        "--coordinator",
        manifestPath,
      ],
      { cwd: repository, env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    assert.ok(child.pid);
    const coordinator: Coordinator = {
      child,
      identity: requireNodeWorkerProcessIdentity(child.pid),
      exited: false,
      code: null,
      signal: null,
      cleanupConfirmed: false,
    };
    coordinators.push(coordinator);
    // Drain logs without persisting runtime output/auth-bearing environment details.
    child.stdout?.resume();
    child.stderr?.resume();
    child.on("error", recordError);
    child.on("exit", (code, signal) => {
      coordinator.exited = true;
      coordinator.code = code;
      coordinator.signal = signal;
    });
    child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object" || !("type" in message)) {
        return;
      }
      if (message.type === "ready" && "ownerId" in message && typeof message.ownerId === "string") {
        coordinator.ownerId = message.ownerId;
      } else if (message.type === "cleanup-complete") {
        coordinator.cleanupConfirmed = true;
      } else if (
        message.type === "format-recovery" &&
        "attemptId" in message &&
        typeof message.attemptId === "string" &&
        "ownerId" in message &&
        typeof message.ownerId === "string" &&
        "revision" in message &&
        typeof message.revision === "number" &&
        "sourceHash" in message &&
        typeof message.sourceHash === "string" &&
        "detail" in message &&
        typeof message.detail === "string"
      ) {
        formatRecoveries.push({
          attemptId: message.attemptId,
          ownerId: message.ownerId,
          revision: message.revision,
          sourceHash: message.sourceHash,
          detail: message.detail,
        });
      } else if (message.type === "error" && "message" in message) {
        recordError(message.message);
      } else if (
        message.type === "decision" &&
        "ownerId" in message &&
        "attemptId" in message &&
        "kind" in message
      ) {
        if (
          typeof message.ownerId !== "string" ||
          typeof message.attemptId !== "string" ||
          typeof message.kind !== "string"
        ) {
          return;
        }
        decisions.push({
          ownerId: message.ownerId,
          attemptId: message.attemptId,
          kind: message.kind,
          ...("profile" in message && typeof message.profile === "string"
            ? { profile: message.profile }
            : {}),
          ...("key" in message && typeof message.key === "string" ? { key: message.key } : {}),
        });
      }
    });
    await waitFor(
      () => {
        if (coordinator.exited) {
          throw new Error("Coordinator exited before accepting custody");
        }
        return Boolean(coordinator.ownerId);
      },
      Date.now() + 120_000,
      "coordinator startup",
    );
    note("Coordinator accepted custody");
    return coordinator;
  };
  const stop = async (coordinator: Coordinator) => {
    if (!coordinator.exited && inspectNodeWorkerProcessIdentity(coordinator.identity) === "live") {
      coordinator.child.kill("SIGTERM");
    }
    await waitFor(
      () => coordinator.exited && retired(coordinator.identity),
      Date.now() + 30_000,
      "exact coordinator process extinction",
    );
    assert.equal(
      coordinator.code,
      0,
      "Coordinator shutdown must not hide a runtime cleanup failure",
    );
    assert.ok(
      coordinator.cleanupConfirmed,
      "Coordinator must join owned runtime cleanup before exiting",
    );
  };
  let admitted: SupervisedTask | undefined;
  let endpoint: SupervisedTask | undefined;
  let baseline: SupervisedOperation | undefined;
  let interruption: object | undefined;
  const observedCrashDescendants: NodeWorkerProcessIdentity[] = [];
  let finalSnapshot: Awaited<ReturnType<typeof captureSupervisedWorkspace>> | undefined;
  let accepted: ReturnType<typeof acceptance>;
  let passed = false;
  let cleanupVerified = false;
  const node = realpathSync(process.execPath);
  const oracleHash = fileHash(oracle);
  const executableHash = fileHash(node);
  const contract = encodeSupervisedWorkflowContract({
    version: 1,
    workspace,
    sourcePaths: ["."],
    maxRecoveryAttempts: 3,
    retentionDays: 30,
    profiles: [
      {
        kind: "command",
        id: "oracle",
        executable: node,
        executableSha256: executableHash,
        argv: ["--permission", "--allow-fs-read=/work", `--allow-fs-read=${oracle}`, oracle],
        cwd: ".",
        timeoutMs: 60_000,
        writable: false,
        network: false,
        replay: "safe",
        readOnlyPaths: [{ path: oracle, sha256: oracleHash }],
      },
      {
        kind: "review",
        id: "independent-review",
        runtime,
        model,
        agentId: "reviewer",
        paths: ["SPEC.md", "graph.mjs", "planner.mjs", "plan.json"],
        instructions:
          "Independently assess the final modules against SPEC.md, including all rejection cases, prior-round dependency semantics, determinism and input immutability. Check plan.json. Treat workflow orchestration statements as context, not a claim that checks passed. Reject bypasses, process APIs, dynamic external imports and any correctness/security defects. No tools or execution.",
        maxBytes: 64 * 1024,
        timeoutMs: 180_000,
      },
    ],
    acceptance: [
      { kind: "receipts", criterionId: "checks", profiles: ["oracle"] },
      { kind: "receipts", criterionId: "review", profiles: ["independent-review"] },
      {
        kind: "artifact",
        criterionId: "artifact",
        path: "plan.json",
        sha256: hash(expectedArtifact),
      },
    ],
  });
  try {
    assert.equal(
      process.platform,
      "linux",
      "Proof requires actual Linux cgroup/user-namespace sandbox",
    );
    const initialSnapshot = await captureSupervisedWorkspace(contract.contract);
    const first = await start();
    assert.ok(first.ownerId);
    admitted = createSupervisedTask(
      {
        flowId: manifest.flowId,
        agentId: "poc",
        runtime,
        model,
        prompt:
          "Read SPEC.md and repair the two-module planner. Follow its baseline-first sequence: before ANY edits, request command profile oracle with key baseline. Recover from the expected failed baseline by repairing both modules and producing plan.json; request a fresh oracle and independent-review. Only after both receipts pass return succeeded for checks, review and artifact. The host will replace the coordinator during the baseline command; do not implement your own continuation or retry service.",
        goal: {
          objective:
            "Deliver a checked, independently reviewed dependency batch planner across coordinator replacement",
          success: [
            { id: "checks", description: "Host-pinned oracle passes on the complete final source" },
            {
              id: "review",
              description: "Independent chosen-runtime reviewer accepts the same final source",
            },
            {
              id: "artifact",
              description: "Retained plan.json exactly matches the specified capacity-2 schedule",
            },
          ],
          partial: [],
        },
        policy: { deadlineAt: Date.now() + 1_200_000, attemptTimeoutMs: 180_000, maxAttempts: 12 },
        workflow: contract.contract,
      },
      first.ownerId,
      Date.now(),
      options,
    );
    note(
      "Managed task admitted; awaiting real runtime baseline request and detached command dispatch",
    );
    await waitFor(
      () => {
        const task = getSupervisedTask(manifest.flowId, options);
        if (task?.endpoint) {
          throw new Error(`Task ended before baseline dispatch: ${task.phase}`);
        }
        const operation = operations().find((item) => item.request.key === "baseline");
        if (operation?.outcome) {
          throw new Error("Baseline finished before interruption could be injected");
        }
        if (!operation?.executionId) {
          return false;
        }
        const execution = getSupervisedOperationExecution(operation.executionId, options);
        const resource = getSupervisedCommandResources(operation.executionId, options);
        return Boolean(
          execution?.dispatchedAt &&
          execution.process &&
          inspectNodeWorkerProcessIdentity(execution.process) === "live" &&
          resource?.state === "bound",
        );
      },
      admitted.policy.deadlineAt,
      "real detached baseline payload dispatch",
    );
    baseline = operations().find((item) => item.request.key === "baseline");
    assert.ok(baseline?.executionId);
    assert.deepEqual(
      decisions[0] && {
        kind: decisions[0].kind,
        profile: decisions[0].profile,
        key: decisions[0].key,
      },
      { kind: "operation", profile: "oracle", key: "baseline" },
    );
    const head = getSupervisedWorkspaceHead(manifest.flowId, 1, options);
    assert.equal(
      head?.source_hash,
      initialSnapshot.hash,
      "Model must not repair the failing baseline before its check",
    );
    const executionBefore = getSupervisedOperationExecution(baseline.executionId, options);
    const scopeBefore = getSupervisedCommandResources(baseline.executionId, options);
    assert.ok(executionBefore?.process && scopeBefore?.identity);
    if (hardCrash) {
      assert.equal(inspectNodeWorkerProcessIdentity(first.identity), "live");
      assert.equal(first.exited, false);
      // Read-only evidence of descendants actually observed before the crash.
      // Not a substitute for attempt-wide kernel custody or a complete future tree.
      const parentByPid = new Map<number, number>();
      for (const entry of readdirSync("/proc")) {
        if (!/^\d+$/.test(entry)) {
          continue;
        }
        try {
          const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
          parentByPid.set(Number(entry), Number(fields[1]));
        } catch (error) {
          if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
            throw error;
          }
        }
      }
      const descendants = new Set([first.identity.pid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [pid, parent] of parentByPid) {
          if (descendants.has(parent) && !descendants.has(pid)) {
            descendants.add(pid);
            changed = true;
          }
        }
      }
      for (const pid of descendants) {
        if (pid === first.identity.pid) {
          continue;
        }
        try {
          observedCrashDescendants.push(requireNodeWorkerProcessIdentity(pid));
        } catch (error) {
          // A vanished sampled process is not an owned live process to signal.
          if (parentByPid.has(pid) && !readdirSync("/proc").includes(String(pid))) {
            continue;
          }
          throw error;
        }
      }
      assert.equal(inspectNodeWorkerProcessIdentity(first.identity), "live");
      note("Killing exact coordinator with SIGKILL while detached baseline command is running");
      assert.ok(first.child.kill("SIGKILL"));
      await waitFor(
        () => first.exited && retired(first.identity),
        Date.now() + 30_000,
        "SIGKILL coordinator extinction",
      );
      assert.equal(first.signal, "SIGKILL");
      assert.equal(first.cleanupConfirmed, false, "Hard-killed coordinator cannot certify cleanup");
    } else {
      note("Interrupting coordinator process with SIGTERM while exact detached command is running");
      await stop(first);
    }
    assert.equal(
      getSupervisedOperationExecution(baseline.executionId, options)?.outcome,
      null,
      "Detached command must remain running after coordinator exit",
    );
    assert.equal(inspectNodeWorkerProcessIdentity(executionBefore.process), "live");
    closeOpenClawStateDatabaseForTest();
    await waitFor(
      () => Boolean(getSupervisedOperationExecution(baseline!.executionId!, options)?.outcome),
      Date.now() + 75_000,
      "same command receipt settles with no coordinator",
    );
    baseline = operations().find((item) => item.operationId === baseline!.operationId);
    assert.ok(baseline?.executionId && baseline.outcome);
    assert.equal(baseline.executionId, executionBefore.executionId);
    assert.equal(baseline.generation, executionBefore.generation);
    assert.equal(baseline.state, "failed");
    assert.equal(baseline.outcome.facts.exitCode, "1");
    assert.equal(baseline.outcome.facts.sourceHash, initialSnapshot.hash);
    assert.equal(typeof baseline.outcome.facts.stdout, "string");
    assert.ok(baseline.outcome.facts.stdout);
    const baselineOutput: unknown = JSON.parse(baseline.outcome.facts.stdout);
    assert.ok(
      baselineOutput &&
        typeof baselineOutput === "object" &&
        "cases" in baselineOutput &&
        "failures" in baselineOutput,
    );
    assert.equal(baselineOutput.cases, 85);
    assert.ok(
      Array.isArray(baselineOutput.failures) && baselineOutput.failures.includes("diamond"),
    );
    assert.equal(getSupervisedTask(manifest.flowId, options)?.endpoint, null);
    const baselineBytes = JSON.stringify(baseline);
    interruption = {
      kind: hardCrash
        ? "hard-coordinator-process-crash"
        : "graceful-coordinator-process-interruption",
      signal: hardCrash ? "SIGKILL" : "SIGTERM",
      coordinator: first.identity,
      observedCrashDescendants,
      execution: executionBefore,
      scope: scopeBefore.identity,
      receiptCompletedWithoutCoordinator: true,
      receiptHash: hash(baselineBytes),
    };
    note(
      "Baseline failed for intended oracle assertions; exact detached receipt survived coordinator loss",
    );
    closeOpenClawStateDatabaseForTest();
    assert.equal(
      JSON.stringify(operations().find((item) => item.operationId === baseline!.operationId)),
      baselineBytes,
    );
    const replacement = await start();
    assert.notEqual(replacement.ownerId, first.ownerId);
    await waitFor(
      () => {
        if (replacement.exited) {
          throw new Error("Replacement coordinator exited before task endpoint");
        }
        const task = getSupervisedTask(manifest.flowId, options);
        if (!task?.endpoint) {
          return false;
        }
        endpoint = task;
        return true;
      },
      admitted.policy.deadlineAt + 5000,
      "real replacement runtime repairs, checks, reviews and completes",
    );
    assert.ok(endpoint);
    assert.equal(endpoint.phase, "succeeded");
    assert.equal(endpoint.endpoint?.acceptedBy, "supervisor");
    await stop(replacement);
    accepted = acceptance();
    assert.ok(accepted, "Durable controller acceptance row is mandatory");
    assert.equal(accepted.contract_hash, contract.hash);
    const resolved = resolveSupervisedWorkflowWorkspace(
      contract.contract,
      manifest.flowId,
      1,
      options,
    );
    finalSnapshot = await captureSupervisedWorkspace(resolved);
    assert.equal(accepted.source_hash, finalSnapshot.hash);
    assert.notEqual(finalSnapshot.hash, initialSnapshot.hash);
    assert.equal(
      readFileSync(path.join(resolved.workspace, "plan.json"), "utf8"),
      expectedArtifact,
    );
    assert.equal(fileHash(path.join(resolved.workspace, "SPEC.md")), hash(specification));
    assert.equal(fileHash(path.join(resolved.workspace, "AGENTS.md")), hash(instructions));
    assert.deepEqual(
      finalSnapshot.files.map((file) => file.path).toSorted(),
      ["AGENTS.md", "SPEC.md", "graph.mjs", "plan.json", "planner.mjs"].toSorted(),
    );
    for (const profile of ["oracle", "independent-review"]) {
      const latest = operations()
        .filter((item) => item.request.profile === profile)
        .toSorted((a, b) => b.admissionRevision - a.admissionRevision)[0];
      assert.ok(latest?.executionId && latest.outcome);
      assert.equal(latest.state, "succeeded");
      assert.equal(latest.outcome.facts.sourceHash, finalSnapshot.hash);
      assert.equal(latest.outcome.facts.resultHash, finalSnapshot.hash);
      const execution = getSupervisedOperationExecution(latest.executionId, options);
      assert.ok(execution?.dispatchedAt && execution.process && execution.finishedAt);
      assert.deepEqual(execution.outcome, latest.outcome);
      assert.ok(
        decisions.some(
          (decision) =>
            decision.ownerId === replacement.ownerId &&
            decision.kind === "operation" &&
            decision.profile === profile,
        ),
        "Real model must request both accepted operation profiles",
      );
      const body: unknown = JSON.parse(accepted.record_json);
      assert.ok(
        body &&
          typeof body === "object" &&
          "operations" in body &&
          Array.isArray(body.operations) &&
          body.operations.includes(latest.operationId),
      );
      if (profile === "oracle") {
        assert.equal(latest.outcome.facts.exitCode, "0");
        assert.equal(latest.outcome.facts.cleanup, "observed");
        assert.ok(latest.outcome.facts.stdout);
        assert.deepEqual(JSON.parse(latest.outcome.facts.stdout), { cases: 85, failures: [] });
      } else {
        assert.equal(latest.outcome.facts.runtime, runtime);
      }
    }
    assert.equal(fileHash(oracle), oracleHash);
    assert.equal(fileHash(node), executableHash);
    assert.equal(getSupervisedWorkflowContract(manifest.flowId, 1, options)?.hash, contract.hash);
    assert.equal(
      JSON.stringify(operations().find((item) => item.operationId === baseline!.operationId)),
      baselineBytes,
      "Replacement must not alter or replay the original failed receipt",
    );
    const durable = {
      endpoint: getSupervisedTask(manifest.flowId, options),
      acceptance: acceptance(),
      operations: operations(),
    };
    closeOpenClawStateDatabaseForTest();
    assert.deepEqual(
      {
        endpoint: getSupervisedTask(manifest.flowId, options),
        acceptance: acceptance(),
        operations: operations(),
      },
      durable,
    );
    assert.ok(formatRecoveries.length <= contract.contract.maxRecoveryAttempts);
    assert.equal(
      new Set(formatRecoveries.map((item) => item.attemptId)).size,
      formatRecoveries.length,
    );
    assert.equal(
      errors.length,
      0,
      "Runtime/dispatcher diagnostics must be investigated, not suppressed",
    );
    note(
      "Controller accepted final artifact, actual oracle and independent review; durable reopen matches",
    );
    passed = true;
  } catch (value) {
    recordError(value);
  } finally {
    // Cancellation fences only this proof flow. Never pkill, kill a PID without
    // its start-time identity, change a receipt, or delete uncertain resources.
    if (admitted && !getSupervisedTask(manifest.flowId, options)?.endpoint) {
      try {
        cancelSupervisedTask(manifest.flowId, Date.now(), options);
      } catch (value) {
        recordError(value);
      }
    }
    for (const coordinator of coordinators) {
      if (!coordinator.exited) {
        try {
          await stop(coordinator);
        } catch (value) {
          recordError(value);
        }
      }
    }
    if (admitted) {
      try {
        // Completed adapters must exit on their own; shutdown is not proof of
        // ordinary cleanup. Failure cleanup may signal only this flow's runners.
        if (!passed) {
          for (const execution of executions()) {
            if (
              execution.process &&
              inspectNodeWorkerProcessIdentity(execution.process) === "live"
            ) {
              process.kill(execution.process.pid, "SIGTERM");
            }
          }
        }
        await waitFor(
          async () => {
            await reconcileSupervisedCommandResources({
              options,
              onlyFlowId: manifest.flowId,
              ownerId: `proof-cleanup-${manifest.flowId}`,
              assertCleanupCurrent: () => {},
              onError: recordError,
            });
            for (const execution of executions()) {
              if (!execution.process || !retired(execution.process)) {
                return false;
              }
              const resource = getSupervisedCommandResources(execution.executionId, options);
              if (
                resource &&
                (resource.state !== "closed" ||
                  (resource.identity && !(await isSupervisedCommandScopeClosed(resource.identity))))
              ) {
                return false;
              }
            }
            for (const resource of attemptResources()) {
              if (
                resource.state !== "closed" ||
                !resource.identity ||
                !(await isSupervisedProcessScopeClosed(resource.identity))
              ) {
                return false;
              }
            }
            if (!observedCrashDescendants.every(retired)) {
              return false;
            }
            return coordinators.every(
              (coordinator) => coordinator.exited && retired(coordinator.identity),
            );
          },
          Date.now() + 45_000,
          "all exact operation runners and bound command scopes extinct",
        );
        cleanupVerified = true;
      } catch (value) {
        recordError(value);
      }
    } else {
      cleanupVerified = coordinators.every(
        (coordinator) => coordinator.exited && retired(coordinator.identity),
      );
    }
    passed = passed && cleanupVerified && errors.length === 0;
    const report = {
      proof: "real-local-managed-workflow",
      runtime,
      model,
      passed,
      terminalStatus: passed ? "passed" : "failed",
      isolatedRoot: root,
      scope: hardCrash
        ? "Local file repair, actual detached command sandbox, independent runtime review and controller acceptance after SIGKILL coordinator replacement during a dispatched command. No crash-during-model-attempt, GitHub publication, CI or Gateway ingress claim."
        : "Local file repair, actual detached command sandbox, independent runtime review, controller acceptance and graceful coordinator process replacement. No GitHub publication, CI, Gateway ingress or hard-crash claim.",
      oracleHash,
      executableHash,
      contractHash: contract.hash,
      interruption,
      coordinators: coordinators.map(
        ({ identity, ownerId, exited, code, signal, cleanupConfirmed }) => ({
          identity,
          ownerId,
          exited,
          code,
          signal,
          cleanupConfirmed,
        }),
      ),
      decisions,
      formatRecoveries,
      baseline,
      endpoint: admitted ? getSupervisedTask(manifest.flowId, options) : null,
      acceptance: admitted ? acceptance() : null,
      finalSnapshot,
      operations: admitted ? operations() : [],
      executions: admitted ? executions() : [],
      attemptResources: admitted ? attemptResources() : [],
      cleanupVerified,
      timeline,
      errors,
    };
    closeOpenClawStateDatabaseForTest();
    mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(
      JSON.stringify({
        report: reportPath,
        terminalStatus: report.terminalStatus,
        cleanupVerified,
      }),
    );
    if (!passed) {
      process.exitCode = 1;
    }
  }
}

if (process.argv[2] === "--coordinator") {
  assert.equal(process.argv.length, 4);
  const manifestPath = process.argv[3];
  assert.ok(manifestPath);
  await runCoordinator(manifestPath);
} else {
  try {
    await runProof();
  } catch (error) {
    // Source/bootstrap failures must also leave a terminal machine-readable
    // outcome. Do not print raw import/config/auth diagnostics as a fallback.
    const reportArgument = process.argv[4];
    if (reportArgument) {
      const reportPath = path.resolve(reportArgument);
      mkdirSync(path.dirname(reportPath), { recursive: true });
      writeFileSync(
        reportPath,
        `${JSON.stringify(
          {
            proof: "real-local-managed-workflow",
            passed: false,
            terminalStatus: "failed",
            stage: "bootstrap-or-reporting",
            isolatedRoot: bootstrapRoot,
            cleanupVerified: false,
            errorType: error instanceof Error ? error.name : typeof error,
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
    }
    console.error(
      "Managed-workflow proof initialization/reporting failed; no passing proof was produced.",
    );
    process.exitCode = 1;
  }
}
