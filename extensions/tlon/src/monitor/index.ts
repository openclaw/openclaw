import { format } from "node:util";
import type { RuntimeEnv, ReplyPayload, OpenClawConfig } from "openclaw/plugin-sdk";
import { getTlonRuntime } from "../runtime.js";
import { createSettingsManager, type TlonSettingsStore } from "../settings.js";
import { normalizeShip, parseChannelNest } from "../targets.js";
import { resolveTlonAccount } from "../types.js";
import { authenticate } from "../urbit/auth.js";
import { ssrfPolicyFromAllowPrivateNetwork } from "../urbit/context.js";
import type { Foreigns, DmInvite } from "../urbit/foreigns.js";
import { sendDm, sendGroupMessage } from "../urbit/send.js";
import { UrbitSSEClient } from "../urbit/sse-client.js";
import {
  type PendingApproval,
  type AdminCommand,
  createPendingApproval,
  formatApprovalRequest,
  formatApprovalConfirmation,
  parseApprovalResponse,
  isApprovalResponse,
  findPendingApproval,
  removePendingApproval,
  parseAdminCommand,
  isAdminCommand,
  formatBlockedList,
  formatPendingList,
} from "./approval.js";
import { fetchAllChannels, fetchInitData } from "./discovery.js";
import { cacheMessage, getChannelHistory, fetchThreadHistory } from "./history.js";
import { downloadMessageImages } from "./media.js";
import { createProcessedMessageTracker } from "./processed-messages.js";
import {
  extractMessageText,
  extractCites,
  formatModelName,
  isBotMentioned,
  stripBotMention,
  isDmAllowed,
  isSummarizationRequest,
  type ParsedCite,
} from "./utils.js";

export type MonitorTlonOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  accountId?: string | null;
};

type ChannelAuthorization = {
  mode?: "restricted" | "open";
  allowedShips?: string[];
};

/**
 * Resolve channel authorization by merging file config with settings store.
 * Settings store takes precedence for fields it defines.
 */
function resolveChannelAuthorization(
  cfg: OpenClawConfig,
  channelNest: string,
  settings?: TlonSettingsStore,
): { mode: "restricted" | "open"; allowedShips: string[] } {
  const tlonConfig = cfg.channels?.tlon as
    | {
        authorization?: { channelRules?: Record<string, ChannelAuthorization> };
        defaultAuthorizedShips?: string[];
      }
    | undefined;

  // Merge channel rules: settings override file config
  const fileRules = tlonConfig?.authorization?.channelRules ?? {};
  const settingsRules = settings?.channelRules ?? {};
  const rule = settingsRules[channelNest] ?? fileRules[channelNest];

  // Merge default authorized ships: settings override file config
  const defaultShips = settings?.defaultAuthorizedShips ?? tlonConfig?.defaultAuthorizedShips ?? [];

  const allowedShips = rule?.allowedShips ?? defaultShips;
  const mode = rule?.mode ?? "restricted";
  return { mode, allowedShips };
}

export async function monitorTlonProvider(opts: MonitorTlonOpts = {}): Promise<void> {
  const core = getTlonRuntime();
  const cfg = core.config.loadConfig() as OpenClawConfig;
  if (cfg.channels?.tlon?.enabled === false) {
    return;
  }

  const logger = core.logging.getChildLogger({ module: "tlon-auto-reply" });
  const formatRuntimeMessage = (...args: Parameters<RuntimeEnv["log"]>) => format(...args);
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: (...args) => {
      logger.info(formatRuntimeMessage(...args));
    },
    error: (...args) => {
      logger.error(formatRuntimeMessage(...args));
    },
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  const account = resolveTlonAccount(cfg, opts.accountId ?? undefined);
  if (!account.enabled) {
    return;
  }
  if (!account.configured || !account.ship || !account.url || !account.code) {
    throw new Error("Tlon account not configured (ship/url/code required)");
  }

  const botShipName = normalizeShip(account.ship);
  runtime.log?.(`[tlon] Starting monitor for ${botShipName}`);

  const ssrfPolicy = ssrfPolicyFromAllowPrivateNetwork(account.allowPrivateNetwork);

  // Store validated values for use in closures (TypeScript narrowing doesn't propagate)
  const accountUrl = account.url;
  const accountCode = account.code;

  // Helper to authenticate with retry logic
  async function authenticateWithRetry(maxAttempts = 10): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      if (opts.abortSignal?.aborted) {
        throw new Error("Aborted while waiting to authenticate");
      }
      try {
        runtime.log?.(`[tlon] Attempting authentication to ${accountUrl}...`);
        return await authenticate(accountUrl, accountCode, { ssrfPolicy });
      } catch (error: any) {
        runtime.error?.(
          `[tlon] Failed to authenticate (attempt ${attempt}): ${error?.message ?? String(error)}`,
        );
        if (attempt >= maxAttempts) {
          throw error;
        }
        const delay = Math.min(30000, 1000 * Math.pow(2, attempt - 1));
        runtime.log?.(`[tlon] Retrying authentication in ${delay}ms...`);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          if (opts.abortSignal) {
            const onAbort = () => {
              clearTimeout(timer);
              reject(new Error("Aborted"));
            };
            opts.abortSignal.addEventListener("abort", onAbort, { once: true });
          }
        });
      }
    }
  }

  let api: UrbitSSEClient | null = null;
  const cookie = await authenticateWithRetry();
  api = new UrbitSSEClient(account.url, cookie, {
    ship: botShipName,
    ssrfPolicy,
    logger: {
      log: (message) => runtime.log?.(message),
      error: (message) => runtime.error?.(message),
    },
    // Re-authenticate on reconnect in case the session expired
    onReconnect: async (client) => {
      runtime.log?.("[tlon] Re-authenticating on SSE reconnect...");
      const newCookie = await authenticateWithRetry(5);
      client.updateCookie(newCookie);
      runtime.log?.("[tlon] Re-authentication successful");
    },
  });

  const processedTracker = createProcessedMessageTracker(2000);
  let groupChannels: string[] = [];
  let botNickname: string | null = null;

  // Settings store manager for hot-reloading config
  const settingsManager = createSettingsManager(api, {
    log: (msg) => runtime.log?.(msg),
    error: (msg) => runtime.error?.(msg),
  });

  // Reactive state that can be updated via settings store
  let effectiveDmAllowlist: string[] = account.dmAllowlist;
  let effectiveShowModelSig: boolean = account.showModelSignature ?? false;
  let effectiveAutoAcceptDmInvites: boolean = account.autoAcceptDmInvites ?? false;
  let effectiveAutoAcceptGroupInvites: boolean = account.autoAcceptGroupInvites ?? false;
  let effectiveGroupInviteAllowlist: string[] = account.groupInviteAllowlist;
  let effectiveAutoDiscoverChannels: boolean = account.autoDiscoverChannels ?? false;
  let effectiveOwnerShip: string | null = account.ownerShip
    ? normalizeShip(account.ownerShip)
    : null;
  let pendingApprovals: PendingApproval[] = [];
  let currentSettings: TlonSettingsStore = {};

  // Track threads we've participated in (by parentId) - respond without mention requirement
  const participatedThreads = new Set<string>();

  // Track DM senders per session to detect shared sessions (security warning)
  const dmSendersBySession = new Map<string, Set<string>>();
  let sharedSessionWarningSent = false;

  // Fetch bot's nickname from contacts
  try {
    const selfProfile = await api.scry("/contacts/v1/self.json");
    if (selfProfile && typeof selfProfile === "object") {
      const profile = selfProfile as { nickname?: { value?: string } };
      botNickname = profile.nickname?.value || null;
      if (botNickname) {
        runtime.log?.(`[tlon] Bot nickname: ${botNickname}`);
      }
    }
  } catch (error: any) {
    runtime.log?.(`[tlon] Could not fetch nickname: ${error?.message ?? String(error)}`);
  }

  // Store init foreigns for processing after settings are loaded
  let initForeigns: Foreigns | null = null;

  // Migrate file config to settings store (seed on first run)
  async function migrateConfigToSettings() {
    const migrations: Array<{ key: string; fileValue: unknown; settingsValue: unknown }> = [
      {
        key: "dmAllowlist",
        fileValue: account.dmAllowlist,
        settingsValue: currentSettings.dmAllowlist,
      },
      {
        key: "groupInviteAllowlist",
        fileValue: account.groupInviteAllowlist,
        settingsValue: currentSettings.groupInviteAllowlist,
      },
      {
        key: "groupChannels",
        fileValue: account.groupChannels,
        settingsValue: currentSettings.groupChannels,
      },
      {
        key: "defaultAuthorizedShips",
        fileValue: account.defaultAuthorizedShips,
        settingsValue: currentSettings.defaultAuthorizedShips,
      },
      {
        key: "autoDiscoverChannels",
        fileValue: account.autoDiscoverChannels,
        settingsValue: currentSettings.autoDiscoverChannels,
      },
      {
        key: "autoAcceptDmInvites",
        fileValue: account.autoAcceptDmInvites,
        settingsValue: currentSettings.autoAcceptDmInvites,
      },
      {
        key: "autoAcceptGroupInvites",
        fileValue: account.autoAcceptGroupInvites,
        settingsValue: currentSettings.autoAcceptGroupInvites,
      },
      {
        key: "showModelSig",
        fileValue: account.showModelSignature,
        settingsValue: currentSettings.showModelSig,
      },
    ];

    for (const { key, fileValue, settingsValue } of migrations) {
      // Only migrate if file has a value and settings store doesn't
      const hasFileValue = Array.isArray(fileValue) ? fileValue.length > 0 : fileValue != null;
      const hasSettingsValue = Array.isArray(settingsValue)
        ? settingsValue.length > 0
        : settingsValue != null;

      if (hasFileValue && !hasSettingsValue) {
        try {
          await api!.poke({
            app: "settings",
            mark: "settings-event",
            json: {
              "put-entry": {
                "bucket-key": "tlon",
                "entry-key": key,
                value: fileValue,
                desk: "moltbot",
              },
            },
          });
          runtime.log?.(`[tlon] Migrated ${key} from config to settings store`);
        } catch (err) {
          runtime.log?.(`[tlon] Failed to migrate ${key}: ${String(err)}`);
        }
      }
    }
  }

  // Load settings from settings store (hot-reloadable config)
  try {
    currentSettings = await settingsManager.load();

    // Migrate file config to settings store if not already present
    await migrateConfigToSettings();

    // Apply settings overrides
    // Note: groupChannels from settings store are merged AFTER discovery runs (below)
    if (currentSettings.defaultAuthorizedShips?.length) {
      runtime.log?.(
        `[tlon] Using defaultAuthorizedShips from settings store: ${currentSettings.defaultAuthorizedShips.join(", ")}`,
      );
    }
    if (currentSettings.autoDiscoverChannels !== undefined) {
      effectiveAutoDiscoverChannels = currentSettings.autoDiscoverChannels;
      runtime.log?.(
        `[tlon] Using autoDiscoverChannels from settings store: ${effectiveAutoDiscoverChannels}`,
      );
    }
    if (currentSettings.dmAllowlist?.length) {
      effectiveDmAllowlist = currentSettings.dmAllowlist;
      runtime.log?.(
        `[tlon] Using dmAllowlist from settings store: ${effectiveDmAllowlist.join(", ")}`,
      );
    }
    if (currentSettings.showModelSig !== undefined) {
      effectiveShowModelSig = currentSettings.showModelSig;
    }
    if (currentSettings.autoAcceptDmInvites !== undefined) {
      effectiveAutoAcceptDmInvites = currentSettings.autoAcceptDmInvites;
      runtime.log?.(
        `[tlon] Using autoAcceptDmInvites from settings store: ${effectiveAutoAcceptDmInvites}`,
      );
    }
    if (currentSettings.autoAcceptGroupInvites !== undefined) {
      effectiveAutoAcceptGroupInvites = currentSettings.autoAcceptGroupInvites;
      runtime.log?.(
        `[tlon] Using autoAcceptGroupInvites from settings store: ${effectiveAutoAcceptGroupInvites}`,
      );
    }
    if (currentSettings.groupInviteAllowlist?.length) {
      effectiveGroupInviteAllowlist = currentSettings.groupInviteAllowlist;
      runtime.log?.(
        `[tlon] Using groupInviteAllowlist from settings store: ${effectiveGroupInviteAllowlist.join(", ")}`,
      );
    }
    if (currentSettings.ownerShip) {
      effectiveOwnerShip = normalizeShip(currentSettings.ownerShip);
      runtime.log?.(`[tlon] Using ownerShip from settings store: ${effectiveOwnerShip}`);
    }
    if (currentSettings.pendingApprovals?.length) {
      pendingApprovals = currentSettings.pendingApprovals;
      runtime.log?.(`[tlon] Loaded ${pendingApprovals.length} pending approval(s) from settings`);
    }
  } catch (err) {
    runtime.log?.(`[tlon] Settings store not available, using file config: ${String(err)}`);
  }

  // Run channel discovery AFTER settings are loaded (so settings store value is used)
  if (effectiveAutoDiscoverChannels) {
    try {
      const initData = await fetchInitData(api, runtime);
      if (initData.channels.length > 0) {
        groupChannels = initData.channels;
      }
      initForeigns = initData.foreigns;
    } catch (error: any) {
      runtime.error?.(`[tlon] Auto-discovery failed: ${error?.message ?? String(error)}`);
    }
  }

  // Merge manual config with auto-discovered channels
  if (account.groupChannels.length > 0) {
    for (const ch of account.groupChannels) {
      if (!groupChannels.includes(ch)) {
        groupChannels.push(ch);
      }
    }
    runtime.log?.(
      `[tlon] Added ${account.groupChannels.length} manual groupChannels to monitoring`,
    );
  }

  // Also merge settings store groupChannels (may have been set via tlon settings command)
  if (currentSettings.groupChannels?.length) {
    for (const ch of currentSettings.groupChannels) {
      if (!groupChannels.includes(ch)) {
        groupChannels.push(ch);
      }
    }
  }

  if (groupChannels.length > 0) {
    runtime.log?.(
      `[tlon] Monitoring ${groupChannels.length} group channel(s): ${groupChannels.join(", ")}`,
    );
  } else {
    runtime.log?.("[tlon] No group channels to monitor (DMs only)");
  }

  // Helper to resolve cited message content
  async function resolveCiteContent(cite: ParsedCite): Promise<string | null> {
    if (cite.type !== "chan" || !cite.nest || !cite.postId) {
      return null;
    }

    try {
      // Scry for the specific post: /v4/{nest}/posts/post/{postId}
      const scryPath = `/channels/v4/${cite.nest}/posts/post/${cite.postId}.json`;
      runtime.log?.(`[tlon] Fetching cited post: ${scryPath}`);

      const data: any = await api!.scry(scryPath);

      // Extract text from the post's essay content
      if (data?.essay?.content) {
        const text = extractMessageText(data.essay.content);
        return text || null;
      }

      return null;
    } catch (err) {
      runtime.log?.(`[tlon] Failed to fetch cited post: ${String(err)}`);
      return null;
    }
  }

  // Resolve all cites in message content and return quoted text
  async function resolveAllCites(content: unknown): Promise<string> {
    const cites = extractCites(content);
    if (cites.length === 0) {
      return "";
    }

    const resolved: string[] = [];
    for (const cite of cites) {
      const text = await resolveCiteContent(cite);
      if (text) {
        const author = cite.author || "unknown";
        resolved.push(`> ${author} wrote: ${text}`);
      }
    }

    return resolved.length > 0 ? resolved.join("\n") + "\n\n" : "";
  }

  // Helper to save pending approvals to settings store
  async function savePendingApprovals(): Promise<void> {
    try {
      await api!.poke({
        app: "settings",
        mark: "settings-event",
        json: {
          "put-entry": {
            desk: "moltbot",
            "bucket-key": "tlon",
            "entry-key": "pendingApprovals",
            value: JSON.stringify(pendingApprovals),
          },
        },
      });
    } catch (err) {
      runtime.error?.(`[tlon] Failed to save pending approvals: ${String(err)}`);
    }
  }

  // Helper to update dmAllowlist in settings store
  async function addToDmAllowlist(ship: string): Promise<void> {
    const normalizedShip = normalizeShip(ship);
    if (!effectiveDmAllowlist.includes(normalizedShip)) {
      effectiveDmAllowlist = [...effectiveDmAllowlist, normalizedShip];
    }
    try {
      await api!.poke({
        app: "settings",
        mark: "settings-event",
        json: {
          "put-entry": {
            desk: "moltbot",
            "bucket-key": "tlon",
            "entry-key": "dmAllowlist",
            value: effectiveDmAllowlist,
          },
        },
      });
      runtime.log?.(`[tlon] Added ${normalizedShip} to dmAllowlist`);
    } catch (err) {
      runtime.error?.(`[tlon] Failed to update dmAllowlist: ${String(err)}`);
    }
  }

  // Helper to update channelRules in settings store
  async function addToChannelAllowlist(ship: string, channelNest: string): Promise<void> {
    const normalizedShip = normalizeShip(ship);
    const channelRules = currentSettings.channelRules ?? {};
    const rule = channelRules[channelNest] ?? { mode: "restricted", allowedShips: [] };
    const allowedShips = [...(rule.allowedShips ?? [])]; // Clone to avoid mutation

    if (!allowedShips.includes(normalizedShip)) {
      allowedShips.push(normalizedShip);
    }

    const updatedRules = {
      ...channelRules,
      [channelNest]: { ...rule, allowedShips },
    };

    // Update local state immediately (don't wait for settings subscription)
    currentSettings = { ...currentSettings, channelRules: updatedRules };

    try {
      await api!.poke({
        app: "settings",
        mark: "settings-event",
        json: {
          "put-entry": {
            desk: "moltbot",
            "bucket-key": "tlon",
            "entry-key": "channelRules",
            value: JSON.stringify(updatedRules),
          },
        },
      });
      runtime.log?.(`[tlon] Added ${normalizedShip} to ${channelNest} allowlist`);
    } catch (err) {
      runtime.error?.(`[tlon] Failed to update channelRules: ${String(err)}`);
    }
  }

  // Helper to block a ship using Tlon's native blocking
  async function blockShip(ship: string): Promise<void> {
    const normalizedShip = normalizeShip(ship);
    try {
      await api!.poke({
        app: "chat",
        mark: "chat-block-ship",
        json: { ship: normalizedShip },
      });
      runtime.log?.(`[tlon] Blocked ship ${normalizedShip}`);
    } catch (err) {
      runtime.error?.(`[tlon] Failed to block ship ${normalizedShip}: ${String(err)}`);
    }
  }

  // Check if a ship is blocked using Tlon's native block list
  async function isShipBlocked(ship: string): Promise<boolean> {
    const normalizedShip = normalizeShip(ship);
    try {
      const blocked = (await api!.scry("/chat/blocked.json")) as string[] | undefined;
      return Array.isArray(blocked) && blocked.some((s) => normalizeShip(s) === normalizedShip);
    } catch (err) {
      runtime.log?.(`[tlon] Failed to check blocked list: ${String(err)}`);
      return false;
    }
  }

  // Get all blocked ships
  async function getBlockedShips(): Promise<string[]> {
    try {
      const blocked = (await api!.scry("/chat/blocked.json")) as string[] | undefined;
      return Array.isArray(blocked) ? blocked : [];
    } catch (err) {
      runtime.log?.(`[tlon] Failed to get blocked list: ${String(err)}`);
      return [];
    }
  }

  // Helper to unblock a ship using Tlon's native blocking
  async function unblockShip(ship: string): Promise<boolean> {
    const normalizedShip = normalizeShip(ship);
    try {
      await api!.poke({
        app: "chat",
        mark: "chat-unblock-ship",
        json: { ship: normalizedShip },
      });
      runtime.log?.(`[tlon] Unblocked ship ${normalizedShip}`);
      return true;
    } catch (err) {
      runtime.error?.(`[tlon] Failed to unblock ship ${normalizedShip}: ${String(err)}`);
      return false;
    }
  }

  // Helper to send DM notification to owner
  async function sendOwnerNotification(message: string): Promise<void> {
    if (!effectiveOwnerShip) {
      runtime.log?.("[tlon] No ownerShip configured, cannot send notification");
      return;
    }
    try {
      await sendDm({
        api: api!,
        fromShip: botShipName,
        toShip: effectiveOwnerShip,
        text: message,
      });
      runtime.log?.(`[tlon] Sent notification to owner ${effectiveOwnerShip}`);
    } catch (err) {
      runtime.error?.(`[tlon] Failed to send notification to owner: ${String(err)}`);
    }
  }

  // Queue a new approval request and notify the owner
  async function queueApprovalRequest(approval: PendingApproval): Promise<void> {
    // Check if ship is blocked - silently ignore
    if (await isShipBlocked(approval.requestingShip)) {
      runtime.log?.(`[tlon] Ignoring request from blocked ship ${approval.requestingShip}`);
      return;
    }

    // Check for duplicate - if found, update it with new content and re-notify
    const existingIndex = pendingApprovals.findIndex(
      (a) =>
        a.type === approval.type &&
        a.requestingShip === approval.requestingShip &&
        (approval.type !== "channel" || a.channelNest === approval.channelNest) &&
        (approval.type !== "group" || a.groupFlag === approval.groupFlag),
    );

    if (existingIndex !== -1) {
      // Update existing approval with new content (preserves the original ID)
      const existing = pendingApprovals[existingIndex];
      if (approval.originalMessage) {
        existing.originalMessage = approval.originalMessage;
        existing.messagePreview = approval.messagePreview;
      }
      runtime.log?.(
        `[tlon] Updated existing approval for ${approval.requestingShip} (${approval.type}) - re-sending notification`,
      );
      await savePendingApprovals();
      const message = formatApprovalRequest(existing);
      await sendOwnerNotification(message);
      return;
    }

    pendingApprovals.push(approval);
    await savePendingApprovals();

    const message = formatApprovalRequest(approval);
    await sendOwnerNotification(message);
    runtime.log?.(
      `[tlon] Queued approval request: ${approval.id} (${approval.type} from ${approval.requestingShip})`,
    );
  }

  // Process the owner's approval response
  async function handleApprovalResponse(text: string): Promise<boolean> {
    const parsed = parseApprovalResponse(text);
    if (!parsed) {
      return false;
    }

    const approval = findPendingApproval(pendingApprovals, parsed.id);
    if (!approval) {
      await sendOwnerNotification(
        "No pending approval found" + (parsed.id ? ` for ID: ${parsed.id}` : ""),
      );
      return true; // Still consumed the message
    }

    if (parsed.action === "approve") {
      switch (approval.type) {
        case "dm":
          await addToDmAllowlist(approval.requestingShip);
          // Process the original message if available
          if (approval.originalMessage) {
            runtime.log?.(
              `[tlon] Processing original message from ${approval.requestingShip} after approval`,
            );
            await processMessage({
              messageId: approval.originalMessage.messageId,
              senderShip: approval.requestingShip,
              messageText: approval.originalMessage.messageText,
              messageContent: approval.originalMessage.messageContent,
              isGroup: false,
              timestamp: approval.originalMessage.timestamp,
            });
          }
          break;

        case "channel":
          if (approval.channelNest) {
            await addToChannelAllowlist(approval.requestingShip, approval.channelNest);
            // Process the original message if available
            if (approval.originalMessage) {
              const parsed = parseChannelNest(approval.channelNest);
              runtime.log?.(
                `[tlon] Processing original message from ${approval.requestingShip} in ${approval.channelNest} after approval`,
              );
              await processMessage({
                messageId: approval.originalMessage.messageId,
                senderShip: approval.requestingShip,
                messageText: approval.originalMessage.messageText,
                messageContent: approval.originalMessage.messageContent,
                isGroup: true,
                channelNest: approval.channelNest,
                hostShip: parsed?.hostShip,
                channelName: parsed?.channelName,
                timestamp: approval.originalMessage.timestamp,
                parentId: approval.originalMessage.parentId,
                isThreadReply: approval.originalMessage.isThreadReply,
              });
            }
          }
          break;

        case "group":
          // Accept the group invite (don't add to allowlist - each invite requires approval)
          if (approval.groupFlag) {
            try {
              await api!.poke({
                app: "groups",
                mark: "group-join",
                json: {
                  flag: approval.groupFlag,
                  "join-all": true,
                },
              });
              runtime.log?.(`[tlon] Joined group ${approval.groupFlag} after approval`);

              // Immediately discover channels from the newly joined group
              // Small delay to allow the join to propagate
              setTimeout(async () => {
                try {
                  const discoveredChannels = await fetchAllChannels(api!, runtime);
                  let newCount = 0;
                  for (const channelNest of discoveredChannels) {
                    if (!watchedChannels.has(channelNest)) {
                      watchedChannels.add(channelNest);
                      newCount++;
                    }
                  }
                  if (newCount > 0) {
                    runtime.log?.(
                      `[tlon] Discovered ${newCount} new channel(s) after joining group`,
                    );
                  }
                } catch (err) {
                  runtime.log?.(`[tlon] Channel discovery after group join failed: ${String(err)}`);
                }
              }, 2000);
            } catch (err) {
              runtime.error?.(`[tlon] Failed to join group ${approval.groupFlag}: ${String(err)}`);
            }
          }
          break;
      }

      await sendOwnerNotification(formatApprovalConfirmation(approval, "approve"));
    } else if (parsed.action === "block") {
      // Block the ship using Tlon's native blocking
      await blockShip(approval.requestingShip);
      await sendOwnerNotification(formatApprovalConfirmation(approval, "block"));
    } else {
      // Denied - just remove from pending, no notification to requester
      await sendOwnerNotification(formatApprovalConfirmation(approval, "deny"));
    }

    // Remove from pending
    pendingApprovals = removePendingApproval(pendingApprovals, approval.id);
    await savePendingApprovals();

    return true;
  }

  // Handle admin commands from owner (unblock, blocked, pending)
  async function handleAdminCommand(text: string): Promise<boolean> {
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

      case "pending": {
        await sendOwnerNotification(formatPendingList(pendingApprovals));
        runtime.log?.(
          `[tlon] Owner requested pending approvals list (${pendingApprovals.length} pending)`,
        );
        return true;
      }

      case "unblock": {
        const shipToUnblock = command.ship;
        const isBlocked = await isShipBlocked(shipToUnblock);
        if (!isBlocked) {
          await sendOwnerNotification(`${shipToUnblock} is not blocked.`);
          return true;
        }
        const success = await unblockShip(shipToUnblock);
        if (success) {
          await sendOwnerNotification(`Unblocked ${shipToUnblock}.`);
        } else {
          await sendOwnerNotification(`Failed to unblock ${shipToUnblock}.`);
        }
        return true;
      }
    }
  }

  // Check if a ship is the owner (always allowed to DM)
  function isOwner(ship: string): boolean {
    if (!effectiveOwnerShip) {
      return false;
    }
    return normalizeShip(ship) === effectiveOwnerShip;
  }

  /**
   * Extract the DM partner ship from the 'whom' field.
   * This is the canonical source for DM routing (more reliable than essay.author).
   * Returns empty string if whom doesn't contain a valid patp-like value.
   */
  function extractDmPartnerShip(whom: unknown): string {
    const raw =
      typeof whom === "string"
        ? whom
        : whom && typeof whom === "object" && "ship" in whom && typeof whom.ship === "string"
          ? whom.ship
          : "";
    const normalized = normalizeShip(raw);
    // Keep DM routing strict: accept only patp-like values.
    return /^~?[a-z-]+$/i.test(normalized) ? normalized : "";
  }

  const processMessage = async (params: {
    messageId: string;
    senderShip: string;
    messageText: string;
    messageContent?: unknown; // Raw Tlon content for media extraction
    isGroup: boolean;
    channelNest?: string;
    hostShip?: string;
    channelName?: string;
    timestamp: number;
    parentId?: string | null;
    isThreadReply?: boolean;
  }) => {
    const {
      messageId,
      senderShip,
      isGroup,
      channelNest,
      hostShip,
      channelName,
      timestamp,
      parentId,
      isThreadReply,
      messageContent,
    } = params;
    const groupChannel = channelNest; // For compatibility
    let messageText = params.messageText;

    // Download any images from the message content
    let attachments: Array<{ path: string; contentType: string }> = [];
    if (messageContent) {
      try {
        attachments = await downloadMessageImages(messageContent);
        if (attachments.length > 0) {
          runtime.log?.(`[tlon] Downloaded ${attachments.length} image(s) from message`);
        }
      } catch (error: any) {
        runtime.log?.(`[tlon] Failed to download images: ${error?.message ?? String(error)}`);
      }
    }

    // Fetch thread context when entering a thread for the first time
    if (isThreadReply && parentId && groupChannel) {
      try {
        const threadHistory = await fetchThreadHistory(api, groupChannel, parentId, 20, runtime);
        if (threadHistory.length > 0) {
          const threadContext = threadHistory
            .slice(-10) // Last 10 messages for context
            .map((msg) => `${msg.author}: ${msg.content}`)
            .join("\n");

          // Prepend thread context to the message
          // Include note about ongoing conversation for agent judgment
          const contextNote = `[Thread conversation - ${threadHistory.length} previous replies. You are participating in this thread. Only respond if relevant or helpful - you don't need to reply to every message.]`;
          messageText = `${contextNote}\n\n[Previous messages]\n${threadContext}\n\n[Current message]\n${messageText}`;
          runtime?.log?.(
            `[tlon] Added thread context (${threadHistory.length} replies) to message`,
          );
        }
      } catch (error: any) {
        runtime?.log?.(`[tlon] Could not fetch thread context: ${error?.message ?? String(error)}`);
        // Continue without thread context - not critical
      }
    }

    if (isGroup && groupChannel && isSummarizationRequest(messageText)) {
      try {
        const history = await getChannelHistory(api, groupChannel, 50, runtime);
        if (history.length === 0) {
          const noHistoryMsg =
            "I couldn't fetch any messages for this channel. It might be empty or there might be a permissions issue.";
          if (isGroup) {
            const parsed = parseChannelNest(groupChannel);
            if (parsed) {
              await sendGroupMessage({
                api: api,
                fromShip: botShipName,
                hostShip: parsed.hostShip,
                channelName: parsed.channelName,
                text: noHistoryMsg,
              });
            }
          } else {
            await sendDm({
              api: api,
              fromShip: botShipName,
              toShip: senderShip,
              text: noHistoryMsg,
            });
          }
          return;
        }

        const historyText = history
          .map(
            (msg) => `[${new Date(msg.timestamp).toLocaleString()}] ${msg.author}: ${msg.content}`,
          )
          .join("\n");

        messageText =
          `Please summarize this channel conversation (${history.length} recent messages):\n\n${historyText}\n\n` +
          "Provide a concise summary highlighting:\n" +
          "1. Main topics discussed\n" +
          "2. Key decisions or conclusions\n" +
          "3. Action items if any\n" +
          "4. Notable participants";
      } catch (error: any) {
        const errorMsg = `Sorry, I encountered an error while fetching the channel history: ${error?.message ?? String(error)}`;
        if (isGroup && groupChannel) {
          const parsed = parseChannelNest(groupChannel);
          if (parsed) {
            await sendGroupMessage({
              api: api,
              fromShip: botShipName,
              hostShip: parsed.hostShip,
              channelName: parsed.channelName,
              text: errorMsg,
            });
          }
        } else {
          await sendDm({ api: api, fromShip: botShipName, toShip: senderShip, text: errorMsg });
        }
        return;
      }
    }

    const route = core.channel.routing.resolveAgentRoute({
      cfg,
      channel: "tlon",
      accountId: opts.accountId ?? undefined,
      peer: {
        kind: isGroup ? "group" : "direct",
        id: isGroup ? (groupChannel ?? senderShip) : senderShip,
      },
    });

    // Warn if multiple users share a DM session (insecure dmScope configuration)
    if (!isGroup) {
      const sessionKey = route.sessionKey;
      if (!dmSendersBySession.has(sessionKey)) {
        dmSendersBySession.set(sessionKey, new Set());
      }
      const senders = dmSendersBySession.get(sessionKey)!;
      if (senders.size > 0 && !senders.has(senderShip)) {
        // Log warning
        runtime.log?.(
          `[tlon] ⚠️ SECURITY: Multiple users sharing DM session. ` +
            `Configure "session.dmScope: per-channel-peer" in OpenClaw config.`,
        );

        // Notify owner via DM (once per monitor session)
        if (!sharedSessionWarningSent && effectiveOwnerShip) {
          sharedSessionWarningSent = true;
          const warningMsg =
            `⚠️ Security Warning: Multiple users are sharing a DM session with this bot. ` +
            `This can leak conversation context between users.\n\n` +
            `Fix: Add to your OpenClaw config:\n` +
            `session:\n  dmScope: "per-channel-peer"\n\n` +
            `Docs: https://docs.openclaw.ai/concepts/session#secure-dm-mode`;

          // Send async, don't block message processing
          sendDm({
            api,
            fromShip: botShipName,
            toShip: effectiveOwnerShip,
            text: warningMsg,
          }).catch((err) =>
            runtime.error?.(`[tlon] Failed to send security warning to owner: ${err}`),
          );
        }
      }
      senders.add(senderShip);
    }

    const senderRole = isOwner(senderShip) ? "owner" : "user";
    const fromLabel = isGroup
      ? `${senderShip} [${senderRole}] in ${channelNest}`
      : `${senderShip} [${senderRole}]`;

    // Compute command authorization for slash commands (owner-only)
    const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(
      messageText,
      cfg,
    );
    let commandAuthorized = false;

    if (shouldComputeAuth) {
      const useAccessGroups = cfg.commands?.useAccessGroups !== false;
      const senderIsOwner = isOwner(senderShip);

      commandAuthorized = core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [{ configured: Boolean(effectiveOwnerShip), allowed: senderIsOwner }],
      });

      // Log when non-owner attempts a slash command (will be silently ignored by Gateway)
      if (!commandAuthorized) {
        console.log(
          `[tlon] Command attempt denied: ${senderShip} is not owner (owner=${effectiveOwnerShip ?? "not configured"})`,
        );
      }
    }

    // Prepend attachment annotations to message body (similar to Signal format)
    let bodyWithAttachments = messageText;
    if (attachments.length > 0) {
      const mediaLines = attachments
        .map((a) => `[media attached: ${a.path} (${a.contentType}) | ${a.path}]`)
        .join("\n");
      bodyWithAttachments = mediaLines + "\n" + messageText;
    }

    const body = core.channel.reply.formatAgentEnvelope({
      channel: "Tlon",
      from: fromLabel,
      timestamp,
      body: bodyWithAttachments,
    });

    // Strip bot ship mention for CommandBody so "/status" is recognized as command-only
    const commandBody = isGroup ? stripBotMention(messageText, botShipName) : messageText;

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      RawBody: messageText,
      CommandBody: commandBody,
      From: isGroup ? `tlon:group:${groupChannel}` : `tlon:${senderShip}`,
      To: `tlon:${botShipName}`,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      ConversationLabel: fromLabel,
      SenderName: senderShip,
      SenderId: senderShip,
      SenderRole: senderRole,
      CommandAuthorized: commandAuthorized,
      CommandSource: "text" as const,
      Provider: "tlon",
      Surface: "tlon",
      MessageSid: messageId,
      // Include downloaded media attachments
      ...(attachments.length > 0 && { Attachments: attachments }),
      OriginatingChannel: "tlon",
      OriginatingTo: `tlon:${isGroup ? groupChannel : botShipName}`,
      // Include thread context for automatic reply routing
      ...(parentId && { ThreadId: String(parentId), ReplyToId: String(parentId) }),
    });

    const dispatchStartTime = Date.now();

    const responsePrefix = core.channel.reply.resolveEffectiveMessagesConfig(
      cfg,
      route.agentId,
    ).responsePrefix;
    const humanDelay = core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId);

    await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        responsePrefix,
        humanDelay,
        deliver: async (payload: ReplyPayload) => {
          let replyText = payload.text;
          if (!replyText) {
            return;
          }

          // Use settings store value if set, otherwise fall back to file config
          const showSignature = effectiveShowModelSig;
          if (showSignature) {
            const modelInfo =
              (payload as { metadata?: { model?: string } }).metadata?.model ||
              (payload as { model?: string }).model ||
              (route as { model?: string }).model ||
              cfg.agents?.defaults?.model?.primary;
            replyText = `${replyText}\n\n_[Generated by ${formatModelName(modelInfo)}]_`;
          }

          if (isGroup && groupChannel) {
            const parsed = parseChannelNest(groupChannel);
            if (!parsed) {
              return;
            }
            await sendGroupMessage({
              api: api,
              fromShip: botShipName,
              hostShip: parsed.hostShip,
              channelName: parsed.channelName,
              text: replyText,
              replyToId: parentId ?? undefined,
            });
            // Track thread participation for future replies without mention
            if (parentId) {
              participatedThreads.add(String(parentId));
              runtime.log?.(`[tlon] Now tracking thread for future replies: ${parentId}`);
            }
          } else {
            await sendDm({ api: api, fromShip: botShipName, toShip: senderShip, text: replyText });
          }
        },
        onError: (err, info) => {
          const dispatchDuration = Date.now() - dispatchStartTime;
          runtime.error?.(
            `[tlon] ${info.kind} reply failed after ${dispatchDuration}ms: ${String(err)}`,
          );
        },
      },
    });
  };

  // Track which channels we're interested in for filtering firehose events
  const watchedChannels = new Set<string>(groupChannels);
  const _watchedDMs = new Set<string>();

  // Firehose handler for all channel messages (/v2)
  const handleChannelsFirehose = async (event: any) => {
    try {
      const nest = event?.nest;
      if (!nest) {
        return;
      }

      // Only process channels we're watching
      if (!watchedChannels.has(nest)) {
        return;
      }

      const response = event?.response;
      if (!response) {
        return;
      }

      // Handle post responses (new posts and replies)
      const essay = response?.post?.["r-post"]?.set?.essay;
      const memo = response?.post?.["r-post"]?.reply?.["r-reply"]?.set?.memo;
      if (!essay && !memo) {
        return;
      }

      const content = memo || essay;
      const isThreadReply = Boolean(memo);
      const messageId = isThreadReply ? response?.post?.["r-post"]?.reply?.id : response?.post?.id;

      if (!processedTracker.mark(messageId)) {
        return;
      }

      const senderShip = normalizeShip(content.author ?? "");
      if (!senderShip || senderShip === botShipName) {
        return;
      }

      // Resolve any cited/quoted messages first
      const citedContent = await resolveAllCites(content.content);
      const rawText = extractMessageText(content.content);
      const messageText = citedContent + rawText;
      if (!messageText.trim()) {
        return;
      }

      cacheMessage(nest, {
        author: senderShip,
        content: messageText,
        timestamp: content.sent || Date.now(),
        id: messageId,
      });

      // Get thread info early for participation check
      const seal = isThreadReply
        ? response?.post?.["r-post"]?.reply?.["r-reply"]?.set?.seal
        : response?.post?.["r-post"]?.set?.seal;
      const parentId = seal?.["parent-id"] || seal?.parent || null;

      // Check if we should respond:
      // 1. Direct mention always triggers response
      // 2. Thread replies where we've participated - respond if relevant (let agent decide)
      const mentioned = isBotMentioned(messageText, botShipName, botNickname ?? undefined);
      const inParticipatedThread =
        isThreadReply && parentId && participatedThreads.has(String(parentId));

      if (!mentioned && !inParticipatedThread) {
        return;
      }

      // Log why we're responding
      if (inParticipatedThread && !mentioned) {
        runtime.log?.(`[tlon] Responding to thread we participated in (no mention): ${parentId}`);
      }

      // Owner is always allowed
      if (isOwner(senderShip)) {
        runtime.log?.(`[tlon] Owner ${senderShip} is always allowed in channels`);
      } else {
        const { mode, allowedShips } = resolveChannelAuthorization(cfg, nest, currentSettings);
        if (mode === "restricted") {
          const normalizedAllowed = allowedShips.map(normalizeShip);
          if (!normalizedAllowed.includes(senderShip)) {
            // If owner is configured, queue approval request
            if (effectiveOwnerShip) {
              const approval = createPendingApproval({
                type: "channel",
                requestingShip: senderShip,
                channelNest: nest,
                messagePreview: messageText.substring(0, 100),
                originalMessage: {
                  messageId: messageId ?? "",
                  messageText,
                  messageContent: content.content,
                  timestamp: content.sent || Date.now(),
                  parentId: parentId ?? undefined,
                  isThreadReply,
                },
              });
              await queueApprovalRequest(approval);
            } else {
              runtime.log?.(
                `[tlon] Access denied: ${senderShip} in ${nest} (allowed: ${allowedShips.join(", ")})`,
              );
            }
            return;
          }
        }
      }

      const parsed = parseChannelNest(nest);
      await processMessage({
        messageId: messageId ?? "",
        senderShip,
        messageText,
        messageContent: content.content, // Pass raw content for media extraction
        isGroup: true,
        channelNest: nest,
        hostShip: parsed?.hostShip,
        channelName: parsed?.channelName,
        timestamp: content.sent || Date.now(),
        parentId,
        isThreadReply,
      });
    } catch (error: any) {
      runtime.error?.(
        `[tlon] Error handling channel firehose event: ${error?.message ?? String(error)}`,
      );
    }
  };

  // Firehose handler for all DM messages (/v3)
  // Track which DM invites we've already processed to avoid duplicate accepts
  const processedDmInvites = new Set<string>();

  const handleChatFirehose = async (event: any) => {
    try {
      // Handle DM invite lists (arrays)
      if (Array.isArray(event)) {
        for (const invite of event as DmInvite[]) {
          const ship = normalizeShip(invite.ship || "");
          if (!ship || processedDmInvites.has(ship)) {
            continue;
          }

          // Owner is always allowed
          if (isOwner(ship)) {
            try {
              await api.poke({
                app: "chat",
                mark: "chat-dm-rsvp",
                json: { ship, ok: true },
              });
              processedDmInvites.add(ship);
              runtime.log?.(`[tlon] Auto-accepted DM invite from owner ${ship}`);
            } catch (err) {
              runtime.error?.(`[tlon] Failed to auto-accept DM from owner: ${String(err)}`);
            }
            continue;
          }

          // Auto-accept if on allowlist and auto-accept is enabled
          if (effectiveAutoAcceptDmInvites && isDmAllowed(ship, effectiveDmAllowlist)) {
            try {
              await api.poke({
                app: "chat",
                mark: "chat-dm-rsvp",
                json: { ship, ok: true },
              });
              processedDmInvites.add(ship);
              runtime.log?.(`[tlon] Auto-accepted DM invite from ${ship}`);
            } catch (err) {
              runtime.error?.(`[tlon] Failed to auto-accept DM from ${ship}: ${String(err)}`);
            }
            continue;
          }

          // If owner is configured and ship is not on allowlist, queue approval
          if (effectiveOwnerShip && !isDmAllowed(ship, effectiveDmAllowlist)) {
            const approval = createPendingApproval({
              type: "dm",
              requestingShip: ship,
              messagePreview: "(DM invite - no message yet)",
            });
            await queueApprovalRequest(approval);
            processedDmInvites.add(ship); // Mark as processed to avoid duplicate notifications
          }
        }
        return;
      }
      if (!("whom" in event) || !("response" in event)) {
        return;
      }

      const whom = event.whom; // DM partner ship or club ID
      const messageId = event.id;
      const response = event.response;

      // Handle add events (new messages)
      const essay = response?.add?.essay;
      if (!essay) {
        return;
      }

      if (!processedTracker.mark(messageId)) {
        return;
      }

      const authorShip = normalizeShip(essay.author ?? "");
      const partnerShip = extractDmPartnerShip(whom);
      const senderShip = partnerShip || authorShip;

      // Ignore the bot's own outbound DM events.
      if (authorShip === botShipName) {
        return;
      }
      if (!senderShip || senderShip === botShipName) {
        return;
      }

      // Log mismatch between author and partner for debugging
      if (authorShip && partnerShip && authorShip !== partnerShip) {
        runtime.log?.(
          `[tlon] DM ship mismatch (author=${authorShip}, partner=${partnerShip}) - routing to partner`,
        );
      }

      // Resolve any cited/quoted messages first
      const citedContent = await resolveAllCites(essay.content);
      const rawText = extractMessageText(essay.content);
      const messageText = citedContent + rawText;
      if (!messageText.trim()) {
        return;
      }

      // Check if this is the owner sending an approval response
      if (isOwner(senderShip) && isApprovalResponse(messageText)) {
        const handled = await handleApprovalResponse(messageText);
        if (handled) {
          runtime.log?.(`[tlon] Processed approval response from owner: ${messageText}`);
          return;
        }
      }

      // Check if this is the owner sending an admin command
      if (isOwner(senderShip) && isAdminCommand(messageText)) {
        const handled = await handleAdminCommand(messageText);
        if (handled) {
          runtime.log?.(`[tlon] Processed admin command from owner: ${messageText}`);
          return;
        }
      }

      // Owner is always allowed to DM (bypass allowlist)
      if (isOwner(senderShip)) {
        runtime.log?.(`[tlon] Processing DM from owner ${senderShip}`);
        await processMessage({
          messageId: messageId ?? "",
          senderShip,
          messageText,
          messageContent: essay.content,
          isGroup: false,
          timestamp: essay.sent || Date.now(),
        });
        return;
      }

      // For DMs from others, check allowlist
      if (!isDmAllowed(senderShip, effectiveDmAllowlist)) {
        // If owner is configured, queue approval request
        if (effectiveOwnerShip) {
          const approval = createPendingApproval({
            type: "dm",
            requestingShip: senderShip,
            messagePreview: messageText.substring(0, 100),
            originalMessage: {
              messageId: messageId ?? "",
              messageText,
              messageContent: essay.content,
              timestamp: essay.sent || Date.now(),
            },
          });
          await queueApprovalRequest(approval);
        } else {
          runtime.log?.(`[tlon] Blocked DM from ${senderShip}: not in allowlist`);
        }
        return;
      }

      await processMessage({
        messageId: messageId ?? "",
        senderShip,
        messageText,
        messageContent: essay.content, // Pass raw content for media extraction
        isGroup: false,
        timestamp: essay.sent || Date.now(),
      });
    } catch (error: any) {
      runtime.error?.(
        `[tlon] Error handling chat firehose event: ${error?.message ?? String(error)}`,
      );
    }
  };

  try {
    runtime.log?.("[tlon] Subscribing to firehose updates...");

    // Subscribe to channels firehose (/v2)
    await api.subscribe({
      app: "channels",
      path: "/v2",
      event: handleChannelsFirehose,
      err: (error) => {
        runtime.error?.(`[tlon] Channels firehose error: ${String(error)}`);
      },
      quit: () => {
        runtime.log?.("[tlon] Channels firehose subscription ended");
      },
    });
    runtime.log?.("[tlon] Subscribed to channels firehose (/v2)");

    // Subscribe to chat/DM firehose (/v3)
    await api.subscribe({
      app: "chat",
      path: "/v3",
      event: handleChatFirehose,
      err: (error) => {
        runtime.error?.(`[tlon] Chat firehose error: ${String(error)}`);
      },
      quit: () => {
        runtime.log?.("[tlon] Chat firehose subscription ended");
      },
    });
    runtime.log?.("[tlon] Subscribed to chat firehose (/v3)");

    // Subscribe to contacts updates to track nickname changes
    await api.subscribe({
      app: "contacts",
      path: "/v1/news",
      event: (event: any) => {
        try {
          // Look for self profile updates
          if (event?.self) {
            const selfUpdate = event.self;
            if (selfUpdate?.contact?.nickname?.value !== undefined) {
              const newNickname = selfUpdate.contact.nickname.value || null;
              if (newNickname !== botNickname) {
                botNickname = newNickname;
                runtime.log?.(`[tlon] Nickname updated: ${botNickname}`);
              }
            }
          }
        } catch (error: any) {
          runtime.error?.(
            `[tlon] Error handling contacts event: ${error?.message ?? String(error)}`,
          );
        }
      },
      err: (error) => {
        runtime.error?.(`[tlon] Contacts subscription error: ${String(error)}`);
      },
      quit: () => {
        runtime.log?.("[tlon] Contacts subscription ended");
      },
    });
    runtime.log?.("[tlon] Subscribed to contacts updates (/v1/news)");

    // Subscribe to settings store for hot-reloading config
    settingsManager.onChange((newSettings) => {
      currentSettings = newSettings;

      // Update watched channels if settings changed
      if (newSettings.groupChannels?.length) {
        const newChannels = newSettings.groupChannels;
        for (const ch of newChannels) {
          if (!watchedChannels.has(ch)) {
            watchedChannels.add(ch);
            runtime.log?.(`[tlon] Settings: now watching channel ${ch}`);
          }
        }
        // Note: we don't remove channels from watchedChannels to avoid missing messages
        // during transitions. The authorization check handles access control.
      }

      // Update DM allowlist
      if (newSettings.dmAllowlist !== undefined) {
        effectiveDmAllowlist =
          newSettings.dmAllowlist.length > 0 ? newSettings.dmAllowlist : account.dmAllowlist;
        runtime.log?.(`[tlon] Settings: dmAllowlist updated to ${effectiveDmAllowlist.join(", ")}`);
      }

      // Update model signature setting
      if (newSettings.showModelSig !== undefined) {
        effectiveShowModelSig = newSettings.showModelSig;
        runtime.log?.(`[tlon] Settings: showModelSig = ${effectiveShowModelSig}`);
      }

      // Update auto-accept DM invites setting
      if (newSettings.autoAcceptDmInvites !== undefined) {
        effectiveAutoAcceptDmInvites = newSettings.autoAcceptDmInvites;
        runtime.log?.(`[tlon] Settings: autoAcceptDmInvites = ${effectiveAutoAcceptDmInvites}`);
      }

      // Update auto-accept group invites setting
      if (newSettings.autoAcceptGroupInvites !== undefined) {
        effectiveAutoAcceptGroupInvites = newSettings.autoAcceptGroupInvites;
        runtime.log?.(
          `[tlon] Settings: autoAcceptGroupInvites = ${effectiveAutoAcceptGroupInvites}`,
        );
      }

      // Update group invite allowlist
      if (newSettings.groupInviteAllowlist !== undefined) {
        effectiveGroupInviteAllowlist =
          newSettings.groupInviteAllowlist.length > 0
            ? newSettings.groupInviteAllowlist
            : account.groupInviteAllowlist;
        runtime.log?.(
          `[tlon] Settings: groupInviteAllowlist updated to ${effectiveGroupInviteAllowlist.join(", ")}`,
        );
      }

      if (newSettings.defaultAuthorizedShips !== undefined) {
        runtime.log?.(
          `[tlon] Settings: defaultAuthorizedShips updated to ${(newSettings.defaultAuthorizedShips || []).join(", ")}`,
        );
      }

      // Update auto-discover channels
      if (newSettings.autoDiscoverChannels !== undefined) {
        effectiveAutoDiscoverChannels = newSettings.autoDiscoverChannels;
        runtime.log?.(`[tlon] Settings: autoDiscoverChannels = ${effectiveAutoDiscoverChannels}`);
      }

      // Update owner ship
      if (newSettings.ownerShip !== undefined) {
        effectiveOwnerShip = newSettings.ownerShip
          ? normalizeShip(newSettings.ownerShip)
          : account.ownerShip
            ? normalizeShip(account.ownerShip)
            : null;
        runtime.log?.(`[tlon] Settings: ownerShip = ${effectiveOwnerShip}`);
      }

      // Update pending approvals
      if (newSettings.pendingApprovals !== undefined) {
        pendingApprovals = newSettings.pendingApprovals;
        runtime.log?.(
          `[tlon] Settings: pendingApprovals updated (${pendingApprovals.length} items)`,
        );
      }
    });

    try {
      await settingsManager.startSubscription();
    } catch (err) {
      // Settings subscription is optional - don't fail if it doesn't work
      runtime.log?.(`[tlon] Settings subscription not available: ${String(err)}`);
    }

    // Subscribe to groups-ui for real-time channel additions (when invites are accepted)
    try {
      await api.subscribe({
        app: "groups",
        path: "/groups/ui",
        event: async (event: any) => {
          try {
            // Handle group/channel join events
            // Event structure: { group: { flag: "~host/group-name", ... }, channels: { ... } }
            if (event && typeof event === "object") {
              // Check for new channels being added to groups
              if (event.channels && typeof event.channels === "object") {
                const channels = event.channels as Record<string, any>;
                for (const [channelNest, _channelData] of Object.entries(channels)) {
                  // Only monitor chat channels
                  if (!channelNest.startsWith("chat/")) {
                    continue;
                  }

                  // If this is a new channel we're not watching yet, add it
                  if (!watchedChannels.has(channelNest)) {
                    watchedChannels.add(channelNest);
                    runtime.log?.(
                      `[tlon] Auto-detected new channel (invite accepted): ${channelNest}`,
                    );

                    // Persist to settings store so it survives restarts
                    if (effectiveAutoAcceptGroupInvites) {
                      try {
                        const currentChannels = currentSettings.groupChannels || [];
                        if (!currentChannels.includes(channelNest)) {
                          const updatedChannels = [...currentChannels, channelNest];
                          // Poke settings store to persist
                          await api.poke({
                            app: "settings",
                            mark: "settings-event",
                            json: {
                              "put-entry": {
                                "bucket-key": "tlon",
                                "entry-key": "groupChannels",
                                value: updatedChannels,
                                desk: "moltbot",
                              },
                            },
                          });
                          runtime.log?.(`[tlon] Persisted ${channelNest} to settings store`);
                        }
                      } catch (err) {
                        runtime.error?.(
                          `[tlon] Failed to persist channel to settings: ${String(err)}`,
                        );
                      }
                    }
                  }
                }
              }

              // Also check for the "join" event structure
              if (event.join && typeof event.join === "object") {
                const join = event.join as { group?: string; channels?: string[] };
                if (join.channels) {
                  for (const channelNest of join.channels) {
                    if (!channelNest.startsWith("chat/")) {
                      continue;
                    }
                    if (!watchedChannels.has(channelNest)) {
                      watchedChannels.add(channelNest);
                      runtime.log?.(`[tlon] Auto-detected joined channel: ${channelNest}`);

                      // Persist to settings store
                      if (effectiveAutoAcceptGroupInvites) {
                        try {
                          const currentChannels = currentSettings.groupChannels || [];
                          if (!currentChannels.includes(channelNest)) {
                            const updatedChannels = [...currentChannels, channelNest];
                            await api.poke({
                              app: "settings",
                              mark: "settings-event",
                              json: {
                                "put-entry": {
                                  "bucket-key": "tlon",
                                  "entry-key": "groupChannels",
                                  value: updatedChannels,
                                  desk: "moltbot",
                                },
                              },
                            });
                            runtime.log?.(`[tlon] Persisted ${channelNest} to settings store`);
                          }
                        } catch (err) {
                          runtime.error?.(
                            `[tlon] Failed to persist channel to settings: ${String(err)}`,
                          );
                        }
                      }
                    }
                  }
                }
              }
            }
          } catch (error: any) {
            runtime.error?.(
              `[tlon] Error handling groups-ui event: ${error?.message ?? String(error)}`,
            );
          }
        },
        err: (error) => {
          runtime.error?.(`[tlon] Groups-ui subscription error: ${String(error)}`);
        },
        quit: () => {
          runtime.log?.("[tlon] Groups-ui subscription ended");
        },
      });
      runtime.log?.("[tlon] Subscribed to groups-ui for real-time channel detection");
    } catch (err) {
      // Groups-ui subscription is optional - channel discovery will still work via polling
      runtime.log?.(`[tlon] Groups-ui subscription failed (will rely on polling): ${String(err)}`);
    }

    // Subscribe to foreigns for auto-accepting group invites
    // Always subscribe so we can hot-reload the setting via settings store
    {
      const processedGroupInvites = new Set<string>();

      // Helper to process pending invites
      const processPendingInvites = async (foreigns: Foreigns) => {
        if (!foreigns || typeof foreigns !== "object") {
          return;
        }

        for (const [groupFlag, foreign] of Object.entries(foreigns)) {
          if (processedGroupInvites.has(groupFlag)) {
            continue;
          }
          if (!foreign.invites || foreign.invites.length === 0) {
            continue;
          }

          const validInvite = foreign.invites.find((inv) => inv.valid);
          if (!validInvite) {
            continue;
          }

          const inviterShip = validInvite.from;
          const normalizedInviter = normalizeShip(inviterShip);

          // Owner invites are always accepted
          if (isOwner(inviterShip)) {
            try {
              await api.poke({
                app: "groups",
                mark: "group-join",
                json: {
                  flag: groupFlag,
                  "join-all": true,
                },
              });
              processedGroupInvites.add(groupFlag);
              runtime.log?.(`[tlon] Auto-accepted group invite from owner: ${groupFlag}`);
            } catch (err) {
              runtime.error?.(`[tlon] Failed to accept group invite from owner: ${String(err)}`);
            }
            continue;
          }

          // Skip if auto-accept is disabled
          if (!effectiveAutoAcceptGroupInvites) {
            // If owner is configured, queue approval
            if (effectiveOwnerShip) {
              const approval = createPendingApproval({
                type: "group",
                requestingShip: inviterShip,
                groupFlag,
              });
              await queueApprovalRequest(approval);
              processedGroupInvites.add(groupFlag);
            }
            continue;
          }

          // Check if inviter is on allowlist
          const isAllowed =
            effectiveGroupInviteAllowlist.length > 0
              ? effectiveGroupInviteAllowlist
                  .map((s) => normalizeShip(s))
                  .some((s) => s === normalizedInviter)
              : false; // Fail-safe: empty allowlist means deny

          if (!isAllowed) {
            // If owner is configured, queue approval
            if (effectiveOwnerShip) {
              const approval = createPendingApproval({
                type: "group",
                requestingShip: inviterShip,
                groupFlag,
              });
              await queueApprovalRequest(approval);
              processedGroupInvites.add(groupFlag);
            } else {
              runtime.log?.(
                `[tlon] Rejected group invite from ${inviterShip} (not in groupInviteAllowlist): ${groupFlag}`,
              );
              processedGroupInvites.add(groupFlag);
            }
            continue;
          }

          // Inviter is on allowlist - accept the invite
          try {
            await api.poke({
              app: "groups",
              mark: "group-join",
              json: {
                flag: groupFlag,
                "join-all": true,
              },
            });
            processedGroupInvites.add(groupFlag);
            runtime.log?.(
              `[tlon] Auto-accepted group invite: ${groupFlag} (from ${validInvite.from})`,
            );
          } catch (err) {
            runtime.error?.(`[tlon] Failed to auto-accept group ${groupFlag}: ${String(err)}`);
          }
        }
      };

      // Process existing pending invites from init data
      if (initForeigns) {
        await processPendingInvites(initForeigns);
      }

      try {
        await api.subscribe({
          app: "groups",
          path: "/v1/foreigns",
          event: (data: unknown) => {
            void (async () => {
              try {
                await processPendingInvites(data as Foreigns);
              } catch (error: any) {
                runtime.error?.(
                  `[tlon] Error handling foreigns event: ${error?.message ?? String(error)}`,
                );
              }
            })();
          },
          err: (error) => {
            runtime.error?.(`[tlon] Foreigns subscription error: ${String(error)}`);
          },
          quit: () => {
            runtime.log?.("[tlon] Foreigns subscription ended");
          },
        });
        runtime.log?.(
          "[tlon] Subscribed to foreigns (/v1/foreigns) for auto-accepting group invites",
        );
      } catch (err) {
        runtime.log?.(`[tlon] Foreigns subscription failed: ${String(err)}`);
      }
    }

    // Discover channels to watch
    if (effectiveAutoDiscoverChannels) {
      const discoveredChannels = await fetchAllChannels(api, runtime);
      for (const channelNest of discoveredChannels) {
        watchedChannels.add(channelNest);
      }
      runtime.log?.(`[tlon] Watching ${watchedChannels.size} channel(s)`);
    }

    // Log watched channels
    for (const channelNest of watchedChannels) {
      runtime.log?.(`[tlon] Watching channel: ${channelNest}`);
    }

    runtime.log?.("[tlon] All subscriptions registered, connecting to SSE stream...");
    await api.connect();
    runtime.log?.("[tlon] Connected! Firehose subscriptions active");

    // Periodically refresh channel discovery
    const pollInterval = setInterval(
      async () => {
        if (!opts.abortSignal?.aborted) {
          try {
            if (effectiveAutoDiscoverChannels) {
              const discoveredChannels = await fetchAllChannels(api, runtime);
              for (const channelNest of discoveredChannels) {
                if (!watchedChannels.has(channelNest)) {
                  watchedChannels.add(channelNest);
                  runtime.log?.(`[tlon] Now watching new channel: ${channelNest}`);
                }
              }
            }
          } catch (error: any) {
            runtime.error?.(`[tlon] Channel refresh error: ${error?.message ?? String(error)}`);
          }
        }
      },
      2 * 60 * 1000,
    );

    if (opts.abortSignal) {
      const signal = opts.abortSignal;
      await new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            clearInterval(pollInterval);
            resolve(null);
          },
          { once: true },
        );
      });
    } else {
      await new Promise(() => {});
    }
  } finally {
    try {
      await api?.close();
    } catch (error: any) {
      runtime.error?.(`[tlon] Cleanup error: ${error?.message ?? String(error)}`);
    }
  }
}
