import { isFutureDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { loadMSTeamsDelegatedTokens, saveMSTeamsDelegatedTokens } from "./delegated-state.js";
import { refreshMSTeamsDelegatedTokens } from "./oauth.token.js";

export {
  hasConfiguredMSTeamsCredentials,
  resolveMSTeamsCredentials,
  type MSTeamsCredentials,
  type MSTeamsFederatedCredentials,
} from "./token-config.js";

export async function resolveDelegatedAccessToken(params: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
}): Promise<string | undefined> {
  const tokens = await loadMSTeamsDelegatedTokens();
  if (!tokens) {
    return undefined;
  }

  // Token still valid (5-min buffer already baked into expiresAt)
  if (isFutureDateTimestampMs(tokens.expiresAt)) {
    return tokens.accessToken;
  }

  try {
    const refreshed = await refreshMSTeamsDelegatedTokens({
      tenantId: params.tenantId,
      clientId: params.clientId,
      clientSecret: params.clientSecret,
      refreshToken: tokens.refreshToken,
      scopes: tokens.scopes,
    });
    await saveMSTeamsDelegatedTokens(refreshed);
    return refreshed.accessToken;
  } catch {
    return undefined;
  }
}
