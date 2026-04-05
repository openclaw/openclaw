import { readClaudeCliCredentialsCached } from "openclaw/plugin-sdk/provider-auth";

export function readClaudeCliCredentialsForRuntime() {
  return readClaudeCliCredentialsCached();
}
