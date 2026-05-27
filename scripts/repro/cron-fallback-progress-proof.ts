#!/usr/bin/env tsx
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-pr-87343-proof-"));
process.env.OPENCLAW_STATE_DIR = stateDir;

const {
  GatewayDrainingError,
  enqueueCommand,
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  markGatewayDraining,
  resetCommandQueueStateForTest,
} = await import("../../src/process/command-queue.js");
const {
  createRunningTaskRun,
  recordTaskRunProgressByRunId,
  resetDetachedTaskLifecycleRuntimeForTests,
} = await import("../../src/tasks/detached-task-runtime.js");
const { findTaskByRunId, resetTaskRegistryForTests } =
  await import("../../src/tasks/task-registry.js");
const { resetTaskFlowRegistryForTests } = await import("../../src/tasks/task-flow-registry.js");
const { FailoverError } = await import("../../src/agents/failover-error.js");
const { runWithModelFallback } = await import("../../src/agents/model-fallback.js");

const runId = "pr-87343-cron-proof";
const sessionLane = "session:pr-87343-cron-proof";
const globalLane = "agent:cron:pr-87343-cron-proof";
const primary = "openai/gpt-4.1-mini";
const fallback = "anthropic/claude-haiku-3-5";
const cfg = {
  agents: {
    defaults: {
      model: {
        primary,
        fallbacks: [fallback],
      },
    },
  },
};

function formatProgressSummary(step?: {
  fallbackStepFromModel: string;
  fallbackStepToModel?: string;
  fallbackStepFromFailureReason?: string;
  fallbackStepFinalOutcome: string;
  fallbackStepFromFailureDetail?: string;
  fallbackStepQueueActive?: number;
  fallbackStepQueueQueued?: number;
  fallbackStepQueueDraining?: boolean;
}): string {
  if (!step) {
    return `model primary=${primary}; queue active=0 queued=0 draining=no`;
  }
  const target = step.fallbackStepToModel ? ` -> ${step.fallbackStepToModel}` : "";
  const reason = step.fallbackStepFromFailureReason
    ? ` reason=${step.fallbackStepFromFailureReason}`
    : "";
  const detail = step.fallbackStepFromFailureDetail
    ? ` detail=${step.fallbackStepFromFailureDetail}`
    : "";
  const active = step.fallbackStepQueueActive ?? 0;
  const queued = step.fallbackStepQueueQueued ?? 0;
  const draining = step.fallbackStepQueueDraining === true ? "yes" : "no";
  return `model fallback: ${step.fallbackStepFromModel}${target}${reason} outcome=${step.fallbackStepFinalOutcome}${detail}; queue active=${active} queued=${queued} draining=${draining}`;
}

resetDetachedTaskLifecycleRuntimeForTests();
resetTaskRegistryForTests({ persist: false });
resetTaskFlowRegistryForTests({ persist: false });
resetCommandQueueStateForTest();

const task = createRunningTaskRun({
  runtime: "cron",
  ownerKey: "agent:main:main",
  scopeKind: "session",
  runId,
  task: "PR #87343 cron fallback progress proof",
  startedAt: Date.now(),
  progressSummary: formatProgressSummary(),
});

if (!task) {
  throw new Error("failed to create cron proof task run");
}

console.log(`[proof] stateDir=${stateDir}`);
console.log(`[proof] task created runtime=${task.runtime} runId=${task.runId}`);
console.log(`[proof] initial progressSummary=${task.progressSummary}`);

const activeTask = enqueueCommand(async () => {
  console.log(`[proof] active queue before fallback=${JSON.stringify(getCommandLaneSnapshot())}`);
  let embeddedFallbackContinuationObserved = false;
  const result = await runWithModelFallback({
    cfg,
    provider: "openai",
    model: "gpt-4.1-mini",
    manifestPlugins: [],
    skipAuthProfileRuntime: true,
    allowGatewayDrainingContinuation: true,
    onFallbackStep: (step) => {
      const progressSummary = formatProgressSummary(step);
      const updated = recordTaskRunProgressByRunId({
        runId,
        runtime: "cron",
        lastEventAt: Date.now(),
        progressSummary,
      });
      console.log(`[proof] fallback step=${JSON.stringify(step)}`);
      console.log(`[proof] recorded progressSummary=${updated.at(-1)?.progressSummary}`);
    },
    run: async (provider, model, options) => {
      console.log(
        `[proof] attempt provider=${provider} model=${model} allowGatewayDrainingContinuation=${options?.allowGatewayDrainingContinuation === true}`,
      );
      return enqueueCommandInLane(
        sessionLane,
        () =>
          enqueueCommandInLane(
            globalLane,
            async () => {
              if (provider === "openai") {
                markGatewayDraining();
                console.log("[proof] gateway drain marked while embedded queue work is active");
                throw new FailoverError("primary rate limited", {
                  reason: "rate_limit",
                  provider,
                  model,
                  status: 429,
                  code: "RESOURCE_EXHAUSTED",
                });
              }
              embeddedFallbackContinuationObserved =
                options?.allowGatewayDrainingContinuation === true;
              return "fallback ok";
            },
            {
              allowGatewayDrainingContinuation: options?.allowGatewayDrainingContinuation === true,
            },
          ),
        {
          allowGatewayDrainingContinuation: options?.allowGatewayDrainingContinuation === true,
        },
      );
    },
  });
  if (!embeddedFallbackContinuationObserved) {
    throw new Error("fallback attempt did not run as an embedded queue continuation");
  }
  console.log(`[proof] active task result=${result.provider}/${result.model}:${result.result}`);
  return result;
});

await activeTask;

try {
  await enqueueCommand(async () => "should not enqueue during drain");
  throw new Error("enqueue unexpectedly succeeded during gateway drain");
} catch (error) {
  if (!(error instanceof GatewayDrainingError)) {
    throw error;
  }
  console.log("[proof] new enqueue rejected with GatewayDrainingError");
}

const finalTask = findTaskByRunId(runId);
console.log(`[proof] final task progressSummary=${finalTask?.progressSummary}`);
console.log(
  "[proof] PASS embedded queue-shaped fallback continued during drain; new enqueue still rejected",
);
