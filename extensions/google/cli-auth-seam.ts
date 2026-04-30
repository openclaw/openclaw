import { readGeminiCliCredentialsCached } from "openclaw/plugin-sdk/provider-auth";

export function readGeminiCliCredentialsForSetup() {
  return readGeminiCliCredentialsCached();
}

export function readGeminiCliCredentialsForSetupNonInteractive() {
  return readGeminiCliCredentialsCached();
}
