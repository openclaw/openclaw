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

type TurnFixture = {
  replyText?: string;
  outboundText?: string;
  responseModel?: string;
  rerouted?: boolean;
  effective?: { provider?: string; model?: string };
};

async function runFollowUp(params: { primary?: TurnFixture; alternate?: TurnFixture } = {}) {
  const state = createQaBusState();
  let call = 0;
  const runAgentPrompt = vi.fn(
    async (_env: unknown, prompt: { provider?: string; model?: string; message: string }) => {
      call += 1;
      const runId = `run-${call}`;
      const provider = prompt.provider ?? "openai";
      const model = prompt.model ?? "primary-model";
      const turn = (call === 1 ? params.primary : params.alternate) ?? {};
      const replyText =
        turn.replyText ??
        (call === 1 ? "hello from the primary model" : "the model switch handoff completed");
      state.addOutboundMessage({
        accountId: "qa-channel",
        to: "dm:qa-operator",
        text: turn.outboundText ?? replyText,
      });
      return {
        started: { runId },
        waited: {
          status: "ok",
          terminalDelivery: { status: "sent", resultCount: 1 },
          terminalReply: { disposition: "visible", text: replyText },
          terminalReceipt: terminalReceipt({
            runId,
            provider,
            model,
            ...turn,
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
        alternateModel: "OPENAI/alternate-alias",
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
      primary: {
        replyText: "hello **from the primary model**",
        outboundText: "hello from the primary model",
        responseModel: "primary-model-concrete",
        rerouted: false,
      },
      alternate: {
        replyText: "the **model switch** handoff completed",
        outboundText: "the model switch handoff completed",
        responseModel: "alternate-model-concrete",
        rerouted: false,
      },
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
      ? { primary: { rerouted, effective } }
      : { alternate: { rerouted, effective } };

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
