/** This assertion belongs to one run's view, never the cached session MCP runtime. */
export type WebchatMcpRequester = Readonly<{
  sessionId: string;
  /** An admitted native child's connection still belongs to this originating session. */
  connectionSessionKey?: string;
  requesterSenderId: string;
  assertCurrent: () => void;
}>;
