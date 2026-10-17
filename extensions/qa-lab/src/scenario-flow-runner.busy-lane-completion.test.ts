// Qa Lab plugin module implements busy-lane completion flow coverage.
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import type { QaSuiteStep } from "./suite-types.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const SCENARIO_ID = "subagent-completion-busy-lane-telegram-live";
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const NODE_EVAL_PREFIX = "node -e ";

type QaFlowApi = Parameters<typeof runScenarioFlow>[0]["api"];
type QaFlowScenario = ReturnType<typeof readQaScenarioById>;
type QaBusState = ReturnType<typeof createQaBusState>;
type QaBusMessage = ReturnType<QaBusState["getSnapshot"]>["messages"][number];
type QaToolEvent = { name: string; toolCallId: string; timestamp: number };

// The live scenario needs a Telegram lease a fork cannot obtain, so the flow is
// driven here through the production interpreter against a simulated requester
// and child. Both simulated requesters are legal models of a real one: the
// difference is only whether the completion the owner delivered is consumed.
type BusyLaneRequester =
  // Copies the token out of the delivered child completion, the only place it
  // exists.
  | "publishes-child-token"
  // Never consumes the steered payload. Publishes whatever completed marker its
  // own initiating prompt already contained, and invents one when it has none.
  | "replays-its-own-prompt";

// The scenario generates `node -e "<script>"`, and the script is the part under
// test, so it is evaluated here with injected filesystem, clock and timer seams
// rather than spawned. Spawning it and letting its real timers expire is what
// the repository test policy forbids, and it is also what would make this
// fixture depend on how the worker happens to be scheduled.
function runGeneratedNodeScript(command: string, deps: { cwd: string; now: () => number }) {
  if (!command.startsWith(NODE_EVAL_PREFIX)) {
    throw new Error(`generated command is no longer a node -e script: ${command.slice(0, 48)}`);
  }
  const source: unknown = JSON.parse(command.slice(NODE_EVAL_PREFIX.length));
  if (typeof source !== "string") {
    throw new Error("generated node -e payload was not a string");
  }
  const written: string[] = [];
  const pendingTimers: (() => void)[] = [];
  const resolveFile = (file: string) => path.join(deps.cwd, file);
  const scriptRequire = (specifier: string) => {
    if (specifier === "node:fs") {
      return {
        existsSync: (file: string) => existsSync(resolveFile(file)),
        writeFileSync: (file: string, contents: string) => {
          writeFileSync(resolveFile(file), contents);
        },
      };
    }
    if (specifier === "node:crypto") {
      return { randomUUID };
    }
    throw new Error(`generated script required an unexpected module: ${specifier}`);
  };
  const scriptProcess = {
    stdout: {
      write: (chunk: string) => {
        written.push(chunk);
      },
    },
    stderr: {
      write: (chunk: string) => {
        written.push(chunk);
      },
    },
    exit: (code: number) => {
      throw new Error(`generated script exited with ${code}: ${written.join("")}`);
    },
  };
  // Queued, never fired on a real clock. The caller releases a timer when the
  // moment it represents has arrived in the fixture's own ordering.
  const scriptSetTimeout = (callback: () => void) => {
    pendingTimers.push(callback);
    return 0;
  };
  runInNewContext(source, {
    require: scriptRequire,
    process: scriptProcess,
    setTimeout: scriptSetTimeout,
    Date: { now: deps.now },
  });
  return { output: written.join(""), pendingTimers };
}

// Puts the minted token back into the text the requester already received, which
// is the regression the scenario's own run-time assertion exists to catch.
function leakTokenIntoPrompt(flow: NonNullable<QaFlowScenario["execution"]["flow"]>) {
  const leaked = structuredClone(flow);
  const actions = leaked.steps[0]?.actions as Record<string, unknown>[] | undefined;
  const guardIndex = actions?.findIndex((action) => {
    const expr = (action as { assert?: { expr?: unknown } }).assert?.expr;
    return (
      typeof expr === "string" && expr.includes("!requesterInstruction.includes(childMintedToken)")
    );
  });
  if (!actions || guardIndex === undefined || guardIndex < 0) {
    throw new Error("scenario no longer asserts that the prompt withholds the child-minted token");
  }
  actions.splice(guardIndex, 0, {
    set: "requesterInstruction",
    value: { expr: "`${requesterInstruction} ${childMintedToken}`" },
  });
  return leaked;
}

async function runBusyLaneCompletionFlow(
  requester: BusyLaneRequester,
  options: { leakTokenIntoPrompt?: boolean } = {},
) {
  const tempDirs = createTempDirHarness();
  const workspaceDir = await tempDirs.makeTempDir("qa-busy-lane-completion-");
  try {
    const scenario = readQaScenarioById(SCENARIO_ID);
    const loadedFlow = scenario.execution.flow;
    if (!loadedFlow) {
      throw new Error(`scenario has no flow: ${SCENARIO_ID}`);
    }
    const flow = options.leakTokenIntoPrompt ? leakTokenIntoPrompt(loadedFlow) : loadedFlow;
    const scenarioConfig = (scenario.execution.config ?? {}) as Record<string, unknown>;
    const childResultPrefix = String(scenarioConfig.childResultPrefix);
    const childVisiblePrefix = String(scenarioConfig.childVisiblePrefix);
    // The durations below are only ever read as fixture numbers; nothing waits
    // for them, so their values cannot race the test worker.
    const config = { ...scenarioConfig, duplicateWindowMs: 0 };
    const vars: Record<string, unknown> = {};
    const state: QaBusState = createQaBusState();
    const requesterSessionKey = "agent:qa:busy-lane-requester";
    const childSessionKey = "agent:qa:busy-lane-child";
    let childRun: Record<string, unknown> | undefined;
    let parentToolEvents: QaToolEvent[] = [];
    let childFinalText = "";
    let replyAnchorLine: number | undefined;

    const sendInbound = async (input: Parameters<QaBusState["addInboundMessage"]>[0]) => {
      const inbound = state.addInboundMessage(input);
      // Requester-visible knowledge: only the instruction text it received.
      const instruction = input.text ?? "";
      // Harness-side knowledge: the commands and markers the scenario authored.
      const conversationId = input.conversation.id;
      // One clock reading, then pure arithmetic. Every ordering the scenario
      // asserts is therefore fixed here rather than observed.
      const base = Date.now();
      const holdStartedAt = base;
      const childEndedAt = base + 1_000;
      const holdFinishedAt = base + 2_000;
      const execResultAt = base + 3_000;
      const completionSendAt = base + 4_000;

      let holdClock = holdStartedAt;
      const hold = runGeneratedNodeScript(String(vars.holdCommand), {
        cwd: workspaceDir,
        now: () => holdClock,
      });
      if (hold.pendingTimers.length !== 1) {
        throw new Error(`hold command no longer defers its release: ${hold.pendingTimers.length}`);
      }
      const barrier = runGeneratedNodeScript(String(vars.barrierCommand), {
        cwd: workspaceDir,
        now: () => childEndedAt,
      });
      // The barrier observed the readiness marker on its first check and minted
      // synchronously, so there is no window it could have been delayed past.
      if (barrier.pendingTimers.length !== 0) {
        throw new Error("barrier command did not observe the hold on its first check");
      }
      // A child learns its terminal reply from the barrier it ran. Where the
      // barrier mints nothing, it can only echo the marker its task carried.
      const promptChildResult = instruction.match(
        new RegExp(`${childResultPrefix}:${UUID_PATTERN}`),
      )?.[0];
      const barrierLine = barrier.output.trim();
      childFinalText = barrierLine.startsWith(`${childResultPrefix}:`)
        ? barrierLine
        : (promptChildResult ?? barrierLine);

      // Release the hold only now, so the child's completion lands strictly
      // inside the interval the exec proof records.
      holdClock = holdFinishedAt;
      for (const release of hold.pendingTimers) {
        release();
      }
      // The scenario also compares the proof file's mtime, so pin it instead of
      // inheriting whatever the filesystem recorded for this write.
      const proofPath = path.join(workspaceDir, String(vars.proofFile));
      await fs.utimes(proofPath, new Date(holdFinishedAt), new Date(holdFinishedAt));

      childRun = {
        label: String(vars.childLabel),
        createdAt: base,
        requesterSessionKey,
        childSessionKey,
        execution: { endedAt: childEndedAt, status: "terminal", outcome: { status: "ok" } },
        delivery: { status: "delivered" },
      };

      const outbound = { accountId: "qa-channel", to: `dm:${conversationId}` };
      state.addOutboundMessage({ ...outbound, text: String(vars.parentMarker) });
      replyAnchorLine = 1;

      const promptVisible = instruction.match(
        new RegExp(`${childVisiblePrefix}:${UUID_PATTERN}`),
      )?.[0];
      const published =
        requester === "publishes-child-token"
          ? childFinalText.replace(`${childResultPrefix}:`, `${childVisiblePrefix}:`)
          : (promptVisible ?? `${childVisiblePrefix}:${randomUUID()}`);
      state.addOutboundMessage({ ...outbound, text: published });
      parentToolEvents = [
        { name: "sessions_spawn", toolCallId: "spawn-1", timestamp: base },
        { name: "exec", toolCallId: "exec-1", timestamp: execResultAt },
        { name: "message", toolCallId: "send-1", timestamp: completionSendAt },
      ];
      return inbound;
    };

    const readSessionTranscriptSummary = async (
      _env: unknown,
      sessionKey: string,
      summaryOptions?: { assistantReplyText?: string; afterEventCursor?: number },
    ) => {
      if (sessionKey === childSessionKey) {
        return { finalText: childFinalText, successfulToolCallCounts: { exec: 1 } };
      }
      if (typeof summaryOptions?.assistantReplyText === "string") {
        return replyAnchorLine === undefined ? {} : { assistantReplyStartLine: replyAnchorLine };
      }
      if (typeof summaryOptions?.afterEventCursor === "number") {
        // Only the completion send survives a cutoff at the committed reply.
        const sends = parentToolEvents.filter((event) => event.name === "message");
        return {
          successfulToolCallCounts: { message: sends.length },
          successfulToolCallEvents: sends,
          userMessageCount: 0,
        };
      }
      return {
        successfulToolCallCounts: Object.fromEntries(
          parentToolEvents.map((event) => [event.name, 1]),
        ),
        successfulToolCallEvents: parentToolEvents,
        userMessageCount: 1,
      };
    };

    // Every fact the flow waits for is in place before it waits, so one
    // evaluation is equivalent to the production poller without its real timer.
    const waitForCondition = async <T>(
      check: () => T | Promise<T | undefined> | undefined,
      timeoutMs: number,
    ) => {
      const value = await check();
      if (value === undefined) {
        throw new Error(`timed out after ${timeoutMs}ms waiting for a flow condition`);
      }
      return value;
    };

    // Mirrors the production waiter's selection — outbound only, sliced by
    // sinceIndex, same predicate — with only the retry loop removed.
    const waitForOutboundMessage = async (
      busState: QaBusState,
      predicate: (candidate: QaBusMessage) => boolean,
      timeoutMs: number,
      waitOptions?: { sinceIndex?: number },
    ) => {
      const match = busState
        .getSnapshot()
        .messages.filter((message) => message.direction === "outbound")
        .slice(waitOptions?.sinceIndex ?? 0)
        .find((message) => predicate(message));
      if (!match) {
        throw new Error(`timed out after ${timeoutMs}ms waiting for outbound marker`);
      }
      return match;
    };

    const api = {
      fs,
      path,
      randomUUID,
      scenario,
      state,
      config,
      env: { gateway: { workspaceDir } },
      transport: {
        accountId: "qa-channel",
        reset: async () => {
          state.reset();
        },
        sendInbound,
      },
      waitForGatewayHealthy: async () => undefined,
      waitForTransportReady: async () => undefined,
      liveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
      sleep: async () => undefined,
      waitForOutboundMessage,
      waitForCondition,
      readNativeQaSubagentRuns: async () => (childRun ? [childRun] : []),
      readSessionTranscriptSummary,
      runScenario: async (name: string, steps: QaSuiteStep[]) => {
        const stepResults: { name: string; status: "pass"; details?: string }[] = [];
        for (const step of steps) {
          const outcome = await step.run();
          stepResults.push({
            name: step.name,
            status: "pass",
            ...(outcome?.details === undefined ? {} : { details: outcome.details }),
          });
        }
        return { name, status: "pass" as const, steps: stepResults };
      },
    } as unknown as QaFlowApi;

    return await runScenarioFlow({ api, flow, scenarioTitle: scenario.title, vars });
  } finally {
    await tempDirs.cleanup();
  }
}

describe("busy-lane Telegram completion scenario flow", () => {
  it("accepts a requester that publishes the child-minted completion token", async () => {
    const result = await runBusyLaneCompletionFlow("publishes-child-token");
    expect(result.status).toBe("pass");
    const details = JSON.parse(result.steps[0]?.details ?? "{}");
    expect(details.verdict).toBe("PASS");
    // The delivered payload carried a value the child's own exec minted, so the
    // outbound assertion could not have been satisfied from the prompt.
    expect(details.childMintedToken).toMatch(new RegExp(`^${UUID_PATTERN}$`));
    expect(details.deferredCompletionCount).toBe(1);
  });

  it("rejects a requester that replays its own prompt instead of the delivered completion", async () => {
    // Same tool counts, same ordering, same duplicate window: the only thing
    // this requester lacks is the child's result.
    await expect(runBusyLaneCompletionFlow("replays-its-own-prompt")).rejects.toThrow(
      /timed out after \d+ms/,
    );
  });

  it("rejects a prompt that regains the child-minted token", async () => {
    // Ordering alone already keeps the payload out of the prompt, but a future
    // edit that puts it back must fail where the cause is legible rather than
    // restoring a pass that proves nothing.
    await expect(
      runBusyLaneCompletionFlow("publishes-child-token", { leakTokenIntoPrompt: true }),
    ).rejects.toThrow(/the initiating prompt carried the child-minted token/);
  });
});
