// Line plugin module implements channel access token behavior.
import type { ResolvedLineAccount } from "./types.js";

export function resolveLineChannelAccessToken(
  explicit: string | undefined,
  params: Pick<ResolvedLineAccount, "accountId" | "channelAccessToken" | "credentialDiagnostics">,
): string {
  if (explicit?.trim()) {
    return explicit.trim();
  }
  if (!params.channelAccessToken) {
    // A named tokenFile that cannot be used resolves to nothing too. Pointing that operator
    // at channelAccessToken sends them to a key that was never the problem, and a symlink
    // reads fine from a shell, so name the file and why it was refused.
    const unusable = params.credentialDiagnostics?.find((entry) =>
      entry.path.endsWith(".tokenFile"),
    );
    throw new Error(
      unusable
        ? `LINE channel access token configured for account "${params.accountId}" is unavailable: ${unusable.path} could not be used (${unusable.reason}). Point it at a readable regular file; symlinks are rejected.`
        : `LINE channel access token missing for account "${params.accountId}" (set channels.line.channelAccessToken or LINE_CHANNEL_ACCESS_TOKEN).`,
    );
  }
  return params.channelAccessToken.trim();
}
