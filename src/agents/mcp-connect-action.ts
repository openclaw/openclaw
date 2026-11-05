import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";

export type McpConnectAction = {
  serverName: string;
  authorizationUrl: string;
};

export function readMcpConnectAction(result: unknown): McpConnectAction | undefined {
  const connect = asRecord(asRecord(asRecord(result)?.details)?.mcpConnect);
  const serverName = typeof connect?.serverName === "string" ? connect.serverName.trim() : "";
  const authorizationUrl =
    typeof connect?.authorizationUrl === "string" ? connect.authorizationUrl.trim() : "";
  const parsed = URL.parse(authorizationUrl);
  if (!serverName || (parsed?.protocol !== "http:" && parsed?.protocol !== "https:")) {
    return undefined;
  }
  return { serverName, authorizationUrl };
}
