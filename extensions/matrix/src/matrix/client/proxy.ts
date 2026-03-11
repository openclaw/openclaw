import { setGlobalDispatcher, ProxyAgent, type Dispatcher } from "undici";
import { getMatrixLogService } from "../sdk-runtime.js";

let proxyConfigured = false;

/**
 * Resolve the proxy URL from environment variables.
 * Matrix-specific MATRIX_PROXY takes precedence, followed by standard proxy vars.
 */
export function resolveMatrixProxyUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    env.MATRIX_PROXY?.trim() ||
    env.HTTPS_PROXY?.trim() ||
    env.HTTP_PROXY?.trim() ||
    env.ALL_PROXY?.trim() ||
    undefined
  );
}

/**
 * Configure undici's global dispatcher to use the proxy for all fetch requests.
 * This affects all HTTP requests made via the native fetch API, including
 * those made by matrix-bot-sdk internally.
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
    const proxyAgent = new ProxyAgent(proxyUrl);
    setGlobalDispatcher(proxyAgent as Dispatcher);
    proxyConfigured = true;

    const LogService = getMatrixLogService();
    LogService.info("MatrixProxy", `Configured global proxy: ${proxyUrl}`);
    return true;
  } catch (err) {
    const LogService = getMatrixLogService();
    LogService.warn("MatrixProxy", `Failed to configure proxy: ${err}`);
    return false;
  }
}

/**
 * Check if proxy is currently configured.
 */
export function isMatrixProxyConfigured(): boolean {
  return proxyConfigured;
}
