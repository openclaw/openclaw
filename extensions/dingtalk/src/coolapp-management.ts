/**
 * DingTalk CoolApp Management API
 *
 * Provides CoolApp TopBox (pinned card) management capabilities:
 * - createTopBox: Create and open interactive card TopBox
 * - closeTopBox: Close interactive card TopBox
 *
 * API Docs:
 * - TopBox overview: https://open.dingtalk.com/document/orgapp/create-and-open-card-top
 * - Close TopBox: https://open.dingtalk.com/document/orgapp/close-card-top
 */

import { getAccessToken } from "./client.js";
import { dingtalkLogger } from "./logger.js";
import type { DingtalkConfig, CreateTopBoxParams, CloseTopBoxParams } from "./types.js";

/** DingTalk API base URL */
const DINGTALK_API_BASE = "https://api.dingtalk.com";

/** HTTP request timeout (milliseconds) */
const REQUEST_TIMEOUT = 30_000;

/**
 * DingTalk API error response structure
 */
interface DingtalkApiErrorResponse {
  code?: string;
  message?: string;
  requestid?: string;
}

/**
 * Generic wrapper for sending DingTalk API requests
 */
async function coolAppApiRequest<ResponseType>(
  method: "POST" | "DELETE",
  path: string,
  accessToken: string,
  options?: {
    body?: Record<string, unknown>;
    operationLabel?: string;
  },
): Promise<ResponseType> {
  const operationLabel = options?.operationLabel ?? `${method} ${path}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const url = `${DINGTALK_API_BASE}${path}`;

    const fetchOptions: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": accessToken,
      },
      signal: controller.signal,
    };

    if (options?.body) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(url, fetchOptions);

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `DingTalk ${operationLabel} failed: HTTP ${response.status}`;

      try {
        const errorData = JSON.parse(errorText) as DingtalkApiErrorResponse;
        if (errorData.message) {
          errorMessage = `DingTalk ${operationLabel} failed: ${errorData.message} (code: ${errorData.code ?? "unknown"}, requestId: ${errorData.requestid ?? "unknown"})`;
        }
      } catch {
        errorMessage = `${errorMessage} - ${errorText}`;
      }

      throw new Error(errorMessage);
    }

    const responseText = await response.text();
    if (!responseText) {
      return {} as ResponseType;
    }

    return JSON.parse(responseText) as ResponseType;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`DingTalk ${operationLabel} timed out after ${REQUEST_TIMEOUT}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Validate credentials and get Access Token
 */
async function resolveAccessToken(cfg: DingtalkConfig): Promise<string> {
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new Error("DingTalk credentials not configured (clientId, clientSecret required)");
  }
  return getAccessToken(cfg.clientId, cfg.clientSecret);
}

// ============================================================================
// TopBox (Pinned Card) API
// ============================================================================

/**
 * Create and open interactive card TopBox
 *
 * Pin an interactive card at the top of a group chat to display key information or provide quick access.
 *
 * @param cfg DingTalk config
 * @param params Create TopBox card parameters
 * @returns API response
 *
 * @example
 * ```ts
 * await createTopBox(cfg, {
 *   cardTemplateId: "e7c769f0-xxxx-xxxx-xxxx-9f96d7f4a453",
 *   outTrackId: "topbox_001",
 *   coolAppCode: "COOLAPP-1-xxxx",
 *   openConversationId: "cidxxxxx==",
 *   cardData: { cardParamMap: { text: "Project Progress: 80%" } },
 * });
 * ```
 */
export async function createTopBox(
  cfg: DingtalkConfig,
  params: CreateTopBoxParams,
): Promise<Record<string, unknown>> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(
    `Creating TopBox in conversation ${params.openConversationId}, template: ${params.cardTemplateId}`,
  );

  const body: Record<string, unknown> = {
    cardTemplateId: params.cardTemplateId,
    outTrackId: params.outTrackId,
    coolAppCode: params.coolAppCode,
    openConversationId: params.openConversationId,
    conversationType: params.conversationType ?? 1,
  };

  if (params.cardData) body.cardData = params.cardData;
  if (params.unionIdPrivateDataMap) body.unionIdPrivateDataMap = params.unionIdPrivateDataMap;
  if (params.userIdPrivateDataMap) body.userIdPrivateDataMap = params.userIdPrivateDataMap;
  if (params.cardSettings) body.cardSettings = params.cardSettings;
  if (params.callbackRouteKey) body.callbackRouteKey = params.callbackRouteKey;
  if (params.platforms) body.platforms = params.platforms;

  const result = await coolAppApiRequest<Record<string, unknown>>(
    "POST",
    "/v2.0/im/topBoxes",
    accessToken,
    { body, operationLabel: "create TopBox" },
  );

  dingtalkLogger.info(
    `TopBox created in conversation ${params.openConversationId}, trackId: ${params.outTrackId}`,
  );

  return result;
}

/**
 * Close interactive card TopBox
 *
 * Remove the pinned interactive card from the top of a group chat.
 *
 * @param cfg DingTalk config
 * @param params Close TopBox card parameters
 *
 * @example
 * ```ts
 * await closeTopBox(cfg, {
 *   openConversationId: "cidxxxxx==",
 *   coolAppCode: "COOLAPP-1-xxxx",
 *   outTrackId: "topbox_001",
 * });
 * ```
 */
export async function closeTopBox(cfg: DingtalkConfig, params: CloseTopBoxParams): Promise<void> {
  const accessToken = await resolveAccessToken(cfg);

  dingtalkLogger.info(
    `Closing TopBox in conversation ${params.openConversationId}, trackId: ${params.outTrackId}`,
  );

  const body: Record<string, unknown> = {
    openConversationId: params.openConversationId,
    coolAppCode: params.coolAppCode,
    outTrackId: params.outTrackId,
    conversationType: params.conversationType ?? 1,
  };

  await coolAppApiRequest<Record<string, unknown>>("DELETE", "/v2.0/im/topBoxes", accessToken, {
    body,
    operationLabel: "close TopBox",
  });

  dingtalkLogger.info(
    `TopBox closed in conversation ${params.openConversationId}, trackId: ${params.outTrackId}`,
  );
}
