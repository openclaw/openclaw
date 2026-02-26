import crypto from "crypto";
import {
  CONTROL_CONTENT_TYPES,
  DISPLAYABLE_CONTENT_TYPES,
  type MessageContentType,
  type MessageData,
  type MessageOptions,
} from "./types.js";

/**
 * Generate the NKN topic hash from a human-readable topic name.
 * nMobile convention: strip leading '#', SHA-1 hash, hex-encode, prefix with "dchat".
 */
export function genTopicHash(topicName: string): string {
  const cleaned = topicName.replace(/^#+/, "");
  const hash = crypto.createHash("sha1").update(cleaned).digest("hex");
  return "dchat" + hash;
}

/**
 * Parse a raw NKN payload string into a MessageData object.
 * Returns null if the payload is not valid JSON or missing required fields.
 */
export function parseNknPayload(raw: string): MessageData | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (!parsed.id || !parsed.contentType) return null;
    return parsed as MessageData;
  } catch {
    return null;
  }
}

/**
 * Strip NKN MultiClient sub-client prefix (__N__.) from an address.
 * e.g. "__0__.cd3530..." → "cd3530..."
 */
export function stripNknSubClientPrefix(addr: string): string {
  return addr.replace(/^__\d+__\./, "");
}

/** Returns true if the content type is a control message (not forwarded to agent). */
export function isControlMessage(contentType: string): boolean {
  return CONTROL_CONTENT_TYPES.has(contentType);
}

/** Returns true if the content type carries displayable content. */
export function isDisplayableMessage(contentType: string): boolean {
  return DISPLAYABLE_CONTENT_TYPES.has(contentType);
}

export interface InboundMessageResult {
  body: string;
  chatType: "direct" | "group";
  sessionKey: string;
  senderId: string;
  senderName: string;
  groupSubject?: string;
  ipfsHash?: string;
  ipfsOptions?: MessageOptions;
}

/**
 * Translate an inbound NKN MessageData to OpenClaw inbound context fields.
 * Returns null for control messages that should not be forwarded.
 */
export function nknToInbound(
  src: string,
  msg: MessageData,
  selfAddress: string,
  opts?: { accountId?: string },
): InboundMessageResult | null {
  if (isControlMessage(msg.contentType)) {
    return null;
  }

  if (!isDisplayableMessage(msg.contentType)) {
    return null;
  }

  // Determine chat type and session key
  const hasTopic = Boolean(msg.topic);
  const hasGroupId = Boolean(msg.groupId);
  const chatType: "direct" | "group" = hasTopic || hasGroupId ? "group" : "direct";

  let sessionKey: string;
  let groupSubject: string | undefined;
  if (hasTopic) {
    sessionKey = `dchat:topic:${msg.topic}`;
    groupSubject = `#${msg.topic}`;
  } else if (hasGroupId) {
    sessionKey = `dchat:group:${msg.groupId}`;
    groupSubject = msg.groupId;
  } else {
    // Include account identity to prevent session key collisions in multi-account setups
    const acct = opts?.accountId;
    sessionKey = acct && acct !== "default" ? `dchat:${acct}:dm:${src}` : `dchat:dm:${src}`;
  }

  // Extract body text
  let body: string;
  const ct = msg.contentType;

  if (ct === "text" || ct === "textExtension") {
    body = msg.content ?? "";
  } else if (ct === "ipfs") {
    const fileType = msg.options?.fileType;
    const isImage = fileType === 1 || fileType === "1" || fileType === undefined;
    const isAudio = fileType === 2 || fileType === "2";
    const isFile = fileType === 0 || fileType === "0";
    if (isImage) {
      body = "[Image]";
    } else if (isAudio) {
      body = "[Audio]";
    } else if (isFile) {
      const fileName = msg.options?.fileName;
      body = fileName ? `[File: ${fileName}]` : "[File]";
    } else {
      body = "[IPFS content]";
    }
  } else if (ct === "audio") {
    body = "[Voice Message]";
  } else if (ct === "image") {
    body = "[Image]";
  } else if (ct === "video") {
    body = "[Video]";
  } else if (ct === "file") {
    body = "[File]";
  } else {
    body = msg.content ?? "";
  }

  // Short sender name: first 8 chars of NKN address
  const senderName = src.length > 16 ? src.substring(0, 8) + "..." : src;

  return {
    body,
    chatType,
    sessionKey,
    senderId: src,
    senderName,
    groupSubject,
    ipfsHash: msg.options?.ipfsHash || (ct === "ipfs" ? msg.content : undefined),
    ipfsOptions: ct === "ipfs" || ct === "audio" ? msg.options : undefined,
  };
}

/**
 * Build an outbound NKN MessageData from text.
 * Sets appropriate content type and topic/groupId fields.
 */
export function textToNkn(
  text: string,
  opts?: {
    topic?: string;
    groupId?: string;
  },
): MessageData {
  return {
    id: crypto.randomUUID(),
    contentType: "text" as MessageContentType,
    content: text,
    ...(opts?.topic ? { topic: opts.topic } : {}),
    ...(opts?.groupId ? { groupId: opts.groupId } : {}),
    timestamp: Date.now(),
  };
}

/**
 * Build an outbound NKN MessageData for IPFS media (image/file).
 */
export function ipfsToNkn(
  options: MessageOptions,
  opts?: {
    topic?: string;
    groupId?: string;
  },
): MessageData {
  return {
    id: crypto.randomUUID(),
    contentType: "ipfs" as MessageContentType,
    content: options.ipfsHash,
    options,
    ...(opts?.topic ? { topic: opts.topic } : {}),
    ...(opts?.groupId ? { groupId: opts.groupId } : {}),
    timestamp: Date.now(),
  };
}

/**
 * Build a delivery receipt MessageData.
 */
export function receiptToNkn(targetMessageId: string): MessageData {
  return {
    id: crypto.randomUUID(),
    contentType: "receipt" as MessageContentType,
    targetID: targetMessageId,
    timestamp: Date.now(),
  };
}

/**
 * Extract a topic name from a session key.
 * dchat:topic:general -> "general"
 * dchat:dm:addr -> undefined
 */
export function extractTopicFromSessionKey(sessionKey: string): string | undefined {
  const match = sessionKey.match(/^dchat:topic:(.+)$/);
  return match?.[1];
}

/**
 * Extract a group ID from a session key.
 * dchat:group:abc123 -> "abc123"
 */
export function extractGroupIdFromSessionKey(sessionKey: string): string | undefined {
  const match = sessionKey.match(/^dchat:group:(.+)$/);
  return match?.[1];
}

/**
 * Extract a direct message address from a session key.
 * dchat:dm:addr -> "addr"
 * dchat:<accountId>:dm:addr -> "addr"
 */
export function extractDmAddressFromSessionKey(sessionKey: string): string | undefined {
  const match = sessionKey.match(/^dchat:(?:[^:]+:)?dm:(.+)$/);
  return match?.[1];
}
