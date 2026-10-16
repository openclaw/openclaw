import type { AnyMessageContent, BaileysEventMap, GroupMetadata, WASocket } from "baileys";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import {
  readWhatsAppBaileysCacheEntry,
  rememberWhatsAppBaileysCacheEntry,
  type WhatsAppBaileysGroupMetadataCache,
} from "./baileys-cache.js";
import type { WhatsAppSocketListen } from "./lifecycle.js";
import {
  addWhatsAppOutboundMentionsToContent,
  mayContainWhatsAppOutboundMention,
  resolveWhatsAppOutboundMentions,
  type WhatsAppOutboundMentionParticipant,
} from "./outbound-mentions.js";
import { isJidGroup } from "./runtime-api.js";

const GROUP_META_TTL_MS = 5 * 60 * 1000;
const WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES = 500;

type WhatsAppGroupMetadataCacheEntry = {
  subject?: string;
  expires: number;
};

export type WhatsAppGroupMetadataCache = Map<string, WhatsAppGroupMetadataCacheEntry>;

type LocalGroupMetadataCacheEntry = WhatsAppGroupMetadataCacheEntry & {
  participants?: string[];
  mentionParticipants?: WhatsAppOutboundMentionParticipant[];
};

type GroupMetadataCacheOwnerParams = {
  sock: WASocket;
  getCurrentSock: () => WASocket | null;
  resolveInboundJid: (jid: string | null | undefined) => Promise<string | null>;
  reconnectCache?: WhatsAppGroupMetadataCache;
  baileysCache?: WhatsAppBaileysGroupMetadataCache;
  listen: WhatsAppSocketListen;
  logVerbose: (message: string) => void;
  logHydrationWarning: (error: string) => void;
};

function rememberGroupMetadataCacheEntry<T extends WhatsAppGroupMetadataCacheEntry>(
  cache: Map<string, T>,
  jid: string,
  entry: T,
): void {
  cache.delete(jid);
  cache.set(jid, entry);

  pruneMapToMaxSize(cache, WHATSAPP_GROUP_METADATA_CACHE_MAX_ENTRIES);
}

function readGroupMetadataCacheEntry<T extends WhatsAppGroupMetadataCacheEntry>(
  cache: Map<string, T>,
  jid: string,
): T | null {
  const entry = cache.get(jid);
  if (!entry) {
    return null;
  }
  if (entry.expires <= Date.now()) {
    cache.delete(jid);
    return null;
  }
  cache.delete(jid);
  cache.set(jid, entry);
  return entry;
}

export function createWhatsAppGroupMetadataCacheOwner(params: GroupMetadataCacheOwnerParams) {
  const reconnectCache = params.reconnectCache ?? new Map();
  const localCache = new Map<string, LocalGroupMetadataCacheEntry>();
  const detachListeners: Array<() => void> = [];
  let cacheRevision = 0;
  let closed = false;
  let started = false;

  const summarize = async (meta: GroupMetadata): Promise<LocalGroupMetadataCacheEntry> => {
    const participantEntries = await Promise.all(
      meta.participants?.map(async (participant) => {
        const mapped = await params.resolveInboundJid(participant.id);
        return {
          display: mapped ?? participant.id,
          mention: {
            id: participant.id,
            lid: participant.lid,
            phoneNumber: participant.phoneNumber,
            e164: mapped,
          } satisfies WhatsAppOutboundMentionParticipant,
        };
      }) ?? [],
    );
    return {
      subject: meta.subject,
      participants: participantEntries.map((entry) => entry.display).filter(Boolean),
      mentionParticipants: participantEntries.map((entry) => entry.mention),
      expires: Date.now() + GROUP_META_TTL_MS,
    };
  };

  const summarizeForReconnect = (meta: GroupMetadata): WhatsAppGroupMetadataCacheEntry => ({
    subject: meta.subject,
    expires: Date.now() + GROUP_META_TTL_MS,
  });

  const rememberFullUpdate = (jid: string, meta: GroupMetadata) => {
    if (closed) {
      return;
    }
    cacheRevision++;
    rememberWhatsAppBaileysCacheEntry(params.baileysCache, jid, meta, GROUP_META_TTL_MS);
    rememberGroupMetadataCacheEntry(reconnectCache, jid, summarizeForReconnect(meta));
    localCache.delete(jid);
  };

  const forgetFullMetadata = (jid: string) => {
    cacheRevision++;
    params.baileysCache?.delete(jid);
    reconnectCache.delete(jid);
    localCache.delete(jid);
  };

  const get = async (jid: string): Promise<LocalGroupMetadataCacheEntry> => {
    if (closed) {
      return { expires: Date.now() + GROUP_META_TTL_MS };
    }
    const cached = readGroupMetadataCacheEntry(localCache, jid);
    if (cached) {
      return cached;
    }
    const revision = cacheRevision;
    try {
      const hydratedEntry = params.baileysCache?.get(jid);
      const providerMetadata = params.baileysCache
        ? readWhatsAppBaileysCacheEntry(params.baileysCache, jid)
        : undefined;
      const hydratedMetadata = providerMetadata?.participants?.length
        ? providerMetadata
        : undefined;
      const meta =
        hydratedMetadata ?? (await (params.getCurrentSock() ?? params.sock).groupMetadata(jid));
      const entry = await summarize(meta);
      if (closed) {
        return { expires: Date.now() + GROUP_META_TTL_MS };
      }
      // Baileys uses this cache for sender-key recipients, not just display metadata.
      if (revision !== cacheRevision) {
        return entry;
      }
      if (hydratedMetadata && hydratedEntry) {
        entry.expires = hydratedEntry.expiresAt;
      } else {
        rememberWhatsAppBaileysCacheEntry(params.baileysCache, jid, meta, GROUP_META_TTL_MS);
      }
      rememberGroupMetadataCacheEntry(reconnectCache, jid, {
        subject: entry.subject,
        expires: entry.expires,
      });
      rememberGroupMetadataCacheEntry(localCache, jid, entry);
      return entry;
    } catch (error) {
      const hydrated = !closed && readGroupMetadataCacheEntry(reconnectCache, jid);
      if (hydrated) {
        rememberGroupMetadataCacheEntry(localCache, jid, hydrated);
        params.logVerbose(
          `Using cached group metadata for ${jid} after fetch failure: ${String(error)}`,
        );
        return hydrated;
      }
      params.logVerbose(`Failed to fetch group metadata for ${jid}: ${String(error)}`);
      return { expires: Date.now() + GROUP_META_TTL_MS };
    }
  };

  const resolveOutboundMentions = async (
    jid: string,
    text: string,
  ): Promise<{ text: string; mentionedJids: string[] }> => {
    if (isJidGroup(jid) !== true || !mayContainWhatsAppOutboundMention(text)) {
      return { text, mentionedJids: [] };
    }
    const meta = await get(jid);
    return resolveWhatsAppOutboundMentions({
      chatJid: jid,
      text,
      participants: meta.mentionParticipants,
    });
  };

  const applyOutboundMentions = async (
    jid: string,
    content: AnyMessageContent,
  ): Promise<AnyMessageContent> => {
    const field = "text" in content && typeof content.text === "string" ? "text" : "caption";
    const text = (content as { text?: unknown; caption?: unknown })[field];
    if (typeof text !== "string") {
      return content;
    }
    const resolved = await resolveOutboundMentions(jid, text);
    return addWhatsAppOutboundMentionsToContent(
      { ...content, [field]: resolved.text } as AnyMessageContent,
      resolved.mentionedJids,
    );
  };

  const start = () => {
    if (started || closed) {
      return;
    }
    started = true;
    const listen = <Event extends keyof BaileysEventMap>(
      event: Event,
      listener: (arg: BaileysEventMap[Event]) => void,
    ) => {
      detachListeners.push(params.listen(event, listener));
    };

    listen("groups.upsert", (groups) => {
      for (const group of groups) {
        if (group.id) {
          rememberFullUpdate(group.id, group);
        }
      }
    });
    listen("groups.update", (updates) => {
      for (const update of updates) {
        if (!update.id) {
          continue;
        }
        if (typeof update.subject === "string" && Array.isArray(update.participants)) {
          rememberFullUpdate(update.id, update as GroupMetadata);
          continue;
        }
        forgetFullMetadata(update.id);
      }
    });
    listen("group-participants.update", (update) => {
      forgetFullMetadata(update.id);
    });

    void (async () => {
      const revision = cacheRevision;
      try {
        const groups = await params.sock.groupFetchAllParticipating();
        if (closed || revision !== cacheRevision) {
          return;
        }
        for (const [jid, meta] of Object.entries(groups ?? {})) {
          if (meta) {
            rememberGroupMetadataCacheEntry(reconnectCache, jid, summarizeForReconnect(meta));
            rememberWhatsAppBaileysCacheEntry(params.baileysCache, jid, meta, GROUP_META_TTL_MS);
          }
        }
        params.logVerbose(
          `Hydrated ${Object.keys(groups ?? {}).length} participating groups on connect`,
        );
      } catch (error) {
        const formatted = String(error);
        params.logHydrationWarning(formatted);
        params.logVerbose(`Failed to hydrate participating groups on connect: ${formatted}`);
      }
    })();
  };

  const close = () => {
    closed = true;
    for (const detach of detachListeners.splice(0)) {
      detach();
    }
  };

  return {
    start,
    close,
    get,
    resolveOutboundMentions,
    applyOutboundMentions,
  } as const;
}

export type WhatsAppGroupMetadataCacheOwner = ReturnType<
  typeof createWhatsAppGroupMetadataCacheOwner
>;
