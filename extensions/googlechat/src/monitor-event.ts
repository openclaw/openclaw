import { isRecord } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import type {
  GoogleChatAction,
  GoogleChatEvent,
  GoogleChatMessage,
  GoogleChatSpace,
  GoogleChatUser,
} from "./types.js";

/** Normalize only at authenticated dispatch; durable admission stores the untouched envelope. */
export function parseGoogleChatInboundPayload(raw: unknown): GoogleChatEvent {
  if (!isRecord(raw)) {
    throw new Error("invalid payload");
  }

  let eventPayload: Record<string, unknown> = raw;
  const rawObj = raw as {
    commonEventObject?: {
      hostApp?: string;
      invokedFunction?: string;
      parameters?: Record<string, string>;
    };
    chat?: {
      messagePayload?: { space?: GoogleChatSpace; message?: GoogleChatMessage };
      buttonClickedPayload?: {
        space?: GoogleChatSpace;
        message?: GoogleChatMessage;
        user?: GoogleChatUser;
        action?: GoogleChatAction;
      };
      user?: GoogleChatUser;
      eventTime?: string;
    };
  };

  const chat = rawObj.chat;
  const messagePayload = chat?.messagePayload;
  if (rawObj.commonEventObject?.hostApp === "CHAT" && chat && messagePayload) {
    eventPayload = {
      type: "MESSAGE",
      space: messagePayload.space,
      message: messagePayload.message,
      user: chat.user,
      eventTime: chat.eventTime,
    };
  } else if (rawObj.commonEventObject?.hostApp === "CHAT") {
    const chatPayload = rawObj.chat;
    const buttonClickedPayload = chatPayload?.buttonClickedPayload;
    if (buttonClickedPayload) {
      const invokedFunction = rawObj.commonEventObject.invokedFunction;
      const parameters = rawObj.commonEventObject.parameters;
      const entries = parameters
        ? Object.entries(parameters)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .map(([key, value]) => ({ key, value }))
        : [];
      const actionParameters = entries.length > 0 ? entries : undefined;
      eventPayload = {
        type: "CARD_CLICKED",
        space: buttonClickedPayload.space,
        message: buttonClickedPayload.message,
        user: buttonClickedPayload.user ?? chatPayload?.user,
        eventTime: chatPayload?.eventTime,
        action:
          buttonClickedPayload.action ??
          ({
            ...(typeof invokedFunction === "string" ? { actionMethodName: invokedFunction } : {}),
            ...(actionParameters ? { parameters: actionParameters } : {}),
          } satisfies GoogleChatAction),
        commonEventObject: {
          ...(typeof invokedFunction === "string" ? { invokedFunction } : {}),
          parameters: rawObj.commonEventObject.parameters,
        },
      };
    }
  }

  const event = eventPayload as GoogleChatEvent;
  const eventType = event.type ?? event.eventType;
  if (typeof eventType !== "string" || !isRecord(event.space)) {
    throw new Error("invalid payload");
  }
  if (eventType === "MESSAGE") {
    if (!isRecord(event.message) || !event.space?.name?.trim() || !event.message?.name?.trim()) {
      throw new Error("invalid payload");
    }
  } else if (eventType === "CARD_CLICKED" && !isRecord(event.user)) {
    throw new Error("invalid payload");
  }

  return event;
}
