/**
 * DingTalk AI Card streaming response
 *
 * Provides:
 * - createAICard: create AI Card instance
 * - streamAICard: stream update card content
 * - finishAICard: finish card
 *
 * API Docs:
 * - Create card: https://open.dingtalk.com/document/orgapp/create-card-instances
 * - Stream update: https://open.dingtalk.com/document/orgapp/streaming-card-updates
 */

import { getAccessToken } from "./client.js";
import { preprocessDingtalkMarkdown } from "./send.js";
import type { DingtalkConfig } from "./types.js";

/** DingTalk API base URL */
const DINGTALK_API_BASE = "https://api.dingtalk.com";

/** AI Card template ID */
const AI_CARD_TEMPLATE_ID = "382e4302-551d-4880-bf29-a30acfab2e71.schema";

/** AI Card status */
const AICardStatus = {
  PROCESSING: "1",
  INPUTING: "2",
  FINISHED: "3",
  EXECUTING: "4",
  FAILED: "5",
} as const;

/** HTTP request timeout (milliseconds) */
const REQUEST_TIMEOUT = 30000;

/**
 * AI Card instance
 */
export interface AICardInstance {
  /** Card instance ID */
  cardInstanceId: string;
  /** Access Token */
  accessToken: string;
  /** Whether streaming update has started */
  inputingStarted: boolean;
  /** Last stream update timestamp (for throttling) */
  lastStreamTime?: number;
  /** Throttle timer (for deferred sending of skipped updates) */
  pendingStreamTimer?: ReturnType<typeof setTimeout>;
  /** Latest content skipped by throttling (to ensure final state consistency) */
  pendingStreamContent?: string;
}

/**
 * Create AI Card parameters
 */
export interface CreateAICardParams {
  /** DingTalk config */
  cfg: DingtalkConfig;
  /** Conversation type: "1" = direct chat, "2" = group chat */
  conversationType: "1" | "2";
  /** Conversation ID */
  conversationId: string;
  /** Sender ID (used in direct chat) */
  senderId?: string;
  /** Sender staffId (used in direct chat) */
  senderStaffId?: string;
  /** Log function */
  log?: (msg: string) => void;
}

/**
 * Create AI Card instance
 *
 * Process:
 * 1. Get Access Token
 * 2. Create card instance (POST /v1.0/card/instances)
 * 3. Deliver card (POST /v1.0/card/instances/deliver)
 *
 * @param params Create parameters
 * @returns AI Card instance or null (on failure)
 */
export async function createAICard(params: CreateAICardParams): Promise<AICardInstance | null> {
  const { cfg, conversationType, conversationId, senderId, senderStaffId, log } = params;

  // Validate credentials
  if (!cfg.clientId || !cfg.clientSecret) {
    log?.(`[AICard] Error: DingTalk credentials not configured`);
    return null;
  }

  try {
    // Get Access Token
    const accessToken = await getAccessToken(cfg.clientId, cfg.clientSecret);
    const timestamp = Date.now();
    const randomPart = Math.random().toString(36).slice(2, 10);
    const cardInstanceId = `card_${timestamp}_${randomPart}`;

    log?.(`[AICard] Creating card instance: ${cardInstanceId}`);

    // 1. Create card instance
    const createBody = {
      cardTemplateId: AI_CARD_TEMPLATE_ID,
      outTrackId: cardInstanceId,
      cardData: {
        cardParamMap: {},
      },
      callbackType: "STREAM",
      imGroupOpenSpaceModel: { supportForward: true },
      imRobotOpenSpaceModel: { supportForward: true },
    };

    const createController = new AbortController();
    const createTimeoutId = setTimeout(() => createController.abort(), REQUEST_TIMEOUT);

    try {
      const createResp = await fetch(`${DINGTALK_API_BASE}/v1.0/card/instances`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": accessToken,
        },
        body: JSON.stringify(createBody),
        signal: createController.signal,
      });

      if (!createResp.ok) {
        const errorText = await createResp.text();
        log?.(`[AICard] Failed to create card: HTTP ${createResp.status} - ${errorText}`);
        return null;
      }

      log?.(`[AICard] Card instance created successfully`);

      // 2. Deliver card
      const isGroup = conversationType === "2";
      const deliverBody: Record<string, unknown> = {
        outTrackId: cardInstanceId,
        userIdType: 1,
      };

      if (isGroup) {
        deliverBody.openSpaceId = `dtv1.card//IM_GROUP.${conversationId}`;
        deliverBody.imGroupOpenDeliverModel = {
          robotCode: cfg.clientId,
        };
      } else {
        const userId = senderStaffId || senderId;
        if (!userId) {
          log?.("[AICard] Error: missing senderStaffId/senderId for IM_ROBOT delivery");
          return null;
        }
        deliverBody.openSpaceId = `dtv1.card//IM_ROBOT.${userId}`;
        deliverBody.imRobotOpenDeliverModel = { spaceType: "IM_ROBOT" };
      }

      const deliverController = new AbortController();
      const deliverTimeoutId = setTimeout(() => deliverController.abort(), REQUEST_TIMEOUT);

      try {
        const deliverResp = await fetch(`${DINGTALK_API_BASE}/v1.0/card/instances/deliver`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-acs-dingtalk-access-token": accessToken,
          },
          body: JSON.stringify(deliverBody),
          signal: deliverController.signal,
        });

        if (!deliverResp.ok) {
          const errorText = await deliverResp.text();
          log?.(`[AICard] Failed to deliver card: HTTP ${deliverResp.status} - ${errorText}`);
          return null;
        }

        log?.(`[AICard] Card delivered successfully`);

        return {
          cardInstanceId,
          accessToken,
          inputingStarted: false,
        };
      } finally {
        clearTimeout(deliverTimeoutId);
      }
    } finally {
      clearTimeout(createTimeoutId);
    }
  } catch (err) {
    log?.(`[AICard] Error creating card: ${String(err)}`);
    return null;
  }
}

/**
 * Stream update AI Card content
 *
 * Process:
 * 1. On first call, switch to INPUTING state
 * 2. Call streaming API to update content
 *
 * @param card AI Card instance
 * @param content Content to update
 * @param finished Whether finished
 * @param log Log function
 * @throws Error if update fails
 */
/** Minimum stream update interval (milliseconds), prevent high-frequency API calls */
const STREAM_THROTTLE_MS = 500;

export async function streamAICard(
  card: AICardInstance,
  content: string,
  finished: boolean = false,
  log?: (msg: string) => void,
): Promise<void> {
  // Throttle protection: limit minimum update interval for non-finalize calls
  if (!finished) {
    const now = Date.now();
    const elapsed = card.lastStreamTime ? now - card.lastStreamTime : Infinity;

    if (elapsed < STREAM_THROTTLE_MS) {
      // Too close to last update, stash content and set deferred send
      card.pendingStreamContent = content;

      if (!card.pendingStreamTimer) {
        const delayMs = STREAM_THROTTLE_MS - elapsed;
        card.pendingStreamTimer = setTimeout(() => {
          card.pendingStreamTimer = undefined;
          const pending = card.pendingStreamContent;
          if (pending) {
            card.pendingStreamContent = undefined;
            streamAICard(card, pending, false, log).catch((err) => {
              log?.(`[AICard] Deferred stream update failed: ${String(err)}`);
            });
          }
        }, delayMs);
      }

      log?.(`[AICard] Throttled stream update (${elapsed}ms < ${STREAM_THROTTLE_MS}ms), deferred`);
      return;
    }

    // Have pending timer but now past throttle window, cancel timer and send latest content directly
    if (card.pendingStreamTimer) {
      clearTimeout(card.pendingStreamTimer);
      card.pendingStreamTimer = undefined;
      card.pendingStreamContent = undefined;
    }

    card.lastStreamTime = now;
  } else {
    // finalize call: cancel any pending throttle timers
    if (card.pendingStreamTimer) {
      clearTimeout(card.pendingStreamTimer);
      card.pendingStreamTimer = undefined;
      card.pendingStreamContent = undefined;
    }
    card.lastStreamTime = Date.now();
  }

  // Before first stream update, switch to INPUTING state
  if (!card.inputingStarted) {
    const statusBody = {
      outTrackId: card.cardInstanceId,
      cardData: {
        cardParamMap: {
          flowStatus: AICardStatus.INPUTING,
          msgContent: "",
          staticMsgContent: "",
          sys_full_json_obj: JSON.stringify({
            order: ["msgContent"],
          }),
        },
      },
    };

    const statusController = new AbortController();
    const statusTimeoutId = setTimeout(() => statusController.abort(), REQUEST_TIMEOUT);

    try {
      const statusResp = await fetch(`${DINGTALK_API_BASE}/v1.0/card/instances`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "x-acs-dingtalk-access-token": card.accessToken,
        },
        body: JSON.stringify(statusBody),
        signal: statusController.signal,
      });

      if (!statusResp.ok) {
        const errorText = await statusResp.text();
        throw new Error(`Failed to switch to INPUTING: HTTP ${statusResp.status} - ${errorText}`);
      }

      log?.(`[AICard] Switched to INPUTING state`);
    } finally {
      clearTimeout(statusTimeoutId);
    }

    card.inputingStarted = true;
  }

  // Call streaming API to update content
  // Preprocess content, merge fragmented newlines within paragraphs
  const processedContent = preprocessDingtalkMarkdown(content);
  const streamBody = {
    outTrackId: card.cardInstanceId,
    guid: (() => {
      const ts = Date.now();
      const rnd = Math.random().toString(36).slice(2, 8);
      return `${ts}_${rnd}`;
    })(),
    key: "msgContent",
    content: processedContent,
    isFull: true,
    isFinalize: finished,
    isError: false,
  };

  const streamController = new AbortController();
  const streamTimeoutId = setTimeout(() => streamController.abort(), REQUEST_TIMEOUT);

  try {
    const streamResp = await fetch(`${DINGTALK_API_BASE}/v1.0/card/streaming`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": card.accessToken,
      },
      body: JSON.stringify(streamBody),
      signal: streamController.signal,
    });

    if (!streamResp.ok) {
      const errorText = await streamResp.text();
      throw new Error(`Failed to stream update: HTTP ${streamResp.status} - ${errorText}`);
    }

    if (!finished) {
      log?.(`[AICard] Streamed ${content.length} chars`);
    }
  } finally {
    clearTimeout(streamTimeoutId);
  }
}

/**
 * Finish AI Card
 *
 * Process:
 * 1. Close streaming channel with final content (isFinalize=true)
 * 2. Update card status to FINISHED
 *
 * @param card AI Card instance
 * @param content Final content
 * @param log Log function
 */
export async function finishAICard(
  card: AICardInstance,
  content: string,
  log?: (msg: string) => void,
): Promise<void> {
  log?.(`[AICard] Finishing card with ${content.length} chars`);

  // 1. Close streaming channel with final content
  await streamAICard(card, content, true, log);

  // 2. Update card status to FINISHED
  // Preprocess content to ensure spaces are not rendered as newlines
  const processedContent = preprocessDingtalkMarkdown(content);
  const finishBody = {
    outTrackId: card.cardInstanceId,
    cardData: {
      cardParamMap: {
        flowStatus: AICardStatus.FINISHED,
        msgContent: processedContent,
        staticMsgContent: "",
        sys_full_json_obj: JSON.stringify({
          order: ["msgContent"],
        }),
      },
    },
  };

  const finishController = new AbortController();
  const finishTimeoutId = setTimeout(() => finishController.abort(), REQUEST_TIMEOUT);

  try {
    const finishResp = await fetch(`${DINGTALK_API_BASE}/v1.0/card/instances`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": card.accessToken,
      },
      body: JSON.stringify(finishBody),
      signal: finishController.signal,
    });

    if (!finishResp.ok) {
      const errorText = await finishResp.text();
      log?.(`[AICard] Warning: Failed to set FINISHED state: HTTP ${finishResp.status}`);
    } else {
      log?.(`[AICard] Card finished successfully`);
    }
  } finally {
    clearTimeout(finishTimeoutId);
  }
}

/**
 * Button definition (for interactive cards)
 */
export interface CardButton {
  /** Button display text */
  text: string;
  /** Button action params (JSON-encoded string, passed to callback) */
  actionParams: Record<string, string>;
  /** Button color: "default" | "primary" | "danger" */
  color?: "default" | "primary" | "danger";
}

/**
 * Update card parameters (with buttons)
 */
export interface UpdateCardWithButtonsParams {
  /** Card instance */
  card: AICardInstance;
  /** Markdown content */
  content: string;
  /** Card status */
  status: keyof typeof AICardStatus;
  /** Interactive button list */
  buttons?: CardButton[];
  /** Log function */
  log?: (msg: string) => void;
}

/**
 * Update card content with interactive buttons
 *
 * Update card's cardParamMap via PUT /v1.0/card/instances,
 * encode button info into cardParamMap for template rendering.
 *
 * Buttons are passed via `actionButtons` field in cardParamMap,
 * template uses `sys_action_list` to render buttons.
 *
 * @param params Update parameters
 */
export async function updateCardWithButtons(params: UpdateCardWithButtonsParams): Promise<void> {
  const { card, content, status, buttons, log } = params;

  const cardParamMap: Record<string, string | object> = {
    flowStatus: AICardStatus[status],
    msgContent: content,
    staticMsgContent: content,
    sys_full_json_obj: JSON.stringify({
      order: ["msgContent"],
    }),
  };

  // Encode buttons into the card action list
  if (buttons && buttons.length > 0) {
    const actionList = buttons.map((button, index) => ({
      actionId: `jarvis_btn_${index}`,
      actionText: button.text,
      actionType: "callback",
      actionParams: button.actionParams,
      style:
        button.color === "danger"
          ? "destructive"
          : button.color === "primary"
            ? "primary"
            : "default",
    }));

    cardParamMap.sys_action_list = JSON.stringify(actionList);
  }

  // Preprocess content to ensure spaces are not rendered as newlines
  cardParamMap.msgContent = preprocessDingtalkMarkdown(cardParamMap.msgContent as string);
  cardParamMap.staticMsgContent = preprocessDingtalkMarkdown(
    cardParamMap.staticMsgContent as string,
  );

  const updateBody = {
    outTrackId: card.cardInstanceId,
    cardData: { cardParamMap },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(`${DINGTALK_API_BASE}/v1.0/card/instances`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-acs-dingtalk-access-token": card.accessToken,
      },
      body: JSON.stringify(updateBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to update card with buttons: HTTP ${response.status} - ${errorText}`);
    }

    log?.(`[AICard] Card updated with ${buttons?.length ?? 0} buttons, status=${status}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Set card status to EXECUTING (intermediate state after button click)
 *
 * When user clicks button to trigger callback, first switch card to EXECUTING state,
 * giving user visual feedback that operation is being processed.
 *
 * @param card AI Card instance
 * @param content Current content (unchanged)
 * @param log Log function
 */
export async function setCardExecuting(
  card: AICardInstance,
  content: string,
  log?: (msg: string) => void,
): Promise<void> {
  await updateCardWithButtons({
    card,
    content,
    status: "EXECUTING",
    log,
  });
}

/**
 * Set card status to FAILED
 *
 * @param card AI Card instance
 * @param content Error message content
 * @param log Log function
 */
export async function setCardFailed(
  card: AICardInstance,
  content: string,
  log?: (msg: string) => void,
): Promise<void> {
  await updateCardWithButtons({
    card,
    content,
    status: "FAILED",
    log,
  });
}
