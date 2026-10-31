export function isSlackThreadAuthorCurrentBot(params: {
  identity: { botUserId?: string; botId?: string };
  author: { userId?: string; botId?: string };
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
