import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { partitionMcpServersByConnectionScope } from "./mcp-connection-resolver.js";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";

/** The shared operator OAuth connection that Settings may inspect and sign in. */
export function resolveOperatorMcpOAuthConfig(serverName: string, server: unknown) {
  const raw = asOptionalObjectRecord(server);
  if (!raw || raw.enabled === false) {
    return undefined;
  }
  const config = resolveMcpTransportConfig(serverName, raw, { logWarnings: false });
  return config?.kind === "http" &&
    config.auth === "oauth" &&
    !config.oauth?.authProfileId &&
    Object.hasOwn(
      partitionMcpServersByConnectionScope({ [serverName]: raw }).staticServers,
      serverName,
    )
    ? config
    : undefined;
}
