import type { MSTeamsTurnContext } from "./sdk-types.js";

export function isMSTeamsLifecycleRemoval(activity: MSTeamsTurnContext["activity"]): boolean {
  if (activity.type === "installationUpdate") {
    // remove-upgrade removes the bot from the manifest, rather than an ordinary app update.
    return activity.action === "remove" || activity.action === "remove-upgrade";
  }
  const botId = activity.recipient?.id;
  return (
    activity.type === "conversationUpdate" &&
    Boolean(botId && activity.membersRemoved?.some((member) => member.id === botId))
  );
}
