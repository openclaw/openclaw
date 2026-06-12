// Qa Lab plugin module implements live transport scenarios behavior.
import {
  LIVE_TRANSPORT_BASELINE_REQUIREMENT_IDS,
  collectLiveTransportRequirementCoverage,
  findMissingLiveTransportRequirements,
  type LiveTransportScenarioDefinition,
  type LiveTransportRequirementId,
} from "openclaw/plugin-sdk/qa-live-transport-scenarios";

export {
  LIVE_TRANSPORT_BASELINE_REQUIREMENT_IDS,
  collectLiveTransportRequirementCoverage,
  findMissingLiveTransportRequirements,
  selectLiveTransportScenarios,
  type LiveTransportScenarioDefinition,
  type LiveTransportRequirementId,
} from "openclaw/plugin-sdk/qa-live-transport-scenarios";

export type LiveTransportCoverageMember = {
  scenarioId?: string;
  requirementId: LiveTransportRequirementId;
};

export type LiveTransportCoverageLane = {
  commandName: string;
  members: readonly LiveTransportCoverageMember[];
  transportId: string;
};

export type LiveTransportCoverageLaneSummary = {
  baselineMissingRequirementIds: LiveTransportRequirementId[];
  commandName: string;
  memberCount: number;
  members: LiveTransportCoverageMember[];
  requirementIds: LiveTransportRequirementId[];
  transportId: string;
};

export const LIVE_TRANSPORT_COVERAGE_LANES: readonly LiveTransportCoverageLane[] = [
  {
    transportId: "discord",
    commandName: "discord",
    members: [
      { requirementId: "canary", scenarioId: "discord-canary" },
      { requirementId: "mention-gating", scenarioId: "discord-mention-gating" },
    ],
  },
  {
    transportId: "slack",
    commandName: "slack",
    members: [
      { requirementId: "canary", scenarioId: "slack-canary" },
      { requirementId: "mention-gating", scenarioId: "slack-mention-gating" },
      { requirementId: "allowlist-block", scenarioId: "slack-allowlist-block" },
      { requirementId: "top-level-reply-shape", scenarioId: "slack-top-level-reply-shape" },
      { requirementId: "restart-resume", scenarioId: "slack-restart-resume" },
      { requirementId: "thread-follow-up", scenarioId: "slack-thread-follow-up" },
      { requirementId: "thread-isolation", scenarioId: "slack-thread-isolation" },
    ],
  },
  {
    transportId: "telegram",
    commandName: "telegram",
    members: [
      { requirementId: "canary" },
      { requirementId: "help-command", scenarioId: "telegram-help-command" },
      { requirementId: "mention-gating", scenarioId: "telegram-mention-gating" },
    ],
  },
  {
    transportId: "whatsapp",
    commandName: "whatsapp",
    members: [
      { requirementId: "canary", scenarioId: "whatsapp-canary" },
      { requirementId: "mention-gating", scenarioId: "whatsapp-mention-gating" },
      { requirementId: "top-level-reply-shape", scenarioId: "whatsapp-top-level-reply-shape" },
      { requirementId: "restart-resume", scenarioId: "whatsapp-restart-resume" },
      { requirementId: "help-command", scenarioId: "whatsapp-help-command" },
      { requirementId: "reaction-observation", scenarioId: "whatsapp-status-reactions" },
      { requirementId: "allowlist-block", scenarioId: "whatsapp-group-allowlist-block" },
    ],
  },
] as const;

export function buildLiveTransportCoverageLaneSummaries(
  lanes: readonly LiveTransportCoverageLane[] = LIVE_TRANSPORT_COVERAGE_LANES,
): LiveTransportCoverageLaneSummary[] {
  return lanes
    .map((lane) => {
      const scenarios: LiveTransportScenarioDefinition[] = lane.members.map((member) => ({
        id: member.scenarioId ?? `${lane.transportId}:${member.requirementId}`,
        requirementId: member.requirementId,
        timeoutMs: 0,
        title: member.requirementId,
      }));
      const requirementIds = collectLiveTransportRequirementCoverage({ scenarios });
      return {
        baselineMissingRequirementIds: findMissingLiveTransportRequirements({
          coveredRequirementIds: requirementIds,
          expectedRequirementIds: LIVE_TRANSPORT_BASELINE_REQUIREMENT_IDS,
        }),
        commandName: lane.commandName,
        memberCount: lane.members.length,
        members: [...lane.members],
        requirementIds,
        transportId: lane.transportId,
      };
    })
    .toSorted((left, right) => left.transportId.localeCompare(right.transportId));
}
