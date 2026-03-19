/**
 * SMS client that sends messages via the hub's outbound API.
 *
 * The hub owns the Quo (OpenPhone) credentials. Instances call
 * POST {HUB_URL}/api/sms/send with their gateway token, and the
 * hub forwards the message to Quo on their behalf.
 */

function getHubUrl(): string {
  const url = process.env.HUB_URL;
  if (!url) throw new Error("HUB_URL not set — cannot send SMS");
  return url.replace(/\/+$/, "");
}

function getGatewayToken(): string {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) throw new Error("OPENCLAW_GATEWAY_TOKEN not set — cannot authenticate with hub");
  return token;
}

export async function sendSms(content: string): Promise<Record<string, unknown>> {
  const hubUrl = getHubUrl();
  const token = getGatewayToken();
  const url = `${hubUrl}/api/sms/send`;

  console.log(`[sms] POST ${url} (${content.length} chars)`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: content }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[sms] Hub returned ${res.status}: ${body}`);
    throw new Error(`SMS send failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  console.log(`[sms] SMS sent successfully via hub`);
  return data;
}
