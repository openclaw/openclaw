import { describe, expect, it } from "vitest";
import { readQaScenarioPack } from "../scenario-catalog.js";
import * as discordScenarioRuntime from "./discord/scenario-runtime.js";
import * as slackScenarioRuntime from "./slack/scenario-runtime.js";
import * as whatsappScenarioRuntime from "./whatsapp/scenario-runtime.js";

const LANES = [
  {
    channel: "discord",
    modulePath: "./live-transports/discord/scenario-runtime.js",
    runtime: discordScenarioRuntime,
  },
  {
    channel: "slack",
    modulePath: "./live-transports/slack/scenario-runtime.js",
    runtime: slackScenarioRuntime,
  },
  {
    channel: "whatsapp",
    modulePath: "./live-transports/whatsapp/scenario-runtime.js",
    runtime: whatsappScenarioRuntime,
  },
] as const;

function readScenarioModuleCallName(flow: unknown) {
  return JSON.stringify(flow).match(/scenarioModule\.([A-Za-z0-9]+)/u)?.[1];
}

describe("live transport scenario module parity", () => {
  it.each(LANES)(
    "keeps $channel scenario definitions and runtime exports in one-to-one parity",
    ({ channel, modulePath, runtime }) => {
      const scenarios = readQaScenarioPack().scenarios.filter(
        (scenario) =>
          scenario.execution.kind === "flow" &&
          scenario.execution.channel === channel &&
          JSON.stringify(scenario.execution.flow).includes(modulePath),
      );
      const callNames = scenarios.map((scenario) => {
        const callName = readScenarioModuleCallName(scenario.execution.flow);
        expect(callName, scenario.id).toBeTypeOf("string");
        expect((runtime as Record<string, unknown>)[callName!], scenario.id).toBeTypeOf("function");
        return callName!;
      });

      expect(new Set(callNames).size).toBe(callNames.length);
      expect(callNames.toSorted()).toEqual(Object.keys(runtime).toSorted());
    },
  );
});
