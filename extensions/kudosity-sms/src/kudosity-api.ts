/**
 * Kudosity v2 API client.
 *
 * Thin wrapper around `fetchWithSsrFGuard` from the OpenClaw SDK so every
 * outbound Kudosity request goes through the repo's pinned-DNS / SSRF guard
 * rather than raw `fetch`. The guard enforces `lint:tmp:no-raw-channel-fetch`
 * policy across `extensions/**`.
 *
 * API Reference: https://developers.kudosity.com/reference
 */

import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

const BASE_URL = "https://api.transmitmessage.com";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KudosityConfig {
  apiKey: string; // pragma: allowlist secret
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
 * Make a guarded Kudosity API request and always release the pinned
 * dispatcher when the caller is done reading the body.
 */
async function kudosityRequest<T>(params: {
  url: string;
  apiKey: string;
  init?: Omit<RequestInit, "headers">;
  auditContext: string;
}): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    init: {
      ...params.init,
      headers: buildHeaders(params.apiKey),
    },
    auditContext: params.auditContext,
  });
  try {
    return await handleResponse<T>(response);
  } finally {
    await release();
  }
}

/**
 * Send an SMS message via the Kudosity v2 API.
 *
 * @see https://developers.kudosity.com/reference/post_v2-sms
 */
export async function sendSMS(config: KudosityConfig, params: SendSMSParams): Promise<SMSResponse> {
  return kudosityRequest<SMSResponse>({
    url: `${BASE_URL}/v2/sms`,
    apiKey: config.apiKey,
    init: {
      method: "POST",
      body: JSON.stringify(params),
    },
    auditContext: "kudosity-sms-send",
  });
}

/**
 * Get SMS details by ID.
 *
 * @see https://developers.kudosity.com/reference/get_v2-sms-id
 */
export async function getSMS(config: KudosityConfig, smsId: string): Promise<SMSResponse> {
  return kudosityRequest<SMSResponse>({
    url: `${BASE_URL}/v2/sms/${encodeURIComponent(smsId)}`,
    apiKey: config.apiKey,
    init: { method: "GET" },
    auditContext: "kudosity-sms-get",
  });
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
  return kudosityRequest<WebhookResponse>({
    url: `${BASE_URL}/v2/webhook`,
    apiKey: config.apiKey,
    init: {
      method: "POST",
      body: JSON.stringify(params),
    },
    auditContext: "kudosity-sms-webhook-create",
  });
}

/**
 * Validate the API key by making a lightweight request.
 * Returns true if the API key is valid, false otherwise.
 */
export async function validateApiKey(config: KudosityConfig): Promise<boolean> {
  try {
    const { response, release } = await fetchWithSsrFGuard({
      url: `${BASE_URL}/v2/sms?limit=1`,
      init: {
        method: "GET",
        headers: buildHeaders(config.apiKey),
      },
      auditContext: "kudosity-sms-validate-api-key",
    });
    try {
      return response.ok;
    } finally {
      await release();
    }
  } catch {
    return false;
  }
}
