import { createHash } from "node:crypto";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatSpace } from "./types.js";

type ChatType = "direct" | "group";
type SpaceEntry = { chatType?: ChatType; lookup?: Promise<ChatType | undefined> };
type AccountSpaces = {
  credentialKey: string;
  spaces: Map<string, SpaceEntry>;
  saturated: boolean;
};

const MAX_ACCOUNTS = 32;
const MAX_SPACES_PER_ACCOUNT = 1024;
const log = createSubsystemLogger("googlechat/space-cache");
const store = createPluginRuntimeStore<Map<string, AccountSpaces>>({
  key: "googlechat:space-classifications",
  errorMessage: "Google Chat space classifications not initialized",
});

function accountSpaces(account: ResolvedGoogleChatAccount): AccountSpaces | undefined {
  let accounts = store.tryGetRuntime();
  if (!accounts) {
    accounts = new Map();
    store.setRuntime(accounts);
  }
  // Match the auth owner's credential identity without retaining raw credentials.
  const credentialKey = createHash("sha256")
    .update(
      JSON.stringify([account.credentialSource, account.credentialsFile, account.credentials]),
    )
    .digest("hex");
  let cached = accounts.get(account.accountId);
  if (cached?.credentialKey === credentialKey) {
    return cached;
  }
  if (!cached && accounts.size >= MAX_ACCOUNTS) {
    return undefined;
  }
  cached = { credentialKey, spaces: new Map(), saturated: false };
  accounts.set(account.accountId, cached);
  return cached;
}

export function resolveGoogleChatSpaceChatType(space: GoogleChatSpace): ChatType | undefined {
  const spaceType = (space.spaceType ?? "").toUpperCase();
  // The current field wins when both current and deprecated fields are present.
  if (spaceType === "DIRECT_MESSAGE") {
    return "direct";
  }
  if (spaceType === "SPACE" || spaceType === "GROUP_CHAT") {
    return "group";
  }
  if (space.singleUserBotDm === true || (space.type ?? "").toUpperCase() === "DM") {
    return "direct";
  }
  if ((space.type ?? "").toUpperCase() === "ROOM") {
    return "group";
  }
  return undefined;
}

function admitSpace(cache: AccountSpaces, name: string): SpaceEntry | undefined {
  const existing = cache.spaces.get(name);
  if (existing) {
    return existing;
  }
  // Do not evict attempted reads: eviction would turn a bounded cache into
  // repeated metadata requests. At capacity, leave new routes unavailable.
  if (cache.spaces.size >= MAX_SPACES_PER_ACCOUNT) {
    if (!cache.saturated) {
      cache.saturated = true;
      log.warn(
        "Space classification cache full; new destination routes remain unavailable until restart.",
      );
    }
    return undefined;
  }
  const entry: SpaceEntry = {};
  cache.spaces.set(name, entry);
  return entry;
}

export function rememberGoogleChatSpace(
  account: ResolvedGoogleChatAccount,
  space: GoogleChatSpace,
): void {
  const chatType = resolveGoogleChatSpaceChatType(space);
  if (!space.name || !chatType) {
    return;
  }
  const cache = accountSpaces(account);
  const entry = cache && admitSpace(cache, space.name);
  if (entry) {
    entry.chatType = chatType;
  }
}

export async function resolveCachedGoogleChatSpaceChatType(
  account: ResolvedGoogleChatAccount,
  spaceName: string,
  load: () => Promise<GoogleChatSpace>,
): Promise<ChatType | undefined> {
  const cache = accountSpaces(account);
  const entry = cache && admitSpace(cache, spaceName);
  if (!entry || entry.chatType || entry.lookup) {
    return entry?.chatType ?? entry?.lookup;
  }
  entry.lookup = (async () => {
    try {
      const space = await load();
      // A newer inbound/send observation takes precedence over this pending read.
      entry.chatType ??= resolveGoogleChatSpaceChatType(space);
      if (!entry.chatType) {
        log.warn(
          "Space type unavailable; destination transcript routing skipped (cached until restart).",
        );
      }
    } catch {
      // Do not log API errors: they may contain remote text or credential details.
      log.warn(
        "Space metadata read failed; destination transcript routing skipped (cached until restart).",
      );
    }
    return entry.chatType;
  })();
  return entry.lookup;
}

export function startGoogleChatSpaceCache(account: ResolvedGoogleChatAccount): () => void {
  const accounts = store.tryGetRuntime();
  accounts?.delete(account.accountId);
  const cache = accountSpaces(account);
  return () => {
    const current = store.tryGetRuntime();
    if (current && current.get(account.accountId) === cache) {
      current.delete(account.accountId);
    }
  };
}
