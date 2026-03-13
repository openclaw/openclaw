import type { Action, CardAction, FlexBubble, FlexCarousel, ListItem } from "./types.js";
/**
 * Create an info card with title, body, and optional footer
 *
 * Editorial design: Clean hierarchy with accent bar, generous spacing,
 * and subtle background zones for visual separation.
 */
export declare function createInfoCard(title: string, body: string, footer?: string): FlexBubble;
/**
 * Create a list card with title and multiple items
 *
 * Editorial design: Numbered/bulleted list with clear visual hierarchy,
 * accent dots for each item, and generous spacing.
 */
export declare function createListCard(title: string, items: ListItem[]): FlexBubble;
/**
 * Create an image card with image, title, and optional body text
 */
export declare function createImageCard(imageUrl: string, title: string, body?: string, options?: {
    aspectRatio?: "1:1" | "1.51:1" | "1.91:1" | "4:3" | "16:9" | "20:13" | "2:1" | "3:1";
    aspectMode?: "cover" | "fit";
    action?: Action;
}): FlexBubble;
/**
 * Create an action card with title, body, and action buttons
 */
export declare function createActionCard(title: string, body: string, actions: CardAction[], options?: {
    imageUrl?: string;
    aspectRatio?: "1:1" | "1.51:1" | "1.91:1" | "4:3" | "16:9" | "20:13" | "2:1" | "3:1";
}): FlexBubble;
/**
 * Create a carousel container from multiple bubbles
 * LINE allows max 12 bubbles in a carousel
 */
export declare function createCarousel(bubbles: FlexBubble[]): FlexCarousel;
/**
 * Create a notification bubble (for alerts, status updates)
 *
 * Editorial design: Bold status indicator with accent color,
 * clear typography, optional icon for context.
 */
export declare function createNotificationBubble(text: string, options?: {
    icon?: string;
    type?: "info" | "success" | "warning" | "error";
    title?: string;
}): FlexBubble;
