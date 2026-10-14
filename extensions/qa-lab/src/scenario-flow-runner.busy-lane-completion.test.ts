// Qa Lab plugin module implements busy-lane completion flow coverage.
import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import { waitForOutboundMessage } from "./suite-runtime-transport.js";
import type { QaSuiteStep } from "./suite-types.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const SCENARIO_ID = "subagent-completion-busy-lane-telegram-live";
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const execAsync = promisify(exec);

type QaFlowApi = Parameters<typeof runScenarioFlow>[0]["api"];
type QaFlowScenario = ReturnType<typeof readQaScenarioById>;
type QaBusState = ReturnType<typeof createQaBusState>;
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
    // Real hold and barrier commands, real child processes, compressed windows.
    const config = {
      ...scenarioConfig,
      holdMs: 800,
      execYieldMs: 5_000,
      barrierTimeoutMs: 5_000,
      duplicateWindowMs: 0,
    };
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
      const createdAt = Date.now();

      const holdPending = execAsync(String(vars.holdCommand), { cwd: workspaceDir });
      const barrierStdout = (
        await execAsync(String(vars.barrierCommand), { cwd: workspaceDir })
      ).stdout.trim();
      const childEndedAt = Date.now();
      // A child learns its terminal reply from the barrier it ran. Where the
      // barrier mints nothing, it can only echo the marker its task carried.
      const promptChildResult = instruction.match(
        new RegExp(`${childResultPrefix}:${UUID_PATTERN}`),
      )?.[0];
      childFinalText = barrierStdout.startsWith(`${childResultPrefix}:`)
        ? barrierStdout
        : (promptChildResult ?? barrierStdout);
      await holdPending;
      const execResultAt = Date.now();

      childRun = {
        label: String(vars.childLabel),
        createdAt,
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
        { name: "sessions_spawn", toolCallId: "spawn-1", timestamp: createdAt },
        { name: "exec", toolCallId: "exec-1", timestamp: execResultAt },
        { name: "message", toolCallId: "send-1", timestamp: Date.now() },
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

    const waitForCondition = async <T>(
      check: () => T | Promise<T | undefined> | undefined,
      timeoutMs: number,
    ) => {
      const startedAt = Date.now();
      for (;;) {
        const value = await check();
        if (value !== undefined) {
          return value;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          throw new Error(`timed out after ${timeoutMs}ms waiting for a flow condition`);
        }
        await sleep(25);
      }
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
      // Keep a genuinely unsatisfiable wait short without weakening it.
      liveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => Math.min(timeoutMs, 1_500),
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
