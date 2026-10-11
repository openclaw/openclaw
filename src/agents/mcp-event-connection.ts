import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleMcpServerConfig } from "../plugins/bundle-mcp.types.js";
import type { SessionMcpRequesterScope } from "./agent-bundle-mcp-types.js";
import { resolveMcpAuthProfileId } from "./mcp-auth-profile.js";
import { McpConnectionAuthorityError } from "./mcp-connection-authority-error.js";
import type { McpConnectionAuthority } from "./mcp-connection-authority.types.js";
import {
  applyMcpConnectionOverride,
  resolveRequesterScopedMcpConnections,
} from "./mcp-connection-resolver.js";
import { operatorMcpOAuthIdentity, requesterMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";

/** Native-selected credential route. Kept privately for exact, bounded unsubscribe cleanup. */
export type McpEventConnectionSelector = {
  serverName: string;
  server: BundleMcpServerConfig;
  cfg: OpenClawConfig;
  agentDir: string;
  requesterScope?: SessionMcpRequesterScope;
  requesterResolver: boolean;
};

/** Adapter only: credential state, refresh, and revocation remain with their existing owners. */
export async function prepareMcpEventCredentialConnection(
  selector: McpEventConnectionSelector,
  assertCallerCurrent: () => void,
) {
  let authority: McpConnectionAuthority | undefined;
  let disposed = false;
  let kind: "configured" | "resolver" | "oauth" | "auth-profile" = "configured";
  const assertActive = () => {
    if (disposed) {
      throw new McpConnectionAuthorityError("retired");
    }
    assertCallerCurrent();
  };
  const assertCurrent = () => {
    assertActive();
    authority?.assertCurrent();
  };
  const release = () => {
    if (!disposed) {
      disposed = true;
      authority?.dispose();
    }
  };
  try {
    assertActive();
    let server = selector.server;
    if (selector.requesterResolver) {
      if (!selector.requesterScope) {
        throw new McpConnectionAuthorityError("retired");
      }
      const resolved = (
        await resolveRequesterScopedMcpConnections({
          serverNames: [selector.serverName],
          ...selector.requesterScope,
          retainAuthority: true,
        })
      ).get(selector.serverName);
      // Take cleanup ownership before checking a caller that may have retired during resolution.
      authority = resolved?.authority;
      assertCurrent();
      if (!resolved || !authority) {
        throw new McpConnectionAuthorityError("unavailable");
      }
      kind = "resolver";
      server = applyMcpConnectionOverride(server, resolved);
    }
    const transport = resolveMcpTransportConfig(selector.serverName, server, {
      logWarnings: false,
    });
    if (transport?.kind !== "http" || transport.transportType !== "streamable-http") {
      throw new Error("MCP Events requires a configured Streamable HTTP server");
    }
    if (!authority) {
      const profileId = resolveMcpAuthProfileId(server);
      if (profileId) {
        const { captureMcpAuthProfileAuthorization } =
          await import("./mcp-auth-profile-authorization.js");
        assertActive();
        authority = await captureMcpAuthProfileAuthorization({
          profileId,
          cfg: selector.cfg,
          agentDir: selector.agentDir,
          assertCurrent: assertCallerCurrent,
        });
        kind = "auth-profile";
      } else if (transport.auth === "oauth") {
        const { captureMcpOAuthAuthorization } = await import("./mcp-oauth-authorization.js");
        assertActive();
        if (transport.oauth?.identity === "per-requester" && !selector.requesterScope) {
          throw new McpConnectionAuthorityError("retired");
        }
        const identity =
          transport.oauth?.identity === "per-requester" && selector.requesterScope
            ? requesterMcpOAuthIdentity(selector.serverName, transport.url, selector.requesterScope)
            : operatorMcpOAuthIdentity(selector.serverName, transport.url);
        authority = await captureMcpOAuthAuthorization({
          identity,
          assertCurrent: assertCallerCurrent,
        });
        kind = "oauth";
      }
    }
    assertCurrent();
    return {
      endpoint: new URL(transport.url).href,
      server,
      cfg: selector.cfg,
      agentDir: selector.agentDir,
      requesterScope: selector.requesterScope,
      selector,
      authorizationIdentity: JSON.stringify([kind, authority?.authorizationId ?? "configured"]),
      assertCurrent,
      release,
      revalidate: async () => {
        assertActive();
        await authority?.revalidate();
        assertCurrent();
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
