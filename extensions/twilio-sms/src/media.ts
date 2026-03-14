/**
 * Download MMS media from Twilio.
 *
 * Twilio media URLs require HTTP Basic auth with the account credentials.
 * URLs look like:
 *   https://api.twilio.com/2010-04-01/Accounts/{Sid}/Messages/{MsgSid}/Media/{MediaSid}
 */
export async function downloadTwilioMedia(params: {
  mediaUrl: string;
  accountSid: string;
  authToken: string;
  contentType: string;
}): Promise<{ buffer: Buffer; contentType: string }> {
  const response = await fetch(params.mediaUrl, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${params.accountSid}:${params.authToken}`).toString("base64")}`,
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Failed to download Twilio media (${response.status}): ${params.mediaUrl}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") || params.contentType;
  return { buffer, contentType };
}
