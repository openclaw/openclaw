import { readQaScenarioById } from "../../scenario-catalog.js";
import { requireFlowScenario } from "../../scenario-catalog.test-utils.js";
import { resolveLiveTransportQaScenarioIds } from "../shared/scenario-selection.js";
import type { SlackQaScenarioImplementation } from "./slack-live.contracts.js";
import * as slackScenarioImplementations from "./slack-live.scenario-implementations.js";

function toSlackScenarioExportName(id: string): string {
  const suffix = id
    .replace(/^slack-/, "")
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("");
  return `slackQa${suffix}Scenario`;
}

export function findScenario(ids?: string[]) {
  return resolveLiveTransportQaScenarioIds({
    channelId: "slack",
    providerMode: "live-frontier",
    scenarioIds: ids,
    supportsModuleFlows: true,
  }).map((id) => {
    const implementation = (
      slackScenarioImplementations as unknown as Record<string, SlackQaScenarioImplementation>
    )[toSlackScenarioExportName(id)];
    if (!implementation) {
      throw new Error(`missing Slack test implementation for ${id}`);
    }
    const scenario = requireFlowScenario(readQaScenarioById(id));
    return Object.assign({}, implementation, {
      id,
      timeoutMs: scenario.execution.timeoutMs ?? 60_000,
      title: scenario.title,
    });
  });
}
