import type { TurnContext } from "@microsoft/agents-hosting";

/**
 * Minimal public surface we depend on from the Microsoft SDK types.
 *
 * Note: we intentionally avoid coupling to SDK classes with private members
 * (like TurnContext) in our own public signatures. The SDK's TS surface is also
 * stricter than what the runtime accepts (e.g. it allows plain activity-like
 * objects), so we model the minimal structural shape we rely on.
 */
export type MSTeamsActivity = TurnContext["activity"];

export type MSTeamsTurnContext = {
  activity: MSTeamsActivity;
  sendActivity: (textOrActivity: string | object) => Promise<unknown>;
  sendActivities: (
    activities: Array<{ type: string } & Record<string, unknown>>,
  ) => Promise<unknown>;
};
