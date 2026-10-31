import type { ModelDecisionCapabilities } from "@openclaw/model-catalog-core/model-catalog-types";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DecisionProviderV1 } from "../decisions/provider-types.js";
import { registered } from "../decisions/runtime.test-support.js";
import type { DecisionBatch, ProviderDecisionOutcome } from "../decisions/types.js";
import {
  clearCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshotState,
} from "../plugins/current-plugin-metadata-state.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTools } from "./openclaw-tools.js";

const batch: DecisionBatch = {
  state: "Please refund this order.",
  questions: { refund: { type: "boolean" } },
};
const answer = {
  status: "ok",
  result: {
    model: "fixture-reported-model",
    answers: { refund: { type: "boolean", probabilityTrue: 0.947 } },
    usage: { inputTokens: 12 },
  },
} satisfies ProviderDecisionOutcome;
const config: OpenClawConfig = {
  agents: {
    defaults: { decisionModel: "fixture/default" },
    entries: {
      main: {},
      alternate: { decisionModel: "fixture/override" },
      disabled: { decisionModel: "" },
    },
  },
};

function fixture(evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer)) {
  registered(evaluate);
  setRuntimeConfigSnapshot(config);
  return evaluate;
}

function assembled(agentId = "main", cfg = config) {
  return createOpenClawTools({
    config: cfg,
    agentSessionKey: `agent:${agentId}:main`,
    disablePluginTools: true,
    disableMessageTool: true,
    wrapBeforeToolCallHook: false,
  }).find((tool) => tool.name === "decision_evaluate");
}
function requiredTool(agentId = "main", cfg = config) {
  return expectDefined(assembled(agentId, cfg), "decision_evaluate was not assembled");
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
  clearCurrentPluginMetadataSnapshot();
});

it("keeps the explicit tool independent of automatic eligibility through Labs on/off transitions", async () => {
  const evaluate = fixture();
  const retained = requiredTool("alternate");
  const expectSelection = (agentId: string, model: string) =>
    expect(evaluate).toHaveBeenLastCalledWith(batch, expect.objectContaining({ agentId, model }));
  for (const decisionAssistance of [false, true, false]) {
    const current: OpenClawConfig = {
      ...config,
      agents: {
        ...config.agents,
        defaults: { ...config.agents!.defaults, experimental: { decisionAssistance } },
      },
    };
    setRuntimeConfigSnapshot(current);
    evaluate.mockClear();
    expect(assembled("disabled", current)).toBeUndefined();
    const fresh = requiredTool("main", current);
    expect(evaluate).not.toHaveBeenCalled();
    expect((await fresh.execute("fresh", batch)).details).toMatchObject({ status: "ok" });
    expectSelection("main", "default");
    expect((await retained.execute("retained", batch)).details).toMatchObject({ status: "ok" });
    expectSelection("alternate", "override");
    expect(evaluate).toHaveBeenCalledTimes(2);
  }
});

it("rejects resource bounds before rubric hashing or provider execution", async () => {
  const evaluate = fixture();
  const decision = {
    protocol: "decision-v1",
    input: ["text"],
    limits: { maxQuestions: 99 },
    questions: {
      boolean: { probabilities: "boolean", abstention: false },
      choice: { probabilities: "provider-defined", abstention: false },
      score: { probabilities: "provider-defined", abstention: false },
    },
  } satisfies ModelDecisionCapabilities;
  const model = { id: "default", name: "Fixture", inference: { chat: false, decision } };
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "owner",
        contracts: { decisionProviders: ["fixture"] },
        modelCatalog: { providers: { fixture: { models: [model] } } },
      },
    ],
  });
  setCurrentPluginMetadataSnapshotState(snapshot, undefined, undefined, undefined, "gateway");
  const tool = requiredTool("main", {
    ...config,
    agents: { defaults: { decisionModel: "fixture/default@synthetic-profile" } },
  });
  expect(tool.description).toContain("at most 99 questions");
  setRuntimeConfigSnapshot({ agents: { defaults: { decisionModel: "fixture/reconfigured" } } });
  let nested: unknown = "private evidence";
  for (let depth = 0; depth < 10000; depth++) {
    nested = { child: nested };
  }
  for (const input of [
    { state: null, questions: { q: { type: "boolean", instructions: nested } } },
    { state: "x".repeat(1_048_577), questions: { q: { type: "boolean" } } },
    {
      state: null,
      questions: Object.fromEntries(
        Array.from({ length: 257 }, (_, index) => [String(index), { type: "boolean" }]),
      ),
    },
  ]) {
    const result = await tool.execute("bounded", input);
    expect(result.details).toMatchObject({
      status: "unavailable",
      reason: "unsupported-input",
      guidance: expect.stringContaining("Host bounds"),
    });
    expect(JSON.stringify(result)).not.toMatch(/private evidence|at most 99 questions/);
  }
  expect(evaluate).not.toHaveBeenCalled();
});
it("rejects malformed or routing arguments without echoing evidence", async () => {
  const evaluate = fixture();
  await expect(requiredTool().execute("call", { ...batch, agentId: "disabled" })).rejects.toThrow(
    "no evidence was sent",
  );
  expect(evaluate).not.toHaveBeenCalled();
});

it("propagates caller cancellation before and during provider work", async () => {
  const cancellation = new Error("caller cancelled");
  const entered = createDeferredCore();
  const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async (_batch, context) => {
    entered.resolve();
    return await new Promise((_resolve, reject) => {
      context.signal.addEventListener("abort", () => reject(cancellation), { once: true });
    });
  });
  fixture(evaluate);
  const tool = requiredTool();
  await expect(tool.execute("before", batch, AbortSignal.abort(cancellation))).rejects.toThrow(
    "caller cancelled",
  );
  expect(evaluate).not.toHaveBeenCalled();
  const controller = new AbortController();
  const pending = tool.execute("during", batch, controller.signal);
  const rejection = expect(pending).rejects.toThrow("caller cancelled");
  await entered.promise;
  controller.abort(cancellation);
  await rejection;
});
