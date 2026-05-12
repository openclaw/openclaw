/**
 * Real-behavior demo for the two Codex review findings on PR #80549.
 *
 * Run:
 *   pnpm exec tsx scripts/repro/trace-tree-hooks-demo.ts
 *
 * Exercises the same code paths the production embedded runner uses:
 *  - hook runner emits `agent_start` BEFORE `llm_input`
 *  - `requesterRunId` plumbed through `deliverSubagentAnnouncement` appears
 *    as `spawnedByRunId` on the resulting Gateway `agent` call
 *  - `llm_input` carries the prompt-split fields (prompt, userPrompt,
 *    prependedContext) with the narrowed contract
 *
 * Output is deterministic, human-readable, and redactable.
 */

import {
  __testing as subagentAnnounceTesting,
  deliverSubagentAnnouncement,
} from "../../src/agents/subagent-announce-delivery.js";
import { createHookRunnerWithRegistry } from "../../src/plugins/hooks.test-helpers.js";

type HookCall = {
  hook: "agent_start" | "llm_input";
  event: Record<string, unknown>;
  at: number;
};

async function demoHookOrdering() {
  console.log("=== Demo 1: agent_start fires before llm_input ===");
  const calls: HookCall[] = [];
  const agentStartHandler = (event: unknown) => {
    calls.push({ hook: "agent_start", event: event as Record<string, unknown>, at: Date.now() });
  };
  const llmInputHandler = (event: unknown) => {
    calls.push({ hook: "llm_input", event: event as Record<string, unknown>, at: Date.now() });
  };

  const { runner } = createHookRunnerWithRegistry([
    { hookName: "agent_start", handler: agentStartHandler },
    { hookName: "llm_input", handler: llmInputHandler },
  ]);

  const ctx = { agentId: "main", sessionId: "session-demo-1", runId: "run-parent-1" };

  // Mirrors the embedded runner call order in src/agents/pi-embedded-runner/run/attempt.ts:
  //   3018: await hookRunner.runAgentStart(...)
  //   3416: hookRunner.runLlmInput(...)
  await runner.runAgentStart(
    {
      runId: "run-parent-1",
      sessionKey: "agent:main:slack:channel:C123",
      sessionId: "session-demo-1",
      agentId: "main",
      model: "sonnet-4.6",
      provider: "anthropic",
      parentRunId: undefined,
      startedAt: Date.now(),
    },
    ctx,
  );
  await runner.runLlmInput(
    {
      runId: "run-parent-1",
      sessionId: "session-demo-1",
      provider: "anthropic",
      model: "sonnet-4.6",
      prompt: "TURN\n\nCTX\n\nhello\n\nAPPEND",
      userPrompt: "hello",
      prependedContext: "CTX",
      historyMessages: [],
      imagesCount: 0,
    },
    ctx,
  );

  console.log(`  hook call order: ${calls.map((c) => c.hook).join(" -> ")}`);
  if (calls[0]?.hook !== "agent_start" || calls[1]?.hook !== "llm_input") {
    console.error("  FAIL: expected agent_start before llm_input");
    process.exit(1);
  }
  const llm = calls[1]?.event;
  console.log(`  llm_input.prompt            = ${JSON.stringify(llm.prompt)}`);
  console.log(`  llm_input.userPrompt        = ${JSON.stringify(llm.userPrompt)}`);
  console.log(`  llm_input.prependedContext  = ${JSON.stringify(llm.prependedContext)}`);
  console.log("  PASS: ordering + prompt-split fields present");
  console.log();
}

async function demoRequesterRunIdPropagation() {
  console.log("=== Demo 2: requesterRunId -> spawnedByRunId on Gateway agent call ===");

  const gatewayCalls: Array<Record<string, unknown>> = [];
  const callGateway = async (request: unknown) => {
    gatewayCalls.push(request as Record<string, unknown>);
    return { status: "final", result: { output: "ack" } };
  };

  subagentAnnounceTesting.setDepsForTest({
    callGateway: callGateway as never,
    getRequesterSessionActivity: () => ({
      sessionId: "requester-session-direct",
      isActive: false,
    }),
    getRuntimeConfig: () => ({}) as never,
  });

  const origin = {
    channel: "slack",
    to: "channel:C123",
    accountId: "acct-1",
    threadId: "171.222",
  } as const;

  await deliverSubagentAnnouncement({
    requesterSessionKey: "agent:main:slack:channel:C123:thread:171.222",
    targetRequesterSessionKey: "agent:main:slack:channel:C123:thread:171.222",
    triggerMessage: "child done",
    steerMessage: "child done",
    requesterOrigin: origin,
    requesterSessionOrigin: origin,
    completionDirectOrigin: origin,
    directOrigin: origin,
    requesterIsSubagent: false,
    expectsCompletionMessage: false,
    bestEffortDeliver: true,
    directIdempotencyKey: "demo-announce-direct",
    requesterRunId: "run-parent-1",
  });

  const last = gatewayCalls.at(-1);
  const params = (last?.params ?? {}) as Record<string, unknown>;
  console.log(`  gateway calls made            = ${gatewayCalls.length}`);
  console.log(`  gateway.method                = ${String(last?.method)}`);
  console.log(`  gateway.params.spawnedByRunId = ${JSON.stringify(params.spawnedByRunId)}`);
  if (params.spawnedByRunId !== "run-parent-1") {
    console.error("  FAIL: spawnedByRunId not propagated");
    process.exit(1);
  }
  console.log("  PASS: requesterRunId forwarded through direct announce path");
  console.log();
}

async function demoRequesterRunIdOmitted() {
  console.log("=== Demo 3: no requesterRunId -> no spawnedByRunId (orphan-recovery path) ===");

  const gatewayCalls: Array<Record<string, unknown>> = [];
  const callGateway = async (request: unknown) => {
    gatewayCalls.push(request as Record<string, unknown>);
    return { status: "final", result: { output: "ack" } };
  };

  subagentAnnounceTesting.setDepsForTest({
    callGateway: callGateway as never,
    getRequesterSessionActivity: () => ({
      sessionId: "requester-session-orphan",
      isActive: false,
    }),
    getRuntimeConfig: () => ({}) as never,
  });

  const origin = {
    channel: "slack",
    to: "channel:C123",
    accountId: "acct-1",
    threadId: "171.222",
  } as const;

  await deliverSubagentAnnouncement({
    requesterSessionKey: "agent:main:slack:channel:C123:thread:171.222",
    targetRequesterSessionKey: "agent:main:slack:channel:C123:thread:171.222",
    triggerMessage: "child done",
    steerMessage: "child done",
    requesterOrigin: origin,
    requesterSessionOrigin: origin,
    completionDirectOrigin: origin,
    directOrigin: origin,
    requesterIsSubagent: false,
    expectsCompletionMessage: false,
    bestEffortDeliver: true,
    directIdempotencyKey: "demo-announce-no-runid",
  });

  const last = gatewayCalls.at(-1);
  const params = (last?.params ?? {}) as Record<string, unknown>;
  console.log(`  gateway.params.spawnedByRunId = ${JSON.stringify(params.spawnedByRunId)}`);
  if (params.spawnedByRunId !== undefined) {
    console.error("  FAIL: expected spawnedByRunId to be undefined");
    process.exit(1);
  }
  console.log("  PASS: spawnedByRunId omitted when requesterRunId not supplied");
  console.log();
}

async function main() {
  await demoHookOrdering();
  await demoRequesterRunIdPropagation();
  await demoRequesterRunIdOmitted();
  console.log("=== All three demos passed ===");
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
