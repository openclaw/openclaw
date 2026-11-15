export type SlackPostMessageIdentity = {
  username?: string;
  iconUrl?: string;
  iconEmoji?: string;
};

export function buildSlackMessageIdentityPayload(identity?: SlackPostMessageIdentity) {
  return {
    ...(identity?.username ? { username: identity.username } : {}),
    ...(identity?.iconUrl
      ? { icon_url: identity.iconUrl }
      : identity?.iconEmoji
        ? { icon_emoji: identity.iconEmoji }
        : {}),
  };
}

export function hasSlackMessageIdentity(identity?: SlackPostMessageIdentity): boolean {
  return Boolean(identity?.username || identity?.iconUrl || identity?.iconEmoji);
}
