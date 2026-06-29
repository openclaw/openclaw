// Qa Lab tests cover transport-backed scenario metadata.
import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import {
  assertQaTransportSupportsScenario,
  defineQaTransportScenario,
  filterQaTransportScenariosForTransport,
  findUnsupportedQaTransportScenarioRequirements,
  mergeQaTransportScenarioRequirements,
  qaTransportRequirementsForStandardScenario,
} from "./qa-transport-scenarios.js";
import type { QaTransportAdapter } from "./qa-transport.js";

type ScenarioTransportFixture = Pick<
  QaTransportAdapter,
  "capabilities" | "id" | "supportedActions"
>;

function createScenarioTransportFixture(
  supportedActions: QaTransportAdapter["supportedActions"],
): ScenarioTransportFixture {
  const transport = createQaChannelTransport(createQaBusState());
  return {
    capabilities: transport.capabilities,
    id: "crabline",
    supportedActions,
  };
}

describe("qa transport scenarios", () => {
  it("maps standard live transport buckets onto existing transport capabilities", () => {
    expect(qaTransportRequirementsForStandardScenario("canary")).toEqual({
      capabilities: ["assertNoFailureReplies", "sendInboundMessage", "waitForOutboundMessage"],
    });
    expect(qaTransportRequirementsForStandardScenario("restart-resume")).toEqual({
      capabilities: [
        "assertNoFailureReplies",
        "sendInboundMessage",
        "waitForOutboundMessage",
        "waitForReady",
      ],
    });
  });

  it("merges standard and explicit requirements without duplicating names", () => {
    const scenario = defineQaTransportScenario({
      id: "slack-thread-follow-up",
      standardId: "thread-follow-up",
      timeoutMs: 30_000,
      title: "Thread follow-up",
      transportRequirements: {
        actions: ["thread-create", "thread-create"],
        capabilities: ["waitForOutboundMessage", "waitForCondition"],
      },
    });

    expect(scenario.transportRequirements).toEqual({
      actions: ["thread-create"],
      capabilities: [
        "assertNoFailureReplies",
        "sendInboundMessage",
        "waitForOutboundMessage",
        "waitForCondition",
      ],
    });
  });

  it("can merge requirements independently for shared scenario builders", () => {
    expect(
      mergeQaTransportScenarioRequirements([
        { actions: ["react"], capabilities: ["sendInboundMessage"] },
        { actions: ["react", "delete"], capabilities: ["sendInboundMessage", "waitForReady"] },
      ]),
    ).toEqual({
      actions: ["react", "delete"],
      capabilities: ["sendInboundMessage", "waitForReady"],
    });
  });

  it("validates a scenario against a real qa-channel transport", () => {
    const transport = createQaChannelTransport(createQaBusState());
    const scenario = defineQaTransportScenario({
      id: "qa-channel-reaction",
      timeoutMs: 30_000,
      title: "Reaction action",
      transportRequirements: {
        actions: ["react"],
        capabilities: ["executeGenericAction", "waitForCondition"],
      },
    });

    expect(() => assertQaTransportSupportsScenario({ scenario, transport })).not.toThrow();
  });

  it("reports unsupported transport actions without executing the action", () => {
    const transport = createScenarioTransportFixture([]);
    const scenario = defineQaTransportScenario({
      id: "reaction-action",
      timeoutMs: 30_000,
      title: "Reaction action",
      transportRequirements: {
        actions: ["react"],
        capabilities: ["executeGenericAction"],
      },
    });

    expect(findUnsupportedQaTransportScenarioRequirements({ scenario, transport })).toEqual({
      actions: ["react"],
      capabilities: [],
    });
    expect(() => assertQaTransportSupportsScenario({ scenario, transport })).toThrow(
      "QA transport crabline cannot run scenario reaction-action; unsupported actions: react",
    );
  });

  it("filters scenarios by the supplied transport contract", () => {
    const transport = createScenarioTransportFixture([]);
    const canary = defineQaTransportScenario({
      id: "canary",
      standardId: "canary",
      timeoutMs: 30_000,
      title: "Canary",
    });
    const reaction = defineQaTransportScenario({
      id: "reaction",
      timeoutMs: 30_000,
      title: "Reaction",
      transportRequirements: { actions: ["react"] },
    });

    expect(
      filterQaTransportScenariosForTransport({
        scenarios: [canary, reaction],
        transport,
      }),
    ).toEqual([canary]);
  });
});
