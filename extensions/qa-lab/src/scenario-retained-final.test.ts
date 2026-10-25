import { createServer } from "node:http";
import { buffer } from "node:stream/consumers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { injectQaBusInboundMessage, type QaBusOutboundMessageInput } from "../../qa-channel/api.js";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { closeQaHttpServer, dispatchQaHttpRequest, startQaBusServer } from "./bus-server.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { createScenarioChannel, dispatchScenarioFinal } from "./scenario-channel.test-support.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import { runQaSuiteScenarioSteps } from "./suite-runtime-flow.js";

type FinalFault =
  | "preview-only"
  | "failed-send"
  | "duplicate"
  | "typed-error"
  | Partial<QaBusOutboundMessageInput>;

async function startRetainedFinalScenario(fault: FinalFault = {}) {
  const previewOnly = fault === "preview-only";
  const scenario = readQaScenarioById("qa-channel-failed-tool-terminal-finalization");
  if (!scenario.execution.flow) {
    throw new Error("expected retained-final scenario flow");
  }
  const config = scenario.execution.config ?? {};
  const expectedReply = String(config.expectedReply);
  const channel = createScenarioChannel();
  const { state, transport, runtime } = channel;
  const bus = await startQaBusServer({ state });
  const startFinal = createDeferred<void>();
  const previewSent = createDeferred<void>();
  const deleteStarted = createDeferred<void>();
  const releaseDelete = createDeferred<void>();
  const finalStarted = createDeferred<void>();
  const releaseFinal = createDeferred<void>();
  const controlCompleted = createDeferred<void>();
  const waitObserved = createDeferred<void>();
  let nextCheck = createDeferred<void>();
  let deadlineExpired = false;
  let outboundRequests = 0;

  // Hold the real bus deletion/response gap independently from the final send.
  const proxy = createServer((req, res) => {
    dispatchQaHttpRequest(res, async () => {
      let body = (await buffer(req)).toString();
      const finalSend = req.url === "/v1/outbound/message" && ++outboundRequests > 1;
      if (finalSend) {
        finalStarted.resolve();
        await releaseFinal.promise;
        if (fault === "failed-send") {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "injected final send failure" }));
          return;
        }
        body = JSON.stringify({ ...JSON.parse(body), ...(typeof fault === "object" ? fault : {}) });
      }
      const forward = () =>
        fetch(`${bus.baseUrl}${req.url}`, {
          method: req.method,
          headers: { "content-type": "application/json" },
          body,
        });
      const response = await forward();
      const text = await response.text();
      if (req.url === "/v1/actions/delete") {
        deleteStarted.resolve();
        await releaseDelete.promise;
      }
      if (finalSend && fault === "duplicate") {
        await (await forward()).arrayBuffer();
      }
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(text);
    });
  });
  const baseUrl = `http://127.0.0.1:${await listenOnLoopback(proxy)}`;
  vi.mocked(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).mockImplementation(
    async ({ ctx, dispatcherOptions, replyOptions }) => {
      if (ctx.CommandTurn?.kind === "native") {
        controlCompleted.resolve();
        return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
      }
      await replyOptions?.onToolStart?.({ phase: "start", name: "exec" });
      await replyOptions?.onPartialReply?.({ text: expectedReply });
      previewSent.resolve();
      await startFinal.promise;
      return dispatchScenarioFinal(
        dispatcherOptions,
        previewOnly ? undefined : { text: expectedReply, isError: fault === "typed-error" },
      );
    },
  );
  const { gateway, ready: gatewayReady, abort } = channel.start(baseUrl);
  const gatewaySettled = gateway.then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );
  const vars: Record<string, unknown> = {};
  const waitForCondition: typeof transport.waitForCondition = (check, timeoutMs, intervalMs) =>
    transport.waitForCondition(
      async () => {
        if (deadlineExpired) {
          throw new Error("injected processing acknowledgment deadline");
        }
        const result = await check();
        waitObserved.resolve();
        nextCheck.resolve();
        return result;
      },
      timeoutMs,
      intervalMs,
    );
  const requests = [
    {
      allInputText: config.promptSnippet,
      plannedToolName: "read",
      plannedWireToolName: "exec",
      plannedToolCallId: "failed-exec",
    },
    {
      allInputText: config.promptSnippet,
      toolOutputCallId: "failed-exec",
      body: {
        input: [
          {
            type: "function_call",
            name: "exec",
            call_id: "failed-exec",
            arguments: 'await tools.read({path:"qa-failed-terminal-missing-file.txt"})',
          },
          { type: "function_call_output", call_id: "failed-exec", output: "ENOENT" },
        ],
        tools: [{ name: "exec" }, { name: "wait" }],
      },
    },
  ];
  const result = runScenarioFlow({
    scenarioTitle: scenario.title,
    flow: scenario.execution.flow,
    vars,
    api: {
      scenario,
      config,
      state,
      transport: {
        accountId: transport.accountId,
        sendInbound: async (input: Parameters<typeof transport.sendInbound>[0]) =>
          (await injectQaBusInboundMessage({ baseUrl, input })).message,
      },
      env: { providerMode: "mock-openai", mock: { baseUrl: "http://mock.invalid" } },
      reset: () => transport.reset(),
      waitForGatewayHealthy: () => gatewayReady,
      waitForQaChannelReady: () => gatewayReady,
      waitForCondition,
      fetchJson: async (url: string) => {
        if (url.endsWith("/debug/request-cursor")) {
          return { cursor: 0 };
        }
        // On old YAML this forces its verdict into the empty retained interval.
        if (!previewOnly) {
          await deleteStarted.promise;
        }
        return requests;
      },
      readSessionTranscriptSummary: async () => ({
        assistantToolCallCounts: { exec: 1 },
        completedToolCallCounts: { exec: 1 },
        successfulToolCallCounts: {},
      }),
      runScenario: runQaSuiteScenarioSteps,
    },
  });
  return {
    state,
    vars,
    result,
    acknowledgedCursor: () => state.getAcknowledgedPollCursor("default"),
    previewSent: Promise.race([
      previewSent.promise,
      result.then((outcome) => {
        throw new Error(`scenario ended before preview: ${outcome.details}`);
      }),
    ]),
    waitObserved: waitObserved.promise,
    startFinal: () => startFinal.resolve(),
    deleteStarted: deleteStarted.promise,
    releaseDelete: () => releaseDelete.resolve(),
    finalStarted: finalStarted.promise,
    releaseFinal: () => releaseFinal.resolve(),
    expireDeadline: () => {
      deadlineExpired = true;
    },
    async probePending() {
      nextCheck = createDeferred<void>();
      return await Promise.race([nextCheck.promise.then(() => undefined), result]);
    },
    async sendControl() {
      await injectQaBusInboundMessage({
        baseUrl,
        input: {
          conversation: { id: "control", kind: "direct" },
          senderId: "qa-driver",
          text: "/stop",
          nativeCommand: { name: "stop" },
        },
      });
      await controlCompleted.promise;
    },
    async [Symbol.asyncDispose]() {
      deadlineExpired = true;
      startFinal.resolve();
      releaseDelete.resolve();
      releaseFinal.resolve();
      await result;
      abort();
      const gatewayError = await gatewaySettled;
      await closeQaHttpServer(proxy);
      await bus.stop();
      if (gatewayError) {
        throw gatewayError;
      }
    },
  };
}

describe("failed-tool scenario retained final", () => {
  it("waits through preview deletion and final send until the exact inbound is acknowledged", async () => {
    await using harness = await startRetainedFinalScenario();
    await harness.previewSent;
    await harness.waitObserved;
    harness.startFinal();
    await harness.deleteStarted;
    expect(
      harness.state.getSnapshot().messages.filter((m) => m.direction === "outbound" && !m.deleted),
    ).toEqual([]);
    expect(harness.acknowledgedCursor()).toBe(0);
    expect(await harness.probePending()).toBeUndefined();
    harness.releaseDelete();
    await harness.finalStarted;
    expect(harness.acknowledgedCursor()).toBe(0);
    expect(await harness.probePending()).toBeUndefined();
    harness.releaseFinal();
    expect(await harness.result).toMatchObject({ status: "pass" });
    expect(harness.acknowledgedCursor()).toBeGreaterThanOrEqual(Number(harness.vars.inboundCursor));
    expect(harness.vars.reply).toMatchObject({
      text: "The requested file could not be read: ENOENT. QA-FAILED-TOOL-FINALIZED-OK",
    });
  });

  const missingReply = "expected exactly one failure-honest reply, got []";
  const wrongRoute = "retained reply has the wrong route";
  it.each<[string, FinalFault, string]>([
    ["preview-only with processing ack", "preview-only", missingReply],
    ["deleted preview without final", "failed-send", missingReply],
    ["duplicate retained final", "duplicate", "expected exactly one failure-honest reply"],
    [
      "typed error with matching text",
      "typed-error",
      "The requested file could not be read: ENOENT",
    ],
    ["wrong account", { accountId: "foreign" }, wrongRoute],
    ["wrong conversation", { to: "group:foreign" }, wrongRoute],
    ["wrong conversation kind", { to: "channel:qa-failed-terminal" }, wrongRoute],
    ["wrong thread", { threadId: "foreign" }, wrongRoute],
    ["wrong reply target", { replyToId: "foreign" }, wrongRoute],
  ])("rejects %s", async (_name, fault, error) => {
    await using harness = await startRetainedFinalScenario(fault);
    await harness.previewSent;
    await harness.waitObserved;
    harness.releaseDelete();
    harness.releaseFinal();
    harness.startFinal();
    expect(await harness.result).toMatchObject({
      status: "fail",
      details: expect.stringContaining(error),
    });
    if (fault !== "typed-error") {
      expect(harness.acknowledgedCursor()).toBeGreaterThanOrEqual(
        Number(harness.vars.inboundCursor),
      );
    }
    if (fault === "preview-only") {
      expect(
        harness.state.getSnapshot().messages.filter((message) => message.direction === "outbound"),
      ).toMatchObject([{ deleted: true }]);
    }
  });

  it("does not accept a later native control as the pending inbound's processing ack", async () => {
    await using harness = await startRetainedFinalScenario();
    await harness.previewSent;
    harness.startFinal();
    await harness.deleteStarted;
    await harness.sendControl();
    expect(harness.acknowledgedCursor()).toBe(0);
    expect(await harness.probePending()).toBeUndefined();
    harness.expireDeadline();
    expect(await harness.result).toMatchObject({
      status: "fail",
      details: "injected processing acknowledgment deadline",
    });
  });
});
