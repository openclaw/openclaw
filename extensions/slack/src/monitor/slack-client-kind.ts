import type { WebClient as SlackWebClient } from "@slack/web-api";
import { normalizeHostname } from "openclaw/plugin-sdk/host-runtime";

/** Detects the isolated GovSlack API plane without consulting mutable config. */
export function isGovSlackClient(client?: SlackWebClient): boolean {
  const apiUrl = client?.slackApiUrl ? URL.parse(client.slackApiUrl) : null;
  return (
    apiUrl?.protocol === "https:" &&
    !apiUrl.port &&
    normalizeHostname(apiUrl.hostname) === "slack-gov.com"
  );
}
