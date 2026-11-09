import type { FetchLike } from "@modelcontextprotocol/client";
import type { SessionMcpRequesterScope } from "./agent-bundle-mcp-types.js";

type ConnectorSource = {
  sessionKey?: string;
  messageId: string;
  channel?: string;
  accountId?: string;
  senderId?: string | null;
  /** The owner's own scheduled job running in its DM session. */
  scheduled?: true;
  assertCurrent: () => void;
};
export function withConnectorSource<T>(
  getSource: () => ConnectorSource | undefined,
  run: () => Promise<T>,
): Promise<T>;
export function getConnectorSource(): ConnectorSource | undefined;
export function withArthaConnectorContext(
  fetchFn: FetchLike,
  options: {
    auth?: string;
    identity?: string;
    requesterScope?: SessionMcpRequesterScope;
    sessionKey?: string;
  },
): FetchLike;
