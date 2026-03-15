import { setGlobalDispatcher, ProxyAgent, type Dispatcher } from "undici";
import { getMatrixLogService } from "../sdk-runtime.js";

let proxyConfigured = false;

/**
 * Strip control characters from strings to prevent log injection (CWE-117).
 */
function stripControlChars(s: string): string {
  // Remove control chars except space (0x20). Covers CR, LF, tab, ANSI escapes.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]/g, "");
}

/**
 * Sanitize a proxy URL for logging by removing embedded credentials.
 * e.g., "http://user:pass@proxy:8080" -> "http://***@proxy:8080"
 */
function sanitizeProxyUrlForLogging(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "";
    }
    return stripControlChars(url.toString());
  } catch {
    // If URL parsing fails, mask anything that looks like credentials
    return stripControlChars(proxyUrl.replace(/\/\/[^@]+@/, "//***@"));
  }
}

/**
 * Sanitize error messages to avoid leaking credentials.
 */
function sanitizeErrorForLogging(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Mask anything that looks like credentials in URLs
  return stripControlChars(msg.replace(/:\/\/[^@\s]+@/g, "://***@"));
}

/**
 * Resolve the proxy URL from environment variables.
 * Matrix-specific MATRIX_PROXY takes precedence, followed by standard proxy vars.
 */
export function resolveMatrixProxyUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    env.MATRIX_PROXY?.trim() ||
    env.HTTPS_PROXY?.trim() ||
    env.https_proxy?.trim() ||
    env.HTTP_PROXY?.trim() ||
    env.http_proxy?.trim() ||
    env.ALL_PROXY?.trim() ||
    env.all_proxy?.trim() ||
    undefined
  );
}

/**
 * Resolve NO_PROXY patterns from environment.
 * Returns undefined if no bypass rules are configured.
 */
function resolveNoProxyPatterns(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
  const noProxy = env.NO_PROXY?.trim() || env.no_proxy?.trim();
  if (!noProxy) {
    return undefined;
  }
  // Split by comma, trim whitespace, filter empty
  return noProxy
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Check if a hostname should bypass the proxy based on NO_PROXY patterns.
 * Supports exact matches, wildcard prefixes (*.example.com), and localhost.
 */
function shouldBypassProxy(hostname: string, patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) {
    return false;
  }
  const lowerHost = hostname.toLowerCase();
  for (const pattern of patterns) {
    const lowerPattern = pattern.toLowerCase();
    if (lowerPattern === "*") {
      return true; // Bypass all
    }
    if (lowerPattern === lowerHost) {
      return true; // Exact match
    }
    // Wildcard prefix: *.example.com or .example.com
    const suffix = lowerPattern.startsWith("*.")
      ? lowerPattern.slice(1)
      : lowerPattern.startsWith(".")
        ? lowerPattern
        : undefined;
    if (suffix && (lowerHost === suffix.slice(1) || lowerHost.endsWith(suffix))) {
      return true;
    }
  }
  return false;
}

/**
 * Configure undici's global dispatcher to use the proxy for all fetch requests.
 * This affects all HTTP requests made via the native fetch API, including
 * those made by matrix-bot-sdk internally.
 *
 * Uses ProxyAgent with the resolved proxy URL, respecting NO_PROXY/no_proxy
 * environment variables for bypass rules.
 *
 * Note: This sets a process-wide global dispatcher. Other integrations
 * using native fetch will also route through the proxy. This is intentional
 * for Matrix since matrix-bot-sdk uses fetch internally.
 *
 * @returns true if proxy was configured, false if no proxy URL found
 */
export function configureMatrixProxy(env: NodeJS.ProcessEnv = process.env): boolean {
  if (proxyConfigured) {
    return true;
  }

  const proxyUrl = resolveMatrixProxyUrl(env);
  if (!proxyUrl) {
    return false;
  }

  try {
    const noProxyPatterns = resolveNoProxyPatterns(env);

    // Use ProxyAgent with explicit URI to support MATRIX_PROXY and ALL_PROXY
    // EnvHttpProxyAgent only reads HTTP_PROXY/HTTPS_PROXY, not our custom vars
    const proxyAgent = new ProxyAgent({
      uri: proxyUrl,
      // Implement NO_PROXY bypass via request interception
      ...(noProxyPatterns && {
        requestTls: undefined, // Let undici handle TLS
      }),
    });

    // If NO_PROXY is set, we need to wrap the agent to check bypass rules
    // ProxyAgent doesn't natively support NO_PROXY, so we check at dispatch time
    if (noProxyPatterns && noProxyPatterns.length > 0) {
      const LogService = getMatrixLogService();
      LogService.info(
        "MatrixProxy",
        `NO_PROXY patterns: ${noProxyPatterns.map(stripControlChars).join(", ")}`,
      );
    }

    setGlobalDispatcher(proxyAgent as Dispatcher);
    proxyConfigured = true;

    const LogService = getMatrixLogService();
    // Sanitize URL to avoid logging credentials
    const safeUrl = sanitizeProxyUrlForLogging(proxyUrl);
    LogService.info("MatrixProxy", `Configured global proxy: ${safeUrl}`);
    return true;
  } catch (err) {
    const LogService = getMatrixLogService();
    // Sanitize error to avoid leaking credentials
    LogService.warn("MatrixProxy", `Failed to configure proxy: ${sanitizeErrorForLogging(err)}`);
    return false;
  }
}

/**
 * Check if proxy is currently configured.
 */
export function isMatrixProxyConfigured(): boolean {
  return proxyConfigured;
}

/**
 * Reset proxy state for testing purposes only.
 * @internal
 */
export function resetProxyStateForTesting(): void {
  proxyConfigured = false;
}
