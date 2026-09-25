export type AgentRunTerminalReplySnapshot =
  | { disposition: "visible"; text: string; modelRouteChange?: string }
  | { disposition: "silent" }
  | { disposition: "empty"; code?: "message-tool-not-called" };
