import type { ResolvedLineAccount } from "./types.js";

export function resolveLineChannelAccessToken(
  explicit: string | undefined,
  params: Pick<ResolvedLineAccount, "accountId" | "channelAccessToken" | "tokenStatus">,
): string {
  if (explicit?.trim()) {
    return explicit.trim();
  }
  if (!params.channelAccessToken) {
    throw new Error(
      params.tokenStatus === "configured_unavailable"
        ? `LINE channel access token is configured but unavailable for account "${params.accountId}" (check the configured tokenFile).`
        : `LINE channel access token missing for account "${params.accountId}" (set channels.line.channelAccessToken or LINE_CHANNEL_ACCESS_TOKEN).`,
    );
  }
  return params.channelAccessToken.trim();
}
