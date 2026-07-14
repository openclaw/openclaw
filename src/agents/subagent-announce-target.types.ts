// Shared native subagent completion routing contract.
export const SUBAGENT_ANNOUNCE_TARGETS = ["channel", "parent"] as const;
export type SubagentAnnounceTarget = (typeof SUBAGENT_ANNOUNCE_TARGETS)[number];

export function readSubagentAnnounceTarget(value: unknown): SubagentAnnounceTarget | undefined {
  return value === "channel" || value === "parent" ? value : undefined;
}
