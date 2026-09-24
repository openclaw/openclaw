// Slack plugin module implements best-effort custom identity fallback for chat.postMessage.
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { getSlackWebApiErrorData } from "./errors.js";
import type {
  SlackBasePostMessagePayload,
  SlackPostMessagePayload,
} from "./post-message-payload.js";

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

function isSlackCustomizeScopeError(err: unknown): boolean {
  const data = getSlackWebApiErrorData(err);
  const code = normalizeLowercaseStringOrEmpty(normalizeOptionalString(data?.error));
  if (code !== "missing_scope") {
    return false;
  }
  const needed = normalizeLowercaseStringOrEmpty(normalizeOptionalString(data?.needed));
  if (needed.includes("chat:write.customize")) {
    return true;
  }
  const scopes = [
    ...normalizeTrimmedStringList(data?.response_metadata?.scopes),
    ...normalizeTrimmedStringList(data?.response_metadata?.acceptedScopes),
  ].map((scope) => normalizeLowercaseStringOrEmpty(scope));
  return scopes.includes("chat:write.customize");
}

function isSlackCustomIdentityRejectedError(err: unknown): boolean {
  if (isSlackCustomizeScopeError(err)) {
    return true;
  }
  const data = getSlackWebApiErrorData(err);
  const code = normalizeLowercaseStringOrEmpty(normalizeOptionalString(data?.error));
  return code === "invalid_arguments" || code === "invalid_arg_name";
}

function hasCustomIdentity(identity?: SlackPostMessageIdentity): boolean {
  return Boolean(identity?.username || identity?.iconUrl || identity?.iconEmoji);
}

/** Post with the requested identity, degrading only on Slack identity-specific errors. */
export async function postSlackMessageWithIdentityFallback<T>(params: {
  basePayload: SlackBasePostMessagePayload;
  identity?: SlackPostMessageIdentity;
  post: (payload: SlackPostMessagePayload, identity?: SlackPostMessageIdentity) => Promise<T>;
}): Promise<T> {
  const { basePayload, identity, post } = params;
  try {
    if (!identity) {
      return await post(basePayload);
    }
    return await post({ ...basePayload, ...buildSlackMessageIdentityPayload(identity) }, identity);
  } catch (err) {
    if (!identity || !hasCustomIdentity(identity) || !isSlackCustomIdentityRejectedError(err)) {
      throw err;
    }
    if (
      !isSlackCustomizeScopeError(err) &&
      identity.username &&
      (identity.iconUrl || identity.iconEmoji)
    ) {
      logVerbose("slack send: custom icon rejected, retrying with username only");
      try {
        return await post(
          { ...basePayload, username: identity.username },
          { username: identity.username },
        );
      } catch (retryError) {
        if (!isSlackCustomIdentityRejectedError(retryError)) {
          throw retryError;
        }
      }
    }
    logVerbose("slack send: custom identity rejected, retrying without custom identity");
    return post(basePayload);
  }
}
