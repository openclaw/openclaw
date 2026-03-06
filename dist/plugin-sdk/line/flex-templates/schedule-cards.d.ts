import type { Action, FlexBubble } from "./types.js";
/**
 * Create a receipt/summary card (for orders, transactions, data tables)
 *
 * Editorial design: Clean table layout with alternating row backgrounds,
 * prominent total section, and clear visual hierarchy.
 */
export declare function createReceiptCard(params: {
    title: string;
    subtitle?: string;
    items: Array<{
        name: string;
        value: string;
        highlight?: boolean;
    }>;
    total?: {
        label: string;
        value: string;
    };
    footer?: string;
}): FlexBubble;
/**
 * Create a calendar event card (for meetings, appointments, reminders)
 *
 * Editorial design: Date as hero, strong typographic hierarchy,
 * color-blocked zones, full text wrapping for readability.
 */
export declare function createEventCard(params: {
    title: string;
    date: string;
    time?: string;
    location?: string;
    description?: string;
    calendar?: string;
    isAllDay?: boolean;
    action?: Action;
}): FlexBubble;
/**
 * Create a calendar agenda card showing multiple events
 *
 * Editorial timeline design: Time-focused left column with event details
 * on the right. Visual accent bars indicate event priority/recency.
 */
export declare function createAgendaCard(params: {
    title: string;
    subtitle?: string;
    events: Array<{
        title: string;
        time?: string;
        location?: string;
        calendar?: string;
        isNow?: boolean;
    }>;
    footer?: string;
}): FlexBubble;
