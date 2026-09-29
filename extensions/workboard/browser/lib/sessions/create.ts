import type { SessionsCreateParams, SessionsCreateResult } from "@openclaw/gateway-protocol";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

export async function requestSessionCreate(
  client: Pick<GatewayBrowserClient, "request">,
  params: SessionsCreateParams = {},
): Promise<string> {
  const result = await client.request<SessionsCreateResult>("sessions.create", params);
  const key = normalizeOptionalString(result?.key);
  if (!key) {
    throw new Error("sessions.create returned no key");
  }
  return key;
}
