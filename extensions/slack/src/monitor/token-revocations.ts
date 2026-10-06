import { Buffer } from "node:buffer";
import type { PluginHookChannelTokensRevokedEvent } from "openclaw/plugin-sdk/channel-credential-events";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const APP_ID = /^A[A-Z0-9]{1,63}$/;
const TEAM_ID = /^T[A-Z0-9]{1,63}$/;
const EVENT_ID = /^Ev[A-Za-z0-9_-]{1,126}$/;
const USER_ID = /^[UW][A-Z0-9]{1,63}$/;
const MAX_OAUTH_USERS = 100;
const MAX_METADATA_BYTES = 16 * 1024;

/** Parse only native Events API control metadata; never retain the raw envelope. */
export function projectSlackTokenRevocation(
  body: unknown,
): PluginHookChannelTokensRevokedEvent | null {
  const envelope = asOptionalRecord(body);
  const event = asOptionalRecord(envelope?.event);
  if (event?.type !== "tokens_revoked") {
    return null;
  }
  const tokens = asOptionalRecord(event.tokens);
  const oauth = tokens?.oauth;
  if (
    envelope?.type !== "event_callback" ||
    !tokens ||
    typeof envelope.api_app_id !== "string" ||
    !APP_ID.test(envelope.api_app_id) ||
    typeof envelope.team_id !== "string" ||
    !TEAM_ID.test(envelope.team_id) ||
    typeof envelope.event_id !== "string" ||
    !EVENT_ID.test(envelope.event_id) ||
    typeof envelope.event_time !== "number" ||
    !Number.isSafeInteger(envelope.event_time) ||
    envelope.event_time < 0 ||
    (oauth !== undefined &&
      (!Array.isArray(oauth) ||
        oauth.length > MAX_OAUTH_USERS ||
        !oauth.every((id) => typeof id === "string" && USER_ID.test(id))))
  ) {
    throw new TypeError("Invalid Slack token revocation metadata");
  }
  const oauthUserIds = oauth === undefined ? [] : [...new Set<string>(oauth)].toSorted();
  const metadata = {
    eventId: envelope.event_id,
    eventTime: envelope.event_time,
    appId: envelope.api_app_id,
    workspaceId: envelope.team_id,
    oauthUserIds,
  };
  if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_METADATA_BYTES) {
    throw new TypeError("Invalid Slack token revocation metadata");
  }
  return metadata;
}
