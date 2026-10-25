import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { normalizeModelRef, splitModelRef } from "./model-switch.test-support.js";
import {
  addQaFlowTestOutbound,
  runLoadedScenarioFlow,
} from "./scenario-flow-runner.test-support.js";

function terminalReceipt(params: {
  runId: string;
  provider: string;
  model: string;
  responseModel?: string;
  rerouted?: boolean;
  effective?: { provider?: string; model?: string };
}) {
  const effective = {
    provider: params.effective?.provider ?? params.provider,
    model: params.effective?.model ?? params.model,
  };
  const responseModel = params.responseModel ?? effective.model;
  return {
    runId: params.runId,
    sessionId: "session-model-switch",
    turnId: `turn-${params.runId}`,
    requested: { provider: params.provider, model: params.model },
    effective: { ...effective, responseModel },
    successfulToolNames: [],
    rerouted:
      params.rerouted ?? (effective.provider !== params.provider || responseModel !== params.model),
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
  primaryRerouted?: boolean;
  primaryEffective?: { provider?: string; model?: string };
  alternateResponseModel?: string;
  alternateRerouted?: boolean;
  alternateEffective?: { provider?: string; model?: string };
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
      addQaFlowTestOutbound(
        state,
        "dm:qa-operator",
        call === 1
          ? (params?.primaryOutboundText ?? replyText)
          : (params?.alternateOutboundText ?? replyText),
      );
      if (call === 1 && params?.unrelatedPrimaryOutboundText) {
        addQaFlowTestOutbound(state, "dm:qa-operator", params.unrelatedPrimaryOutboundText);
      }
      if (call === 2 && params?.unrelatedLaterOutboundText) {
        addQaFlowTestOutbound(state, "dm:qa-operator", params.unrelatedLaterOutboundText);
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
            rerouted: call === 1 ? params?.primaryRerouted : params?.alternateRerouted,
            effective: call === 1 ? params?.primaryEffective : params?.alternateEffective,
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
      primaryResponseModel: "primary-model-concrete",
      primaryRerouted: false,
      alternateResponseModel: "alternate-model-concrete",
      alternateRerouted: false,
    });

    expect(result.status).toBe("pass");
    expect(runAgentPrompt.mock.calls[1]?.[1]).toMatchObject({
      provider: "openai",
      model: "alternate-model",
    });
    expect(result.modelSwitchEvidence).toMatchObject({
      primary: { runId: "run-1", effective: { responseModel: "primary-model-concrete" } },
      alternate: { runId: "run-2", effective: { responseModel: "alternate-model-concrete" } },
      terminalReply: {
        disposition: "visible",
        text: "the **model switch** handoff completed",
      },
      terminalDelivery: { status: "sent", resultCount: 1 },
    });
    expect(result.steps[0]?.details).toBe("hello **from the primary model**");
    expect(result.steps[1]?.details).toBe("the **model switch** handoff completed");
  });

  const receiptErrors = {
    default: "default-model run did not return an exact owned terminal receipt",
    alternate: "alternate-model run did not return distinct exact owned model evidence",
  } as const;
  const receiptOverrides = (
    run: keyof typeof receiptErrors,
    rerouted: boolean,
    effective?: { provider?: string; model?: string },
  ) =>
    run === "default"
      ? { primaryRerouted: rerouted, primaryEffective: effective }
      : { alternateRerouted: rerouted, alternateEffective: effective };

  it.each([
    { run: "default" as const, changed: "model", effective: { model: "fallback-model" } },
    { run: "default" as const, changed: "provider", effective: { provider: "fallback-provider" } },
    { run: "alternate" as const, changed: "model", effective: { model: "fallback-model" } },
    {
      run: "alternate" as const,
      changed: "provider",
      effective: { provider: "fallback-provider" },
    },
  ])(
    "requires a changed $run effective $changed to be marked rerouted",
    async ({ run, effective }) => {
      const { result } = await runFollowUp(receiptOverrides(run, true, effective));
      expect(result.status).toBe("pass");

      await expect(runFollowUp(receiptOverrides(run, false, effective))).rejects.toThrow(
        receiptErrors[run],
      );
    },
  );

  it.each(["default", "alternate"] as const)(
    "rejects an unchanged %s route reported as rerouted",
    async (run) => {
      await expect(runFollowUp(receiptOverrides(run, true))).rejects.toThrow(receiptErrors[run]);
    },
  );
});
