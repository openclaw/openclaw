import { createHmac, randomUUID } from "node:crypto";
import path from "node:path";
import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/account-helpers";
import {
  createMessageReceiptFromOutboundResults,
  isRecentOutboundMessageIdentity,
  recordOutboundMessageIdentity,
  type ChannelMessageSendMediaContext,
} from "openclaw/plugin-sdk/channel-outbound";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import {
  readProviderJsonResponse,
  readProviderTextResponse,
} from "openclaw/plugin-sdk/provider-http";
import { sanitizeUntrustedFileName } from "openclaw/plugin-sdk/security-runtime";
import { ssrfPolicyFromPrivateNetworkOptIn } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { truncateUtf8Prefix } from "openclaw/plugin-sdk/text-utility-runtime";
import { fetchWithSsrFGuard } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { resolveNextcloudTalkApiCredentialsResult } from "./api-credentials.js";
import { releaseNextcloudTalkGuardedResponse } from "./guarded-response.js";
import { stripNextcloudTalkTargetPrefix } from "./normalize.js";
import { getOptionalNextcloudTalkRuntime } from "./runtime.js";
import type { NextcloudTalkInboundMessage, NextcloudTalkSendResult } from "./types.js";
import { parseWebDavFileId } from "./webdav.js";

const OUTBOUND_FILE_PREFIX = /^openclaw-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})-/u;
const FILE_ID_REQUEST =
  '<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/></d:prop></d:propfind>';

function createFileClient(account: ResolvedNextcloudTalkAccount) {
  const credentials = resolveNextcloudTalkApiCredentialsResult(account.config);
  if (credentials.status !== "available") {
    throw new Error(
      "Nextcloud Talk attachments require available apiUser and apiPassword/apiPasswordFile credentials.",
    );
  }
  const base = new URL(account.baseUrl);
  if (
    !/^https?:$/u.test(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error(
      "Nextcloud Talk attachment baseUrl must be an HTTP(S) URL without credentials, query, or fragment.",
    );
  }
  const authorization = `Basic ${Buffer.from(`${credentials.value.apiUser}:${credentials.value.apiPassword}`).toString("base64")}`;
  const url = (pathname: string) =>
    `${base.origin}${base.pathname.replace(/\/+$/u, "")}${pathname}`;
  async function request<T>(
    pathname: string,
    init: RequestInit,
    read: (response: Response) => Promise<T>,
    options: { signal?: AbortSignal; beforeRequest?: () => void } = {},
  ): Promise<T> {
    options.signal?.throwIfAborted();
    const headers = new Headers(init.headers);
    headers.set("Authorization", authorization);
    headers.set("OCS-APIRequest", "true");
    if (!headers.has("Accept")) {
      headers.set("Accept", "application/json");
    }
    const guarded = await fetchWithSsrFGuard({
      url: url(pathname),
      init: { ...init, headers },
      maxRedirects: 0,
      requireHttps: base.protocol === "https:",
      policy: {
        ...ssrfPolicyFromPrivateNetworkOptIn(
          account.config.network?.dangerouslyAllowPrivateNetwork,
        ),
        hostnameAllowlist: [base.hostname],
      },
      timeoutMs: 120_000,
      signal: options.signal,
      beforeRequest: options.beforeRequest,
      auditContext: "nextcloud-talk-outbound-file",
    });
    try {
      return await read(guarded.response);
    } finally {
      await releaseNextcloudTalkGuardedResponse(guarded);
    }
  }
  async function json(
    pathname: string,
    init: RequestInit,
    options?: Parameters<typeof request>[3],
  ) {
    return await request(
      pathname,
      init,
      async (response) => {
        if (!response.ok) {
          throw new Error(`Nextcloud Talk attachment API failed (${response.status}).`);
        }
        const payload = await readProviderJsonResponse<unknown>(
          response,
          "Nextcloud Talk attachment API",
        );
        if (!isRecord(payload) || !isRecord(payload.ocs)) {
          throw new Error("Nextcloud Talk attachment API returned an invalid response.");
        }
        return payload.ocs.data;
      },
      options,
    );
  }
  async function user(options?: Parameters<typeof request>[3]) {
    const data = await json("/ocs/v1.php/cloud/user?format=json", {}, options);
    if (
      !isRecord(data) ||
      typeof data.id !== "string" ||
      !data.id ||
      data.id === "." ||
      data.id === ".." ||
      data.id.includes("/") ||
      data.id.includes("\\") ||
      Array.from(data.id).some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
      })
    ) {
      throw new Error("Nextcloud Talk API account has no valid canonical user ID.");
    }
    return data.id;
  }
  async function history(
    roomToken: string,
    messageId?: string,
    options?: Parameters<typeof request>[3],
  ) {
    const query = new URLSearchParams({
      lookIntoFuture: "0",
      limit: messageId ? "1" : "200",
      setReadMarker: "0",
      noStatusUpdate: "1",
      markNotificationsAsRead: "0",
    });
    if (messageId) {
      query.set("lastKnownMessageId", messageId);
      query.set("includeLastKnown", "1");
    }
    const data = await json(
      `/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(roomToken)}?${query}`,
      {},
      options,
    );
    return Array.isArray(data) ? data : [];
  }
  return { request, json, user, history };
}

function fileReference(
  account: ResolvedNextcloudTalkAccount,
  roomToken: string,
  uid: string,
  fileId: string,
) {
  return createHmac("sha256", account.secret)
    .update(
      JSON.stringify(["nextcloud-talk-outbound-file", account.accountId, roomToken, uid, fileId]),
    )
    .digest("hex");
}

function echoIdentity(accountId: string, roomToken: string, actor: string, fileId: string) {
  return {
    channel: "nextcloud-talk",
    accountId,
    conversationId: roomToken,
    sourceId: `file:${actor.toLowerCase()}:${fileId}`,
  };
}

/** The bounded cache handles webhook-before-ack; exact history handles restart/backlog. */
export async function isNextcloudTalkOutboundFileEcho(params: {
  account: ResolvedNextcloudTalkAccount;
  message: NextcloudTalkInboundMessage;
  signal?: AbortSignal;
}): Promise<boolean> {
  params.signal?.throwIfAborted();
  const { account, message } = params;
  const file = message.attachment;
  if (!file?.fileId) {
    return false;
  }
  if (
    isRecentOutboundMessageIdentity(
      echoIdentity(account.accountId, message.roomToken, message.senderId, file.fileId),
    )
  ) {
    return true;
  }
  const candidate = OUTBOUND_FILE_PREFIX.test(file.name);
  if (!candidate) {
    return false;
  }
  if (
    !account.secret ||
    resolveNextcloudTalkApiCredentialsResult(account.config).status !== "available"
  ) {
    return false;
  }
  try {
    const client = createFileClient(account);
    const uid = await client.user({ signal: params.signal });
    if (message.senderId !== `users/${uid}`) {
      return false;
    }
    const referenceId = fileReference(account, message.roomToken, uid, file.fileId);
    const history = await client.history(message.roomToken, message.messageId, {
      signal: params.signal,
    });
    params.signal?.throwIfAborted();
    return history.some(
      (entry) =>
        isRecord(entry) &&
        String(entry.id) === message.messageId &&
        entry.token === message.roomToken &&
        entry.actorType === "users" &&
        entry.actorId === uid &&
        entry.referenceId === referenceId &&
        isRecord(entry.messageParameters) &&
        isRecord(entry.messageParameters.file) &&
        String(entry.messageParameters.file.id) === file.fileId,
    );
  } catch {
    params.signal?.throwIfAborted();
    // A failed proof of authorship must not drop a human re-share.
    return false;
  }
}

export async function sendMediaNextcloudTalk(
  ctx: ChannelMessageSendMediaContext,
): Promise<NextcloudTalkSendResult> {
  const account = resolveNextcloudTalkAccount({
    cfg: ctx.cfg,
    accountId: ctx.accountId,
  });
  if (!account.enabled || !account.baseUrl || !account.secret) {
    throw new Error("Nextcloud Talk account is disabled or not configured.");
  }
  const roomToken = stripNextcloudTalkTargetPrefix(ctx.to);
  if (!roomToken) {
    throw new Error("Room token is required for Nextcloud Talk attachments.");
  }
  if (ctx.replyToId && !/^[1-9]\d*$/u.test(ctx.replyToId)) {
    throw new Error("Nextcloud Talk attachment replyTo must be a positive message ID.");
  }
  const client = createFileClient(account);
  const assertCurrent = () => {
    ctx.signal?.throwIfAborted();
    ctx.assertDirectAdapterHandoff?.();
  };
  const options = { signal: ctx.signal, beforeRequest: assertCurrent };
  assertCurrent();
  if (ctx.silent) {
    const data = await client.json("/ocs/v2.php/cloud/capabilities?format=json", {}, options);
    assertCurrent();
    const spreed =
      isRecord(data) && isRecord(data.capabilities) ? data.capabilities.spreed : undefined;
    // Talk gates silent file metadata on media-caption, not silent-send.
    if (
      !isRecord(spreed) ||
      !Array.isArray(spreed.features) ||
      !spreed.features.includes("media-caption")
    ) {
      throw new Error(
        "Nextcloud Talk silent attachments require the server's media-caption capability. Upgrade Talk before retrying.",
      );
    }
  }
  const maxBytes =
    resolveChannelMediaMaxBytes({
      cfg: ctx.cfg,
      accountId: account.accountId,
      resolveChannelLimitMb: () => account.config.mediaMaxMb,
    }) ?? 20 * 1024 * 1024;
  const media = await loadOutboundMediaFromUrl(ctx.mediaUrl, {
    maxBytes,
    mediaAccess: ctx.mediaAccess,
    mediaLocalRoots: ctx.mediaLocalRoots,
    mediaReadFile: ctx.mediaReadFile,
    optimizeImages: false,
  });
  assertCurrent();
  const uid = await client.user(options);
  const uploadId = randomUUID();
  const prefix = `openclaw-${uploadId}-`;
  const filename = sanitizeUntrustedFileName(media.fileName ?? "attachment.bin", "attachment.bin");
  const nameBudget = 250 - Buffer.byteLength(prefix);
  // Reserve room for a complete stem code point even for an oversized extension.
  const extension = truncateUtf8Prefix(path.extname(filename), nameBudget - 4);
  const stem = truncateUtf8Prefix(
    filename.slice(0, filename.length - path.extname(filename).length),
    nameBudget - Buffer.byteLength(extension),
  );
  const uploadFolderPath = `/OpenClaw/openclaw-${uploadId}`;
  const filePath = `${uploadFolderPath}/${prefix}${stem}${extension}`;
  const davRoot = `/remote.php/dav/files/${encodeURIComponent(uid)}`;
  const uploadFolder = `${davRoot}${uploadFolderPath}`;
  const davPath = `${davRoot}${filePath.split("/").map(encodeURIComponent).join("/")}`;
  let uploadFolderOwned = false;
  let publicationAttempted = false;
  try {
    await client.request(
      `${davRoot}/OpenClaw`,
      { method: "MKCOL" },
      async (response) => {
        if (response.status !== 201 && response.status !== 405) {
          throw new Error(`Nextcloud Talk attachment folder creation failed (${response.status}).`);
        }
      },
      options,
    );
    // Only a positively created private collection proves ownership after a lost PUT ack.
    await client.request(
      uploadFolder,
      { method: "MKCOL" },
      async (response) => {
        if (response.status !== 201) {
          throw new Error(
            `Nextcloud Talk private upload folder creation failed (${response.status}).`,
          );
        }
        uploadFolderOwned = true;
      },
      options,
    );
    await client.request(
      davPath,
      {
        method: "PUT",
        headers: {
          "If-None-Match": "*",
          "Content-Type": media.contentType ?? "application/octet-stream",
        },
        body: new Uint8Array(media.buffer),
      },
      async (response) => {
        if (response.status !== 201) {
          // A concurrent pre-existing file is not ours, even inside the private collection.
          if (response.status === 412) {
            uploadFolderOwned = false;
          }
          const recovery =
            response.status === 401
              ? "Check apiUser and update its app password (apiPassword/apiPasswordFile) before retrying."
              : response.status === 507
                ? "Free Files storage or increase the API user's quota before retrying."
                : "Check Nextcloud server logs and the API user's Files write access.";
          throw new Error(
            `Nextcloud Talk attachment upload failed (${response.status}). ${recovery}`,
          );
        }
      },
      options,
    );
    const fileId = await client.request(
      davPath,
      {
        method: "PROPFIND",
        headers: { Depth: "0", "Content-Type": "application/xml" },
        body: FILE_ID_REQUEST,
      },
      async (response) => {
        if (response.status !== 207) {
          throw new Error("Nextcloud Talk uploaded file identity unavailable.");
        }
        const id = parseWebDavFileId(
          await readProviderTextResponse(response, "Nextcloud Talk uploaded file identity", {
            maxBytes: 64 * 1024,
          }),
        );
        if (!id) {
          throw new Error("Nextcloud Talk uploaded file identity invalid.");
        }
        return id;
      },
      options,
    );
    const referenceId = fileReference(account, roomToken, uid, fileId);
    const caption = convertMarkdownTables(
      ctx.text.trim(),
      resolveMarkdownTableMode({
        cfg: ctx.cfg,
        channel: "nextcloud-talk",
        accountId: account.accountId,
      }),
    );
    const body = new URLSearchParams({
      path: filePath,
      shareType: "10",
      shareWith: roomToken,
      permissions: "1",
      referenceId,
      talkMetaData: JSON.stringify({
        caption,
        ...(ctx.silent ? { silent: true } : {}),
        ...(ctx.replyToId ? { replyTo: Number(ctx.replyToId) } : {}),
      }),
    });
    await ctx.onPlatformSendDispatch?.();
    assertCurrent();
    recordOutboundMessageIdentity(
      echoIdentity(account.accountId, roomToken, `users/${uid}`, fileId),
    );
    let publicationError: unknown;
    try {
      await client.json(
        "/ocs/v2.php/apps/files_sharing/api/v1/shares?format=json",
        { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
        {
          ...options,
          beforeRequest: () => {
            assertCurrent();
            publicationAttempted = true;
          },
        },
      );
    } catch (error) {
      if (!publicationAttempted) {
        throw error;
      }
      publicationError = error;
    }
    // A share response contains a share ID, not a chat ID. Even a failed POST
    // may have published; reconcile once without retrying or deleting its file.
    let history: unknown[];
    try {
      history = await client.history(roomToken);
    } catch (error) {
      throw new Error(
        "Nextcloud Talk attachment delivery not confirmed; uploaded file retained. Do not blindly retry.",
        { cause: error },
      );
    }
    const message = history.find(
      (entry) =>
        isRecord(entry) &&
        entry.token === roomToken &&
        entry.actorType === "users" &&
        entry.actorId === uid &&
        entry.referenceId === referenceId &&
        /^[1-9]\d*$/u.test(String(entry.id)) &&
        isRecord(entry.messageParameters) &&
        isRecord(entry.messageParameters.file) &&
        String(entry.messageParameters.file.id) === fileId,
    );
    if (!isRecord(message)) {
      throw new Error(
        "Nextcloud Talk attachment delivery not confirmed; uploaded file retained. Do not blindly retry.",
        { cause: publicationError },
      );
    }
    const messageId = String(message.id);
    const replyToId =
      isRecord(message.parent) && String(message.parent.id) === ctx.replyToId
        ? ctx.replyToId
        : undefined;
    recordOutboundMessageIdentity({
      channel: "nextcloud-talk",
      accountId: account.accountId,
      conversationId: roomToken,
      messageId,
    });
    getOptionalNextcloudTalkRuntime()?.channel.activity.record({
      channel: "nextcloud-talk",
      accountId: account.accountId,
      direction: "outbound",
    });
    return {
      messageId,
      roomToken,
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "nextcloud-talk", conversationId: roomToken, messageId }],
        kind: "media",
        ...(replyToId ? { replyToId } : {}),
      }),
    };
  } catch (error) {
    if (uploadFolderOwned && !publicationAttempted) {
      try {
        await client.request(uploadFolder, { method: "DELETE" }, async (response) => {
          if (!response.ok && response.status !== 404) {
            throw new Error("cleanup rejected", { cause: error });
          }
        });
      } catch {
        throw new Error(
          "Nextcloud Talk attachment failed before sharing; unshared upload cleanup also failed.",
          { cause: error },
        );
      }
    }
    throw error;
  }
}
