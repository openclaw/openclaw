export type SlackBotAuthorIdentity = {
  botUserId?: string;
  botId?: string;
};

export type SlackThreadAuthorTuple = {
  userId?: string;
  botId?: string;
};

export type SlackThreadHistoryFilterPolicy = {
  retainCurrentBotMessages: boolean;
};

export type SlackThreadHistoryFilterResult<T> = {
  kept: T[];
  omittedCurrentBot: number;
};

export type SlackThreadIncludeRootMessageInput = {
  thread?: {
    includeRootMessage?: boolean;
  };
};

export function isSlackThreadAuthorCurrentBot(params: {
  identity: SlackBotAuthorIdentity;
  author: SlackThreadAuthorTuple;
}): boolean {
  const { identity, author } = params;
  if (identity.botUserId && author.userId && author.userId === identity.botUserId) {
    return true;
  }
  if (identity.botId && author.botId && author.botId === identity.botId) {
    return true;
  }
  return false;
}

export function resolveSlackThreadIncludeRootMessage(
  input: SlackThreadIncludeRootMessageInput,
): boolean {
  return input.thread?.includeRootMessage !== false;
}

export function resolveSlackThreadHistoryFilterPolicy(params: {
  isNewThreadSession: boolean;
  includeRootMessage: boolean;
}): SlackThreadHistoryFilterPolicy {
  return {
    retainCurrentBotMessages: params.isNewThreadSession && params.includeRootMessage,
  };
}

export function applySlackThreadHistoryFilterPolicy<T extends SlackThreadAuthorTuple>(params: {
  history: T[];
  policy: SlackThreadHistoryFilterPolicy;
  identity: SlackBotAuthorIdentity;
}): SlackThreadHistoryFilterResult<T> {
  if (params.policy.retainCurrentBotMessages) {
    return { kept: params.history, omittedCurrentBot: 0 };
  }
  const kept: T[] = [];
  let omittedCurrentBot = 0;
  for (const entry of params.history) {
    if (
      isSlackThreadAuthorCurrentBot({
        identity: params.identity,
        author: entry,
      })
    ) {
      omittedCurrentBot += 1;
      continue;
    }
    kept.push(entry);
  }
  return { kept, omittedCurrentBot };
}

export function shouldIncludeBotThreadStarterContext(params: {
  starterIsCurrentBot: boolean;
  isNewThreadSession: boolean;
  includeRootMessage: boolean;
  hasStarterText: boolean;
}): boolean {
  if (!params.hasStarterText) {
    return false;
  }
  return params.starterIsCurrentBot && params.isNewThreadSession && params.includeRootMessage;
}

export function formatSlackBotStarterThreadLabel(params: {
  roomLabel: string;
  starterText?: string;
}): string {
  const base = `Slack thread ${params.roomLabel}`;
  if (!params.starterText) {
    return base;
  }
  const snippet = params.starterText.replace(/\s+/g, " ").slice(0, 80).trim();
  if (!snippet) {
    return base;
  }
  return `${base} (assistant root): ${snippet}`;
}
