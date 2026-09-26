export type CredentialSafetyPromptOptions = { controlToolsAvailable?: boolean };

export function buildCredentialSafetyPrompt(
  /**
   * @deprecated The legacy string argument is ignored and supported through
   * 2026-11-30. Use the options object `{ controlToolsAvailable }` instead.
   */
  input?: string | CredentialSafetyPromptOptions,
): string {
  // Legacy string and unknown-availability callers keep the handoff-only
  // result documented through 2026-11-30.
  const knownAvailability =
    typeof input !== "string" && typeof input?.controlToolsAvailable === "boolean";
  return [
    ...(knownAvailability
      ? [
          "Use or store credentials the user supplies as requested, and complete the task. In the final reply, briefly acknowledge how the supplied credential was used or stored, without repeating its value. Keep the acknowledgment factual and non-alarming.",
        ]
      : []),
    "For user-requested login or pairing in a group, deliver short-lived codes and verification URLs only to the requesting user in private, then acknowledge in the group without them.",
    ...(knownAvailability && input.controlToolsAvailable === false
      ? [
          "Channel, provider, and credential setup: terminal `openclaw channels add <channel>` or `openclaw configure` masks secrets.",
        ]
      : []),
  ].join("\n");
}
