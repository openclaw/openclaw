function generateApprovalId(type) {
  const timestamp = Date.now();
  const randomPart = Math.random().toString(36).substring(2, 6);
  return `${type}-${timestamp}-${randomPart}`;
}
function createPendingApproval(params) {
  return {
    id: generateApprovalId(params.type),
    type: params.type,
    requestingShip: params.requestingShip,
    channelNest: params.channelNest,
    groupFlag: params.groupFlag,
    messagePreview: params.messagePreview,
    originalMessage: params.originalMessage,
    timestamp: Date.now()
  };
}
function truncate(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + "...";
}
function formatApprovalRequest(approval) {
  const preview = approval.messagePreview ? `
"${truncate(approval.messagePreview, 100)}"` : "";
  switch (approval.type) {
    case "dm":
      return `New DM request from ${approval.requestingShip}:${preview}

Reply "approve", "deny", or "block" (ID: ${approval.id})`;
    case "channel":
      return `${approval.requestingShip} mentioned you in ${approval.channelNest}:${preview}

Reply "approve", "deny", or "block"
(ID: ${approval.id})`;
    case "group":
      return `Group invite from ${approval.requestingShip} to join ${approval.groupFlag}

Reply "approve", "deny", or "block"
(ID: ${approval.id})`;
  }
}
function parseApprovalResponse(text) {
  const trimmed = text.trim().toLowerCase();
  const match = trimmed.match(/^(approve|deny|block)(?:\s+(.+))?$/);
  if (!match) {
    return null;
  }
  const action = match[1];
  const id = match[2]?.trim();
  return { action, id };
}
function isApprovalResponse(text) {
  const trimmed = text.trim().toLowerCase();
  return trimmed.startsWith("approve") || trimmed.startsWith("deny") || trimmed.startsWith("block");
}
function findPendingApproval(pendingApprovals, id) {
  if (id) {
    return pendingApprovals.find((a) => a.id === id);
  }
  return pendingApprovals[pendingApprovals.length - 1];
}
function hasDuplicatePending(pendingApprovals, type, requestingShip, channelNest, groupFlag) {
  return pendingApprovals.some((approval) => {
    if (approval.type !== type || approval.requestingShip !== requestingShip) {
      return false;
    }
    if (type === "channel" && approval.channelNest !== channelNest) {
      return false;
    }
    if (type === "group" && approval.groupFlag !== groupFlag) {
      return false;
    }
    return true;
  });
}
function removePendingApproval(pendingApprovals, id) {
  return pendingApprovals.filter((a) => a.id !== id);
}
function formatApprovalConfirmation(approval, action) {
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
}
function parseAdminCommand(text) {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === "blocked") {
    return { type: "blocked" };
  }
  if (trimmed === "pending") {
    return { type: "pending" };
  }
  const unblockMatch = trimmed.match(/^unblock\s+(~[\w-]+)$/);
  if (unblockMatch) {
    return { type: "unblock", ship: unblockMatch[1] };
  }
  return null;
}
function isAdminCommand(text) {
  return parseAdminCommand(text) !== null;
}
function formatBlockedList(ships) {
  if (ships.length === 0) {
    return "No ships are currently blocked.";
  }
  return `Blocked ships (${ships.length}):
${ships.map((s) => `\u2022 ${s}`).join("\n")}`;
}
function formatPendingList(approvals) {
  if (approvals.length === 0) {
    return "No pending approval requests.";
  }
  return `Pending approvals (${approvals.length}):
${approvals.map((a) => `\u2022 ${a.id}: ${a.type} from ${a.requestingShip}`).join("\n")}`;
}
export {
  createPendingApproval,
  findPendingApproval,
  formatApprovalConfirmation,
  formatApprovalRequest,
  formatBlockedList,
  formatPendingList,
  generateApprovalId,
  hasDuplicatePending,
  isAdminCommand,
  isApprovalResponse,
  parseAdminCommand,
  parseApprovalResponse,
  removePendingApproval
};
