import crypto from "node:crypto";
import { logger } from "../logger.js";

const TICKET_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_TICKETS = 500;

const ticketStore = new Map();

function normalizeCode(code) {
  return String(code || "").trim().toUpperCase();
}

function sanitizeUserId(userId) {
  const trimmed = String(userId || "").trim();
  return trimmed || null;
}

function cleanupExpiredTickets(now = Date.now()) {
  for (const [code, ticket] of ticketStore) {
    if (ticket.expiresAt <= now) {
      ticketStore.delete(code);
    }
  }

  if (ticketStore.size <= MAX_TICKETS) return;

  const ordered = [...ticketStore.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  const overflow = ticketStore.size - MAX_TICKETS;
  for (let i = 0; i < overflow; i += 1) {
    ticketStore.delete(ordered[i][0]);
  }
}

function generateTicketCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 8; i += 1) {
    code += alphabet[crypto.randomInt(0, alphabet.length)];
  }
  return code;
}

export function createUploadTicket({
  filePath,
  fileName,
  mimeType,
  size,
  ownerUserId,
  accountId,
  note,
}) {
  cleanupExpiredTickets();

  let code = generateTicketCode();
  while (ticketStore.has(code)) {
    code = generateTicketCode();
  }

  const now = Date.now();
  const ticket = {
    code,
    filePath,
    fileName,
    mimeType: mimeType || "application/octet-stream",
    size: Number(size) || 0,
    ownerUserId: sanitizeUserId(ownerUserId),
    accountId: String(accountId || "default"),
    note: String(note || "").trim(),
    createdAt: now,
    expiresAt: now + TICKET_TTL_MS,
  };

  ticketStore.set(code, ticket);
  logger.info("[upload-ticket] created", {
    code,
    ownerUserId: ticket.ownerUserId || "any",
    accountId: ticket.accountId,
    size: ticket.size,
    fileName: ticket.fileName,
  });

  return ticket;
}

export function parsePickupCommand(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  // 支持：取件 ABCD1234 /pickup ABCD1234 /提取 ABCD1234
  const match = raw.match(/^\/?(?:pickup|pick|取件|提取|附件)\s+([A-Za-z0-9_-]{6,64})(?:\s+([\s\S]+))?$/i);
  if (!match) return null;

  return {
    code: normalizeCode(match[1]),
    extraPrompt: String(match[2] || "").trim(),
  };
}

export function consumeUploadTicket({ code, requesterUserId, accountId }) {
  cleanupExpiredTickets();

  const normalized = normalizeCode(code);
  const ticket = ticketStore.get(normalized);
  if (!ticket) {
    return { ok: false, reason: "not_found" };
  }

  const now = Date.now();
  if (ticket.expiresAt <= now) {
    ticketStore.delete(normalized);
    return { ok: false, reason: "expired" };
  }

  const requester = sanitizeUserId(requesterUserId);
  if (ticket.ownerUserId && requester && ticket.ownerUserId !== requester) {
    return { ok: false, reason: "forbidden" };
  }

  if (accountId && String(accountId) !== String(ticket.accountId)) {
    return { ok: false, reason: "wrong_account" };
  }

  ticketStore.delete(normalized);
  logger.info("[upload-ticket] consumed", {
    code: normalized,
    requesterUserId: requester || "unknown",
    accountId: accountId || "default",
    fileName: ticket.fileName,
  });
  return { ok: true, ticket };
}

export function describeTicketFailure(reason) {
  switch (reason) {
    case "expired":
      return "取件码已过期，请重新上传文件。";
    case "forbidden":
      return "这个取件码绑定了其他成员，当前账号无权使用。";
    case "wrong_account":
      return "取件码与当前机器人账号不匹配，请在对应应用里使用。";
    case "not_found":
    default:
      return "未找到对应取件码，请检查是否输入正确。";
  }
}

export function listPendingTicketCount() {
  cleanupExpiredTickets();
  return ticketStore.size;
}
