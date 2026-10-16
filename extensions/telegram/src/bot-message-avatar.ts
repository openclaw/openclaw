import { AbortController as TelegramAbortController } from "abort-controller";
import type { Bot } from "grammy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveTelegramMediaRuntimeOptions } from "./accounts.js";
import { resolveMedia } from "./bot/delivery.resolve-media.js";
import type { TelegramContext } from "./bot/types.js";
import type { TelegramTransport } from "./fetch.js";

const AVATAR_TTL_MS = 5 * 60_000;
const AVATAR_MAX_ENTRIES = 128;
const AVATAR_MAX_BYTES = 256 * 1024;

/** One resolver belongs to one bot account, never to the viewer's profile. */
export function createTelegramDirectAvatarResolver(params: {
  api: Pick<Bot["api"], "getUserProfilePhotos" | "getFile">;
  accountId: string;
  token: string;
  transport?: TelegramTransport;
  abortSignal?: AbortSignal;
}) {
  const cache = new Map<number, { expiresAt: number; path?: string }>();
  const pending = new Set<number>();
  return (
    ctx: Pick<TelegramContext, "message" | "me">,
    cfg: OpenClawConfig,
  ): string | undefined => {
    const message = ctx.message;
    const senderId = message.from?.id;
    // A private chat portrait describes its peer, not a group, channel, or forwarded author.
    if (
      params.abortSignal?.aborted ||
      message.chat.type !== "private" ||
      !senderId ||
      message.from?.is_bot ||
      message.chat.id !== senderId
    ) {
      return undefined;
    }
    const cached = cache.get(senderId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.path;
    }
    if (pending.has(senderId) || pending.size >= AVATAR_MAX_ENTRIES) {
      return cached?.path;
    }
    const load = async () => {
      const signals = [AbortSignal.timeout(4_000), params.abortSignal].filter(
        (signal): signal is AbortSignal => signal !== undefined,
      );
      const abortSignal = AbortSignal.any(signals);
      // grammY requires its declared abort-controller signal; media fetches use the native signal.
      const apiAbort = new TelegramAbortController();
      const abort = () => apiAbort.abort();
      if (abortSignal.aborted) {
        abort();
      } else {
        abortSignal.addEventListener("abort", abort, { once: true });
      }
      try {
        const photos = await params.api.getUserProfilePhotos(
          senderId,
          { offset: 0, limit: 1 },
          apiAbort.signal,
        );
        if (abortSignal.aborted) {
          return undefined;
        }
        const photo = photos.photos[0]?.[0];
        if (!photo) {
          // A successful empty response clears a prior portrait; failures leave it unchanged.
          return "";
        }
        const media = await resolveMedia({
          ...resolveTelegramMediaRuntimeOptions({
            cfg,
            accountId: params.accountId,
            token: params.token,
            transport: params.transport,
          }),
          ctx: {
            message: { photo: [photo] },
            me: ctx.me,
            getFile: (signal) => params.api.getFile(photo.file_id, signal),
          },
          maxBytes: AVATAR_MAX_BYTES,
          abortSignal,
        });
        return abortSignal.aborted ? undefined : media?.path;
      } catch {
        // Missing/private photos and transient API failures must not reject the message.
        return undefined;
      } finally {
        abortSignal.removeEventListener("abort", abort);
      }
    };
    pending.add(senderId);
    // Portrait acquisition belongs to the bot account and must never delay an inbound turn.
    void load()
      .then((path) => {
        if (params.abortSignal?.aborted) {
          return;
        }
        cache.delete(senderId);
        cache.set(senderId, { path: path ?? cached?.path, expiresAt: Date.now() + AVATAR_TTL_MS });
        if (cache.size > AVATAR_MAX_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) {
            cache.delete(oldest);
          }
        }
      })
      .finally(() => pending.delete(senderId));
    return cached?.path;
  };
}
