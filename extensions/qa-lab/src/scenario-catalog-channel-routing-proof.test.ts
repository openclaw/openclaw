import { describe, expect, it } from "vitest";
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

describe.each(routingScenarios)("$scenarioId", (scenario) => {
  it("accepts replies only in their originating conversation", async () => {
    await expect(runRoutingScenario(scenario, "none")).resolves.toMatchObject({ status: "pass" });
  });
  const leaks =
    scenario.routes.length > 1
      ? (["conversation", "conversation-kind", "account"] as const)
      : (["conversation"] as const);
  it.each(leaks)("rejects and identifies %s leakage", async (leak) => {
    const result = runRoutingScenario(scenario, leak);
    await expect(result).rejects.toThrow(scenario.expectedFailure);
    if (leak === "conversation") {
      for (const route of scenario.routes) {
        await expect(result).rejects.toThrow(route[2].split(":")[1]);
      }
    } else {
      const [target] = scenario.routes[0];
      const conversationId = target.split(":")[1];
      const kind = target.startsWith("dm:") ? "direct" : "group";
      const leakedKind =
        leak === "conversation-kind" ? (kind === "direct" ? "group" : "direct") : kind;
      const account = leak === "account" ? "foreign-account" : "qa-channel";
      await expect(result).rejects.toThrow(`qa-channel:${kind}:${conversationId}:`);
      await expect(result).rejects.toThrow(`${account}:${leakedKind}:${conversationId}:`);
    }
  });
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
