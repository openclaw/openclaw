/**
 * Synthetic controller-only custody measurement; no provider, database, or workspace I/O.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/steer-withdrawal-measure.ts
 *   --output <new-directory> --sessions 4096 [--baseline-dir <sparse-source-overlay>]
 * Alternate baseline/candidate processes. Repeat with --allocation for sampled allocation;
 * allocation-instrumented timings are diagnostic, separate from the uninstrumented gate.
 * --scenario send-now --action wait|send-now --iterations 100 --hold-ms 50 measures
 * a real Agent's held-tool boundary through the controller's indexed RPC source.
 * --scenario send-now-fallback uses the real timeout/withdrawal and follow-up queue owners.
 * Its 1ms delivery deadline accelerates the 120s default; --hold-ms bounds remaining work.
 * Use wait/wait unchanged runs as A/A controls, then interleave wait/send-now.
 * This owner workload has resident session shape, not a large physical database,
 * filesystem stress, WebSocket authorization, or an external provider.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    sessions: { type: "string", default: "4096" },
    "baseline-dir": { type: "string" },
    allocation: { type: "boolean", default: false },
    scenario: { type: "string", default: "withdrawal" },
    action: { type: "string", default: "wait" },
    iterations: { type: "string", default: "100" },
    "hold-ms": { type: "string", default: "50" },
    "cpu-profile": { type: "boolean", default: false },
  },
});
assert(values.output, "--output is required");
const collectGarbage = expectDefined(globalThis.gc, "Run with --expose-gc");
const sessions = Number(values.sessions);
assert(Number.isSafeInteger(sessions) && sessions > 0 && sessions % 2 === 0);
const output = path.resolve(values.output);
mkdirSync(output);
const configPath = path.join(output, "openclaw.json");
writeFileSync(configPath, JSON.stringify({ plugins: { enabled: false } }));
process.env = createGatewayBenchEnv(output, configPath, { startupTrace: false });
if (values["baseline-dir"]) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = path.resolve(values["baseline-dir"]);
  await import("./worker-retained-heap-preload.ts");
}
const fallback = values.scenario === "send-now-fallback";
const sendNow = values.scenario === "send-now" || fallback;
const sourceRoot = values["baseline-dir"] ?? fileURLToPath(new URL("../../", import.meta.url));
const sourceHashes = Object.fromEntries(
  [
    ...["steer", "mailbox-source", "message-injection-failure"].map(
      (owner) => `src/sessions/session-controller.${owner}.ts`,
    ),
    ...(fallback
      ? [
          "src/agents/embedded-agent-runner/run/attempt-queue-message.ts",
          "src/auto-reply/reply/queue/enqueue.ts",
        ]
      : []),
    ...(sendNow
      ? [
          "agent",
          "agent-loop",
          "agent-loop-tool-execution",
          "pending-message-queue",
          "tool-interruption",
        ].map((owner) => `packages/agent-core/src/${owner}.ts`)
      : []),
  ].map((owner) => [
    owner,
    createHash("sha256")
      .update(
        readFileSync(
          existsSync(path.join(sourceRoot, owner))
            ? path.join(sourceRoot, owner)
            : fileURLToPath(new URL(`../../${owner}`, import.meta.url)),
        ),
      )
      .digest("hex"),
  ]),
);
if (sendNow) {
  await measureSendNow();
} else {
  assert.equal(values.scenario, "withdrawal");
  await measureWithdrawal();
}

async function measureWithdrawal() {
  const { createReplyOperation } =
    await import("../../src/sessions/session-controller.operation.js");
  const { submitSessionControllerSteer } =
    await import("../../src/sessions/session-controller.steer.js");
  const {
    reserveSessionControllerSource,
    tryClaimSessionControllerTask,
    releaseSessionControllerClaim,
    retireSessionControllerInput,
  } = await import("../../src/sessions/session-controller.mailbox.js");
  const { MessageInjectionWithdrawnError } =
    await import("../../src/auto-reply/reply/message-injection-authority.js");
  const makeTurn = (index: number, prefix: string) => {
    const sessionKey = `agent:main:steer-measure-${prefix}-${index}`;
    const withdrawn = index % 2 === 0;
    const operation = createReplyOperation({
      sessionKey,
      sessionId: `${prefix}-${index}`,
      resetTriggered: false,
    });
    operation.setPhase("running");
    operation.attachBackend({
      kind: "embedded",
      runId: `synthetic-run-${prefix}-${index}`,
      cancel() {},
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        async queueMessage() {
          throw new Error("Expected asynchronous prepared injection");
        },
        async queueMessageAsync(_text, options, authority) {
          await authority.prepareCurrent();
          authority.assertCurrent();
          options?.onQueueAccepted?.(true);
          throw withdrawn
            ? new MessageInjectionWithdrawnError("synthetic exact withdrawal at delivery deadline")
            : new Error("synthetic ambiguous receipt after acceptance");
        },
      },
    });
    const input = reserveSessionControllerSource(sessionKey, { policy: { mode: "steer" } });
    return { operation, input, withdrawn };
  };
  function inject(turn: ReturnType<typeof makeTurn>) {
    return submitSessionControllerSteer({
      input: turn.input,
      text: "synthetic input",
      options: { waitForTranscriptCommit: true },
    });
  }
  async function finish(turn: ReturnType<typeof makeTurn>) {
    turn.operation.complete();
    const claim = tryClaimSessionControllerTask(turn.input);
    if (claim) {
      releaseSessionControllerClaim(claim);
      await claim.settlement.promise;
    }
    retireSessionControllerInput(turn.input);
    await turn.input.settlement.promise;
    return Boolean(claim);
  }
  for (let index = 0; index < 64; index++) {
    const turn = makeTurn(index, "warm");
    await inject(turn);
    await finish(turn);
  }
  const turns = Array.from({ length: sessions }, (_, index) => makeTurn(index, "measured"));
  collectGarbage();
  const inspector = values.allocation ? new Session() : undefined;
  if (inspector) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const latencyMs: number[] = [];
  const counts = { withdrawn: 0, withdrawnClaimable: 0, ambiguous: 0, ambiguousClaimable: 0 };
  const hostLoad = { before: loadavg(), after: [] as number[] };
  const cpu = process.cpuUsage();
  const started = performance.now();
  for (const turn of turns) {
    const start = performance.now();
    const result = await inject(turn);
    latencyMs.push(performance.now() - start);
    assert.equal(result.status, turn.withdrawn ? "rejected" : "indeterminate");
    if (turn.withdrawn) {
      counts.withdrawn++;
    } else {
      counts.ambiguous++;
    }
  }
  const elapsedMs = performance.now() - started;
  const usage = process.cpuUsage(cpu);
  hostLoad.after = loadavg();
  let sampledAllocatedBytes: number | undefined;
  if (inspector) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    inspector.disconnect();
    sampledAllocatedBytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
    writeFileSync(path.join(output, "allocation.heapprofile"), JSON.stringify(profile));
  }
  // Measure settlement alone; the repaired followup's extra execution is required work.
  for (const turn of turns) {
    const claimed = Number(await finish(turn));
    if (turn.withdrawn) {
      counts.withdrawnClaimable += claimed;
    } else {
      counts.ambiguousClaimable += claimed;
    }
  }
  latencyMs.sort((a, b) => a - b);
  const result = {
    node: process.version,
    sessions,
    allocation: values.allocation,
    sourceHashes,
    counts,
    elapsedMs,
    cpuMs: (usage.user + usage.system) / 1000,
    sampledAllocatedBytes,
    samplingInterval: values.allocation ? 32768 : undefined,
    p50Ms: latencyMs[Math.ceil(sessions * 0.5) - 1],
    p95Ms: latencyMs[Math.ceil(sessions * 0.95) - 1],
    maxMs: latencyMs.at(-1),
    hostLoad,
  };
  writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
}

async function measureSendNow() {
  assert(values.action === "wait" || values.action === "send-now");
  const iterations = Number(values.iterations);
  const holdMs = Number(values["hold-ms"]);
  assert(Number.isSafeInteger(iterations) && iterations > 0);
  assert(Number.isSafeInteger(holdMs) && holdMs > 0);
  const { createPendingSteerToolControl, steerActiveSessionWithOptionalDeliveryWait } =
    await import("../../src/agents/embedded-agent-runner/run/attempt-queue-message.js");
  const { setSteeringMessageIdentity } =
    await import("../../src/agents/sessions/steering-message-identity.js");
  const { registerQueuedUserMessageRetirement } =
    await import("../../src/agents/sessions/queued-user-message-retirement.js");
  const { enqueueFollowupRun } = await import("../../src/auto-reply/reply/queue/enqueue.js");
  const { Type } = await import("typebox");
  const { Agent } = await import("../../packages/agent-core/src/agent.js");
  const { createAssistantMessageEventStream } = await import("@openclaw/ai/event-stream");
  const { createAssistantOutput } =
    await import("../../packages/ai/src/transports/assistant-output.js");
  const { createDeferredCore } = await import("../../src/shared/deferred.js");
  const { createReplyOperation } =
    await import("../../src/sessions/session-controller.operation.js");
  const { beginSessionControllerSteer, sendSessionControllerSteerNow } =
    await import("../../src/sessions/session-controller.steer.js");
  const { captureReplyMessageInjectionTarget } =
    await import("../../src/sessions/session-controller.message-injection.js");
  const {
    reserveSessionControllerSource,
    retireSessionControllerInput,
    bindSessionControllerSource,
  } = await import("../../src/sessions/session-controller.mailbox.js");
  const { getRpcSourceForGateway, registerRpcSource } =
    await import("../../src/sessions/session-controller.rpc-sources.js");
  const model = {
    api: "synthetic-steer-bench",
    provider: "synthetic-steer-bench",
    id: "synthetic-steer-bench",
    name: "Synthetic steering boundary",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
  const residents = Array.from({ length: sessions }, (_, index) => {
    const runId = `resident-${index}`;
    const input = reserveSessionControllerSource(`agent:main:resident-${index}`, {
      policy: { mode: "steer" },
      protocolRunId: runId,
    });
    registerRpcSource(runId, { input, adapter: {} });
    return input;
  });
  const counts = {
    lookups: 0,
    interrupts: 0,
    interruptedResults: 0,
    consumed: 0,
    continued: 0,
    fallbackQueued: 0,
    followupTurns: 0,
  };
  async function run(index: number, measured: boolean) {
    const started = createDeferredCore();
    const consumed = createDeferredCore();
    const delivered = createDeferredCore();
    const message = { role: "user" as const, content: "Synthetic correction", timestamp: 2 };
    let requestCount = 0;
    let toolAborted = false;
    let providerAssertionError: unknown;
    const agent = new Agent({
      initialState: {
        model,
        tools: [
          {
            name: "held_tool",
            label: "held_tool",
            description: "Synthetic abort-aware tool with bounded cleanup",
            parameters: Type.Object({}),
            interruptible: true,
            execute: async (_id, _args, signal) => {
              await new Promise<void>((resolve) => {
                const timer = setTimeout(() => {
                  signal?.removeEventListener("abort", abort);
                  resolve();
                }, holdMs);
                const abort = () => {
                  clearTimeout(timer);
                  toolAborted = true;
                  resolve();
                };
                signal?.addEventListener("abort", abort, { once: true });
                started.resolve();
              });
              return {
                content: [{ type: "text" as const, text: "Synthetic tool settled" }],
                details: {},
              };
            },
          },
        ],
      },
      streamFn: (_model, context) => {
        requestCount++;
        if (requestCount === 2 || (fallback && requestCount === 3)) {
          try {
            assert.equal(
              context.messages.some(
                (entry) =>
                  entry.role === "user" &&
                  (entry.content === message.content ||
                    (Array.isArray(entry.content) &&
                      entry.content.some(
                        (block) => block.type === "text" && block.text === message.content,
                      ))),
              ),
              !fallback || toolAborted || requestCount === 3,
            );
            const result = context.messages.find((entry) => entry.role === "toolResult");
            assert(result?.role === "toolResult");
            assert.equal(result.isError, toolAborted);
            if (toolAborted && requestCount === 2) {
              assert.deepEqual(result.content, [
                { type: "text", text: "Synthetic tool settled" },
                { type: "text", text: "Interrupted by the user to send a pending message." },
              ]);
              if (measured) {
                counts.interruptedResults++;
              }
            }
          } catch (error) {
            providerAssertionError = error;
          }
        }
        const assistant = createAssistantOutput(model);
        assistant.content =
          requestCount === 1
            ? [{ type: "toolCall", id: `call-${index}`, name: "held_tool", arguments: {} }]
            : [{ type: "text", text: "Synthetic run continued" }];
        const reason = requestCount === 1 ? "toolUse" : "stop";
        assistant.stopReason = reason;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({
            type: "done",
            reason,
            message: assistant,
          });
          stream.end();
        });
        return stream;
      },
    });
    agent.subscribe((event) => {
      if (event.type === "message_end" && event.message === message) {
        consumed.resolve();
        delivered.resolve();
      }
    });
    const sessionKey = `agent:main:measured-${index}`;
    const runId = `measured-${index}`;
    const operation = createReplyOperation({ sessionKey, sessionId: runId, resetTriggered: false });
    operation.setPhase("running");
    const activeSession: Parameters<typeof steerActiveSessionWithOptionalDeliveryWait>[0] = {
      agent,
      steer: async (_text, _images, _recorder, _media, _order, identity) => {
        setSteeringMessageIdentity(message, identity);
        registerQueuedUserMessageRetirement(message, () => true);
        agent.steer(message);
      },
      subscribe: (listener) =>
        agent.subscribe((event) => {
          if (event.type !== "agent_end") {
            listener(event);
          }
        }),
    };
    let queueAttempts = 0;
    const queueMessage = async (
      _text: string,
      options?: import("../../src/sessions/session-controller.backend-contracts.js").ReplyBackendQueueMessageOptions,
    ) => {
      if (fallback) {
        await steerActiveSessionWithOptionalDeliveryWait(activeSession, message.content, {
          ...options,
          deliveryTimeoutMs: queueAttempts++ === 0 ? 1 : 120_000,
        });
        return;
      }
      agent.steer(message);
      options?.onQueueAccepted?.(true);
      await delivered.promise;
    };
    operation.attachBackend({
      kind: "embedded",
      runId,
      cancel: () => agent.abort(),
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        queueMessage,
        queueMessageAsync: async (text, options, authority) => {
          await authority.prepareCurrent();
          authority.assertCurrent();
          await queueMessage(text, options);
        },
        steerNow: fallback
          ? createPendingSteerToolControl({ agent }, () => !operation.result)
          : {
              read: () =>
                agent.hasPendingSteeringMessage((pending) => pending === message)
                  ? { status: "available", tools: ["held_tool"] }
                  : undefined,
              send: () => {
                if (!agent.hasPendingSteeringMessage((pending) => pending === message)) {
                  return { status: "settled", tools: [] };
                }
                const result = agent.interruptTools();
                return { status: result.status, tools: result.tools.map((tool) => tool.toolName) };
              },
            },
      },
    });
    const input = reserveSessionControllerSource(sessionKey, {
      policy: { mode: "steer" },
      protocolRunId: runId,
    });
    registerRpcSource(runId, { input, adapter: {} });
    const work = agent.prompt("Start the synthetic held tool");
    try {
      await started.promise;
      const target = captureReplyMessageInjectionTarget(operation);
      assert(target);
      const start = (assertCurrent?: () => void): ReturnType<typeof beginSessionControllerSteer> =>
        beginSessionControllerSteer({
          input,
          target,
          text: message.content,
          retry: start,
          retryWithdrawnSteer: assertCurrent !== undefined,
          options: { waitForTranscriptCommit: true, assertCurrent },
        });
      const attempt = await start();
      assert(attempt);
      assert(await attempt.acceptance);
      if (fallback) {
        assert.equal((await attempt.outcome).status, "rejected");
        assert(!agent.hasPendingSteeringMessage((pending) => pending === message));
        const followup = {
          prompt: message.content,
          enqueuedAt: Date.now(),
          run: {
            agentId: "main",
            agentDir: output,
            sessionId: runId,
            sessionFile: path.join(output, "synthetic.json"),
            workspaceDir: output,
            config: {},
            provider: model.provider,
            model: model.id,
            timeoutMs: 10000,
            blockReplyBreak: "text_end" as const,
          },
        };
        bindSessionControllerSource(input, followup);
        assert(
          enqueueFollowupRun(
            sessionKey,
            followup,
            { mode: "followup", debounceMs: 0 },
            "none",
            async () => {
              if (measured) {
                counts.followupTurns++;
              }
              await agent.prompt(message);
            },
          ),
        );
        if (measured) {
          counts.fallbackQueued++;
        }
      }
      const iterationCpu = process.cpuUsage();
      const before = performance.now();
      const selected = getRpcSourceForGateway(runId, undefined);
      assert.equal(selected?.input, input);
      if (measured) {
        counts.lookups++;
      }
      if (values.action === "send-now") {
        const result = await sendSessionControllerSteerNow(input);
        assert(["interrupted", ...(fallback ? ["settled"] : [])].includes(result.status));
        const repeated = await sendSessionControllerSteerNow(input);
        assert(repeated.status === result.status || repeated.status === "settled");
        if (measured && result.status === "interrupted") {
          counts.interrupts++;
        }
      }
      const effectMs = performance.now() - before;
      if (fallback && !toolAborted) {
        await work;
        operation.complete();
      }
      await consumed.promise;
      const settlementMs = performance.now() - before;
      if (!fallback) {
        assert.deepEqual(await attempt.outcome, { status: "accepted" });
      }
      await work;
      if (fallback) {
        await input.settlement.promise;
      }
      if (providerAssertionError) {
        throw new Error("Synthetic provider boundary assertion failed", {
          cause: providerAssertionError,
        });
      }
      const iterationUsage = process.cpuUsage(iterationCpu);
      if (!fallback) {
        assert.equal(toolAborted, values.action === "send-now");
      }
      assert.equal(agent.state.messages.filter((entry) => entry === message).length, 1);
      assert.equal(requestCount, fallback && !toolAborted ? 3 : 2);
      assert.equal(agent.signal?.aborted ?? false, false);
      const final = agent.state.messages.at(-1);
      assert(final?.role === "assistant");
      assert.deepEqual(final.content, [{ type: "text", text: "Synthetic run continued" }]);
      if (measured) {
        counts.consumed++;
        counts.continued++;
      }
      return {
        effectMs,
        settlementMs,
        cpuMs: (iterationUsage.user + iterationUsage.system) / 1000,
      };
    } finally {
      operation.complete();
      retireSessionControllerInput(input);
      await input.settlement.promise;
    }
  }
  for (let index = -10; index < 0; index++) {
    await run(index, false);
  }
  collectGarbage();
  const inspector = values.allocation || values["cpu-profile"] ? new Session() : undefined;
  inspector?.connect();
  if (values.allocation) {
    await inspector!.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  if (values["cpu-profile"]) {
    await inspector!.post("Profiler.enable");
    await inspector!.post("Profiler.start");
  }
  const hostLoad = { before: loadavg(), after: [] as number[] };
  const samples: Awaited<ReturnType<typeof run>>[] = [];
  const cpu = process.cpuUsage();
  const before = performance.now();
  for (let index = 0; index < iterations; index++) {
    samples.push(await run(index, true));
  }
  const elapsedMs = performance.now() - before;
  const usage = process.cpuUsage(cpu);
  hostLoad.after = loadavg();
  let sampledAllocatedBytes: number | undefined;
  if (values.allocation) {
    const { profile } = await inspector!.post("HeapProfiler.stopSampling");
    sampledAllocatedBytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
    writeFileSync(path.join(output, "allocation.heapprofile"), JSON.stringify(profile));
  }
  if (values["cpu-profile"]) {
    const { profile } = await inspector!.post("Profiler.stop");
    writeFileSync(path.join(output, "cpu.cpuprofile"), JSON.stringify(profile));
  }
  inspector?.disconnect();
  const distribution = (key: keyof (typeof samples)[number]) => {
    const sorted = samples.map((sample) => sample[key]).toSorted((a, b) => a - b);
    return {
      p50: sorted[Math.ceil(iterations * 0.5) - 1],
      p95: sorted[Math.ceil(iterations * 0.95) - 1],
      min: sorted[0],
      max: sorted.at(-1),
    };
  };
  const result = {
    scenario: values.scenario,
    action: values.action,
    node: process.version,
    residentSessions: sessions,
    iterations,
    holdMs,
    sourceHashes,
    allocation: values.allocation,
    cpuProfile: values["cpu-profile"],
    sampledAllocatedBytes,
    elapsedMs,
    cpuMs: (usage.user + usage.system) / 1000,
    counts,
    samples,
    effectMs: distribution("effectMs"),
    settlementMs: distribution("settlementMs"),
    actionThroughContinuationCpuMs: distribution("cpuMs"),
    hostLoad,
    limitations:
      "Controller/Agent owner only; synthetic provider; no durable transcript, WebSocket, database, workspace, or btrfs load.",
  };
  writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
  for (const input of residents) {
    retireSessionControllerInput(input);
  }
  await Promise.all(residents.map((input) => input.settlement.promise));
}
