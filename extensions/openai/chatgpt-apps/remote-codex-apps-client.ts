import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  type CallToolResult,
  type CallToolRequest,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

const REMOTE_CLIENT_INFO = {
  name: "openclaw-chatgpt-apps-bridge",
  version: "0.1.0",
} as const;

export type RemoteCodexAppsAuth = {
  accessToken: string;
  accountId: string;
};

export type RemoteCodexAppsClient = {
  listTools(params?: { cursor?: string }): Promise<{
    tools: Tool[];
    nextCursor?: string;
  }>;
  listAllTools(): Promise<Tool[]>;
  callTool(params: Pick<CallToolRequest["params"], "name" | "arguments">): Promise<CallToolResult>;
  close(): Promise<void>;
};

export type RemoteCodexAppsClientFactory = (params: {
  chatgptBaseUrl: string;
  auth: RemoteCodexAppsAuth;
  fetch?: typeof fetch;
}) => Promise<RemoteCodexAppsClient>;

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function appendPath(basePath: string, suffix: string): string {
  const trimmedBase = trimTrailingSlashes(basePath);
  const trimmedSuffix = suffix.replace(/^\/+/, "");
  if (!trimmedBase) {
    return `/${trimmedSuffix}`;
  }
  return `${trimmedBase}/${trimmedSuffix}`;
}

export function deriveChatgptAppsMcpUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.search = "";
  url.hash = "";

  const hostname = url.hostname.toLowerCase();
  const pathname = trimTrailingSlashes(url.pathname);

  if (
    (hostname === "chatgpt.com" || hostname === "chat.openai.com") &&
    (pathname === "" || pathname === "/backend-api")
  ) {
    url.pathname = "/backend-api/wham/apps";
    return url.toString();
  }

  if (pathname.includes("/api/codex")) {
    url.pathname = appendPath(pathname, "apps");
    return url.toString();
  }

  url.pathname = appendPath(pathname, "api/codex/apps");
  return url.toString();
}

export const createRemoteCodexAppsClient: RemoteCodexAppsClientFactory = async (params) => {
  const transport = new StreamableHTTPClientTransport(
    new URL(deriveChatgptAppsMcpUrl(params.chatgptBaseUrl)),
    {
      fetch: params.fetch,
      requestInit: {
        headers: {
          Authorization: `Bearer ${params.auth.accessToken}`,
          "ChatGPT-Account-ID": params.auth.accountId,
        },
      },
    },
  );
  const client = new Client(REMOTE_CLIENT_INFO);
  await client.connect(transport);

  return {
    listTools: async (listParams = {}) => {
      const result = await client.listTools(
        listParams.cursor ? { cursor: listParams.cursor } : undefined,
      );
      return {
        tools: result.tools,
        nextCursor: result.nextCursor,
      };
    },
    listAllTools: async () => {
      const tools: Tool[] = [];
      let cursor: string | undefined;

      do {
        const result = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...result.tools);
        cursor = result.nextCursor;
      } while (cursor);

      return tools;
    },
    callTool: async (callParams) =>
      (await client.callTool(
        {
          name: callParams.name,
          arguments: callParams.arguments,
        },
        CallToolResultSchema,
      )) as CallToolResult,
    close: async () => {
      await client.close();
    },
  };
};
