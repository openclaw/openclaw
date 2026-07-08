// Qa Lab plugin module plans the bounded CI smoke lanes.
import { OPENCLAW_CRABLINE_DEFAULT_CHANNEL } from "@openclaw/crabline";
import { defaultQaModelForMode, normalizeQaProviderMode } from "./model-selection.js";
import { readQaScenarioPack } from "./scenario-catalog.js";
import { readQaScorecardTaxonomyReport } from "./scorecard-taxonomy.js";
import { scenarioMatchesQaProviderLane } from "./suite-planning.js";

const QA_SMOKE_PROFILE = "smoke-ci";
const QA_SMOKE_CI_LANES = {
  matrix: "matrix",
  crabline: OPENCLAW_CRABLINE_DEFAULT_CHANNEL,
} as const;

type QaSmokeCiLane = keyof typeof QA_SMOKE_CI_LANES;

type QaSmokeCiShard = {
  lane: QaSmokeCiLane;
  channel: string;
  scenario_ids: string[];
};

function isQaSmokeCiLane(value: string): value is QaSmokeCiLane {
  return Object.hasOwn(QA_SMOKE_CI_LANES, value);
}

export function createQaSmokeCiShard(lane: string): QaSmokeCiShard {
  if (!isQaSmokeCiLane(lane)) {
    throw new Error(`unknown QA smoke CI lane: ${lane}`);
  }

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

  const supportedChannels = new Set<string>(Object.values(QA_SMOKE_CI_LANES));
  const unsupportedChannels = new Set(
    scenarios
      .map((scenario) => scenario.execution.channel ?? OPENCLAW_CRABLINE_DEFAULT_CHANNEL)
      .filter((channel) => !supportedChannels.has(channel)),
  );
  if (unsupportedChannels.size > 0) {
    throw new Error(
      `${QA_SMOKE_PROFILE} resolved unsupported CI channels: ${[...unsupportedChannels].toSorted().join(", ")}.`,
    );
  }

  const channel = QA_SMOKE_CI_LANES[lane];
  const scenarioIds = scenarios
    .filter(
      (scenario) => (scenario.execution.channel ?? OPENCLAW_CRABLINE_DEFAULT_CHANNEL) === channel,
    )
    .map((scenario) => scenario.id)
    .toSorted();
  if (scenarioIds.length === 0) {
    throw new Error(`${QA_SMOKE_PROFILE} CI lane ${lane} did not resolve any scenarios.`);
  }

  return { lane, channel, scenario_ids: scenarioIds };
}
