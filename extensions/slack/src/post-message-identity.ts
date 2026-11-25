import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

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

export function normalizeSlackSendIdentity(
  identity?: SlackPostMessageIdentity,
): SlackPostMessageIdentity | undefined {
  const username = normalizeOptionalString(identity?.username);
  const iconUrl = normalizeOptionalString(identity?.iconUrl);
  const iconEmoji = normalizeOptionalString(identity?.iconEmoji);
  const normalized = {
    ...(username ? { username } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    ...(iconEmoji ? { iconEmoji } : {}),
  };
  return hasSlackMessageIdentity(normalized) ? normalized : undefined;
}
