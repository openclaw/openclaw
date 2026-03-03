/**
 * Kudosity v2 API client.
 *
 * Thin wrapper around fetch for the Kudosity REST API.
 * No external dependencies — uses the native Node.js fetch API.
 *
 * API Reference: https://developers.kudosity.com/reference
 */

const BASE_URL = "https://api.transmitmessage.com";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KudosityConfig {
  apiKey: string;
  sender: string;
}

export interface SendSMSParams {
  message: string;
  sender: string;
  recipient: string;
  message_ref?: string;
  track_links?: boolean;
}

export interface SMSResponse {
  id: string;
  recipient: string;
  recipient_country: string;
  sender: string;
  sender_country: string;
  message_ref: string;
  message: string;
  status: string;
  sms_count: string;
  is_gsm: boolean;
  routed_via: string;
  track_links: boolean;
  direction: string;
  created_at: string;
  updated_at: string;
}

export interface WebhookCreateParams {
  url: string;
  event_type: string;
}

export interface WebhookResponse {
  id: string;
  url: string;
  event_type: string;
  created_at: string;
  updated_at: string;
}

export interface InboundSMSEvent {
  id: string;
  sender: string;
  recipient: string;
  message: string;
  message_ref?: string;
  created_at: string;
}

export interface KudosityApiError {
  error: string;
  message: string;
  status_code: number;
}

// ─── API Client ──────────────────────────────────────────────────────────────

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.text();
    let errorMessage: string;
    try {
      const parsed = JSON.parse(errorBody) as KudosityApiError;
      errorMessage = parsed.message || parsed.error || errorBody;
    } catch {
      errorMessage = errorBody;
    }
    throw new Error(`Kudosity API error (${response.status}): ${errorMessage}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Send an SMS message via the Kudosity v2 API.
 *
 * @see https://developers.kudosity.com/reference/post_v2-sms
 */
export async function sendSMS(config: KudosityConfig, params: SendSMSParams): Promise<SMSResponse> {
  const response = await fetch(`${BASE_URL}/v2/sms`, {
    method: "POST",
    headers: buildHeaders(config.apiKey),
    body: JSON.stringify(params),
  });
  return handleResponse<SMSResponse>(response);
}

/**
 * Get SMS details by ID.
 *
 * @see https://developers.kudosity.com/reference/get_v2-sms-id
 */
export async function getSMS(config: KudosityConfig, smsId: string): Promise<SMSResponse> {
  const response = await fetch(`${BASE_URL}/v2/sms/${encodeURIComponent(smsId)}`, {
    method: "GET",
    headers: buildHeaders(config.apiKey),
  });
  return handleResponse<SMSResponse>(response);
}

/**
 * Create a webhook subscription.
 *
 * @see https://developers.kudosity.com/reference/post_v2-webhook
 */
export async function createWebhook(
  config: KudosityConfig,
  params: WebhookCreateParams,
): Promise<WebhookResponse> {
  const response = await fetch(`${BASE_URL}/v2/webhook`, {
    method: "POST",
    headers: buildHeaders(config.apiKey),
    body: JSON.stringify(params),
  });
  return handleResponse<WebhookResponse>(response);
}

/**
 * Validate the API key by making a lightweight request.
 * Returns true if the API key is valid, false otherwise.
 */
export async function validateApiKey(config: KudosityConfig): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/v2/sms?limit=1`, {
      method: "GET",
      headers: buildHeaders(config.apiKey),
    });
    return response.ok;
  } catch {
    return false;
  }
}
