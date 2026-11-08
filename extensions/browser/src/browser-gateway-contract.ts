/**
 * Node-hosted browser control uses these values on both sides of the gateway
 * contract, so keep them as literal exports instead of duplicated strings.
 */
export const BROWSER_REQUEST_GATEWAY_METHOD = "browser.request" as const;
export const SESSION_BROWSER_REQUEST_GATEWAY_METHOD = "browser.dashboard.request" as const;
export const BROWSER_REQUEST_GATEWAY_SCOPE = "operator.admin" as const;
export const BROWSER_REQUEST_GATEWAY_SCOPES = [BROWSER_REQUEST_GATEWAY_SCOPE] as const;
