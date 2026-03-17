import {
  resolveChannelMediaMaxBytes
} from "openclaw/plugin-sdk/msteams";
import { createMSTeamsConversationStoreFs } from "./conversation-store-fs.js";
import { getMSTeamsRuntime } from "./runtime.js";
import { createMSTeamsAdapter, loadMSTeamsSdkWithAuth } from "./sdk.js";
import { resolveMSTeamsCredentials } from "./token.js";
function parseRecipient(to) {
  const trimmed = to.trim();
  const finalize = (type, id) => {
    const normalized = id.trim();
    if (!normalized) {
      throw new Error(`Invalid target value: missing ${type} id`);
    }
    return { type, id: normalized };
  };
  if (trimmed.startsWith("conversation:")) {
    return finalize("conversation", trimmed.slice("conversation:".length));
  }
  if (trimmed.startsWith("user:")) {
    return finalize("user", trimmed.slice("user:".length));
  }
  if (trimmed.startsWith("19:") || trimmed.includes("@thread")) {
    return finalize("conversation", trimmed);
  }
  return finalize("user", trimmed);
}
async function findConversationReference(recipient) {
  if (recipient.type === "conversation") {
    const ref = await recipient.store.get(recipient.id);
    if (ref) {
      return { conversationId: recipient.id, ref };
    }
    return null;
  }
  const found = await recipient.store.findByUserId(recipient.id);
  if (!found) {
    return null;
  }
  return { conversationId: found.conversationId, ref: found.reference };
}
async function resolveMSTeamsSendContext(params) {
  const msteamsCfg = params.cfg.channels?.msteams;
  if (!msteamsCfg?.enabled) {
    throw new Error("msteams provider is not enabled");
  }
  const creds = resolveMSTeamsCredentials(msteamsCfg);
  if (!creds) {
    throw new Error("msteams credentials not configured");
  }
  const store = createMSTeamsConversationStoreFs();
  const recipient = parseRecipient(params.to);
  const found = await findConversationReference({ ...recipient, store });
  if (!found) {
    throw new Error(
      `No conversation reference found for ${recipient.type}:${recipient.id}. The bot must receive a message from this conversation before it can send proactively.`
    );
  }
  const { conversationId, ref } = found;
  const core = getMSTeamsRuntime();
  const log = core.logging.getChildLogger({ name: "msteams:send" });
  const { sdk, authConfig } = await loadMSTeamsSdkWithAuth(creds);
  const adapter = createMSTeamsAdapter(authConfig, sdk);
  const tokenProvider = new sdk.MsalTokenProvider(authConfig);
  const storedConversationType = ref.conversation?.conversationType?.toLowerCase() ?? "";
  let conversationType;
  if (storedConversationType === "personal") {
    conversationType = "personal";
  } else if (storedConversationType === "channel") {
    conversationType = "channel";
  } else {
    conversationType = "groupChat";
  }
  const sharePointSiteId = msteamsCfg.sharePointSiteId;
  const mediaMaxBytes = resolveChannelMediaMaxBytes({
    cfg: params.cfg,
    resolveChannelLimitMb: ({ cfg }) => cfg.channels?.msteams?.mediaMaxMb
  });
  return {
    appId: creds.appId,
    conversationId,
    ref,
    adapter,
    log,
    conversationType,
    tokenProvider,
    sharePointSiteId,
    mediaMaxBytes
  };
}
export {
  resolveMSTeamsSendContext
};
