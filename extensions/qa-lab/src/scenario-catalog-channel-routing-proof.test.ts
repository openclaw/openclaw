import { expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { runLoadedScenarioFlow } from "./scenario-flow-runner.test-support.js";
import { formatTransportTranscript, recentOutboundSummary } from "./suite-runtime-transport.js";

type ScenarioRoute = readonly [target: string, marker: string, leakedTarget: string];

type ChannelRoutingScenario = {
  scenarioId: string;
  routes: readonly ScenarioRoute[];
  expectedFailure: string;
};

type RouteLeak = "none" | "conversation" | "conversation-kind" | "account";
const transportApi = { formatTransportTranscript, recentOutboundSummary };

const routingScenarios = [
  {
    scenarioId: "channel-secondary-conversation-isolation",
    expectedFailure: "secondary conversation leaked into primary route",
    routes: [
      ["group:primary", "QA-PRIMARY-CONVERSATION-OK", "group:secondary"],
      ["group:secondary", "QA-SECONDARY-CONVERSATION-OK", "group:primary"],
    ],
  },
  {
    scenarioId: "channel-dm-group-routing",
    expectedFailure: "DM/group routes crossed",
    routes: [
      ["dm:qa-routing-dm", "QA-DM-ROUTING-OK", "group:qa-routing-group"],
      ["group:qa-routing-group", "QA-GROUP-ROUTING-OK", "dm:qa-routing-dm"],
    ],
  },
  {
    scenarioId: "channel-canary",
    expectedFailure: "expected one canary reply, saw 2",
    routes: [["group:qa-routing-primary", "QA-CHANNEL-CANARY-OK", "group:foreign"]],
  },
  {
    scenarioId: "dm-chat-baseline",
    expectedFailure: "expected exactly one DM baseline marker reply, saw 2",
    routes: [["dm:alice", "QA-DM-BASELINE-OK", "dm:mallory"]],
  },
  {
    scenarioId: "channel-chat-baseline",
    expectedFailure: "expected exactly one channel baseline marker reply, saw 2",
    routes: [["channel:qa-room", "QA-CHANNEL-BASELINE-OK", "dm:mallory"]],
  },
] as const satisfies readonly ChannelRoutingScenario[];

function runRoutingScenario(scenario: ChannelRoutingScenario, leak: RouteLeak) {
  return runLoadedScenarioFlow(scenario.scenarioId, {
    state: createQaBusState(),
    api: transportApi,
    onWaitForOutboundMessage: ({ waitCount, state }) => {
      const route = scenario.routes[waitCount - 1];
      if (!route) {
        throw new Error(`unexpected outbound wait ${waitCount}`);
      }
      const [target, marker, otherTarget] = route;
      const reply = { accountId: "qa-channel", to: target, text: marker };
      state.addOutboundMessage(reply);
      if (leak !== "none") {
        const leakedTarget =
          leak === "conversation"
            ? otherTarget
            : leak === "conversation-kind"
              ? `${target.startsWith("dm:") ? "group" : "dm"}:${target.split(":")[1]}`
              : target;
        state.addOutboundMessage({
          ...reply,
          accountId: leak === "account" ? "foreign-account" : "qa-channel",
          to: leakedTarget,
        });
      }
    },
  });
}

it.each(routingScenarios)(
  "accepts replies delivered only to their originating conversation in $scenarioId",
  async (scenario) => {
    await expect(runRoutingScenario(scenario, "none")).resolves.toMatchObject({ status: "pass" });
  },
);

it.each(routingScenarios)(
  "rejects and identifies replies leaked into another conversation in $scenarioId",
  async (scenario) => {
    const result = runRoutingScenario(scenario, "conversation");

    await expect(result).rejects.toThrow(scenario.expectedFailure);
    for (const route of scenario.routes) {
      await expect(result).rejects.toThrow(route[2].split(":")[1]);
    }
  },
);

it.each(
  routingScenarios
    .slice(0, 2)
    .flatMap((scenario) =>
      (["conversation-kind", "account"] as const).map((leak) => ({ scenario, leak })),
    ),
)("rejects a same-ID $leak route collision in $scenario.scenarioId", async ({ scenario, leak }) => {
  const result = runRoutingScenario(scenario, leak);
  const [target] = scenario.routes[0];
  const conversationId = target.split(":")[1];
  const expectedKind = target.startsWith("dm:") ? "direct" : "group";
  const leakedKind =
    leak === "conversation-kind" ? (expectedKind === "direct" ? "group" : "direct") : expectedKind;
  const leakedAccount = leak === "account" ? "foreign-account" : "qa-channel";

  await expect(result).rejects.toThrow(scenario.expectedFailure);
  await expect(result).rejects.toThrow(`qa-channel:${expectedKind}:${conversationId}:`);
  await expect(result).rejects.toThrow(`${leakedAccount}:${leakedKind}:${conversationId}:`);
});

it("reports the blocked actor reply instead of crashing while formatting its transcript", async () => {
  const result = runLoadedScenarioFlow("channel-multi-actor-ordering", {
    state: createQaBusState(),
    api: transportApi,
    onWaitForOutboundMessage: ({ state }) => {
      for (const text of ["QA-MULTI-ACTOR-ORDERING-OK", "QA-BLOCKED-ACTOR-SHOULD-NOT-REPLY"]) {
        state.addOutboundMessage({
          accountId: "qa-channel",
          to: "group:qa-routing-ordering",
          text,
        });
      }
    },
  });

  await expect(result).rejects.toThrow("blocked actor produced a reply");
  await expect(result).rejects.toThrow("QA-BLOCKED-ACTOR-SHOULD-NOT-REPLY");
});
