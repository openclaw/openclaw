import { randomBytes } from "node:crypto";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { PendingApproval } from "../settings.js";

function generateApprovalId(type: PendingApproval["type"]): string {
  const timestamp = Date.now();
  const randomPart = randomBytes(3).toString("hex");
  return `${type}-${timestamp}-${randomPart}`;
}

export function createPendingApproval(
  params: Omit<PendingApproval, "id" | "timestamp">,
): PendingApproval {
  return {
    id: generateApprovalId(params.type),
    type: params.type,
    requestingShip: params.requestingShip,
    channelNest: params.channelNest,
    groupFlag: params.groupFlag,
    messagePreview:
      params.messagePreview != null ? sliceUtf16Safe(params.messagePreview, 0, 100) : undefined,
    originalMessage: params.originalMessage,
    timestamp: Date.now(),
  };
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return sliceUtf16Safe(text, 0, maxLength - 3) + "...";
}

export function formatApprovalRequest(approval: PendingApproval): string {
  const preview = approval.messagePreview ? `\n"${truncate(approval.messagePreview, 100)}"` : "";

  switch (approval.type) {
    case "dm":
      return (
        `New DM request from ${approval.requestingShip}:${preview}\n\n` +
        `Reply "approve", "deny", or "block" (ID: ${approval.id})`
      );

    case "channel":
      return (
        `${approval.requestingShip} mentioned you in ${approval.channelNest}:${preview}\n\n` +
        `Reply "approve", "deny", or "block"\n` +
        `(ID: ${approval.id})`
      );

    case "group":
      return (
        `Group invite from ${approval.requestingShip} to join ${approval.groupFlag}\n\n` +
        `Reply "approve", "deny", or "block"\n` +
        `(ID: ${approval.id})`
      );
  }
  throw new Error("Unsupported approval type");
}

type ApprovalResponse = {
  action: "approve" | "deny" | "block";
  id?: string;
};

export function parseApprovalResponse(text: string): ApprovalResponse | null {
  const trimmed = normalizeLowercaseStringOrEmpty(text);

  const match = trimmed.match(/^(approve|deny|block)(?:\s+(.+))?$/);
  if (!match) {
    return null;
  }

  const action = match[1] as "approve" | "deny" | "block";
  const id = match[2]?.trim();

  return { action, id };
}

export function findPendingApproval(
  pendingApprovals: PendingApproval[],
  id?: string,
): PendingApproval | undefined {
  if (id) {
    return pendingApprovals.find((a) => a.id === id);
  }
  return pendingApprovals[pendingApprovals.length - 1];
}

export function removePendingApproval(
  pendingApprovals: PendingApproval[],
  id: string,
): PendingApproval[] {
  return pendingApprovals.filter((a) => a.id !== id);
}

export function formatApprovalConfirmation(
  approval: PendingApproval,
  action: "approve" | "deny" | "block",
): string {
  if (action === "block") {
    return `Blocked ${approval.requestingShip}. They will no longer be able to contact the bot.`;
  }

  const actionText = action === "approve" ? "Approved" : "Denied";

  switch (approval.type) {
    case "dm":
      if (action === "approve") {
        return `${actionText} DM access for ${approval.requestingShip}. They can now message the bot.`;
      }
      return `${actionText} DM request from ${approval.requestingShip}.`;

    case "channel":
      if (action === "approve") {
        return `${actionText} ${approval.requestingShip} for ${approval.channelNest}. They can now interact in this channel.`;
      }
      return `${actionText} ${approval.requestingShip} for ${approval.channelNest}.`;

    case "group":
      if (action === "approve") {
        return `${actionText} group invite from ${approval.requestingShip} to ${approval.groupFlag}. Joining group...`;
      }
      return `${actionText} group invite from ${approval.requestingShip} to ${approval.groupFlag}.`;
  }
  throw new Error("Unsupported approval type");
}

type AdminCommand = { type: "unblock"; ship: string } | { type: "blocked" } | { type: "pending" };

export function parseAdminCommand(text: string): AdminCommand | null {
  const trimmed = normalizeLowercaseStringOrEmpty(text);

  if (trimmed === "blocked") {
    return { type: "blocked" };
  }

  if (trimmed === "pending") {
    return { type: "pending" };
  }

  const unblockMatch = trimmed.match(/^unblock\s+(~[\w-]+)$/);
  if (unblockMatch) {
    return { type: "unblock", ship: expectDefined(unblockMatch[1], "unblock ship capture") };
  }

  return null;
}

export function formatBlockedList(ships: string[]): string {
  if (ships.length === 0) {
    return "No ships are currently blocked.";
  }
  return `Blocked ships (${ships.length}):\n${ships.map((s) => `• ${s}`).join("\n")}`;
}

export function formatPendingList(approvals: PendingApproval[]): string {
  if (approvals.length === 0) {
    return "No pending approval requests.";
  }
  return `Pending approvals (${approvals.length}):\n${approvals
    .map((a) => `• ${a.id}: ${a.type} from ${a.requestingShip}`)
    .join("\n")}`;
}
