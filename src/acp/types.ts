import type { McpServer, SessionId } from "@agentclientprotocol/sdk";
import { VERSION } from "../version.js";

export type AcpSession = {
  sessionId: SessionId;
  sessionKey: string;
  cwd: string;
  createdAt: number;
  mcpServers: McpServer[];
  abortController: AbortController | null;
  activeRunId: string | null;
};

export type AcpServerOptions = {
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  defaultSessionKey?: string;
  defaultSessionLabel?: string;
  requireExistingSession?: boolean;
  resetSession?: boolean;
  prefixCwd?: boolean;
  verbose?: boolean;
};

export const ACP_AGENT_INFO = {
  name: "openclaw-acp",
  title: "OpenClaw ACP Gateway",
  version: VERSION,
};
