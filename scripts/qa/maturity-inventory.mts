import fs from "node:fs";
import path from "node:path";
import { buildOfficialChannelDocsCatalog } from "../write-official-channel-catalog.mts";

type MaturityInventoryMember = {
  id: string;
  label: string;
  docsPath: string;
};

export type MaturityInventoryProjection = {
  membersBySurface: ReadonlyMap<string, readonly MaturityInventoryMember[]>;
  unmapped: readonly MaturityInventoryMember[];
  ignored: readonly MaturityInventoryMember[];
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

export const MATURITY_PROVIDER_COHORT_SURFACE_IDS = new Set([
  "hosted-providers",
  "media-generation",
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
  return { membersBySurface, unmapped, ignored: [] };
}

type ProviderCatalog = {
  entries?: Array<{
    openclaw?: {
      providers?: Array<{
        id?: string;
        name?: string;
        docs?: string;
        categories?: string[];
      }>;
    };
  }>;
};

export function collectProviderMaturityInventory(
  repoRoot = process.cwd(),
): MaturityInventoryProjection {
  const catalogPath = path.join(repoRoot, "scripts/lib/official-external-provider-catalog.json");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as ProviderCatalog;
  const membersBySurface = new Map<string, MaturityInventoryMember[]>();
  const unmapped: MaturityInventoryMember[] = [];
  for (const entry of catalog.entries ?? []) {
    for (const provider of entry.openclaw?.providers ?? []) {
      if (!provider.id || !provider.name || !provider.docs) {
        continue;
      }
      const member = { id: provider.id, label: provider.name, docsPath: provider.docs };
      const categories = new Set(provider.categories ?? []);
      const surfaceId =
        categories.has("media") || categories.has("video")
          ? "media-generation"
          : categories.has("cloud")
            ? "hosted-providers"
            : undefined;
      if (!surfaceId) {
        unmapped.push(member);
        continue;
      }
      const members = membersBySurface.get(surfaceId) ?? [];
      members.push(member);
      membersBySurface.set(surfaceId, members);
    }
  }
  for (const members of membersBySurface.values()) {
    members.sort((left, right) => left.label.localeCompare(right.label));
  }
  return { membersBySurface, unmapped, ignored: [] };
}

const APP_SURFACE_BY_DIRECTORY = new Map([
  ["android", "android"],
  ["ios", "ios"],
  ["linux", "linux-app"],
  ["macos", "macos-app"],
  ["macos-mlx-tts", "voice"],
  ["swabble", "voice"],
]);

const APP_DOCS_BY_DIRECTORY = new Map([
  ["android", "/platforms/android"],
  ["ios", "/platforms/ios"],
  ["linux", "/platforms/linux"],
  ["macos", "/platforms/mac"],
  ["macos-mlx-tts", "/nodes/talk"],
  ["swabble", "/nodes/voicewake"],
]);

const APP_SUPPORT_DIRECTORIES = new Set([".i18n", "mobile", "shared"]);

export function collectAppMaturityInventory(repoRoot = process.cwd()): MaturityInventoryProjection {
  const appsRoot = path.join(repoRoot, "apps");
  const membersBySurface = new Map<string, MaturityInventoryMember[]>();
  const unmapped: MaturityInventoryMember[] = [];
  const ignored: MaturityInventoryMember[] = [];
  if (!fs.existsSync(appsRoot)) {
    return { membersBySurface, unmapped, ignored };
  }
  for (const entry of fs
    .readdirSync(appsRoot, { withFileTypes: true })
    .filter((candidate) => candidate.isDirectory())
    .toSorted((left, right) => left.name.localeCompare(right.name))) {
    const member = {
      id: entry.name,
      label: entry.name,
      docsPath: APP_DOCS_BY_DIRECTORY.get(entry.name) ?? "",
    };
    if (APP_SUPPORT_DIRECTORIES.has(entry.name)) {
      ignored.push(member);
      continue;
    }
    const surfaceId = APP_SURFACE_BY_DIRECTORY.get(entry.name);
    if (!surfaceId) {
      unmapped.push(member);
      continue;
    }
    const members = membersBySurface.get(surfaceId) ?? [];
    members.push(member);
    membersBySurface.set(surfaceId, members);
  }
  return { membersBySurface, unmapped, ignored };
}
