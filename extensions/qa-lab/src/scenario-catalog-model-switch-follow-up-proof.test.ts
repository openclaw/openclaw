import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { describe, expect, it } from "vitest";
import { normalizeModelRef, splitModelRef } from "./model-switch.test-support.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";

type Turn = {
  reply: string;
  responseModel?: string;
  rerouted?: boolean;
  effective?: { provider?: string; model?: string };
};
async function runFollowUp(primary: Partial<Turn> = {}, alternate: Partial<Turn> = {}) {
  const turns: Turn[] = [
    { reply: "hello from the primary model", ...primary },
    { reply: "the model switch handoff completed", ...alternate },
  ];
  let call = 0;
  const runAgentPrompt = async (
    _env: unknown,
    prompt: { provider?: string; model?: string; message: string },
  ) => {
    call += 1;
    const runId = `run-${call}`;
    const provider = prompt.provider ?? "openai";
    const model = prompt.model ?? "primary-model";
    const turn = turns[call - 1]!;
    const effective = { provider, model, ...turn.effective };
    const responseModel = turn.responseModel ?? effective.model;
    return {
      started: { runId },
      waited: {
        status: "ok",
        terminalDelivery: { status: "sent", resultCount: 1 },
        terminalReply: { disposition: "visible", text: turn.reply },
        terminalReceipt: {
          runId,
          sessionId: "session-model-switch",
          turnId: `turn-${runId}`,
          requested: { provider, model },
          effective: { ...effective, responseModel },
          rerouted: turn.rerouted ?? (effective.provider !== provider || responseModel !== model),
          terminalDisposition: "visible",
        },
      },
    };
  };
  return runLoadedScenarioFlow("model-switch-follow-up", {
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
}

describe("model-switch follow-up terminal evidence", () => {
  it("invokes the canonical alias target and records exact run-owned evidence", async () => {
    const result = await runFollowUp(
      {
        reply: "hello **from the primary model**",
        responseModel: "primary-model-concrete",
        rerouted: false,
      },
      {
        reply: "the **model switch** handoff completed",
        responseModel: "alternate-model-concrete",
        rerouted: false,
      },
    );

    expect(result.status).toBe("pass");
    expect(result.modelSwitchEvidence).toMatchObject({
      primary: { runId: "run-1", effective: { responseModel: "primary-model-concrete" } },
      alternate: {
        runId: "run-2",
        requested: { provider: "openai", model: "alternate-model" },
        effective: { responseModel: "alternate-model-concrete" },
      },
    });
    expect(result.steps[0]?.details).toBe("hello **from the primary model**");
    expect(result.steps[1]?.details).toBe("the **model switch** handoff completed");
  });

  const receiptErrors = {
    default: "default-model run did not return an exact owned terminal receipt",
    alternate: "alternate-model run did not return distinct exact owned model evidence",
  } as const;
  const runWithReceipt = (
    run: keyof typeof receiptErrors,
    rerouted: boolean,
    effective?: { provider?: string; model?: string },
  ) =>
    run === "default"
      ? runFollowUp({ rerouted, effective })
      : runFollowUp({}, { rerouted, effective });

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
      const result = await runWithReceipt(run, true, effective);
      expect(result.status).toBe("pass");

      await expect(runWithReceipt(run, false, effective)).rejects.toThrow(receiptErrors[run]);
    },
  );

  it.each(["default", "alternate"] as const)(
    "rejects an unchanged %s route reported as rerouted",
    async (run) => {
      await expect(runWithReceipt(run, true)).rejects.toThrow(receiptErrors[run]);
    },
  );
});
