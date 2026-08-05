// Rcs plugin module translates OpenClaw MessagePresentation into Twilio Content
// API create requests. Twilio sends RCS rich content by pre-creating a Content
// Template (ContentSid, HX...) and then sending it with ContentSid +
// ContentVariables, so this module builds the exact create-request body for each
// supported content type. It is pure and provider-shaped; the Twilio API calls
// live in twilio.ts and the outbound wiring in channel.ts.
import type {
  MessagePresentation,
  MessagePresentationButton,
  MessagePresentationOption,
} from "openclaw/plugin-sdk/interactive-runtime";
import {
  resolveMessagePresentationButtonAction,
  resolveMessagePresentationOptionAction,
} from "openclaw/plugin-sdk/interactive-runtime";

// RCS Business Messaging suggestion limits: up to 11 suggested replies/actions
// per message and short suggestion text. Bounded here so the builder never emits
// a content template Twilio would reject for the RCS channel.
const MAX_SUGGESTIONS = 11;
// Twilio RCS suggestion button title max is 20 chars; postback id max is 200.
const MAX_SUGGESTION_TITLE = 20;
const MAX_POSTBACK_DATA = 200;
const MAX_CARD_TITLE = 200;
// Card long text goes in the card `body` field; `subtitle` is a separate
// 60-char field Twilio rejects when overrun, so we populate `body`, not subtitle.
const MAX_CARD_BODY = 1600;
const MAX_BODY = 1600;

type RcsContentType = "media" | "card";

/** Suggested-reply (postback) action inside a twilio/card template. */
type TwilioQuickReplyAction = { id: string; title: string };
// Only URL call-to-actions are produced: the portable MessagePresentation
// contract has url/web-app actions but no dial action, so PHONE_NUMBER CTAs are
// not reachable from a presentation and are intentionally not built here.
/** URL action inside a twilio/card template. */
type TwilioCtaAction = { type: "URL"; title: string; url: string };
/** Action inside a twilio/card template (mixes CTAs and suggested replies). */
type TwilioCardAction = TwilioCtaAction | { type: "QUICK_REPLY"; title: string; id: string };

/** Exact JSON body posted to Twilio's Content API create endpoint. */
export type TwilioContentCreateRequest = {
  friendly_name: string;
  language: string;
  types: Record<string, unknown>;
  variables?: Record<string, string>;
};

export type TwilioContentSpec = {
  /** Which content type was built, for capability accounting and telemetry. */
  contentType: RcsContentType;
  /** Create-request body for POST https://content.twilio.com/v1/Content. */
  request: TwilioContentCreateRequest;
  /** ContentVariables passed to the Messages API alongside the created ContentSid. */
  variables: Record<string, string>;
};

type RcsContentBuildInput = {
  presentation: MessagePresentation;
  /** Plain-text body used when the presentation has no text/context blocks. */
  fallbackText?: string;
  /** Outbound media attached to the message, used for media/card templates. */
  mediaUrls?: string[];
  friendlyName?: string;
  language?: string;
};

type ClassifiedAction =
  | { kind: "cta"; action: TwilioCtaAction }
  | { kind: "quick"; action: TwilioQuickReplyAction };

function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function clampPostback(value: string): string {
  return value.slice(0, MAX_POSTBACK_DATA);
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function presentationBody(presentation: MessagePresentation, fallbackText?: string): string {
  const parts: string[] = [];
  for (const block of presentation.blocks) {
    if ((block.type === "text" || block.type === "context") && block.text.trim()) {
      parts.push(block.text.trim());
    }
  }
  const body = parts.join("\n\n").trim() || (fallbackText ?? "").trim();
  return clamp(body, MAX_BODY);
}

function classifyButton(button: MessagePresentationButton): ClassifiedAction | null {
  const title = clamp(button.label ?? "", MAX_SUGGESTION_TITLE);
  if (!title) {
    return null;
  }
  const action = resolveMessagePresentationButtonAction(button);
  if (!action) {
    return null;
  }
  switch (action.type) {
    case "url":
    case "web-app": {
      // Twilio call-to-action URL buttons require an http(s) URL; drop anything
      // else so a non-web scheme never reaches the Content API.
      const url = action.url?.trim();
      return url && isHttpUrl(url) ? { kind: "cta", action: { type: "URL", title, url } } : null;
    }
    case "command":
      return { kind: "quick", action: { id: clampPostback(action.command), title } };
    case "callback":
      return { kind: "quick", action: { id: clampPostback(action.value), title } };
    case "approval":
      // RCS has no native approval affordance; carry the decision as an opaque
      // postback so the tap round-trips to the agent as a normal inbound turn.
      return {
        kind: "quick",
        action: {
          id: clampPostback(
            `approval:${action.approvalKind}:${action.approvalId}:${action.decision}`,
          ),
          title,
        },
      };
    default:
      return null;
  }
}

function classifyOption(option: MessagePresentationOption): ClassifiedAction | null {
  const title = clamp(option.label ?? "", MAX_SUGGESTION_TITLE);
  if (!title) {
    return null;
  }
  const action = resolveMessagePresentationOptionAction(option);
  if (!action) {
    return null;
  }
  const value = action.type === "command" ? action.command : action.value;
  return { kind: "quick", action: { id: clampPostback(value), title } };
}

function collectActions(presentation: MessagePresentation): {
  ctaActions: TwilioCtaAction[];
  quickReplies: TwilioQuickReplyAction[];
} {
  const ctaActions: TwilioCtaAction[] = [];
  const quickReplies: TwilioQuickReplyAction[] = [];
  for (const block of presentation.blocks) {
    if (block.type === "buttons") {
      for (const button of block.buttons) {
        const classified = classifyButton(button);
        if (classified?.kind === "cta") {
          ctaActions.push(classified.action);
        } else if (classified?.kind === "quick") {
          quickReplies.push(classified.action);
        }
      }
    } else if (block.type === "select") {
      for (const option of block.options) {
        const classified = classifyOption(option);
        if (classified?.kind === "quick") {
          quickReplies.push(classified.action);
        }
      }
    }
  }
  return {
    ctaActions: ctaActions.slice(0, MAX_SUGGESTIONS),
    quickReplies: quickReplies.slice(0, MAX_SUGGESTIONS),
  };
}

/**
 * Builds the Twilio Content API create request for a portable presentation, or
 * null when the presentation is plain text with no rich affordance (the caller
 * then sends a normal text Body, which needs no content template).
 *
 * Content-type selection:
 * - URL actions, suggested replies, or media alongside actions -> twilio/card
 * - media only -> twilio/media
 *
 * Twilio exposes standalone quick-reply and call-to-action templates for other
 * channels, but RCS actions are carried by twilio/card.
 */
export function presentationToTwilioContent(input: RcsContentBuildInput): TwilioContentSpec | null {
  const { presentation } = input;
  const { ctaActions, quickReplies } = collectActions(presentation);
  const body = presentationBody(presentation, input.fallbackText);
  const title = clamp(presentation.title ?? "", MAX_CARD_TITLE);
  const mediaUrls = (input.mediaUrls ?? []).filter((url) => /^https?:\/\//i.test(url));
  const hasMedia = mediaUrls.length > 0;

  const spec = (
    contentType: RcsContentType,
    types: Record<string, unknown>,
  ): TwilioContentSpec => ({
    contentType,
    request: {
      friendly_name: input.friendlyName ?? "openclaw_rcs_dynamic",
      language: input.language ?? "en",
      types,
    },
    variables: {},
  });

  const anyActions = ctaActions.length > 0 || quickReplies.length > 0;

  if (anyActions) {
    const actions: TwilioCardAction[] = [
      ...ctaActions,
      ...quickReplies.map((quick) => ({
        type: "QUICK_REPLY" as const,
        id: quick.id,
        title: quick.title,
      })),
    ].slice(0, MAX_SUGGESTIONS);
    return spec("card", {
      "twilio/card": {
        title: title || clamp(body, MAX_CARD_TITLE) || "Message",
        ...(body && body !== title ? { body: clamp(body, MAX_CARD_BODY) } : {}),
        ...(hasMedia ? { media: mediaUrls } : {}),
        actions,
      },
    });
  }
  if (hasMedia) {
    return spec("media", {
      "twilio/media": { ...(body ? { body } : {}), media: mediaUrls },
    });
  }
  return null;
}
