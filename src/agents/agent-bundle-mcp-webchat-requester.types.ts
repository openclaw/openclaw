/** This assertion belongs to one run's view, never the cached session MCP runtime. */
export type WebchatMcpRequester = Readonly<{
  sessionId: string;
  sessionKey: string;
  runId: string;
  requesterSenderId: string;
  assertCurrent: () => void;
}>;
