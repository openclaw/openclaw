import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { generateHexPkceVerifierChallenge } from "openclaw/plugin-sdk/provider-auth";
import {
  generateOAuthState,
  parseOAuthAuthorizationInput,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import {
  MSTEAMS_DEFAULT_DELEGATED_SCOPES,
  MSTEAMS_OAUTH_REDIRECT_URI,
  buildMSTeamsAuthEndpoint,
  type MSTeamsDelegatedOAuthContext,
  type MSTeamsDelegatedTokens,
} from "./oauth.shared.js";
import { exchangeMSTeamsCodeForTokens } from "./oauth.token.js";

export type { MSTeamsDelegatedOAuthContext, MSTeamsDelegatedTokens };

export async function loginMSTeamsDelegated(
  ctx: MSTeamsDelegatedOAuthContext,
  params: {
    tenantId: string;
    clientId: string;
    clientSecret: string;
  },
): Promise<MSTeamsDelegatedTokens> {
  await ctx.note(
    [
      "A URL will be shown for you to open in your browser.",
      "After signing in, copy the redirect URL and paste it back here.",
    ].join("\n"),
    "MSTeams Delegated OAuth",
  );

  const { verifier, challenge } = generateHexPkceVerifierChallenge();
  const state = generateOAuthState();
  const query = new URLSearchParams({
    client_id: params.clientId,
    response_type: "code",
    redirect_uri: MSTEAMS_OAUTH_REDIRECT_URI,
    scope: MSTEAMS_DEFAULT_DELEGATED_SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    prompt: "consent",
  });
  const authUrl = `${buildMSTeamsAuthEndpoint(params.tenantId)}?${query.toString()}`;

  ctx.progress.update("OAuth URL ready");
  ctx.log(`\nOpen this URL in your LOCAL browser:\n\n${authUrl}\n`);
  ctx.progress.update("Waiting for you to paste the callback URL...");
  // A paste that does not answer this sign-in keeps the prompt open.
  const callbackInput = await ctx.prompt({
    message: "Paste the redirect URL here: ",
    validate: (value) => {
      try {
        parseOAuthAuthorizationInput(value, { state, signInUrl: authUrl });
        return undefined;
      } catch (error) {
        return formatErrorMessage(error);
      }
    },
  });
  const { code } = parseOAuthAuthorizationInput(callbackInput, { state });
  ctx.progress.update("Exchanging authorization code for tokens...");
  return exchangeMSTeamsCodeForTokens({
    tenantId: params.tenantId,
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    code,
    verifier,
  });
}
