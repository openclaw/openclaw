import type { QaProviderModeInput } from "../../model-selection.js";
import { readQaScenarioById } from "../../scenario-catalog.js";
import {
  listLiveTransportQaScenarios,
  resolveLiveTransportQaScenarioIds,
} from "../shared/scenario-selection.js";

const TELEGRAM_QA_CHANNEL_ID = "telegram";

function isDefaultTelegramReleaseScenario(scenarioId: string) {
  return (
    readQaScenarioById(scenarioId).execution.config?.requireParticipantIdentityFixture !== true
  );
}

export function resolveTelegramQaScenarioIds(params: {
  profile?: string;
  primaryModel?: string;
  providerMode: QaProviderModeInput;
  scenarioIds?: readonly string[];
}): string[] {
  const scenarioIds = resolveLiveTransportQaScenarioIds({
    channelId: TELEGRAM_QA_CHANNEL_ID,
    ...params,
  });
  const profile = params.profile?.trim() || "release";
  if (params.scenarioIds?.length || profile !== "release") {
    return scenarioIds;
  }
  return scenarioIds.filter(isDefaultTelegramReleaseScenario);
}

export function listTelegramQaScenarios(params: {
  primaryModel?: string;
  providerMode: QaProviderModeInput;
}) {
  const scenarios = listLiveTransportQaScenarios({
    channelId: TELEGRAM_QA_CHANNEL_ID,
    ...params,
  });
  for (const scenario of scenarios) {
    scenario.defaultEnabled &&= isDefaultTelegramReleaseScenario(scenario.id);
  }
  return scenarios;
}
