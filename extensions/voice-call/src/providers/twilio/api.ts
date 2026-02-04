export async function twilioApiRequest<T = unknown>(params: {
  baseUrl: string;
  accountSid: string;
  authToken: string;
  endpoint: string;
  body?: URLSearchParams | Record<string, string | string[]>;
  allowNotFound?: boolean;
  method?: "GET" | "POST";
}): Promise<T> {
  const method = params.method ?? "POST";

  const bodyParams =
    params.body instanceof URLSearchParams
      ? params.body
      : Object.entries(params.body ?? {}).reduce<URLSearchParams>((acc, [key, value]) => {
          if (Array.isArray(value)) {
            for (const entry of value) {
              acc.append(key, entry);
            }
          } else if (typeof value === "string") {
            acc.append(key, value);
          }
          return acc;
        }, new URLSearchParams());

  const url =
    method === "GET" && bodyParams.toString()
      ? `${params.baseUrl}${params.endpoint}?${bodyParams.toString()}`
      : `${params.baseUrl}${params.endpoint}`;

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${params.accountSid}:${params.authToken}`).toString("base64")}`,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    ...(method === "POST" ? { body: bodyParams } : {}),
  });

  if (!response.ok) {
    if (params.allowNotFound && response.status === 404) {
      return undefined as T;
    }
    const errorText = await response.text();
    throw new Error(`Twilio API error: ${response.status} ${errorText}`);
  }

  const text = await response.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}
