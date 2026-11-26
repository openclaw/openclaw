import type { ProviderNativeAuthDisplay } from "../plugins/provider-external-auth.types.js";

/** Secret-free credential modes captured by a prepared agent runtime. */
export type PreparedAgentCredentialMode =
  | "api_key"
  | "oauth"
  | "token"
  | Readonly<{
      source: "native";
      mode: "api_key" | "oauth" | "token";
      display?: ProviderNativeAuthDisplay;
    }>;

export type PreparedAgentCredentialModes = Readonly<Record<string, PreparedAgentCredentialMode>>;
