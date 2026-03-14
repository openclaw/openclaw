export type TwilioSmsProbe = {
  ok: boolean;
  accountSid?: string;
  friendlyName?: string;
  status?: string;
  error?: string;
};

/**
 * Probe a Twilio account by fetching account info from the REST API.
 */
export async function probeTwilioSms(params: {
  accountSid: string | undefined;
  authToken: string | undefined;
  timeoutMs?: number;
}): Promise<TwilioSmsProbe> {
  const { accountSid, authToken } = params;
  if (!accountSid || !authToken) {
    return { ok: false, error: "Missing accountSid or authToken" };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 10_000);

    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return {
        ok: false,
        accountSid,
        error: `HTTP ${response.status}`,
      };
    }

    const data = (await response.json()) as {
      friendly_name?: string;
      status?: string;
    };

    return {
      ok: true,
      accountSid,
      friendlyName: data.friendly_name,
      status: data.status,
    };
  } catch (err) {
    return {
      ok: false,
      accountSid,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
