import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  deleteSessionEntry,
  getSessionEntryAsync,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { listMSTeamsAccountIds, resolveMSTeamsAccountConfig } from "../accounts.js";
import { normalizeMSTeamsConversationId } from "../inbound.js";
import type { MSTeamsMessageHandlerDeps } from "../monitor-handler.types.js";
import { getMSTeamsRuntime } from "../runtime.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";

export async function handleMSTeamsLifecycleRemoval(
  context: MSTeamsTurnContext,
  deps: MSTeamsMessageHandlerDeps,
): Promise<void> {
  const activity = context.activity;
  const cfg = deps.readConfig?.() ?? deps.cfg;
  const account = resolveMSTeamsAccountConfig(cfg, deps.accountId);
  if (account.enabled === false || (account.appId && account.appId !== deps.appId)) {
    return;
  }
  const conversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "");
  if (!conversationId) {
    return;
  }
  const reference = await deps.conversationStore.get(conversationId);
  // The reference identifies the removed installation and makes a second removal
  // event harmless after cleanup. Keep it until the session owner succeeds.
  if (!reference || (reference.agent?.id ?? reference.bot?.id) !== activity.recipient?.id) {
    return;
  }
  const conversationType = normalizeOptionalLowercaseString(
    activity.conversation?.conversationType,
  );
  const isPersonal =
    (conversationType === "personal" || (!conversationType && !activity.conversation?.isGroup)) &&
    activity.conversation?.isGroup !== true &&
    !activity.channelData?.team &&
    !activity.channelData?.channel &&
    !reference.teamId &&
    (!reference.conversation?.conversationType ||
      reference.conversation.conversationType === "personal");
  if (!isPersonal) {
    await deps.conversationStore.remove(conversationId);
    return;
  }
  // A removal actor need not be the session's user; route the stored DM owner.
  const senderId = reference.user?.aadObjectId ?? reference.aadObjectId ?? reference.user?.id;
  if (!senderId) {
    return;
  }
  const routing = getMSTeamsRuntime().channel.routing;
  const routeForAccount = (accountId: string) =>
    routing.resolveAgentRoute({
      cfg,
      channel: "msteams",
      accountId,
      peer: { kind: "direct", id: senderId },
    });
  const route = routeForAccount(deps.accountId);
  const fullCfg = createRuntimeConfigReader(deps.accountPolicyCfg ?? deps.cfg)();
  const sharedWithAnotherAccount = listMSTeamsAccountIds(fullCfg).some(
    (accountId) =>
      accountId !== deps.accountId && routeForAccount(accountId).sessionKey === route.sessionKey,
  );
  // Main/per-peer sessions span channels; per-channel-peer can span bot accounts.
  // Uninstalling one installation must never erase those deliberately shared sessions.
  if (
    !["per-channel-peer", "per-account-channel-peer"].includes(route.dmScope ?? "main") ||
    sharedWithAnotherAccount
  ) {
    deps.log.info("msteams removal left shared session intact", { accountId: deps.accountId });
    await deps.conversationStore.remove(conversationId);
    return;
  }
  const scope = {
    agentId: route.agentId,
    sessionKey: route.sessionKey,
    storePath: resolveStorePath(cfg.session?.store, { agentId: route.agentId }),
  };
  const entry = await getSessionEntryAsync(scope);
  if (entry?.modelSelectionLocked) {
    deps.log.info("msteams removal left locked session intact", { accountId: deps.accountId });
    await deps.conversationStore.remove(conversationId);
    return;
  }
  if (entry) {
    const deleted = await deleteSessionEntry({
      ...scope,
      archiveTranscript: true,
      expectedSessionId: entry.sessionId ?? null,
      expectedUpdatedAt: entry.updatedAt,
    });
    if (!deleted) {
      throw new Error("Microsoft Teams removal session changed during cleanup; retry required.");
    }
  }
  await deps.conversationStore.remove(conversationId);
  deps.log.info("msteams installation session removed", { accountId: deps.accountId });
}
