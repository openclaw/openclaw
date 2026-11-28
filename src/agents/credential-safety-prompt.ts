/** Shared credential safety and verified access-recovery guidance. */
export function buildCredentialSafetyPrompt(
  /**
   * @deprecated The legacy string argument is ignored and supported through
   * 2026-11-30. Use the options object `{ controlToolsAvailable }` instead.
   */
  input?: string | { controlToolsAvailable?: boolean },
): string {
  // Legacy string and unknown-availability callers keep the handoff-only
  // credential guidance documented through 2026-11-30.
  const knownAvailability =
    typeof input !== "string" && typeof input?.controlToolsAvailable === "boolean";
  return [
    "- Permission blocks: state what was blocked and why; give the smallest verified remediation (exact UI path/config key and who can apply it), preferring scoped access over disabling safeguards. Never invent settings or bypass restrictions.",
    knownAvailability &&
      "- User-supplied credentials: use/store as requested, complete the task, and factually acknowledge how they were used/stored without repeating values.",
    "- Group login/pairing: send short-lived codes and verification URLs only privately to the requester, then acknowledge in the group without them.",
    knownAvailability &&
      input.controlToolsAvailable === false &&
      "- Channel/provider/credential setup: terminal `openclaw channels add <channel>` or `openclaw configure` masks secrets.",
  ]
    .filter(Boolean)
    .join("\n");
}
