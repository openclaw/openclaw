import { twilioApiRequest } from "openclaw/plugin-sdk/twilio-shared";

export type SendTwilioSmsParams = {
  to: string;
  body: string;
  accountSid: string;
  authToken: string;
  from: string;
  /** Optional media URLs for outbound MMS. */
  mediaUrl?: string[];
};

export type SendTwilioSmsResult = {
  ok: true;
  sid: string;
  status: string;
};

/**
 * Send an SMS (or MMS) via the Twilio REST API.
 */
export async function sendTwilioSms(params: SendTwilioSmsParams): Promise<SendTwilioSmsResult> {
  const body: Record<string, string | string[]> = {
    To: params.to,
    From: params.from,
    Body: params.body,
  };
  if (params.mediaUrl && params.mediaUrl.length > 0) {
    body.MediaUrl = params.mediaUrl;
  }

  const result = await twilioApiRequest<{ sid: string; status: string }>({
    accountSid: params.accountSid,
    authToken: params.authToken,
    endpoint: `/2010-04-01/Accounts/${params.accountSid}/Messages.json`,
    body,
  });

  return { ok: true, sid: result.sid, status: result.status };
}
