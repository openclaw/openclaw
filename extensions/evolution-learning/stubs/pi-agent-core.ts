/**
 * @mariozechner/pi-agent-core 的最小化 Mock
 */
export type AgentToolResult<T> = {
  content: Array<{ type: "text"; text: string }>;
  details: T;
};
