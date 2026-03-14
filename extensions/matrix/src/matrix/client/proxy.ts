import { setGlobalDispatcher, ProxyAgent, EnvHttpProxyAgent, type Dispatcher } from "undici";
import { getMatrixLogService } from "../sdk-runtime.js";

let proxyConfigured = false;

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
    return url.toString();
  } catch {
    // If URL parsing fails, mask anything that looks like credentials
    return proxyUrl.replace(/\/\/[^@]+@/, "//***@");
  }
}

/**
 * Sanitize error messages to avoid leaking credentials.
 */
function sanitizeErrorForLogging(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Mask anything that looks like credentials in URLs
  return msg.replace(/:\/\/[^@\s]+@/g, "://***@");
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
 * Configure undici's global dispatcher to use the proxy for all fetch requests.
 * This affects all HTTP requests made via the native fetch API, including
 * those made by matrix-bot-sdk internally.
 *
 * Uses EnvHttpProxyAgent which automatically respects NO_PROXY/no_proxy
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
    // Use EnvHttpProxyAgent which respects NO_PROXY/no_proxy bypass rules
    const proxyAgent = new EnvHttpProxyAgent();
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
