import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

function splitModelRef(raw: string) {
  const [provider, ...model] = raw.split("/");
  return provider && model.length
    ? { provider: provider.toLowerCase(), model: model.join("/") }
    : null;
}

function normalizeModelRef(raw: string) {
  const split = splitModelRef(raw);
  if (!split) {
    return null;
  }
  return split.provider === "openai" && split.model.toLowerCase() === "alternate-alias"
    ? { provider: "openai", model: "alternate-model" }
    : split;
}

function terminalReceipt(params: {
  runId: string;
  provider: string;
  model: string;
  responseModel?: string;
}) {
  const responseModel = params.responseModel ?? params.model;
  return {
    runId: params.runId,
    sessionId: "session-model-switch",
    turnId: `turn-${params.runId}`,
    requested: { provider: params.provider, model: params.model },
    effective: { provider: params.provider, model: params.model, responseModel },
    successfulToolNames: [],
    rerouted: responseModel !== params.model,
    terminalDisposition: "visible",
  };
}

async function runFollowUp(params?: {
  alternateModel?: string;
  alternateReceiptRunId?: string;
  primaryReplyText?: string;
  primaryOutboundText?: string;
  primaryDelivery?: { status: string; resultCount: number } | null;
  alternateReplyText?: string;
  alternateOutboundText?: string;
  alternateDelivery?: { status: string; resultCount: number } | null;
  primaryResponseModel?: string;
  alternateResponseModel?: string;
  unrelatedPrimaryOutboundText?: string;
  unrelatedLaterOutboundText?: string;
  onRun?: () => void;
}) {
  const state = createQaBusState();
  let call = 0;
  const runAgentPrompt = vi.fn(
    async (_env: unknown, prompt: { provider?: string; model?: string; message: string }) => {
      params?.onRun?.();
      call += 1;
      const runId = `run-${call}`;
      const provider = prompt.provider ?? "openai";
      const model = prompt.model ?? "primary-model";
      const replyText =
        call === 1
          ? (params?.primaryReplyText ?? "hello from the primary model")
          : (params?.alternateReplyText ?? "the model switch handoff completed");
      state.addOutboundMessage({
        accountId: "qa-channel",
        to: "dm:qa-operator",
        text:
          call === 1
            ? (params?.primaryOutboundText ?? replyText)
            : (params?.alternateOutboundText ?? replyText),
      });
      if (call === 1 && params?.unrelatedPrimaryOutboundText) {
        state.addOutboundMessage({
          accountId: "qa-channel",
          to: "dm:qa-operator",
          text: params.unrelatedPrimaryOutboundText,
        });
      }
      if (call === 2 && params?.unrelatedLaterOutboundText) {
        state.addOutboundMessage({
          accountId: "qa-channel",
          to: "dm:qa-operator",
          text: params.unrelatedLaterOutboundText,
        });
      }
      const terminalDelivery = call === 1 ? params?.primaryDelivery : params?.alternateDelivery;
      return {
        started: { runId },
        waited: {
          status: "ok",
          ...(terminalDelivery === null
            ? {}
            : {
                terminalDelivery: terminalDelivery ?? { status: "sent", resultCount: 1 },
              }),
          terminalReply: { disposition: "visible", text: replyText },
          terminalReceipt: terminalReceipt({
            runId: call === 2 ? (params?.alternateReceiptRunId ?? runId) : runId,
            provider,
            model,
            responseModel:
              call === 1 ? params?.primaryResponseModel : params?.alternateResponseModel,
          }),
        },
      };
    },
  );
  const result = await runLoadedScenarioFlow("model-switch-follow-up", {
    state,
    api: {
      env: {
        providerMode: "mock-openai",
        primaryModel: "openai/primary-model",
        alternateModel: params?.alternateModel ?? "OPENAI/alternate-alias",
        gateway: {},
      },
      runAgentPrompt,
      splitModelRef,
      normalizeModelRef,
      normalizeLowercaseStringOrEmpty,
      resolveQaLiveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
    },
  });
  return { result, runAgentPrompt };
}

describe("model-switch follow-up terminal evidence", () => {
  it("invokes the canonical alias target and records exact run-owned evidence", async () => {
    const { result, runAgentPrompt } = await runFollowUp({
      primaryReplyText: "hello **from the primary model**",
      primaryOutboundText: "hello from the primary model",
      alternateReplyText: "the **model switch** handoff completed",
      alternateOutboundText: "the model switch handoff completed",
    });

    expect(result.status).toBe("pass");
    expect(runAgentPrompt.mock.calls[1]?.[1]).toMatchObject({
      provider: "openai",
      model: "alternate-model",
    });
    expect(result.modelSwitchEvidence).toMatchObject({
      primary: { runId: "run-1", effective: { responseModel: "primary-model" } },
      alternate: { runId: "run-2", effective: { responseModel: "alternate-model" } },
      terminalReply: {
        disposition: "visible",
        text: "the **model switch** handoff completed",
      },
      terminalDelivery: { status: "sent", resultCount: 1 },
    });
    expect(result.steps[0]?.details).toBe("hello **from the primary model**");
    expect(result.steps[1]?.details).toBe("the **model switch** handoff completed");
  });
});
