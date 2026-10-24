import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { hasModelSwitchContinuitySignal } from "./model-switch-eval.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

const continuity = "the model handoff preserved the QA mission after rereading the scenario pack";
const richContinuity = continuity.replace("model handoff", "**model handoff**");
const readError = "alternate-model run did not return exact owned successful read evidence";

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
  params: {
    reply?: string;
    outbound?: string;
    responseModel?: string;
    rerouted?: boolean;
    effective?: { provider?: string; model?: string };
    laterText?: string;
  } = {},
) {
  const state = createQaBusState();
  const send = (text: string) =>
    state.addOutboundMessage({ accountId: "qa-channel", to: "dm:qa-operator", text });
  let call = 0;
  const runAgentPrompt = vi.fn(
    async (_env: unknown, prompt: { provider?: string; model?: string }) => {
      call += 1;
      const alternate: typeof params = call === 2 ? params : {};
      const runId = `run-${call}`;
      const { provider = "openai", model = "primary-model" } = prompt;
      const effective = { provider, model, ...alternate.effective };
      const responseModel = alternate.responseModel ?? effective.model;
      const replyText =
        call === 1
          ? "the QA scenario pack verifies source and docs"
          : (alternate.reply ?? continuity);
      send(alternate.outbound ?? replyText);
      if (alternate.laterText) {
        send(alternate.laterText);
      }
      return {
        started: { runId },
        waited: {
          status: "ok",
          terminalDelivery: { status: "sent", resultCount: 1 },
          terminalReply: { disposition: "visible", text: replyText },
          terminalReceipt: {
            runId,
            sessionId: "session-tools",
            turnId: `turn-${call}`,
            requested: { provider, model },
            effective: { ...effective, responseModel },
            successfulToolNames: ["read"],
            rerouted:
              alternate.rerouted ?? (effective.provider !== provider || responseModel !== model),
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
      runAgentPrompt,
    },
  });
  return { result, runAgentPrompt };
}

describe("model-switch tool continuity terminal evidence", () => {
  it("invokes the canonical alias target and accepts run-owned delivery", async () => {
    const { result, runAgentPrompt } = await runToolContinuity({
      reply: richContinuity,
      outbound: continuity,
      responseModel: "alternate-model-concrete",
      rerouted: false,
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
      terminalReply: { disposition: "visible", text: richContinuity },
      terminalDelivery: { status: "sent", resultCount: 1 },
    });
    expect(result.steps[0]?.details).toBe(richContinuity);
  });

  it.each([
    { changed: "model", effective: { model: "fallback-model" } },
    { changed: "provider", effective: { provider: "fallback-provider" } },
  ])("requires changed $changed to be marked rerouted", async ({ effective }) => {
    const { result } = await runToolContinuity({ effective, rerouted: true });
    expect(result.status).toBe("pass");

    await expect(runToolContinuity({ effective, rerouted: false })).rejects.toThrow(readError);
  });

  it("rejects an unchanged alternate route reported as rerouted", async () => {
    await expect(runToolContinuity({ rerouted: true })).rejects.toThrow(readError);
  });

  it("rejects unrelated later continuity text when the alternate reply lacks it", async () => {
    await expect(
      runToolContinuity({
        reply: "the alternate tool run completed",
        laterText: continuity,
      }),
    ).rejects.toThrow("alternate-model terminal reply missed kickoff continuity");
  });
});
