import { randomBytes } from "node:crypto";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { PendingApproval } from "../settings.js";

export function createPendingApproval(
  params: Omit<PendingApproval, "id" | "timestamp">,
): PendingApproval {
  const timestamp = Date.now();
  return {
    id: `${params.type}-${timestamp}-${randomBytes(3).toString("hex")}`,
    type: params.type,
    requestingShip: params.requestingShip,
    ...(params.clubId !== undefined ? { clubId: params.clubId } : {}),
    ...(params.clubMode !== undefined ? { clubMode: params.clubMode } : {}),
    ...(params.verifiedDirect === true ? { verifiedDirect: true } : {}),
    channelNest: params.channelNest,
    groupFlag: params.groupFlag,
    messagePreview:
      params.messagePreview != null ? sliceUtf16Safe(params.messagePreview, 0, 100) : undefined,
    originalMessage: params.originalMessage,
    timestamp,
  };
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return sliceUtf16Safe(text, 0, maxLength - 3) + "...";
}

function formatApprovalInstructions(id: string): string {
  return (
    `Reply "approve", "deny", or "block" if this is the only pending request. ` +
    `If multiple are pending, reply "approve ${id}", "deny ${id}", or "block ${id}".`
  );
}

export function formatApprovalRequest(approval: PendingApproval): string {
  const preview = approval.messagePreview ? `\n"${truncate(approval.messagePreview, 100)}"` : "";

  switch (approval.type) {
    case "club":
    case "dm":
      if (approval.clubId !== undefined) {
        const permission =
          approval.type === "club" && approval.clubMode === "once"
            ? "Approving enables this club for automatic replies, including future messages."
            : "Approving permits this saved message only; it does not enable future messages.";
        const replayLine = approval.originalMessage
          ? "The reply goes to the club, using its own conversation."
          : "No message was saved; approval only dismisses this request.";
        return (
          `Group DM ${approval.clubId}: claimed author ${approval.requestingShip} (unverified).${preview}\n\n` +
          `${permission} Tlon does not authenticate club authors or participants. Input delivered under this club ID can use the agent's normal permitted tools.\n` +
          `${replayLine} No direct-DM access or owner authority is granted. ` +
          (approval.type === "club"
            ? "Deny or block disables this club; no ship is blocked.\n"
            : "Blocking only dismisses this legacy request; no ship is blocked.\n") +
          formatApprovalInstructions(approval.id)
        );
      }
      return (
        `New DM request from ${approval.requestingShip}:${preview}\n\n` +
        formatApprovalInstructions(approval.id)
      );

    case "channel":
      return (
        `${approval.requestingShip} mentioned you in ${approval.channelNest}:${preview}\n\n` +
        formatApprovalInstructions(approval.id)
      );

    case "group":
      return (
        `Group invite from ${approval.requestingShip} to join ${approval.groupFlag}\n\n` +
        formatApprovalInstructions(approval.id)
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
  return id
    ? pendingApprovals.find((approval) => approval.id === id)
    : pendingApprovals.length === 1
      ? pendingApprovals[0]
      : undefined;
}

export function removePendingApproval(
  pendingApprovals: PendingApproval[],
  id: string,
): PendingApproval[] {
  return pendingApprovals.filter((a) => a.id !== id);
}

/**
 * DM requests saved before sender provenance was recorded cannot be told apart from unverified
 * group DM claims, so their stored message is never replayed; the sender must send it again.
 */
export function requiresResendAfterApproval(approval: PendingApproval): boolean {
  return (
    approval.type === "dm" &&
    approval.originalMessage !== undefined &&
    approval.clubId === undefined &&
    approval.verifiedDirect !== true
  );
}

export function formatApprovalConfirmation(
  approval: PendingApproval,
  action: "approve" | "deny" | "block",
): string {
  if (approval.clubId !== undefined) {
    if (approval.type !== "club") {
      return `Resolved legacy group DM request ${approval.id}. No standing club or direct-DM access was granted; no ship was blocked.`;
    }
    if (action !== "approve") {
      return `Disabled group DM ${approval.clubId}. No ship was blocked. Set its clubRules entry to "allow" to enable it again.`;
    }
    return approval.clubMode === "once"
      ? `Enabled group DM ${approval.clubId} for automatic replies from unverified input. No direct-DM access or owner authority was granted.`
      : `Approved this group DM message only. No standing club or direct-DM access was granted.`;
  }
  if (action === "block") {
    return `Blocked ${approval.requestingShip}. They will no longer be able to contact the bot.`;
  }

  const actionText = action === "approve" ? "Approved" : "Denied";

  switch (approval.type) {
    case "club":
    case "dm":
      if (action === "approve") {
        if (requiresResendAfterApproval(approval)) {
          return (
            `${actionText} DM access for ${approval.requestingShip}. They can now message the bot.\n` +
            `Their earlier message was saved before this version and its sender cannot be verified, ` +
            `so it was not processed. Ask ${approval.requestingShip} to send it again.`
          );
        }
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
    .map((a) =>
      a.clubId !== undefined
        ? `• ${a.id}: group DM ${a.clubId} (unverified)`
        : `• ${a.id}: ${a.type} from ${a.requestingShip}`,
    )
    .join("\n")}`;
}
