type SlackBotAuthorIdentity = {
  botUserId?: string;
  botId?: string;
};

type SlackThreadAuthorTuple = {
  userId?: string;
  botId?: string;
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
