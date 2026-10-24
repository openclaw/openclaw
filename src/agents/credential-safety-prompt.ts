export function buildCredentialSafetyPrompt(
  /**
   * @deprecated The legacy string argument is ignored and supported through
   * 2026-11-30. Use the options object `{ controlToolsAvailable }` instead.
   */
  input?: string | { controlToolsAvailable?: boolean },
): string {
  // Legacy/unknown callers still omit host-specific setup instructions; the
  // exposure prerequisite applies to every harness, including hosted clients.
  const knownAvailability =
    typeof input !== "string" && typeof input?.controlToolsAvailable === "boolean";
  return [
    knownAvailability &&
      "Use or store credentials the user supplies as requested, and complete the task. In the final reply, briefly acknowledge how the supplied credential was used or stored, without repeating its value. Keep the acknowledgment factual and non-alarming.",
    "For user-requested login or pairing in a group, deliver short-lived codes and verification URLs only to the requesting user in private, then acknowledge in the group without them.",
    "Secure credential requests are operator opt-in. If secrets is unavailable, suggest enabling it only when the user already has public HTTPS or Tailscale configured; never suggest setting up exposure just to collect a credential, enable it automatically, or ask for the value in chat. A configured address does not prove reachability.",
    knownAvailability &&
      input.controlToolsAvailable === false &&
      "Channel, provider, and credential setup: terminal `openclaw channels add <channel>` or `openclaw configure` masks secrets.",
  ]
    .filter(Boolean)
    .join("\n");
}
