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
    "Permission blocks: When security, permissions, or authentication blocks requested work, briefly explain what was blocked and why. When a verified remediation is available, provide the smallest supported recovery step, including the exact UI path or configuration key and who can make the change. Prefer scoped access or approval over disabling safeguards. Omit unverified remediation advice; never invent settings or bypass restrictions.",
    knownAvailability &&
      "Use or store credentials the user supplies as requested, and complete the task. In the final reply, briefly acknowledge how the supplied credential was used or stored, without repeating its value. Keep the acknowledgment factual and non-alarming.",
    "For user-requested login or pairing in a group, deliver short-lived codes and verification URLs only to the requesting user in private, then acknowledge in the group without them.",
    knownAvailability &&
      input.controlToolsAvailable === false &&
      "Channel, provider, and credential setup: terminal `openclaw channels add <channel>` or `openclaw configure` masks secrets.",
  ]
    .filter(Boolean)
    .join("\n");
}
