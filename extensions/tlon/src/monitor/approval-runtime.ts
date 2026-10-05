import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime";
import {
  putTlonSetting,
  TLON_PENDING_APPROVAL_LIMIT,
  type PendingApproval,
  type TlonSettingsStore,
} from "../settings.js";
import { normalizeShip } from "../targets.js";
import { sendDm } from "../urbit/send.js";
import type { UrbitSSEClient } from "../urbit/sse-client.js";
import {
  findPendingApproval,
  formatApprovalConfirmation,
  formatApprovalRequest,
  formatBlockedList,
  formatPendingList,
  parseAdminCommand,
  parseApprovalResponse,
  removePendingApproval,
} from "./approval.js";

type TlonApprovalApi = Pick<UrbitSSEClient, "poke" | "scry">;

export function createTlonApprovalRuntime(params: {
  api: TlonApprovalApi;
  runtime: RuntimeEnv;
  botShipName: string;
  state: {
    pendingApprovals: PendingApproval[];
    currentSettings: TlonSettingsStore;
    effectiveDmAllowlist: string[];
    effectiveOwnerShip: string | null;
  };
  processApprovedMessage: (approval: PendingApproval) => Promise<void>;
  refreshWatchedChannels: () => Promise<number>;
}) {
  const { api, runtime, botShipName, state, processApprovedMessage, refreshWatchedChannels } =
    params;

  let approvalOverflowNoticeSent = false;
  let approvalOverflowNoticeAttempts = 0;

  const savePendingApprovals = async (required = false): Promise<void> => {
    try {
      await putTlonSetting(api, "pendingApprovals", JSON.stringify(state.pendingApprovals));
    } catch (err) {
      runtime.error?.(`[tlon] Failed to save pending approvals: ${String(err)}`);
      if (required) {
        throw err;
      }
    }
  };

  const addToDmAllowlist = async (ship: string): Promise<void> => {
    const normalizedShip = normalizeShip(ship);
    const nextAllowlist = state.effectiveDmAllowlist.includes(normalizedShip)
      ? state.effectiveDmAllowlist
      : [...state.effectiveDmAllowlist, normalizedShip];
    state.effectiveDmAllowlist = nextAllowlist;
    try {
      await putTlonSetting(api, "dmAllowlist", nextAllowlist);
      runtime.log?.(`[tlon] Added ${normalizedShip} to dmAllowlist`);
    } catch (err) {
      runtime.error?.(`[tlon] Failed to update dmAllowlist: ${String(err)}`);
    }
  };

  const addToChannelAllowlist = async (ship: string, channelNest: string): Promise<void> => {
    const normalizedShip = normalizeShip(ship);
    const currentSettings = state.currentSettings;
    const channelRules = currentSettings.channelRules ?? {};
    const rule = channelRules[channelNest] ?? { mode: "restricted", allowedShips: [] };
    const allowedShips = [...(rule.allowedShips ?? [])];

    if (!allowedShips.includes(normalizedShip)) {
      allowedShips.push(normalizedShip);
    }

    const updatedRules = {
      ...channelRules,
      [channelNest]: { ...rule, allowedShips },
    };
    state.currentSettings = { ...currentSettings, channelRules: updatedRules };

    try {
      await putTlonSetting(api, "channelRules", JSON.stringify(updatedRules));
      runtime.log?.(`[tlon] Added ${normalizedShip} to ${channelNest} allowlist`);
    } catch (err) {
      runtime.error?.(`[tlon] Failed to update channelRules: ${String(err)}`);
    }
  };

  const setShipBlocked = async (ship: string, blocked: boolean): Promise<boolean> => {
    const normalizedShip = normalizeShip(ship);
    const action = blocked ? "block" : "unblock";
    try {
      await api.poke({
        app: "chat",
        mark: `chat-${action}-ship`,
        json: { ship: normalizedShip },
      });
      runtime.log?.(`[tlon] ${blocked ? "Blocked" : "Unblocked"} ship ${normalizedShip}`);
      return true;
    } catch (err) {
      runtime.error?.(`[tlon] Failed to ${action} ship ${normalizedShip}: ${String(err)}`);
      return false;
    }
  };

  const isShipBlocked = async (ship: string): Promise<boolean> => {
    const normalizedShip = normalizeShip(ship);
    try {
      const blocked = (await api.scry("/chat/blocked.json")) as string[] | undefined;
      return (
        Array.isArray(blocked) && blocked.some((item) => normalizeShip(item) === normalizedShip)
      );
    } catch (err) {
      runtime.log?.(`[tlon] Failed to check blocked list: ${String(err)}`);
      return false;
    }
  };

  const getBlockedShips = async (): Promise<string[]> => {
    try {
      const blocked = (await api.scry("/chat/blocked.json")) as string[] | undefined;
      return Array.isArray(blocked) ? blocked : [];
    } catch (err) {
      runtime.log?.(`[tlon] Failed to get blocked list: ${String(err)}`);
      return [];
    }
  };

  const sendOwnerNotification = async (message: string): Promise<boolean> => {
    const ownerShip = state.effectiveOwnerShip;
    if (!ownerShip) {
      runtime.log?.("[tlon] No ownerShip configured, cannot send notification");
      return false;
    }
    try {
      await sendDm({
        api,
        fromShip: botShipName,
        toShip: ownerShip,
        text: message,
      });
      runtime.log?.(`[tlon] Sent notification to owner ${ownerShip}`);
      return true;
    } catch (err) {
      runtime.error?.(`[tlon] Failed to send notification to owner: ${String(err)}`);
      return false;
    }
  };

  const queueApprovalRequest = async (approval: PendingApproval): Promise<boolean> => {
    if (await isShipBlocked(approval.requestingShip)) {
      runtime.log?.(`[tlon] Ignoring request from blocked ship ${approval.requestingShip}`);
      return false;
    }

    const approvals = state.pendingApprovals;
    const existing = approvals.find(
      (item) =>
        item.type === approval.type &&
        item.requestingShip === approval.requestingShip &&
        // A group DM claim must never merge into (or overwrite) a verified 1:1 request.
        item.clubId === approval.clubId &&
        (approval.type !== "channel" || item.channelNest === approval.channelNest) &&
        (approval.type !== "group" || item.groupFlag === approval.groupFlag),
    );

    if (existing) {
      if (approval.originalMessage) {
        existing.originalMessage = approval.originalMessage;
        existing.messagePreview = approval.messagePreview;
      }
      runtime.log?.(
        `[tlon] Updated existing approval for ${approval.requestingShip} (${approval.type}) - re-sending notification`,
      );
      await savePendingApprovals(true);
      await sendOwnerNotification(formatApprovalRequest(existing));
      return true;
    }

    if (approvals.length >= TLON_PENDING_APPROVAL_LIMIT) {
      runtime.log?.(
        `[tlon] Pending approval limit reached; ignoring ${approval.type} request from ${approval.requestingShip}`,
      );
      if (!approvalOverflowNoticeSent && approvalOverflowNoticeAttempts < 3) {
        approvalOverflowNoticeAttempts += 1;
        approvalOverflowNoticeSent = await sendOwnerNotification(
          `Pending approval queue is full (${approvals.length}). Resolve existing requests with approve, deny, or block before asking rejected requesters to retry.`,
        );
      }
      return false;
    }

    approvalOverflowNoticeSent = false;
    approvalOverflowNoticeAttempts = 0;
    state.pendingApprovals = [...approvals, approval];
    await savePendingApprovals(true);
    await sendOwnerNotification(formatApprovalRequest(approval));
    runtime.log?.(
      `[tlon] Queued approval request: ${approval.id} (${approval.type} from ${approval.requestingShip})`,
    );
    return true;
  };

  const handleApprovalResponse = async (text: string): Promise<boolean> => {
    const parsed = parseApprovalResponse(text);
    if (!parsed) {
      return false;
    }

    const approval = findPendingApproval(state.pendingApprovals, parsed.id);
    if (!approval) {
      await sendOwnerNotification(
        `No pending approval found${parsed.id ? ` for ID: ${parsed.id}` : ""}`,
      );
      return true;
    }

    if (parsed.action === "approve") {
      switch (approval.type) {
        case "dm":
          await addToDmAllowlist(approval.requestingShip);
          if (approval.originalMessage) {
            runtime.log?.(
              `[tlon] Processing original message from ${approval.requestingShip} after approval`,
            );
            await processApprovedMessage(approval);
          }
          break;
        case "channel":
          if (approval.channelNest) {
            await addToChannelAllowlist(approval.requestingShip, approval.channelNest);
            if (approval.originalMessage) {
              runtime.log?.(
                `[tlon] Processing original message from ${approval.requestingShip} in ${approval.channelNest} after approval`,
              );
              await processApprovedMessage(approval);
            }
          }
          break;
        case "group":
          if (approval.groupFlag) {
            try {
              await api.poke({
                app: "groups",
                mark: "group-join",
                json: {
                  flag: approval.groupFlag,
                  "join-all": true,
                },
              });
              runtime.log?.(`[tlon] Joined group ${approval.groupFlag} after approval`);
              setTimeout(() => {
                void (async () => {
                  try {
                    const newCount = await refreshWatchedChannels();
                    if (newCount > 0) {
                      runtime.log?.(
                        `[tlon] Discovered ${newCount} new channel(s) after joining group`,
                      );
                    }
                  } catch (err) {
                    runtime.log?.(
                      `[tlon] Channel discovery after group join failed: ${String(err)}`,
                    );
                  }
                })();
              }, 2000);
            } catch (err) {
              runtime.error?.(`[tlon] Failed to join group ${approval.groupFlag}: ${String(err)}`);
            }
          }
          break;
      }
    } else if (parsed.action === "block") {
      await setShipBlocked(approval.requestingShip, true);
    }
    await sendOwnerNotification(formatApprovalConfirmation(approval, parsed.action));

    state.pendingApprovals = removePendingApproval(state.pendingApprovals, approval.id);
    await savePendingApprovals();
    return true;
  };

  const handleAdminCommand = async (text: string): Promise<boolean> => {
    const command = parseAdminCommand(text);
    if (!command) {
      return false;
    }

    switch (command.type) {
      case "blocked": {
        const blockedShips = await getBlockedShips();
        await sendOwnerNotification(formatBlockedList(blockedShips));
        runtime.log?.(`[tlon] Owner requested blocked ships list (${blockedShips.length} ships)`);
        return true;
      }
      case "pending":
        await sendOwnerNotification(formatPendingList(state.pendingApprovals));
        runtime.log?.(
          `[tlon] Owner requested pending approvals list (${state.pendingApprovals.length} pending)`,
        );
        return true;
      case "unblock": {
        const shipToUnblock = command.ship;
        if (!(await isShipBlocked(shipToUnblock))) {
          await sendOwnerNotification(`${shipToUnblock} is not blocked.`);
          return true;
        }
        const success = await setShipBlocked(shipToUnblock, false);
        await sendOwnerNotification(
          success ? `Unblocked ${shipToUnblock}.` : `Failed to unblock ${shipToUnblock}.`,
        );
        return true;
      }
    }
    throw new Error("Unsupported Tlon admin command");
  };

  return {
    queueApprovalRequest,
    handleApprovalResponse,
    handleAdminCommand,
  };
}
