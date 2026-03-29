import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, type OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import { kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { resolveOutboundAttachmentFromUrl } from "openclaw/plugin-sdk/media-runtime";
import { resolveSignalAccount } from "./accounts.js";
import { signalRpcRequest } from "./client.js";
import { markdownToSignalText, type SignalTextStyleRange } from "./format.js";
import { resolveSignalRpcContext } from "./rpc-context.js";

/**
 * Convert a local file path to a data URI so signal-cli can receive the
 * attachment inline (useful when signal-cli runs on a different host).
 */
async function localFileToDataUri(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  const mimeMap: Record<string, string> = {
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    mp4: "video/mp4",
    pdf: "application/pdf",
  };
  const mime = mimeMap[ext] ?? "application/octet-stream";
  const fname = path.basename(filePath);
  return `data:${mime};filename=${fname};base64,${buf.toString("base64")}`;
}

export type SignalSendOpts = {
  cfg?: OpenClawConfig;
  baseUrl?: string;
  account?: string;
  accountId?: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  maxBytes?: number;
  timeoutMs?: number;
  textMode?: "markdown" | "plain";
  textStyles?: SignalTextStyleRange[];
};

export type SignalSendResult = {
  messageId: string;
  timestamp?: number;
};

export type SignalRpcOpts = Pick<SignalSendOpts, "baseUrl" | "account" | "accountId" | "timeoutMs">;

export type SignalReceiptType = "read" | "viewed";

type SignalTarget =
  | { type: "recipient"; recipient: string }
  | { type: "group"; groupId: string }
  | { type: "username"; username: string };

function parseTarget(raw: string): SignalTarget {
  let value = raw.trim();
  if (!value) {
    throw new Error("Signal recipient is required");
  }
  const lower = value.toLowerCase();
  if (lower.startsWith("signal:")) {
    value = value.slice("signal:".length).trim();
  }
  const normalized = value.toLowerCase();
  if (normalized.startsWith("group:")) {
    return { type: "group", groupId: value.slice("group:".length).trim() };
  }
  if (normalized.startsWith("username:")) {
    return {
      type: "username",
      username: value.slice("username:".length).trim(),
    };
  }
  if (normalized.startsWith("u:")) {
    return { type: "username", username: value.trim() };
  }
  return { type: "recipient", recipient: value };
}

type SignalTargetParams = {
  recipient?: string[];
  groupId?: string;
  username?: string[];
};

type SignalTargetAllowlist = {
  recipient?: boolean;
  group?: boolean;
  username?: boolean;
};

function buildTargetParams(
  target: SignalTarget,
  allow: SignalTargetAllowlist,
): SignalTargetParams | null {
  if (target.type === "recipient") {
    if (!allow.recipient) {
      return null;
    }
    return { recipient: [target.recipient] };
  }
  if (target.type === "group") {
    if (!allow.group) {
      return null;
    }
    return { groupId: target.groupId };
  }
  if (target.type === "username") {
    if (!allow.username) {
      return null;
    }
    return { username: [target.username] };
  }
  return null;
}

export async function sendMessageSignal(
  to: string,
  text: string,
  opts: SignalSendOpts = {},
): Promise<SignalSendResult> {
  const cfg = opts.cfg ?? loadConfig();
  const accountInfo = resolveSignalAccount({
    cfg,
    accountId: opts.accountId,
  });
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const target = parseTarget(to);
  let message = text ?? "";
  let messageFromPlaceholder = false;
  let textStyles: SignalTextStyleRange[] = [];
  const textMode = opts.textMode ?? "markdown";
  const maxBytes = (() => {
    if (typeof opts.maxBytes === "number") {
      return opts.maxBytes;
    }
    if (typeof accountInfo.config.mediaMaxMb === "number") {
      return accountInfo.config.mediaMaxMb * 1024 * 1024;
    }
    if (typeof cfg.agents?.defaults?.mediaMaxMb === "number") {
      return cfg.agents.defaults.mediaMaxMb * 1024 * 1024;
    }
    return 8 * 1024 * 1024;
  })();

  let attachments: string[] | undefined;
  if (opts.mediaUrl?.trim()) {
    const resolved = await resolveOutboundAttachmentFromUrl(opts.mediaUrl.trim(), maxBytes, {
      localRoots: opts.mediaLocalRoots,
    });
    // Convert to data URI only for remote signal-cli (non-localhost baseUrl),
    // since remote hosts cannot access local file paths. Local signal-cli
    // can handle file paths directly and avoids unnecessary base64 encoding.
    const isRemote = baseUrl != null && !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(baseUrl);
    const attachmentRef = isRemote ? await localFileToDataUri(resolved.path) : resolved.path;
    attachments = [attachmentRef];
    const kind = kindFromMime(resolved.contentType ?? undefined);
    if (!message && kind) {
      // Avoid sending an empty body when only attachments exist.
      message = kind === "image" ? "<media:image>" : `<media:${kind}>`;
      messageFromPlaceholder = true;
    }
  }

  if (message.trim() && !messageFromPlaceholder) {
    if (textMode === "plain") {
      textStyles = opts.textStyles ?? [];
    } else {
      const tableMode = resolveMarkdownTableMode({
        cfg,
        channel: "signal",
        accountId: accountInfo.accountId,
      });
      const formatted = markdownToSignalText(message, { tableMode });
      message = formatted.text;
      textStyles = formatted.styles;
    }
  }

  if (!message.trim() && (!attachments || attachments.length === 0)) {
    throw new Error("Signal send requires text or media");
  }

  const params: Record<string, unknown> = { message };
  if (textStyles.length > 0) {
    params["text-style"] = textStyles.map(
      (style) => `${style.start}:${style.length}:${style.style}`,
    );
  }
  if (account) {
    params.account = account;
  }
  if (attachments && attachments.length > 0) {
    params.attachments = attachments;
  }

  const targetParams = buildTargetParams(target, {
    recipient: true,
    group: true,
    username: true,
  });
  if (!targetParams) {
    throw new Error("Signal recipient is required");
  }
  Object.assign(params, targetParams);

  const result = await signalRpcRequest<{ timestamp?: number }>("send", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
  const timestamp = result?.timestamp;
  return {
    messageId: timestamp ? String(timestamp) : "unknown",
    timestamp,
  };
}

export async function sendTypingSignal(
  to: string,
  opts: SignalRpcOpts & { stop?: boolean } = {},
): Promise<boolean> {
  const { baseUrl, account } = resolveSignalRpcContext(opts);
  const targetParams = buildTargetParams(parseTarget(to), {
    recipient: true,
    group: true,
  });
  if (!targetParams) {
    return false;
  }
  const params: Record<string, unknown> = { ...targetParams };
  if (account) {
    params.account = account;
  }
  if (opts.stop) {
    params.stop = true;
  }
  await signalRpcRequest("sendTyping", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
  return true;
}

export async function sendReadReceiptSignal(
  to: string,
  targetTimestamp: number,
  opts: SignalRpcOpts & { type?: SignalReceiptType } = {},
): Promise<boolean> {
  if (!Number.isFinite(targetTimestamp) || targetTimestamp <= 0) {
    return false;
  }
  const { baseUrl, account } = resolveSignalRpcContext(opts);
  const targetParams = buildTargetParams(parseTarget(to), {
    recipient: true,
  });
  if (!targetParams) {
    return false;
  }
  const params: Record<string, unknown> = {
    ...targetParams,
    targetTimestamp,
    type: opts.type ?? "read",
  };
  if (account) {
    params.account = account;
  }
  await signalRpcRequest("sendReceipt", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
  return true;
}
