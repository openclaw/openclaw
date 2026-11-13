import { TELEGRAM_WIDGET_DATA_MAX_BYTES } from "./widget-bot-api.js";

/** The prompt-facing request prefix; widget code chooses the text after it. */
export const TELEGRAM_WIDGET_REQUEST_PREFIX = "widget_request:";

// Bounded rules for Telegram widget profile 1 (https://core.telegram.org/bots/widgets).
// This text replaces the browser-host rules of show_widget in Telegram turns.
export const TELEGRAM_WIDGET_AUTHORING_GUIDANCE = [
  "Telegram shows widget_code as a widget inside a chat message: a sandbox with no network, no CDN and no libraries.",
  "Limits: 32 KB of HTML and 4 KB after zlib compression; aim for 3 KB, with no comments or dead code.",
  "Allowed: div, span, p, h1-h6, lists, tables, details/summary, button, canvas, inline SVG (no clipPath, mask, filters or SMIL), img with data: PNG/JPEG/WebP/GIF only.",
  "Removed: input, select, textarea, forms, iframe, audio, video. There is no keyboard; use buttons.",
  "CSS: flex, grid, %, em. No vh, no scrolling (overflow auto becomes hidden), no sticky, no color-mix() or oklch(), no @font-face, no nesting; generic fonts only.",
  "Clients stop a widget that has more than 16 elements with opacity below 1, filter or a blurred box-shadow, 2000 elements or 400 CSS rules. Use solid theme colors for fills and tints, not opacity.",
  "The bubble is 200-600px wide (design for 320px) and at most 600px tall; anything taller is cut off. Use tabs or details for more.",
  "Never hard-code colors or set html/body background. Use var(--tg-theme-text-color), --tg-theme-hint-color, --tg-theme-link-color, --tg-theme-button-color, --tg-theme-button-text-color, --tg-theme-secondary-bg-color, --tg-theme-accent-text-color, --tg-theme-destructive-text-color, --tg-theme-section-separator-color. An unstyled button looks native.",
  "Script API is window.TelegramWidget (there is no openclaw object): TelegramWidget.chatData is the state string or null; draw from it synchronously at start and again in TelegramWidget.onEvent('chatDataChanged', draw). Keep purely local choices in localStorage.",
  "Scripts run in QuickJS with a DOM shim, not a browser: element ids are not global variables, so look elements up with document.getElementById or querySelector.",
  `To ask you to act, call TelegramWidget.request(data) inside a click handler only (1-64 bytes, never from timers or on load). It reaches you as "${TELEGRAM_WIDGET_REQUEST_PREFIX} <data>". The promise resolves at once; show "Sent" and wait for chatDataChanged.`,
  `When you answer a ${TELEGRAM_WIDGET_REQUEST_PREFIX} turn, call show_widget with the same title and only the new state (no widget_code): that updates the tapped widget in place. Then reply NO_REPLY. New widget_code always sends a new message.`,
  "TelegramWidget.openLink(httpsUrl) and TelegramWidget.copyText(text) work only inside click handlers.",
  "The title is shown as the caption under the widget. Do not restate the widget in text afterwards: reply NO_REPLY unless you have something the widget does not show.",
].join(" ");

export const TELEGRAM_WIDGET_STATE_DESCRIPTION = `Widget state the code reads as TelegramWidget.chatData, at most ${TELEGRAM_WIDGET_DATA_MAX_BYTES} bytes (usually JSON). Without widget_code, it updates the widget the user just tapped.`;
