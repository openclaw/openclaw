import { normalizeGroupActivation } from "../../../../../src/auto-reply/group-activation.js";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention
} from "../../../../../src/config/group-policy.js";
import {
  loadSessionStore,
  resolveGroupSessionKey,
  resolveStorePath
} from "../../../../../src/config/sessions.js";
function resolveGroupPolicyFor(cfg, conversationId) {
  const groupId = resolveGroupSessionKey({
    From: conversationId,
    ChatType: "group",
    Provider: "whatsapp"
  })?.id;
  const whatsappCfg = cfg.channels?.whatsapp;
  const hasGroupAllowFrom = Boolean(
    whatsappCfg?.groupAllowFrom?.length || whatsappCfg?.allowFrom?.length
  );
  return resolveChannelGroupPolicy({
    cfg,
    channel: "whatsapp",
    groupId: groupId ?? conversationId,
    hasGroupAllowFrom
  });
}
function resolveGroupRequireMentionFor(cfg, conversationId) {
  const groupId = resolveGroupSessionKey({
    From: conversationId,
    ChatType: "group",
    Provider: "whatsapp"
  })?.id;
  return resolveChannelGroupRequireMention({
    cfg,
    channel: "whatsapp",
    groupId: groupId ?? conversationId
  });
}
function resolveGroupActivationFor(params) {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.agentId
  });
  const store = loadSessionStore(storePath);
  const entry = store[params.sessionKey];
  const requireMention = resolveGroupRequireMentionFor(params.cfg, params.conversationId);
  const defaultActivation = !requireMention ? "always" : "mention";
  return normalizeGroupActivation(entry?.groupActivation) ?? defaultActivation;
}
export {
  resolveGroupActivationFor,
  resolveGroupPolicyFor,
  resolveGroupRequireMentionFor
};
