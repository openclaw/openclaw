import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const DEFAULT_SLASH_CALLBACK_PATH = "/api/channels/mattermost/command";

export function normalizeCallbackPath(value: unknown): string {
  const path = normalizeOptionalString(value) ?? DEFAULT_SLASH_CALLBACK_PATH;
  return path.startsWith("/") ? path : `/${path}`;
}

/** Registration and the pre-plugin auth artifact must discover the same routes. */
export function collectMattermostCallbackPaths(config: unknown): string[] {
  const base = asOptionalRecord(config);
  const paths = new Set<string>();
  for (const account of [base, ...Object.values(asOptionalRecord(base?.accounts) ?? {})]) {
    const commands = asOptionalRecord(asOptionalRecord(account)?.commands);
    paths.add(normalizeCallbackPath(commands?.callbackPath));
    const callbackUrl = normalizeOptionalString(commands?.callbackUrl);
    if (callbackUrl) {
      const path = URL.parse(callbackUrl)?.pathname;
      if (path) {
        paths.add(path);
      }
    }
  }
  return [...paths];
}

function isWildcardBindHost(rawHost: string): boolean {
  const trimmed = rawHost.trim();
  if (!trimmed) {
    return false;
  }
  const host = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;

  // Wildcard listen hosts are valid bind addresses but are not routable callback
  // destinations. Never expose them in callback URLs derived from gateway.customBindHost.
  return host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0" || host === "::0";
}

export function resolveCallbackHost(rawHost?: string, trim = false): string {
  const host =
    rawHost && !isWildcardBindHost(rawHost) ? (trim ? rawHost.trim() : rawHost) : "localhost";
  return host.includes(":") && !(host.startsWith("[") && host.endsWith("]")) ? `[${host}]` : host;
}
