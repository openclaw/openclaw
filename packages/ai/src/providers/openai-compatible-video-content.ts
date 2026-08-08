// Vendor-compatible video parts extend OpenAI wire shapes without claiming first-party support.
import type {
  ChatCompletionContentPart,
  ChatCompletionContentPartImage,
} from "openai/resources/chat/completions.js";
import type {
  ResponseFunctionCallOutputItemList,
  ResponseInputContent,
  ResponseInputImage,
} from "openai/resources/responses/responses.js";
import type { MediaContent } from "../types.js";

/** Chat Completions vendor extension used only by video-capable compatible models. */
type OpenAICompatibleChatVideoContentPart = {
  type: "video_url";
  video_url: { url: string };
};

/** Responses vendor extension used only by explicitly video-capable compatible models. */
type OpenAICompatibleResponsesVideoContentPart = {
  type: "input_video";
  video_url: string;
};

/** First-party Chat parts plus the capability-gated compatible video extension. */
export type OpenAICompatibleChatContentPart =
  | ChatCompletionContentPart
  | OpenAICompatibleChatVideoContentPart;

/** First-party Responses parts plus the capability-gated compatible video extension. */
export type OpenAICompatibleResponsesContentPart =
  | ResponseInputContent
  | OpenAICompatibleResponsesVideoContentPart;

/** First-party function output parts plus the compatible video extension. */
export type OpenAICompatibleResponsesFunctionOutputPart =
  | ResponseFunctionCallOutputItemList[number]
  | OpenAICompatibleResponsesVideoContentPart;

/** Project normalized inline media onto Chat Completions compatible content parts. */
export function buildOpenAICompatibleChatMediaPart(
  media: MediaContent,
): ChatCompletionContentPartImage | OpenAICompatibleChatVideoContentPart {
  const url = `data:${media.mimeType};base64,${media.data}`;
  return media.type === "video"
    ? { type: "video_url", video_url: { url } }
    : { type: "image_url", image_url: { url } };
}

/** Project normalized inline media onto Responses compatible content parts. */
export function buildOpenAICompatibleResponsesMediaPart(
  media: MediaContent,
): ResponseInputImage | OpenAICompatibleResponsesVideoContentPart {
  const videoOrImageUrl = `data:${media.mimeType};base64,${media.data}`;
  return media.type === "video"
    ? { type: "input_video", video_url: videoOrImageUrl }
    : { type: "input_image", detail: "auto", image_url: videoOrImageUrl };
}
