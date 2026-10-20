import * as http from "node:http";
import * as https from "node:https";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { collectErrorGraphCandidates, extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { safeParseJsonWithSchema, safeParseWithSchema } from "openclaw/plugin-sdk/extension-shared";
import { captureEffectAuthority } from "openclaw/plugin-sdk/fetch-runtime";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import { classifyTransientNetworkErrorCode, retryAsync } from "openclaw/plugin-sdk/retry-runtime";
import { sleep, sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { z } from "zod";
import type { SynologyHostedMediaUrl } from "./outbound-media.js";

const MIN_SEND_INTERVAL_MS = 500;
export const SYNOLOGY_CHAT_TEXT_CHUNK_LIMIT = 2_000;
/** user_list JSON can be larger than inbound webhook pre-auth payloads. */
const USER_LIST_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;
/** Wall-clock budget for user_list fetch including response body. */
const USER_LIST_REQUEST_TIMEOUT_MS = 15_000;
/** Wall-clock budget for outgoing webhook requests including response body. */
const POST_REQUEST_TIMEOUT_MS = 30_000;

type SendSlotState = {
  tail: Promise<void>;
  lastSendTime: number;
  waiters: number;
};

// Pace sends per incoming webhook endpoint so a burst on one account cannot
// head-of-line block an independent account's webhook.
const sendSlots = new Map<string, SendSlotState>();

const UNPROVEN_TRANSPORT_ERROR_BRANCH = "unproven transport error branch";

function nestedTransportErrorCandidates(current: Record<string, unknown>): unknown[] {
  const aggregateBranches = Array.isArray(current.errors)
    ? current.errors.map((branch) => branch ?? UNPROVEN_TRANSPORT_ERROR_BRANCH)
    : [];
  const wrappers = [current.cause, current.original, current.error, current.reason].filter(
    (candidate) => candidate !== undefined && candidate !== null,
  );
  return [...aggregateBranches, ...wrappers];
}

function isProvenPreConnectFailure(error: unknown): boolean {
  let foundPreConnectLeaf = false;
  for (const candidate of collectErrorGraphCandidates(error, nestedTransportErrorCandidates)) {
    const classification = classifyTransientNetworkErrorCode(extractErrorCode(candidate));
    const nested =
      candidate && typeof candidate === "object"
        ? nestedTransportErrorCandidates(candidate as Record<string, unknown>)
        : [];
    // A webhook POST is safe to replay only when every terminal transport branch
    // proves it failed before connect; aggregate summary codes cannot hide a reset.
    if (nested.length > 0) {
      if (classification === "ambiguous") {
        return false;
      }
      continue;
    }
    if (classification !== "pre-connect") {
      return false;
    }
    foundPreConnectLeaf = true;
  }
  return foundPreConnectLeaf;
}

// Synology Chat uses two different user_id spaces:
//   - Outgoing webhook user_id: per-integration sequential ID (e.g. 1)
//   - Chat API user_id: global internal ID (e.g. 4)
// The chatbot API (method=chatbot) requires the Chat API user_id in the
// user_ids array. We resolve via the user_list API and cache the result.

type ChatUser = z.infer<typeof ChatUserSchema>;

type ChatUserCacheEntry = {
  users: ChatUser[];
  cachedAt: number;
};

type ChatWebhookPayload = {
  text?: string;
  file_url?: string;
  user_ids?: number[];
};

type SynologyHostedFileSendResult =
  | { status: "accepted" }
  | { status: "not-dispatched" }
  | { status: "rejected" }
  | { status: "indeterminate" };

const ChatUserSchema = z.object({
  user_id: z.number(),
  username: z.string().default(""),
  nickname: z.string().default(""),
});

const ChatUserListResponseSchema = z.object({
  success: z.boolean(),
  data: z
    .object({
      users: z
        .array(z.unknown())
        .optional()
        .transform((users) =>
          (users ?? []).flatMap((user) => {
            const parsed = safeParseWithSchema(ChatUserSchema, user);
            return parsed ? [parsed] : [];
          }),
        ),
    })
    .optional(),
});

// Cache user lists per bot endpoint to avoid cross-account bleed.
const chatUserCache = new Map<string, ChatUserCacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function sendMessage(
  incomingUrl: string,
  text: string,
  userId?: string,
  allowInsecureSsl = false,
  onPlatformSendDispatch?: () => Promise<void>,
): Promise<boolean> {
  const effect = captureEffectAuthority();
  const chunks = chunkTextForOutbound(text, SYNOLOGY_CHAT_TEXT_CHUNK_LIMIT);
  const acceptedChunks: string[] = [];
  for (const chunk of chunks.length > 0 ? chunks : [text]) {
    let initiated = false;
    try {
      // Synology Chat API requires numeric user_ids to specify the recipient.
      const body = buildWebhookBody({ text: chunk }, userId);
      // Retry only proven pre-connect failures; ambiguous webhook replays can duplicate messages.
      await waitForSendSlot(incomingUrl);
      await onPlatformSendDispatch?.();
      const result = await retryAsync(
        () => {
          initiated = false;
          return effect.initiate(() => {
            initiated = true;
            return doPost(incomingUrl, body, allowInsecureSsl);
          });
        },
        {
          attempts: 3,
          minDelayMs: 0,
          shouldRetry: (error) => initiated && isProvenPreConnectFailure(error),
          delayMs: ({ attempt }) => 300 * 2 ** (attempt - 1),
          sleep: async (delayMs) => {
            initiated = false;
            await sleepWithAbort(delayMs);
            await waitForSendSlot(incomingUrl);
            await onPlatformSendDispatch?.();
          },
        },
      );
      if (result !== "accepted") {
        throw new Error(`Failed to send message to Synology Chat (${result})`);
      }
      acceptedChunks.push(chunk);
    } catch (error) {
      if (acceptedChunks.length > 0) {
        throw createChannelPartialDeliveryError(error, {
          visibleReplySent: true,
          content: acceptedChunks.join(""),
        });
      }
      if (!initiated) {
        throw error;
      }
      return false;
    }
  }
  return true;
}

export async function sendHostedFileUrl(
  incomingUrl: string,
  fileUrl: SynologyHostedMediaUrl,
  userId?: string,
  allowInsecureSsl = false,
  onPlatformSendDispatch?: () => Promise<void>,
): Promise<SynologyHostedFileSendResult> {
  const effect = captureEffectAuthority();
  const body = buildWebhookBody({ file_url: fileUrl }, userId);

  await waitForSendSlot(incomingUrl);
  await onPlatformSendDispatch?.();

  let initiated = false;
  try {
    const status = await effect.initiate(() => {
      initiated = true;
      return doPost(incomingUrl, body, allowInsecureSsl);
    });
    return { status };
  } catch (error) {
    if (!initiated) {
      throw error;
    }
    // Proven pre-connect failures cannot have queued the capability. All other
    // transport errors stay indeterminate because Synology may have the POST.
    return { status: isProvenPreConnectFailure(error) ? "not-dispatched" : "indeterminate" };
  }
}

// Cache user lists for CACHE_TTL_MS to avoid excessive API calls.
async function fetchChatUsers(
  incomingUrl: string,
  allowInsecureSsl = false,
  log?: { warn: (...args: unknown[]) => void },
): Promise<ChatUser[]> {
  const now = Date.now();
  const listUrl = incomingUrl.replace(/method=\w+/, "method=user_list");
  const cached = chatUserCache.get(listUrl);
  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached.users;
  }
  try {
    const response = await requestSynology(listUrl, allowInsecureSsl);
    if (!response) {
      log?.warn("fetchChatUsers: invalid user_list URL, using cached data");
      return cached?.users ?? [];
    }
    const result = safeParseJsonWithSchema(
      ChatUserListResponseSchema,
      response.data.toString("utf8"),
    );
    if (!result) {
      log?.warn("fetchChatUsers: failed to parse user_list response");
    } else if (result.success) {
      const users = result.data?.users ?? [];
      chatUserCache.set(listUrl, { users, cachedAt: now });
      return users;
    } else {
      log?.warn(`fetchChatUsers: API returned success=${result.success}, using cached data`);
    }
  } catch (error) {
    const message = formatErrorMessage(error);
    const fallback = message.startsWith("HTTP error — ") ? "" : ", using cached data";
    log?.warn(`fetchChatUsers: ${message}${fallback}`);
  }
  return cached?.users ?? [];
}

async function waitForSendSlot(incomingUrl: string): Promise<void> {
  pruneIdleSendSlots();
  const slot = sendSlots.get(incomingUrl) ?? {
    tail: Promise.resolve(),
    lastSendTime: 0,
    waiters: 0,
  };
  sendSlots.set(incomingUrl, slot);
  slot.waiters += 1;
  const next = slot.tail.then(async () => {
    const elapsed = Date.now() - slot.lastSendTime;
    if (elapsed < MIN_SEND_INTERVAL_MS) {
      await sleep(MIN_SEND_INTERVAL_MS - elapsed);
    }
    slot.lastSendTime = Date.now();
  });
  slot.tail = next.catch(() => {});
  try {
    await next;
  } finally {
    slot.waiters -= 1;
  }
}

function pruneIdleSendSlots(): void {
  const now = Date.now();
  for (const [incomingUrl, slot] of sendSlots) {
    // Retire a slot only after its cooldown elapses so a follow-up send to the
    // same endpoint still honors the minimum interval.
    if (slot.waiters === 0 && now - slot.lastSendTime >= MIN_SEND_INTERVAL_MS) {
      sendSlots.delete(incomingUrl);
    }
  }
}

/**
 * Resolve a mutable webhook username/nickname to the correct Chat API user_id.
 *
 * Synology Chat outgoing webhooks send a user_id that may NOT match the
 * Chat-internal user_id needed by the chatbot API (method=chatbot).
 * The webhook's "username" field corresponds to the Chat user's "nickname".
 */
export async function resolveLegacyWebhookNameToChatUserId(params: {
  incomingUrl: string;
  mutableWebhookUsername: string;
  allowInsecureSsl?: boolean;
  log?: { warn: (...args: unknown[]) => void };
}): Promise<number | undefined> {
  const users = await fetchChatUsers(params.incomingUrl, params.allowInsecureSsl, params.log);
  const lower = normalizeLowercaseStringOrEmpty(params.mutableWebhookUsername);

  // Match by nickname first (webhook "username" field = Chat "nickname")
  const byNickname = users.find((u) => normalizeLowercaseStringOrEmpty(u.nickname) === lower);
  if (byNickname) {
    return byNickname.user_id;
  }

  return users.find((user) => normalizeLowercaseStringOrEmpty(user.username) === lower)?.user_id;
}

function buildWebhookBody(payload: ChatWebhookPayload, userId?: string): string {
  const numericId = parseNumericUserId(userId);
  if (numericId !== undefined) {
    payload.user_ids = [numericId];
  }
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

function parseNumericUserId(userId?: string): number | undefined {
  if (userId === undefined) {
    return undefined;
  }
  return parseStrictNonNegativeInteger(userId);
}

type SynologyResponse = { statusCode?: number; data: Buffer };

function requestSynology(
  url: string,
  allowInsecureSsl: boolean,
  body?: string,
): Promise<SynologyResponse | undefined> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return Promise.resolve(undefined);
  }
  const transport = parsedUrl.protocol === "https:" ? https : http;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  return new Promise<SynologyResponse | undefined>((resolve, reject) => {
    let response: http.IncomingMessage | undefined;
    let req: http.ClientRequest;
    const readResponse = (res: http.IncomingMessage) => {
      response = res;
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes <= USER_LIST_RESPONSE_MAX_BYTES) {
          chunks.push(chunk);
        } else {
          chunks.length = 0;
          // Lookup responses fail closed; POST responses must still be drained
          // because an oversized envelope cannot undo HTTP200 acceptance.
          if (body === undefined) {
            reject(new Error(`user_list response exceeded ${USER_LIST_RESPONSE_MAX_BYTES} bytes`));
            res.destroy();
            req.destroy();
          }
        }
      });
      res.on("end", () =>
        resolve({
          statusCode: res.statusCode,
          data:
            bytes <= USER_LIST_RESPONSE_MAX_BYTES ? Buffer.concat(chunks, bytes) : Buffer.alloc(0),
        }),
      );
      res.on("error", reject);
      res.resume();
    };
    // Synology NAS may use self-signed certs; only the operator's explicit
    // allowInsecureSsl setting skips certificate verification.
    const requestOptions = { rejectUnauthorized: !allowInsecureSsl };
    try {
      req =
        body === undefined
          ? transport.get(url, requestOptions, readResponse)
          : transport.request(
              url,
              {
                ...requestOptions,
                method: "POST",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                  "Content-Length": Buffer.byteLength(body),
                },
              },
              readResponse,
            );
    } catch {
      // No request exists yet, so a hosted capability cannot have been sent.
      resolve(undefined);
      return;
    }
    req.on("error", (error) =>
      reject(body === undefined ? new Error(`HTTP error — ${formatErrorMessage(error)}`) : error),
    );
    // One absolute budget includes connect, upload, and response drain.
    deadlineTimer = setTimeout(
      () => {
        reject(new Error(body === undefined ? "request timed out" : "Request timeout"));
        response?.destroy();
        req.destroy();
      },
      body === undefined ? USER_LIST_REQUEST_TIMEOUT_MS : POST_REQUEST_TIMEOUT_MS,
    );
    deadlineTimer.unref?.();
    if (body !== undefined) {
      req.write(body);
      req.end();
    }
  }).finally(() => clearTimeout(deadlineTimer));
}

async function doPost(
  url: string,
  body: string,
  allowInsecureSsl = false,
): Promise<SynologyHostedFileSendResult["status"]> {
  const response = await requestSynology(url, allowInsecureSsl, body);
  if (!response) {
    return "not-dispatched";
  }
  const result = safeParseJsonWithSchema(
    ChatUserListResponseSchema.pick({ success: true }),
    response.data.toString("utf8"),
  );
  if (response.statusCode === 200) {
    return result?.success === false ? "rejected" : "accepted";
  }
  // A proxy 5xx can follow acceptance, so it cannot prove rejection.
  return (response.statusCode ?? 500) >= 500 ? "indeterminate" : "rejected";
}
