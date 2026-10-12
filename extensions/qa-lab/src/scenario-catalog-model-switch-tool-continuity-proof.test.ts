import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { hasModelSwitchContinuitySignal } from "./model-switch-eval.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { runQaSuiteScenarioSteps } from "./suite-runtime-flow.js";

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

async function runToolContinuity(
  alternateTools: string[],
  params?: {
    catchFailureResult?: boolean;
    primaryTools?: string[];
    primaryOutboundText?: string;
    primaryDelivery?: { status: string; resultCount: number } | null;
    alternateReplyText?: string;
    alternateOutboundText?: string;
    alternateDelivery?: { status: string; resultCount: number } | null;
    alternateResponseModel?: string;
    unrelatedPrimaryOutboundText?: string;
    unrelatedLaterOutboundText?: string;
  },
) {
  const state = createQaBusState();
  let call = 0;
  const runAgentPrompt = vi.fn(
    async (_env: unknown, prompt: { provider?: string; model?: string }) => {
      call += 1;
      const runId = `run-${call}`;
      const provider = prompt.provider ?? "openai";
      const model = prompt.model ?? "primary-model";
      const responseModel = call === 2 ? (params?.alternateResponseModel ?? model) : model;
      const replyText =
        call === 1
          ? "the QA scenario pack verifies source and docs"
          : (params?.alternateReplyText ??
            "the model handoff preserved the QA mission after rereading the scenario pack");
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
          terminalReceipt: {
            runId,
            sessionId: "session-tools",
            turnId: `turn-${call}`,
            requested: { provider, model },
            effective: { provider, model, responseModel },
            successfulToolNames: call === 1 ? (params?.primaryTools ?? ["read"]) : alternateTools,
            rerouted: responseModel !== model,
            terminalDisposition: "visible",
          },
        },
      };
    },
  );
  const result = await runLoadedScenarioFlow("model-switch-tool-continuity", {
    state,
    api: {
      env: {
        providerMode: "mock-openai",
        primaryModel: "openai/primary-model",
        alternateModel: "OPENAI/alternate-alias",
        gateway: {},
      },
      splitModelRef,
      normalizeModelRef,
      normalizeLowercaseStringOrEmpty,
      resolveQaLiveTurnTimeoutMs: (_env: unknown, timeoutMs: number) => timeoutMs,
      hasModelSwitchContinuitySignal,
      ...(params?.catchFailureResult ? { runScenario: runQaSuiteScenarioSteps } : {}),
      runAgentPrompt,
    },
  });
  return { result, runAgentPrompt };
}

describe("model-switch tool continuity terminal evidence", () => {
  it("invokes the canonical alias target and accepts run-owned delivery", async () => {
    const { result, runAgentPrompt } = await runToolContinuity(["read"], {
      alternateReplyText:
        "the **model handoff** preserved the QA mission after rereading the scenario pack",
      alternateOutboundText:
        "the model handoff preserved the QA mission after rereading the scenario pack",
    });

    expect(result.status).toBe("pass");
    expect(runAgentPrompt.mock.calls[1]?.[1]).toMatchObject({
      provider: "openai",
      model: "alternate-model",
    });
    expect(result.modelSwitchEvidence).toMatchObject({
      primary: { runId: "run-1", successfulToolNames: ["read"] },
      primaryDelivery: { status: "sent", resultCount: 1 },
      alternate: { runId: "run-2", successfulToolNames: ["read"] },
      terminalReply: {
        disposition: "visible",
        text: "the **model handoff** preserved the QA mission after rereading the scenario pack",
      },
      terminalDelivery: { status: "sent", resultCount: 1 },
    });
    expect(result.steps[0]?.details).toBe(
      "the **model handoff** preserved the QA mission after rereading the scenario pack",
    );
  });

  it("rejects unrelated later continuity text when the alternate reply lacks it", async () => {
    await expect(
      runToolContinuity(["read"], {
        alternateReplyText: "the alternate tool run completed",
        unrelatedLaterOutboundText:
          "the model handoff preserved the QA mission after rereading the scenario pack",
      }),
    ).rejects.toThrow("alternate-model terminal reply missed kickoff continuity");
  });
});
