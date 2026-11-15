import type { CodexCursorPage, JsonObject, JsonValue } from "./protocol-json.js";

export type CodexMcpServerStatus = {
  name: string;
  pluginId?: string | null;
  /** Present only after the configured server completed MCP initialization. */
  serverInfo?: {
    name: string;
    title?: string | null;
    version: string;
    description?: string | null;
    icons?: JsonValue[] | null;
    websiteUrl?: string | null;
  } | null;
  /** Advertised by the initialized thread-owned connection. */
  serverCapabilities?: JsonValue | null;
  tools: JsonObject;
  resources?: JsonValue[];
  resourceTemplates?: JsonValue[];
  authStatus?: "unsupported" | "notLoggedIn" | "bearerToken" | "oAuth";
};

export type CodexListMcpServerStatusResponse = CodexCursorPage<CodexMcpServerStatus>;

export type ResourceReadParams = {
  threadId?: string | null;
  originCallId?: string | null;
  server: string;
  uri: string;
  connectorId?: string | null;
};

export type ToolCallParams = {
  threadId: string;
  server: string;
  tool: string;
  arguments?: JsonValue;
  _meta?: JsonValue;
};

type CodexMcpResourceContent =
  | { uri: string; mimeType?: string; text: string; _meta?: unknown }
  | { uri: string; mimeType?: string; blob: string; _meta?: unknown };

export type ResourceReadResult = {
  contents: CodexMcpResourceContent[];
  originCallId?: string | null;
};

export type ToolCallResult = {
  content: JsonValue[];
  structuredContent?: JsonValue;
  isError?: boolean;
  _meta?: JsonValue;
};
