import type { messagingApi } from "@line/bot-sdk";
import { datetimePickerAction, messageAction, postbackAction, uriAction, type Action } from "./actions.js";
export { datetimePickerAction, messageAction, postbackAction, uriAction };
type TemplateMessage = messagingApi.TemplateMessage;
type ConfirmTemplate = messagingApi.ConfirmTemplate;
type ButtonsTemplate = messagingApi.ButtonsTemplate;
type CarouselTemplate = messagingApi.CarouselTemplate;
type CarouselColumn = messagingApi.CarouselColumn;
type ImageCarouselTemplate = messagingApi.ImageCarouselTemplate;
type ImageCarouselColumn = messagingApi.ImageCarouselColumn;
/**
 * Create a confirm template (yes/no style dialog)
 */
export declare function createConfirmTemplate(text: string, confirmAction: Action, cancelAction: Action, altText?: string): TemplateMessage;
/**
 * Create a button template with title, text, and action buttons
 */
export declare function createButtonTemplate(title: string, text: string, actions: Action[], options?: {
    thumbnailImageUrl?: string;
    imageAspectRatio?: "rectangle" | "square";
    imageSize?: "cover" | "contain";
    imageBackgroundColor?: string;
    defaultAction?: Action;
    altText?: string;
}): TemplateMessage;
/**
 * Create a carousel template with multiple columns
 */
export declare function createTemplateCarousel(columns: CarouselColumn[], options?: {
    imageAspectRatio?: "rectangle" | "square";
    imageSize?: "cover" | "contain";
    altText?: string;
}): TemplateMessage;
/**
 * Create a carousel column for use with createTemplateCarousel
 */
export declare function createCarouselColumn(params: {
    title?: string;
    text: string;
    actions: Action[];
    thumbnailImageUrl?: string;
    imageBackgroundColor?: string;
    defaultAction?: Action;
}): CarouselColumn;
/**
 * Create an image carousel template (simpler, image-focused carousel)
 */
export declare function createImageCarousel(columns: ImageCarouselColumn[], altText?: string): TemplateMessage;
/**
 * Create an image carousel column for use with createImageCarousel
 */
export declare function createImageCarouselColumn(imageUrl: string, action: Action): ImageCarouselColumn;
/**
 * Create a simple yes/no confirmation dialog
 */
export declare function createYesNoConfirm(question: string, options?: {
    yesText?: string;
    noText?: string;
    yesData?: string;
    noData?: string;
    altText?: string;
}): TemplateMessage;
/**
 * Create a button menu with simple text buttons
 */
export declare function createButtonMenu(title: string, text: string, buttons: Array<{
    label: string;
    text?: string;
}>, options?: {
    thumbnailImageUrl?: string;
    altText?: string;
}): TemplateMessage;
/**
 * Create a button menu with URL links
 */
export declare function createLinkMenu(title: string, text: string, links: Array<{
    label: string;
    url: string;
}>, options?: {
    thumbnailImageUrl?: string;
    altText?: string;
}): TemplateMessage;
/**
 * Create a simple product/item carousel
 */
export declare function createProductCarousel(products: Array<{
    title: string;
    description: string;
    imageUrl?: string;
    price?: string;
    actionLabel?: string;
    actionUrl?: string;
    actionData?: string;
}>, altText?: string): TemplateMessage;
import type { LineTemplateMessagePayload } from "./types.js";
/**
 * Convert a TemplateMessagePayload from ReplyPayload to a LINE TemplateMessage
 */
export declare function buildTemplateMessageFromPayload(payload: LineTemplateMessagePayload): TemplateMessage | null;
export type { TemplateMessage, ConfirmTemplate, ButtonsTemplate, CarouselTemplate, CarouselColumn, ImageCarouselTemplate, ImageCarouselColumn, Action, };
