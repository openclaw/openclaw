/**
 * Decode the bot user ID from a Pumble JWT bot token.
 *
 * Pumble bot tokens are JWTs carrying `workspaceUser` (or `sub`) claims
 * that identify the bot in the workspace.
 */
export function resolveBotUserIdFromJwt(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as {
      workspaceUser?: string;
      sub?: string;
    };
    return payload.workspaceUser?.trim() || payload.sub?.trim() || undefined;
  } catch {
    return undefined;
  }
}
