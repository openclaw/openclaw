import type { EmailOutboundPayload } from "./types.js";

export async function sendEmailOutbound(params: {
  account: { outboundUrl: string; outboundToken: string };
  payload: EmailOutboundPayload;
}): Promise<{ messageId?: string }> {
  const { account, payload } = params;

  if (!account.outboundUrl || !account.outboundToken) {
    throw new Error("Email outbound not configured: missing outboundUrl or outboundToken");
  }

  const response = await fetch(account.outboundUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${account.outboundToken}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown");
    throw new Error(`Email outbound failed (${response.status}): ${errorText}`);
  }

  const payloadJson = (await response.json().catch(() => ({}))) as {
    messageId?: string;
    id?: string;
  };

  return {
    messageId: payloadJson.messageId ?? payloadJson.id,
  };
}
