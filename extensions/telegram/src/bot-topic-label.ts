import type { Bot } from "grammy";
import { resolveAgentWorkspaceDir } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  advanceConversationLabelRefinement,
  readConversationLabelRefinementSource,
  generateConversationLabel,
} from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { prepareSkillCommandsForWorkspace } from "openclaw/plugin-sdk/skill-commands-runtime";
import type { FreshTelegramSessionEntryLoader } from "./bot-message-dispatch.types.js";
import { getTopicLabelRefinement, getTopicName, updateTopicName } from "./topic-name-cache.js";

/** The topic cache owns Telegram provenance; core owns task selection and refinement policy. */
export async function updateTelegramTopicLabel(params: {
  bot: Bot;
  cfg: OpenClawConfig;
  agentId: string;
  topicNameCacheScope: string;
  sessionKey: string;
  chatId: number;
  threadId: number;
  userMessage: string;
  prompt: string;
  skillFilter?: string[];
  firstTurn: boolean;
  loadFreshSessionEntry: FreshTelegramSessionEntryLoader;
  isSuperseded: () => boolean;
}): Promise<void> {
  params.loadFreshSessionEntry.clear();
  const { entry, storePath } = await params.loadFreshSessionEntry(
    params.agentId,
    params.sessionKey,
  );
  if (!entry?.sessionId || entry.label || entry.displayName) {
    return;
  }
  const scope = params.topicNameCacheScope;
  const name = await getTopicName(params.chatId, params.threadId, scope);
  const state = await getTopicLabelRefinement(params.chatId, params.threadId, scope);
  const skillCommands = await prepareSkillCommandsForWorkspace({
    cfg: params.cfg,
    agentId: params.agentId,
    workspaceDir: resolveAgentWorkspaceDir(params.cfg, params.agentId),
    sessionEntry: entry,
    sessionKey: params.sessionKey,
    skillFilter: params.skillFilter,
  });
  let userMessage = params.userMessage;
  if (params.firstTurn) {
    // A known topic name has no automatic provenance and belongs to the user.
    if (name || state) {
      return;
    }
  } else {
    const next = advanceConversationLabelRefinement({
      state,
      sessionId: entry.sessionId,
      currentName: name,
      userMessage,
      skillCommands,
    });
    if (!next) {
      return;
    }
    // Claim the sole attempt before reading context or calling the model.
    await updateTopicName(params.chatId, params.threadId, { refinement: next }, scope);
    if (next.remainingMessages) {
      return;
    }
    userMessage = await readConversationLabelRefinementSource(
      {
        agentId: params.agentId,
        sessionId: entry.sessionId,
        sessionKey: params.sessionKey,
        storePath,
      },
      userMessage,
      skillCommands,
    );
  }
  const label = await generateConversationLabel({
    userMessage,
    prompt: params.prompt,
    maxLength: 128,
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (!label) {
    return;
  }
  params.loadFreshSessionEntry.clear();
  const current = await params.loadFreshSessionEntry(params.agentId, params.sessionKey);
  const currentName = await getTopicName(params.chatId, params.threadId, scope);
  if (
    params.isSuperseded() ||
    current.entry?.sessionId !== entry.sessionId ||
    current.entry?.label ||
    current.entry?.displayName ||
    currentName !== name
  ) {
    return;
  }
  await params.bot.api.editForumTopic(params.chatId, params.threadId, { name: label });
  await updateTopicName(
    params.chatId,
    params.threadId,
    {
      name: label,
      refinement: {
        sessionId: entry.sessionId,
        generatedName: label,
        remainingMessages: params.firstTurn ? 6 : 0,
      },
    },
    scope,
  );
}
