// Qa Lab plugin module plans bounded CI smoke shards.
import { OPENCLAW_CRABLINE_DEFAULT_CHANNEL } from "@openclaw/crabline";
import { defaultQaModelForMode, normalizeQaProviderMode } from "./model-selection.js";
import { readQaScenarioPack, type QaSeedScenarioWithSource } from "./scenario-catalog.js";
import { readQaScorecardTaxonomyReport } from "./scorecard-taxonomy.js";
import {
  scenarioMatchesQaProviderLane,
  scenarioRequiresIsolatedQaSuiteWorker,
} from "./suite-planning.js";

const QA_SMOKE_PROFILE = "smoke-ci";
const QA_SMOKE_DEFAULT_CHANNEL_SHARDS = 2;
const QA_SMOKE_MAX_SHARDS = 8;

export type QaSmokeCiShard = {
  name: string;
  slug: string;
  channel: string;
  scenario_ids: string[];
};

function scenarioWeight(scenario: QaSeedScenarioWithSource): number {
  if (scenario.execution.kind === "script") {
    return 8;
  }
  if (scenario.execution.kind === "playwright") {
    return 6;
  }
  if (scenario.execution.kind === "vitest") {
    return 4;
  }
  return scenarioRequiresIsolatedQaSuiteWorker(scenario) ? 3 : 1;
}

function splitBalanced(
  scenarios: readonly QaSeedScenarioWithSource[],
  shardCount: number,
): QaSeedScenarioWithSource[][] {
  const shards = Array.from({ length: shardCount }, () => ({ scenarios: [], weight: 0 })) as Array<{
    scenarios: QaSeedScenarioWithSource[];
    weight: number;
  }>;
  const sortedScenarios = [...scenarios].toSorted(
    (left, right) =>
      scenarioWeight(right) - scenarioWeight(left) || left.id.localeCompare(right.id),
  );
  for (const scenario of sortedScenarios) {
    const target = shards.toSorted(
      (left, right) => left.weight - right.weight || left.scenarios.length - right.scenarios.length,
    )[0];
    target.scenarios.push(scenario);
    target.weight += scenarioWeight(scenario);
  }
  return shards.map((shard) =>
    shard.scenarios.toSorted((left, right) => left.id.localeCompare(right.id)),
  );
}

function slugifyChannel(channel: string): string {
  return channel.replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "");
}

export function createQaSmokeCiMatrix(): { include: QaSmokeCiShard[] } {
  const scenarioPack = readQaScenarioPack();
  const scorecardReport = readQaScorecardTaxonomyReport(scenarioPack.scenarios);
  const profile = scorecardReport.profiles.find((entry) => entry.id === QA_SMOKE_PROFILE);
  if (!profile) {
    throw new Error(`taxonomy.yaml does not define QA run profile ${QA_SMOKE_PROFILE}.`);
  }
  const categoryScenarioRefs = new Set(
    scorecardReport.categories
      .filter((category) => category.profiles.includes(QA_SMOKE_PROFILE))
      .flatMap((category) => category.scenarioRefs),
  );
  const providerMode = normalizeQaProviderMode("mock-openai");
  const primaryModel = defaultQaModelForMode(providerMode);
  const scenarios = scenarioPack.scenarios.filter(
    (scenario) =>
      categoryScenarioRefs.has(scenario.sourcePath) &&
      scenarioMatchesQaProviderLane({
        scenario,
        providerMode,
        primaryModel,
        channelDriver: profile.channelDriver,
      }),
  );
  if (scenarios.length === 0) {
    throw new Error(`${QA_SMOKE_PROFILE} did not resolve any executable QA scenarios.`);
  }

  const scenariosByChannel = new Map<string, QaSeedScenarioWithSource[]>();
  for (const scenario of scenarios) {
    const channel = scenario.execution.channel ?? OPENCLAW_CRABLINE_DEFAULT_CHANNEL;
    const channelScenarios = scenariosByChannel.get(channel) ?? [];
    channelScenarios.push(scenario);
    scenariosByChannel.set(channel, channelScenarios);
  }

  const shards = [...scenariosByChannel.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([channel, channelScenarios]) => {
      const shardCount =
        channel === OPENCLAW_CRABLINE_DEFAULT_CHANNEL
          ? Math.min(QA_SMOKE_DEFAULT_CHANNEL_SHARDS, channelScenarios.length)
          : 1;
      return splitBalanced(channelScenarios, shardCount).map((shardScenarios, index) => {
        const suffix = shardCount > 1 ? ` ${index + 1}/${shardCount}` : "";
        const slugSuffix = shardCount > 1 ? `-${index + 1}-of-${shardCount}` : "";
        return {
          name: `${channel}${suffix}`,
          slug: `${slugifyChannel(channel)}${slugSuffix}`,
          channel,
          scenario_ids: shardScenarios.map((scenario) => scenario.id),
        };
      });
    });
  if (shards.length > QA_SMOKE_MAX_SHARDS) {
    throw new Error(
      `${QA_SMOKE_PROFILE} resolved ${shards.length} CI shards; maximum is ${QA_SMOKE_MAX_SHARDS}.`,
    );
  }
  return { include: shards };
}
