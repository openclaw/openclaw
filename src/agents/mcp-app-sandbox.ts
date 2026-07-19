import {
  buildSandboxHostContentSecurityPolicy,
  buildSandboxHostPath,
  buildSandboxHostProxyHtml,
  decodeSandboxHostCsp,
  normalizeSandboxHostCsp,
  resolveSandboxHostPort,
  SANDBOX_HOST_PATH,
  type SandboxHostCsp,
} from "./sandbox-host.js";

export type McpAppCsp = SandboxHostCsp;

// Keep the MCP Apps API byte-stable while sharing the underlying host with board widgets.
export const MCP_APP_SANDBOX_PATH = SANDBOX_HOST_PATH;
export const normalizeMcpAppCsp = normalizeSandboxHostCsp;
export const buildMcpAppSandboxPath = buildSandboxHostPath;
export const resolveMcpAppSandboxPort = resolveSandboxHostPort;
export const decodeMcpAppSandboxCsp = decodeSandboxHostCsp;
export const buildMcpAppSandboxProxyHtml = buildSandboxHostProxyHtml;
export const buildMcpAppContentSecurityPolicy = buildSandboxHostContentSecurityPolicy;
