/** Resolves full provider auth state for callers that need mode and profile provenance. */
export type ProviderAuthResolver = (
  provider: string,
  options?: {
    oauthMarker?: string;
    excludeProfileIds?: readonly string[];
  },
) => {
  apiKey: string | undefined;
  discoveryApiKey?: string;
  mode: "api_key" | "aws-sdk" | "oauth" | "token" | "none";
  source: "env" | "profile" | "none";
  profileId?: string;
  preparationFailed?: boolean;
  authFlow?: string;
};
