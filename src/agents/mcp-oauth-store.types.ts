import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

type McpOAuthAuthorizationChallenge = {
  resourceMetadataUrl?: string;
  scope?: string;
  requiresAuthorization?: true;
};

export type McpOAuthStore = {
  /** Provenance for token-less rows that Doctor must interpret during legacy import. */
  credentialState?: "uninitialized" | "cleared";
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  tokenExpiresAt?: number;
  tokensAuthorizationServerUrl?: string;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
  lastAuthorizationUrl?: string;
  redirectUrl?: string;
  pendingAuthorizationChallenge?: McpOAuthAuthorizationChallenge;
};
