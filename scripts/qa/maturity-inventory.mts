import { buildOfficialChannelDocsCatalog } from "../write-official-channel-catalog.mts";

type MaturityInventoryMember = {
  id: string;
  label: string;
  docsPath: string;
};

export type MaturityInventoryProjection = {
  membersBySurface: ReadonlyMap<string, readonly MaturityInventoryMember[]>;
  unmapped: readonly MaturityInventoryMember[];
};

const COMMUNITY_CHANNEL_IDS = new Set([
  "buzz",
  "clickclack",
  "irc",
  "line",
  "mattermost",
  "nextcloud-talk",
  "nostr",
  "raft",
  "reef",
  "sms",
  "synology-chat",
  "tlon",
  "twitch",
]);

const REGIONAL_CHANNEL_IDS = new Set([
  "feishu",
  "openclaw-weixin",
  "openclaw-zaloclawbot",
  "qqbot",
  "wecom",
  "yuanbao",
  "zalo",
  "zalouser",
]);

const DEDICATED_CHANNEL_SURFACES = new Map([
  ["a2a", "app-sdk"],
  ["discord", "discord"],
  ["googlechat", "google-chat"],
  ["imessage", "imessage-bluebubbles"],
  ["matrix", "matrix"],
  ["msteams", "microsoft-teams"],
  ["signal", "signal"],
  ["slack", "slack"],
  ["telegram", "telegram"],
  ["webchat", "control-ui"],
  ["whatsapp", "whatsapp"],
]);

export const MATURITY_CHANNEL_COHORT_SURFACE_IDS = new Set([
  "community-channels",
  "regional-channels",
]);

function channelSurfaceId(channelId: string): string | undefined {
  if (COMMUNITY_CHANNEL_IDS.has(channelId)) {
    return "community-channels";
  }
  if (REGIONAL_CHANNEL_IDS.has(channelId)) {
    return "regional-channels";
  }
  return DEDICATED_CHANNEL_SURFACES.get(channelId);
}

export function collectChannelMaturityInventory(
  repoRoot = process.cwd(),
): MaturityInventoryProjection {
  const membersBySurface = new Map<string, MaturityInventoryMember[]>();
  const unmapped: MaturityInventoryMember[] = [];
  for (const entry of buildOfficialChannelDocsCatalog({ repoRoot }).entries) {
    const member = { id: entry.id, label: entry.label, docsPath: entry.docsPath };
    const surfaceId = channelSurfaceId(entry.id);
    if (!surfaceId) {
      unmapped.push(member);
      continue;
    }
    const members = membersBySurface.get(surfaceId) ?? [];
    members.push(member);
    membersBySurface.set(surfaceId, members);
  }
  for (const members of membersBySurface.values()) {
    members.sort((left, right) => left.label.localeCompare(right.label));
  }
  return { membersBySurface, unmapped };
}
