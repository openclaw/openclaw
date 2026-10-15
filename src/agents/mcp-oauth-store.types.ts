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
  /** Non-secret authorization incarnation; token refresh preserves it, reauthorization does not. */
  authorizationId?: string;
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

export type McpOAuthMutation =
  | { kind: "clientInformation"; clientInformation: OAuthClientInformationMixed }
  | {
      kind: "tokens";
      tokens: OAuthTokens;
      tokenExpiresAt: number | undefined;
      replaceAuthorization?: boolean;
    }
  | { kind: "ensureAuthorization" }
  | {
      kind: "authorizationRedirect";
      authorizationUrl: string;
      redirectUrl?: string;
      codeVerifier?: string;
    }
  | { kind: "discoveryState"; discoveryState: OAuthDiscoveryState }
  | {
      kind: "invalidate";
      scope: "all" | "client" | "tokens" | "verifier" | "discovery";
      suppressStoredTokens: boolean;
    }
  | { kind: "bindTokensIssuer" }
  | {
      kind: "authorizationChallenge";
      resourceMetadataUrl?: string;
      scope?: string;
      requiresAuthorization?: true;
      rejectedAccessToken?: string;
    }
  | { kind: "completeAuthorization" };
