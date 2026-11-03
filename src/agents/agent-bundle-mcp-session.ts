import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { bindMcpClientElicitation } from "./mcp-client-elicitation.js";
import { disposeMcpClient } from "./mcp-client-lifecycle.js";
import type { McpToolCatalogMetadata } from "./mcp-tool-metadata.js";

export type BundleMcpSession = {
  serverName: string;
  client: Client;
  transport: Transport;
  transportType: "stdio" | "sse" | "streamable-http";
  requestTimeoutMs: number;
  connected: boolean;
  disconnectReason?: string;
  retiring: boolean;
  connectPromise?: Promise<void>;
  disposePromise?: Promise<void>;
  detachStderr?: () => void;
  toolMetadata?: McpToolCatalogMetadata;
  withElicitation?: ReturnType<typeof bindMcpClientElicitation>;
};

const BUNDLE_MCP_DISPOSE_TIMEOUT_MS = 5_000;
const BUNDLE_MCP_TEST_STATE_KEY = Symbol.for("openclaw.bundleMcpTestState");
type BundleMcpTestState = { disposeTimeoutMs?: number };

function getBundleMcpTestState(): BundleMcpTestState {
  return resolveGlobalSingleton(BUNDLE_MCP_TEST_STATE_KEY, () => ({}));
}

export function setBundleMcpDisposeTimeoutMsForTest(timeoutMs?: number): void {
  // Non-isolated test workers can reload this module while a facade still
  // references an older copy. Share the override across those copies.
  getBundleMcpTestState().disposeTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? Math.floor(timeoutMs)
      : undefined;
}

export function disposeBundleMcpSession(
  session: BundleMcpSession,
): Promise<"closed" | "uncertain"> {
  return disposeMcpClient(
    session,
    getBundleMcpTestState().disposeTimeoutMs ?? BUNDLE_MCP_DISPOSE_TIMEOUT_MS,
  );
}
