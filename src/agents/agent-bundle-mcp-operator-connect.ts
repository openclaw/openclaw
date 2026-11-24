/** Owner sign-in surface for shared OAuth MCP servers that are not yet authorized. */
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionToolOverrides } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { McpToolCatalog } from "./agent-bundle-mcp-catalog.types.js";
import {
  buildRequesterConnectCatalog,
  formatOperatorMcpOAuthLinkResult,
  listOAuthServers,
  mergeMcpConnectCatalog,
} from "./agent-bundle-mcp-requester-connect.js";
import { loadSessionMcpConfig } from "./agent-bundle-mcp-runtime-config.js";
import type { RequesterMcpConnect, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { setMcpCodeModeGuestResultFromAgentResult } from "./mcp-content.js";
import { operatorMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { completeOperatorMcpOAuthLink, startOperatorMcpOAuthLink } from "./mcp-oauth-link.js";
import { readMcpOAuthCredentialsStatuses } from "./mcp-oauth.js";

export type OperatorMcpConnectContext = {
  cfg: OpenClawConfig;
  metadata?: PluginMetadataSnapshot;
  senderIsOwner?: boolean;
  chatType?: string;
  isTurnTainted?: () => boolean;
  toolOverrides?: Pick<SessionToolOverrides, "mcpServers" | "mcpToolsDeny">;
  toolDenylist?: string[];
};

/** Shared sign-in is turn-bound; never store its authority on the session runtime. */
async function createOperatorMcpConnect(
  runtime: SessionMcpRuntime,
  context: OperatorMcpConnectContext | undefined,
): Promise<RequesterMcpConnect | undefined> {
  if (
    !context ||
    context.senderIsOwner !== true ||
    context.chatType !== "direct" ||
    context.isTurnTainted?.() !== false
  ) {
    return undefined;
  }
  const { loaded, fingerprint, safeServerNamesByServer } = loadSessionMcpConfig({
    ...context,
    workspaceDir: runtime.workspaceDir,
    manifestRegistry:
      context.metadata?.pluginIds === undefined ? context.metadata?.manifestRegistry : undefined,
    logDiagnostics: false,
  });
  const configured = listOAuthServers(Object.keys(loaded.mcpServers), loaded.mcpServers, "shared");
  if (configured.length === 0) {
    return undefined;
  }
  const statuses = await readMcpOAuthCredentialsStatuses(
    configured.map(({ serverName, resolved }) =>
      operatorMcpOAuthIdentity(serverName, resolved.url, context.cfg),
    ),
  );
  const authorizedServerNames = configured
    .filter(
      (_, index) =>
        expectDefined(statuses[index], "shared MCP OAuth status").state === "authorized",
    )
    .map(({ serverName }) => serverName);
  const authorized = new Set(authorizedServerNames);
  const missing = new Set(
    configured
      .filter(({ serverName }) => !authorized.has(serverName))
      .map(({ serverName }) => serverName),
  );
  if (missing.size === 0) {
    return undefined;
  }
  return {
    catalog: buildRequesterConnectCatalog(missing, safeServerNamesByServer, "operator"),
    authorizedServerNames,
    configFingerprint: JSON.stringify({ config: fingerprint, authorizedServerNames }),
    createExecute: (serverName) =>
      missing.has(serverName)
        ? async (_toolCallId, input, signal) => {
            signal?.throwIfAborted();
            if (context.isTurnTainted?.() !== false) {
              throw new Error(
                "Shared MCP sign-in requires an untainted owner turn in a direct chat.",
              );
            }
            const callbackUrl = isRecord(input) ? input.callbackUrl : undefined;
            if (callbackUrl !== undefined) {
              if (typeof callbackUrl !== "string") {
                throw new Error("callbackUrl is required");
              }
              const status = await completeOperatorMcpOAuthLink({
                cfg: context.cfg,
                metadata: context.metadata,
                serverName,
                callbackUrl,
              });
              if (status === "expired") {
                return {
                  content: [
                    {
                      type: "text",
                      text: `MCP sign-in for "${serverName}" expired. Call this tool without callbackUrl to start a new sign-in.`,
                    },
                  ],
                  details: { status: "error", mcpServer: serverName },
                };
              }
              return formatOperatorMcpOAuthLinkResult({ status, serverName });
            }
            return formatOperatorMcpOAuthLinkResult(
              await startOperatorMcpOAuthLink({
                cfg: context.cfg,
                metadata: context.metadata,
                serverName,
              }),
            );
          }
        : undefined,
  };
}

/**
 * Connect bootstraps for servers absent from the live catalog: the turn's owner sign-in
 * first, then the session's requester sign-in.
 */
export async function resolveMcpConnectSurface(
  runtime: SessionMcpRuntime,
  catalog: McpToolCatalog,
  context: OperatorMcpConnectContext | undefined,
) {
  const operator = await createOperatorMcpConnect(runtime, context);
  return {
    catalog: mergeMcpConnectCatalog(
      mergeMcpConnectCatalog(catalog, runtime.requesterConnect),
      operator,
    ),
    createExecute: (serverName: string) => {
      const connect =
        operator?.createExecute(serverName) ?? runtime.requesterConnect?.createExecute(serverName);
      return connect
        ? async (toolCallId: string, input: unknown, signal?: AbortSignal) => {
            signal?.throwIfAborted();
            return setMcpCodeModeGuestResultFromAgentResult(
              await connect(toolCallId, input, signal),
            );
          }
        : undefined;
    },
  };
}
