// CLI-only: the doctor fix hint. Run errors reach chat, so their message names no command.
// `--method device-code` (the hint shipped through v2026.11.6) still resolves to this login.
export const CODEX_NATIVE_PROFILE_IMPORT_COMMAND =
  "openclaw models auth login --provider openai --method oauth";

export class CodexAppServerAuthProfileUnavailableError extends Error {
  readonly code = "selected_auth_profile_unavailable";
}

export function formatCodexAuthProfileUnavailableMessage(profileId: string): string {
  const missing = `Codex app-server auth profile "${profileId}" was not found in the OpenClaw credential store. This is a local credential lookup failure.`;
  return profileId === "openai:default"
    ? `${missing} Since 2026.9.5, OpenClaw no longer supplies this profile from the native Codex login. Sign in to OpenAI in OpenClaw for this agent, then retry.`
    : `${missing} Restore or select an existing OpenAI profile, then retry.`;
}
