import assert from "node:assert/strict";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { injectQaBusInboundMessage } from "../../qa-channel/api.js";
import { startQaBusServer } from "./bus-server.js";
import { waitForQaTransportCondition } from "./qa-transport.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { createScenarioChannel, dispatchScenarioFinal } from "./scenario-channel.test-support.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import { runQaSuiteScenarioSteps } from "./suite-runtime-flow.js";
import { waitForCompletedQaReply } from "./suite-runtime-transport.js";

const scenario = readQaScenarioById("remember-across-conversations");
const step = scenario.execution.flow!.steps[0]!;
const guarded = step.actions.find((action) => isRecord(action) && "try" in action);
assert.ok(isRecord(guarded) && isRecord(guarded.try) && Array.isArray(guarded.try.actions));
const actions: unknown[] = guarded.try.actions;
const recallStart = actions.findIndex(
  (action) => isRecord(action) && action.set === "requestCursorBeforeRecall",
);
const recallEnd = actions.findIndex((action) => isRecord(action) && "if" in action);
assert.ok(recallStart >= 0 && recallEnd > recallStart);

describe("memory scenario completed reply", () => {
  const channel = createScenarioChannel();
  const { state, transport, runtime } = channel;
  let bus: Awaited<ReturnType<typeof startQaBusServer>>;
  let running: ReturnType<typeof channel.start>;
  let observeAcknowledgment = (_cursor: number) => {};
  let observeCompletionRead = (_accountId: string | undefined, _cursor: number) => {};

  beforeAll(async () => {
    bus = await startQaBusServer({ state });
    const resolvePollCursor = state.resolvePollCursor.bind(state);
    vi.spyOn(state, "resolvePollCursor").mockImplementation((input) => {
      const cursor = resolvePollCursor(input);
      observeAcknowledgment(input?.acknowledgedCursor ?? 0);
      return cursor;
    });
    const getAcknowledgedPollCursor = state.getAcknowledgedPollCursor.bind(state);
    vi.spyOn(state, "getAcknowledgedPollCursor").mockImplementation((accountId) => {
      const cursor = getAcknowledgedPollCursor(accountId);
      observeCompletionRead(accountId, cursor);
      return cursor;
    });
    running = channel.start(bus.baseUrl);
    await running.ready;
  });

  afterAll(async () => {
    running.abort();
    await running.gateway;
    await bus.stop();
  });

  async function runRecall(finalText?: string, helperLeak?: "group" | "anchor") {
    state.reset();
    const previewSent = createDeferred<void>();
    const releaseFinal = createDeferred<void>();
    const acknowledged = createDeferred<void>();
    const waitingForCompletion = createDeferred<"waiting">();
    let inboundCursor = 0;
    observeAcknowledgment = (cursor) => {
      if (inboundCursor > 0 && cursor >= inboundCursor) {
        acknowledged.resolve();
      }
    };
    observeCompletionRead = (accountId, cursor) => {
      if (accountId === "default" && inboundCursor > 0 && cursor < inboundCursor) {
        waitingForCompletion.resolve("waiting");
      }
    };
    vi.mocked(
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    ).mockImplementationOnce(async ({ dispatcherOptions, replyOptions }) => {
      await replyOptions?.onPartialReply?.({ text: "You usually want" });
      previewSent.resolve();
      await releaseFinal.promise;
      return dispatchScenarioFinal(
        dispatcherOptions,
        finalText === undefined ? undefined : { text: finalText },
      );
    });
    const vars: Record<string, unknown> = {
      transcriptRoot: "/synthetic-memory-transcripts",
      sourceSession: { sessionId: "private-source-transcript" },
      targetSession: { sessionId: "anchor-transcript" },
      groupSession: { sessionId: "group-transcript" },
      initialSessionsVisibility: "tree",
    };
    const result = runScenarioFlow({
      scenarioTitle: scenario.title,
      flow: { steps: [{ name: step.name, actions: actions.slice(recallStart, recallEnd) }] },
      vars,
      api: {
        scenario,
        config: scenario.execution.config ?? {},
        state,
        path,
        env: { providerMode: "live-frontier" },
        waitForCompletedQaReply,
        transport: {
          accountId: transport.accountId,
          sendInbound: async (input: Parameters<typeof transport.sendInbound>[0]) => {
            const { message } = await injectQaBusInboundMessage({ baseUrl: bus.baseUrl, input });
            inboundCursor = state
              .getSnapshot()
              .events.findLast(
                (event) => event.kind === "inbound-message" && event.message.id === message.id,
              )!.cursor;
            return message;
          },
        },
        fs: {
          readdir: async () => ["recall.jsonl"],
          readFile: async () =>
            `memory_search\nprivate-source-transcript\n${helperLeak ? `${helperLeak}-transcript` : ""}`,
        },
        readConfigSnapshot: async () => ({
          config: { tools: { sessions: { visibility: "tree" } } },
        }),
        liveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
        waitForCondition: waitForQaTransportCondition,
        runScenario: runQaSuiteScenarioSteps,
      },
    });
    try {
      await previewSent.promise;
      expect(await Promise.race([waitingForCompletion.promise, result])).toBe("waiting");
      expect(state.getAcknowledgedPollCursor("default")).toBeLessThan(inboundCursor);
    } finally {
      releaseFinal.resolve();
      await acknowledged.promise;
      await result;
    }
    expect(vars.targetOutbound).toEqual(
      finalText === undefined ? undefined : expect.objectContaining({ text: finalText }),
    );
    return await result;
  }

  const preference = "lemon pepper wings with blue cheese";
  const missedPreference = "private target missed recalled preference";
  it.each([
    [preference, undefined, undefined],
    [undefined, undefined, "completed without a retained reply"],
    ["lemon pepper wings with ranch", undefined, missedPreference],
    [`${preference}; GROUP-ONLY loaded nachos with black olives`, undefined, missedPreference],
    [`${preference}; ANCHOR-ONLY pretzel bites test marker`, undefined, missedPreference],
    [preference, "group", "group transcript"],
    [preference, "anchor", "anchor transcript"],
  ] as const)(
    "waits for completion before validating final=%s and leak=%s",
    async (text, leak, failure) => {
      expect(await runRecall(text, leak)).toMatchObject(
        failure === undefined
          ? { status: "pass" }
          : { status: "fail", details: expect.stringContaining(failure) },
      );
    },
  );
});
