import { randomUUID } from "node:crypto";
import axios from "axios";
import { getOAuth2AccessToken } from "./client.js";
import type { ResolvedDingtalkAccount } from "./types.js";

const DINGTALK_API = "https://api.dingtalk.com";

// Template for DingTalk AI Card (official streaming card template)
const AI_CARD_TEMPLATE_ID = "382e4302-551d-4880-bf29-a30acfab2e71.schema";

const AICardStatus = {
  PROCESSING: "1",
  INPUTING: "2",
  FINISHED: "3",
} as const;

export interface AICardInstance {
  cardInstanceId: string;
  accessToken: string;
  inputingStarted: boolean;
}

type AICardTarget =
  | { type: "user"; userId: string }
  | { type: "group"; openConversationId: string };

function buildDeliverBody(
  cardInstanceId: string,
  target: AICardTarget,
  robotCode: string,
): Record<string, unknown> {
  const base = { outTrackId: cardInstanceId, userIdType: 1 };
  if (target.type === "group") {
    return {
      ...base,
      openSpaceId: `dtv1.card//IM_GROUP.${target.openConversationId}`,
      imGroupOpenDeliverModel: { robotCode },
    };
  }
  return {
    ...base,
    openSpaceId: `dtv1.card//IM_ROBOT.${target.userId}`,
    imRobotOpenDeliverModel: { spaceType: "IM_ROBOT", robotCode },
  };
}

/**
 * Create and deliver an AI Card instance.
 *
 * Required permissions:
 * - Card.Instance.Write
 * - Card.Streaming.Write
 */
export async function createAICard(params: {
  account: ResolvedDingtalkAccount;
  conversationType: "1" | "2";
  conversationId: string;
  senderStaffId: string;
  log?: (...args: unknown[]) => void;
}): Promise<AICardInstance | null> {
  const { account, conversationType, conversationId, senderStaffId, log } = params;
  const robotCode = account.robotCode ?? account.clientId;
  if (!robotCode) return null;

  const target: AICardTarget =
    conversationType === "2"
      ? { type: "group", openConversationId: conversationId }
      : { type: "user", userId: senderStaffId };

  try {
    const accessToken = await getOAuth2AccessToken(account);
    const cardInstanceId = `card_${randomUUID()}`;

    const headers = {
      "x-acs-dingtalk-access-token": accessToken,
      "Content-Type": "application/json",
    };

    // 1. Create card instance
    await axios.post(
      `${DINGTALK_API}/v1.0/card/instances`,
      {
        cardTemplateId: AI_CARD_TEMPLATE_ID,
        outTrackId: cardInstanceId,
        cardData: { cardParamMap: {} },
        callbackType: "STREAM",
        imGroupOpenSpaceModel: { supportForward: true },
        imRobotOpenSpaceModel: { supportForward: true },
      },
      { headers },
    );

    // 2. Deliver card to target
    const deliverBody = buildDeliverBody(cardInstanceId, target, robotCode);
    await axios.post(`${DINGTALK_API}/v1.0/card/instances/deliver`, deliverBody, { headers });

    return { cardInstanceId, accessToken, inputingStarted: false };
  } catch (err) {
    log?.(`dingtalk[${account.accountId}]: AI Card creation failed: ${err}`);
    return null;
  }
}

/**
 * Stream content update to an AI Card.
 */
export async function streamAICard(params: {
  card: AICardInstance;
  content: string;
  finished?: boolean;
  log?: (...args: unknown[]) => void;
}): Promise<void> {
  const { card, content, finished = false, log } = params;
  const headers = {
    "x-acs-dingtalk-access-token": card.accessToken,
    "Content-Type": "application/json",
  };

  // Switch to INPUTING state on first stream update
  if (!card.inputingStarted) {
    try {
      await axios.put(
        `${DINGTALK_API}/v1.0/card/instances`,
        {
          outTrackId: card.cardInstanceId,
          cardData: {
            cardParamMap: {
              flowStatus: AICardStatus.INPUTING,
              msgContent: "",
              staticMsgContent: "",
              sys_full_json_obj: JSON.stringify({ order: ["msgContent"] }),
            },
          },
        },
        { headers },
      );
      card.inputingStarted = true;
    } catch (err) {
      log?.(`dingtalk: AI Card INPUTING transition failed: ${err}`);
      throw err;
    }
  }

  // Stream content via the streaming API
  try {
    await axios.put(
      `${DINGTALK_API}/v1.0/card/streaming`,
      {
        outTrackId: card.cardInstanceId,
        guid: randomUUID(),
        key: "msgContent",
        content,
        isFull: true,
        isFinalize: finished,
        isError: false,
      },
      { headers },
    );
  } catch (err) {
    log?.(`dingtalk: AI Card streaming update failed: ${err}`);
    throw err;
  }
}

/**
 * Finish an AI Card: finalize the streaming channel, then set FINISHED status.
 */
export async function finishAICard(params: {
  card: AICardInstance;
  content: string;
  log?: (...args: unknown[]) => void;
}): Promise<void> {
  const { card, content, log } = params;

  // 1. Send final content with isFinalize=true
  await streamAICard({ card, content, finished: true, log });

  // 2. Update card status to FINISHED
  try {
    await axios.put(
      `${DINGTALK_API}/v1.0/card/instances`,
      {
        outTrackId: card.cardInstanceId,
        cardData: {
          cardParamMap: {
            flowStatus: AICardStatus.FINISHED,
            msgContent: content,
            staticMsgContent: "",
            sys_full_json_obj: JSON.stringify({ order: ["msgContent"] }),
          },
        },
      },
      {
        headers: {
          "x-acs-dingtalk-access-token": card.accessToken,
          "Content-Type": "application/json",
        },
      },
    );
  } catch (err) {
    log?.(`dingtalk: AI Card FINISHED update failed: ${err}`);
  }
}
