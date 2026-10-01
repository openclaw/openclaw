import path from "node:path";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import {
  createPluginRuntimeMock,
  createStartAccountContext,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createReplyDispatcher, settleReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { injectQaBusInboundMessage, qaChannelPlugin } from "../../qa-channel/api.js";
import { startQaBusServer } from "./bus-server.js";
import { createQaBusState } from "./bus-state.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import { runQaSuiteScenarioSteps } from "./suite-runtime-flow.js";
import { waitForCompletedQaReply } from "./suite-runtime-transport.js";

const scenario = readQaScenarioById("remember-across-conversations");
const config = scenario.execution.config ?? {};
const step = scenario.execution.flow!.steps[0]!;
const guarded = step.actions.find((action) => isRecord(action) && "try" in action);
if (!isRecord(guarded) || !isRecord(guarded.try) || !Array.isArray(guarded.try.actions)) {
  throw new Error("expected memory recall actions");
}
const actions: unknown[] = guarded.try.actions;
const recallStart = actions.findIndex(
  (action) => isRecord(action) && action.set === "requestCursorBeforeRecall",
);
const recallEnd = actions.findIndex((action) => isRecord(action) && "if" in action);
if (recallStart < 0 || recallEnd <= recallStart) {
  throw new Error("expected memory recall and evidence boundary");
}

describe("memory scenario completed reply", () => {
  const state = createQaBusState();
  const transport = createQaChannelTransport(state);
  const runtime = createPluginRuntimeMock({
    channel: { inbound: { buildContext: buildChannelInboundEventContext } },
  });
  const controller = new AbortController();
  let bus: Awaited<ReturnType<typeof startQaBusServer>>;
  let gateway: Promise<unknown>;
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
    const cfg = transport.createGatewayConfig({ baseUrl: bus.baseUrl });
    const ready = createDeferred<void>();
    const context = createStartAccountContext({
      account: qaChannelPlugin.config.resolveAccount(cfg, transport.accountId),
      cfg,
      abortSignal: controller.signal,
      statusPatchSink: (snapshot) => {
        if (snapshot.lifecycle === "ready") {
          ready.resolve();
        }
      },
    });
    const startAccount = qaChannelPlugin.gateway?.startAccount;
    if (!startAccount) {
      throw new Error("expected QA channel gateway entry point");
    }
    gateway = Promise.resolve(startAccount({ ...context, channelRuntime: runtime.channel }));
    await Promise.race([
      ready.promise,
      gateway.then(() => {
        throw new Error("QA channel stopped before ready");
      }),
    ]);
  });

  afterAll(async () => {
    controller.abort();
    await gateway;
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
    // Model execution is held; the real channel preview, dispatcher, HTTP bus,
    // and poller's processing acknowledgment establish completion independently.
    vi.mocked(
      runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher,
    ).mockImplementationOnce(async ({ dispatcherOptions, replyOptions }) => {
      await replyOptions?.onPartialReply?.({ text: "You usually want" });
      previewSent.resolve();
      await releaseFinal.promise;
      const dispatcher = createReplyDispatcher(dispatcherOptions);
      try {
        if (finalText !== undefined) {
          dispatcher.sendFinalReply({ text: finalText });
        }
      } finally {
        await settleReplyDispatcher({ dispatcher });
      }
      return { queuedFinal: finalText !== undefined, counts: dispatcher.getQueuedCounts() };
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
      // Execute the shipped recall selector and all its fact/source assertions.
      // Independent session seeding and config-toggle scenarios are live-suite proof.
      flow: { steps: [{ name: step.name, actions: actions.slice(recallStart, recallEnd) }] },
      vars,
      api: {
        scenario,
        config,
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
            ["memory_search", "private-source-transcript", helperLeak && `${helperLeak}-transcript`]
              .filter(Boolean)
              .join("\n"),
        },
        readConfigSnapshot: async () => ({
          config: { tools: { sessions: { visibility: "tree" } } },
        }),
        liveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
        waitForCondition: async <T>(check: () => T | Promise<T | undefined> | undefined) => {
          const value = await check();
          if (value === undefined) {
            throw new Error("expected helper transcript after completed recall");
          }
          return value;
        },
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
    if (finalText === undefined) {
      expect(vars.targetOutbound).toBeUndefined();
    } else {
      expect(vars.targetOutbound).toMatchObject({ text: finalText });
    }
    return await result;
  }

  it("reads the edited final only after the originating turn completes", async () => {
    expect(await runRecall("lemon pepper wings with blue cheese")).toMatchObject({
      status: "pass",
    });
  });

  it("rejects an acknowledged turn whose preview was removed without a retained reply", async () => {
    expect(await runRecall()).toMatchObject({
      status: "fail",
      details: expect.stringContaining("completed without a retained reply"),
    });
  });

  it.each([
    "lemon pepper wings with ranch",
    "lemon pepper wings with blue cheese; GROUP-ONLY loaded nachos with black olives",
    "lemon pepper wings with blue cheese; ANCHOR-ONLY pretzel bites test marker",
  ])("rejects the completed wrong or leaking preference: %s", async (text) => {
    expect(await runRecall(text)).toMatchObject({
      status: "fail",
      details: expect.stringContaining("private target missed recalled preference"),
    });
  });

  it.each(["group", "anchor"] as const)(
    "rejects completed recall with %s helper leakage",
    async (leak) => {
      expect(await runRecall("lemon pepper wings with blue cheese", leak)).toMatchObject({
        status: "fail",
        details: expect.stringContaining(`${leak} transcript`),
      });
    },
  );
});
