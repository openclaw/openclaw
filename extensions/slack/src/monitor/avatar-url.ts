import { matchesHostnameAllowlist } from "openclaw/plugin-sdk/security-runtime";

function parseHttpsUrl(value: string): URL | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the URL the avatar download may fetch under the avatar allowlist.
 *
 * Slack serves a user's default avatar through Gravatar and names the
 * Slack-hosted image as the `d=` fallback, which Gravatar redirects to. The
 * Gravatar host stays outside the allowlist, so the download goes straight to
 * the fallback when that fallback is itself on an allowlisted host. Any other
 * host outside the allowlist yields undefined so the caller never issues a
 * request the policy would reject.
 */
export function resolveSlackAvatarDownloadUrl(
  imageUrl: string,
  hostnameAllowlist: string[],
): string | undefined {
  const parsed = parseHttpsUrl(imageUrl);
  if (!parsed) {
    return undefined;
  }
  if (matchesHostnameAllowlist(parsed.hostname, hostnameAllowlist)) {
    return imageUrl;
  }
  const fallback = parsed.searchParams.get("d");
  if (!fallback) {
    return undefined;
  }
  const fallbackUrl = parseHttpsUrl(fallback);
  if (!fallbackUrl || !matchesHostnameAllowlist(fallbackUrl.hostname, hostnameAllowlist)) {
    return undefined;
  }
  return fallbackUrl.toString();
}
