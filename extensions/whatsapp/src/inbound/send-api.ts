// Whatsapp API module exposes the plugin public contract.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AnyMessageContent,
  MiscMessageGenerationOptions,
  NewChatMessageCapInfo,
  ReachoutTimelockState,
  SignalKeyStoreWithTransaction,
  USyncQueryResult,
  WAMessage,
  WAPresence,
} from "baileys";
import { USyncQuery, USyncUser } from "baileys";
import { isTcTokenExpired, resolveTcTokenJid } from "baileys/lib/Utils/tc-token-utils.js";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import { redactIdentifier } from "openclaw/plugin-sdk/logging-core";
import { getChildLogger, logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveWhatsAppDocumentFileName } from "../document-filename.js";
import { addWhatsAppImagePreviewFields } from "../image-preview.js";
import { isWhatsAppNewsletterJid } from "../normalize.js";
import { buildQuotedMessageOptions } from "../quoted-message.js";
import { toWhatsappJid, toWhatsappJidWithLid } from "../text-runtime.js";
import {
  addWhatsAppOutboundMentionsToContent,
  type WhatsAppOutboundMentionResolution,
} from "./outbound-mentions.js";
import {
  combineWhatsAppSendResults,
  normalizeWhatsAppSendResult,
  type WhatsAppSendKind,
  type WhatsAppSendResult,
} from "./send-result.js";
import type { ActiveWebSendOptions } from "./types.js";

type StructuredContactSend = {
  displayName: string;
  vcard: string;
};

type StructuredLocationSend = {
  address?: string;
  degreesLatitude: number;
  degreesLongitude: number;
  name?: string;
};

type StructuredStickerSendOptions = {
  mimetype?: string;
};

type WhatsAppTokenKeyEntry = {
  token?: Buffer | Uint8Array | null;
  timestamp?: number | string | null;
  senderTimestamp?: number;
};

type WebSendSocket = {
  sendMessage: (
    jid: string,
    content: AnyMessageContent,
    options?: MiscMessageGenerationOptions,
  ) => Promise<WAMessage | undefined>;
  sendPresenceUpdate: (presence: WAPresence, jid?: string) => Promise<unknown>;
  executeUSyncQuery?: (query: USyncQuery) => Promise<USyncQueryResult | undefined>;
  getAuthState?: () => { keys: SignalKeyStoreWithTransaction } | undefined;
  getLIDForPN?: (jid: string) => Promise<string | null>;
  fetchAccountReachoutTimelock?: () => Promise<ReachoutTimelockState>;
  fetchNewChatMessageCap?: () => Promise<NewChatMessageCapInfo>;
};

const outboundTokenLogger = getChildLogger({
  module: "web-send",
  feature: "outbound-token-diagnostics",
});
const DIRECT_PN_SEND_JID_RE = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/i;
const DIRECT_LID_SEND_JID_RE = /^(\d+)(?::\d+)?@lid$/i;

function recordWhatsAppOutbound(accountId: string) {
  recordChannelActivity({
    channel: "whatsapp",
    accountId,
    direction: "outbound",
  });
}

function supportsForcedDocumentMediaType(mediaType: string): boolean {
  return mediaType.startsWith("image/") || mediaType.startsWith("video/");
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function normalizeDirectLidJid(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") {
    return null;
  }
  const value = String(raw).trim();
  const match = value.match(DIRECT_LID_SEND_JID_RE);
  if (match) {
    return `${match[1]}@lid`;
  }
  if (value.includes("@")) {
    return null;
  }
  const digits = value.replace(/\D/g, "");
  return digits ? `${digits}@lid` : null;
}

function normalizeDirectPnDigits(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") {
    return null;
  }
  const value = String(raw).trim();
  const match = value.match(DIRECT_PN_SEND_JID_RE);
  if (match) {
    return match[1];
  }
  const digits = value.replace(/\D/g, "");
  return digits || null;
}

function findUsyncLidJid(result: USyncQueryResult | undefined, phoneDigits: string): string | null {
  for (const entry of result?.list ?? []) {
    const record = entry as Record<string, unknown>;
    const entryPhone = normalizeDirectPnDigits(record.id);
    if (entryPhone && entryPhone !== phoneDigits) {
      continue;
    }
    const lidJid = normalizeDirectLidJid(record.lid);
    if (lidJid) {
      return lidJid;
    }
  }
  return null;
}

async function persistOutboundLidMapping(params: {
  authDir: string;
  phoneDigits: string;
  lidJid: string;
}): Promise<void> {
  const lidDigits = normalizeDirectLidJid(params.lidJid)?.replace(/\D/g, "");
  if (!lidDigits) {
    return;
  }
  await fs.mkdir(params.authDir, { recursive: true });
  await Promise.all([
    writeJsonFile(path.join(params.authDir, `lid-mapping-${params.phoneDigits}.json`), lidDigits),
    writeJsonFile(
      path.join(params.authDir, `lid-mapping-${lidDigits}_reverse.json`),
      params.phoneDigits,
    ),
  ]);
}

async function persistAndResolveOutboundLidMapping(params: {
  authDir: string;
  recipient: string;
  localJid: string;
  phoneDigits: string;
  lidJid: string;
  source: "Baileys LID mapping" | "USync";
}): Promise<string> {
  await persistOutboundLidMapping({
    authDir: params.authDir,
    phoneDigits: params.phoneDigits,
    lidJid: params.lidJid,
  });
  const resolved =
    normalizeDirectLidJid(params.lidJid) ??
    toWhatsappJidWithLid(params.recipient, { authDir: params.authDir });
  if (resolved !== params.localJid) {
    outboundTokenLogger.info(
      {
        to: redactIdentifier(params.recipient),
        pnJid: redactIdentifier(params.localJid),
        lidJid: redactIdentifier(resolved),
      },
      `resolved outbound WhatsApp PN target to LID via ${params.source}`,
    );
  }
  return resolved;
}

async function resolveOutboundJidWithUsync(params: {
  sock: WebSendSocket;
  authDir?: string;
  recipient: string;
}): Promise<string> {
  const localJid = params.authDir
    ? toWhatsappJidWithLid(params.recipient, { authDir: params.authDir })
    : toWhatsappJid(params.recipient);
  const phoneDigits = localJid.match(DIRECT_PN_SEND_JID_RE)?.[1];
  if (!params.authDir || !phoneDigits) {
    return localJid;
  }
  try {
    const lidJid = normalizeDirectLidJid(await params.sock.getLIDForPN?.(localJid));
    if (lidJid) {
      return await persistAndResolveOutboundLidMapping({
        authDir: params.authDir,
        recipient: params.recipient,
        localJid,
        phoneDigits,
        lidJid,
        source: "Baileys LID mapping",
      });
    }
  } catch (err) {
    logVerbose(`WhatsApp outbound Baileys LID lookup failed: ${String(err)}`);
  }
  if (!params.sock.executeUSyncQuery) {
    return localJid;
  }
  try {
    const query = new USyncQuery()
      .withContext("interactive")
      .withMode("query")
      .withContactProtocol()
      .withLIDProtocol()
      .withUser(new USyncUser().withId(localJid));
    const result = await params.sock.executeUSyncQuery(query);
    const lidJid = findUsyncLidJid(result, phoneDigits);
    if (!lidJid) {
      return localJid;
    }
    return await persistAndResolveOutboundLidMapping({
      authDir: params.authDir,
      recipient: params.recipient,
      localJid,
      phoneDigits,
      lidJid,
      source: "USync",
    });
  } catch (err) {
    logVerbose(`WhatsApp outbound USync LID lookup failed: ${String(err)}`);
    return localJid;
  }
}

function hasUsableTcToken(entry: WhatsAppTokenKeyEntry | undefined): boolean {
  const tokenLength = entry?.token?.length ?? 0;
  return tokenLength > 0 && !isTcTokenExpired(entry?.timestamp);
}

function describeTcTokenEntry(entry: WhatsAppTokenKeyEntry | undefined) {
  const token = entry?.token;
  const tokenLength = token?.length ?? 0;
  const tokenSha256 =
    token && tokenLength > 0
      ? createHash("sha256").update(Buffer.from(token)).digest("hex").slice(0, 12)
      : undefined;
  return {
    tokenLength,
    tokenSha256,
    timestamp: entry?.timestamp,
    senderTimestamp: entry?.senderTimestamp,
    expired: tokenLength > 0 ? isTcTokenExpired(entry?.timestamp) : undefined,
  };
}

async function readOutboundTcTokenEntry(params: {
  keys: SignalKeyStoreWithTransaction;
  tcTokenJid: string;
}): Promise<WhatsAppTokenKeyEntry | undefined> {
  const entries = await params.keys.get("tctoken", [params.tcTokenJid]);
  return entries[params.tcTokenJid] as WhatsAppTokenKeyEntry | undefined;
}

async function maybeFetchOutboundTokenDiagnostics(params: { sock: WebSendSocket }): Promise<{
  reachoutTimelock?: ReachoutTimelockState;
  newChatMessageCap?: NewChatMessageCapInfo;
}> {
  const [reachoutTimelock, newChatMessageCap] = await Promise.all([
    params.sock.fetchAccountReachoutTimelock?.().catch((err: unknown) => {
      logVerbose(`WhatsApp reachout timelock lookup failed: ${String(err)}`);
      return undefined;
    }),
    params.sock.fetchNewChatMessageCap?.().catch((err: unknown) => {
      logVerbose(`WhatsApp new-chat message cap lookup failed: ${String(err)}`);
      return undefined;
    }),
  ]);
  return { reachoutTimelock, newChatMessageCap };
}

function formatDateForError(value: Date | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const time = value.getTime();
  return Number.isFinite(time) ? value.toISOString() : undefined;
}

function buildReachoutTimelockError(params: {
  jid: string;
  tcTokenJid: string;
  reachoutTimelock: ReachoutTimelockState;
  newChatMessageCap?: NewChatMessageCapInfo;
}): Error {
  const until = formatDateForError(params.reachoutTimelock.timeEnforcementEnds);
  const reason = params.reachoutTimelock.enforcementType
    ? ` type ${params.reachoutTimelock.enforcementType}`
    : "";
  const quota =
    params.newChatMessageCap?.used_quota !== undefined &&
    params.newChatMessageCap?.total_quota !== undefined
      ? ` new-chat quota ${params.newChatMessageCap.used_quota}/` +
        `${params.newChatMessageCap.total_quota}.`
      : "";
  return new Error(
    `WhatsApp reachout timelock is active${reason}${until ? ` until ${until}` : ""}; ` +
      `missing trusted-contact privacy token for ${redactIdentifier(params.jid)} ` +
      `(${redactIdentifier(params.tcTokenJid)}), so WhatsApp Web may accept the request ` +
      `without delivering a visible 1:1 message.${quota}`,
  );
}

async function ensureOutboundTcToken(params: { sock: WebSendSocket; jid: string }): Promise<void> {
  if (!DIRECT_PN_SEND_JID_RE.test(params.jid) && !DIRECT_LID_SEND_JID_RE.test(params.jid)) {
    return;
  }
  const authState = params.sock.getAuthState?.();
  const getLIDForPN = params.sock.getLIDForPN;
  if (!authState?.keys || !getLIDForPN) {
    return;
  }
  const tcTokenJid = await resolveTcTokenJid(params.jid, async (jid) => await getLIDForPN(jid));
  const entry = await readOutboundTcTokenEntry({ keys: authState.keys, tcTokenJid });
  if (hasUsableTcToken(entry)) {
    outboundTokenLogger.debug(
      {
        jid: redactIdentifier(params.jid),
        tcTokenJid: redactIdentifier(tcTokenJid),
        token: describeTcTokenEntry(entry),
      },
      "using outbound WhatsApp trusted-contact token",
    );
    return;
  }
  const diagnostics = await maybeFetchOutboundTokenDiagnostics({ sock: params.sock });
  const logMissingToken = diagnostics.reachoutTimelock?.isActive
    ? outboundTokenLogger.warn.bind(outboundTokenLogger)
    : outboundTokenLogger.info.bind(outboundTokenLogger);
  logMissingToken(
    {
      jid: redactIdentifier(params.jid),
      tcTokenJid: redactIdentifier(tcTokenJid),
      token: describeTcTokenEntry(entry),
      reachoutTimelock: diagnostics.reachoutTimelock,
      newChatMessageCap: diagnostics.newChatMessageCap,
    },
    "missing outbound WhatsApp trusted-contact token",
  );
  if (diagnostics.reachoutTimelock?.isActive) {
    throw buildReachoutTimelockError({
      jid: params.jid,
      tcTokenJid,
      reachoutTimelock: diagnostics.reachoutTimelock,
      newChatMessageCap: diagnostics.newChatMessageCap,
    });
  }
}

export function createWebSendApi(params: {
  sock: WebSendSocket;
  defaultAccountId: string;
  resolveOutboundMentions?: (params: {
    jid: string;
    text: string;
  }) => Promise<WhatsAppOutboundMentionResolution> | WhatsAppOutboundMentionResolution;
  // When provided, lets outbound resolve `{phone}@s.whatsapp.net` to `{lid}@lid`
  // via Baileys' lid-mapping-{phone-digits}.json files in the auth dir, so
  // proactive sends to LID-addressed contacts reach the recipient instead of
  // ending up in a sender-only ghost chat (#67378). Defaults to PN-only.
  authDir?: string;
}) {
  const resolveOutboundJid = (recipient: string): Promise<string> =>
    resolveOutboundJidWithUsync({ sock: params.sock, authDir: params.authDir, recipient });
  const resolveMentions = async (
    jid: string,
    text: string,
  ): Promise<WhatsAppOutboundMentionResolution> =>
    params.resolveOutboundMentions
      ? await params.resolveOutboundMentions({ jid, text })
      : { text, mentionedJids: [] };
  const sendStructuredMessage = async (
    to: string,
    content: AnyMessageContent,
    kind: WhatsAppSendKind,
  ): Promise<WhatsAppSendResult> => {
    const jid = await resolveOutboundJid(to);
    await ensureOutboundTcToken({ sock: params.sock, jid });
    const result = await params.sock.sendMessage(jid, content);
    recordWhatsAppOutbound(params.defaultAccountId);
    return normalizeWhatsAppSendResult(result, kind);
  };

  return {
    sendMessage: async (
      to: string,
      text: string,
      mediaBuffer?: Buffer,
      mediaTypeInput?: string,
      sendOptions?: ActiveWebSendOptions,
    ): Promise<WhatsAppSendResult> => {
      let mediaType = mediaTypeInput;
      const jid = await resolveOutboundJid(to);
      let payload: AnyMessageContent;
      if (mediaBuffer) {
        mediaType ??= "application/octet-stream";
      }
      const shouldSendAudioText = Boolean(
        mediaBuffer && mediaType?.startsWith("audio/") && text.trim(),
      );
      const resolvedPayloadText = shouldSendAudioText
        ? { text, mentionedJids: [] }
        : await resolveMentions(jid, text);
      if (mediaBuffer && mediaType) {
        if (sendOptions?.asDocument === true && supportsForcedDocumentMediaType(mediaType)) {
          const fileName = resolveWhatsAppDocumentFileName({
            fileName: sendOptions?.fileName,
            mimetype: mediaType,
          });
          payload = {
            document: mediaBuffer,
            fileName,
            caption: resolvedPayloadText.text || undefined,
            mimetype: mediaType,
          };
        } else if (mediaType.startsWith("image/")) {
          payload = await addWhatsAppImagePreviewFields({
            image: mediaBuffer,
            caption: resolvedPayloadText.text || undefined,
            mimetype: mediaType,
          });
        } else if (mediaType.startsWith("audio/")) {
          payload = { audio: mediaBuffer, ptt: true, mimetype: mediaType };
        } else if (mediaType.startsWith("video/")) {
          const gifPlayback = sendOptions?.gifPlayback;
          payload = {
            video: mediaBuffer,
            caption: resolvedPayloadText.text || undefined,
            mimetype: mediaType,
            ...(gifPlayback ? { gifPlayback: true } : {}),
          };
        } else {
          const fileName = resolveWhatsAppDocumentFileName({
            fileName: sendOptions?.fileName,
            mimetype: mediaType,
          });
          payload = {
            document: mediaBuffer,
            fileName,
            caption: resolvedPayloadText.text || undefined,
            mimetype: mediaType,
          };
        }
      } else {
        payload = { text: resolvedPayloadText.text };
      }
      payload = addWhatsAppOutboundMentionsToContent(payload, resolvedPayloadText.mentionedJids);
      const quotedOpts = buildQuotedMessageOptions({
        messageId: sendOptions?.quotedMessageKey?.id,
        remoteJid: sendOptions?.quotedMessageKey?.remoteJid,
        fromMe: sendOptions?.quotedMessageKey?.fromMe,
        participant: sendOptions?.quotedMessageKey?.participant,
        messageText: sendOptions?.quotedMessageKey?.messageText,
      });
      await ensureOutboundTcToken({ sock: params.sock, jid });
      const result = quotedOpts
        ? await params.sock.sendMessage(jid, payload, quotedOpts)
        : await params.sock.sendMessage(jid, payload);
      const results = [normalizeWhatsAppSendResult(result, mediaBuffer ? "media" : "text")];
      if (shouldSendAudioText) {
        const resolvedAudioText = await resolveMentions(jid, text);
        const textPayload = addWhatsAppOutboundMentionsToContent(
          { text: resolvedAudioText.text },
          resolvedAudioText.mentionedJids,
        );
        const textResult = quotedOpts
          ? await params.sock.sendMessage(jid, textPayload, quotedOpts)
          : await params.sock.sendMessage(jid, textPayload);
        results.push(normalizeWhatsAppSendResult(textResult, "text"));
      }
      const accountId = sendOptions?.accountId ?? params.defaultAccountId;
      recordWhatsAppOutbound(accountId);
      return combineWhatsAppSendResults(mediaBuffer ? "media" : "text", results);
    },
    sendPoll: async (
      to: string,
      poll: { question: string; options: string[]; maxSelections?: number },
    ): Promise<WhatsAppSendResult> => {
      return await sendStructuredMessage(
        to,
        {
          poll: {
            name: poll.question,
            values: poll.options,
            selectableCount: poll.maxSelections ?? 1,
          },
        } as AnyMessageContent,
        "poll",
      );
    },
    sendContact: async (
      to: string,
      contact: StructuredContactSend,
    ): Promise<WhatsAppSendResult> => {
      return await sendStructuredMessage(
        to,
        {
          contacts: {
            displayName: contact.displayName,
            contacts: [
              {
                displayName: contact.displayName,
                vcard: contact.vcard,
              },
            ],
          },
        } as AnyMessageContent,
        "contact",
      );
    },
    sendLocation: async (
      to: string,
      location: StructuredLocationSend,
    ): Promise<WhatsAppSendResult> => {
      return await sendStructuredMessage(
        to,
        {
          location: {
            degreesLatitude: location.degreesLatitude,
            degreesLongitude: location.degreesLongitude,
            name: location.name,
            address: location.address,
          },
        } as AnyMessageContent,
        "location",
      );
    },
    sendSticker: async (
      to: string,
      stickerBuffer: Buffer,
      options?: StructuredStickerSendOptions,
    ): Promise<WhatsAppSendResult> => {
      return await sendStructuredMessage(
        to,
        {
          sticker: stickerBuffer,
          mimetype: options?.mimetype ?? "image/webp",
        } as AnyMessageContent,
        "sticker",
      );
    },
    sendReaction: async (
      chatJid: string,
      messageId: string,
      emoji: string,
      fromMe: boolean,
      participant?: string,
    ): Promise<WhatsAppSendResult> => {
      // Resolve DM targets through the same LID-aware path as normal sends so
      // reactions land on the delivered WhatsApp message key.
      const jid = await resolveOutboundJid(chatJid);
      const result = await params.sock.sendMessage(jid, {
        react: {
          text: emoji,
          key: {
            remoteJid: jid,
            id: messageId,
            fromMe,
            participant: participant ? toWhatsappJid(participant) : undefined,
          },
        },
      } as AnyMessageContent);
      return normalizeWhatsAppSendResult(result, "reaction");
    },
    sendComposingTo: async (to: string): Promise<void> => {
      const jid = await resolveOutboundJid(to);
      if (isWhatsAppNewsletterJid(jid)) {
        return;
      }
      await params.sock.sendPresenceUpdate("composing", jid);
    },
  } as const;
}
