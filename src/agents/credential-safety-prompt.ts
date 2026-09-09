export type CredentialSafetyPromptOptions = { controlToolsAvailable?: boolean };

export function buildCredentialSafetyPrompt(
  /**
   * @deprecated The legacy string argument is ignored and supported through
   * 2026-11-30. Use the options object `{ controlToolsAvailable }` instead.
   */
  input?: string | CredentialSafetyPromptOptions,
): string {
  return [
    "For user-requested login or pairing in a group, deliver short-lived codes and verification URLs only to the requesting user in private, then acknowledge in the group without them.",
    ...(typeof input !== "string" && input?.controlToolsAvailable === false
      ? [
          "Channel, provider, and credential setup: use terminal `openclaw channels add <channel>` or `openclaw configure`; prompts mask secrets. Never collect tokens, API keys, or passwords in chat.",
        ]
      : []),
  ].join("\n");
}
