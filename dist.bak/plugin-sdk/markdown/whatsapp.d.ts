/**
 * Convert standard Markdown bold/italic/strikethrough to WhatsApp formatting.
 *
 * Order of operations matters:
 * 1. Protect fenced code blocks (```...```) — already WhatsApp-compatible
 * 2. Protect inline code (`...`) — leave as-is
 * 3. Convert **bold** → *bold* and __bold__ → *bold*
 * 4. Convert ~~strike~~ → ~strike~
 * 5. Restore protected spans
 *
 * Italic *text* and _text_ are left alone since WhatsApp uses _text_ for italic
 * and single * is already WhatsApp bold — no conversion needed for single markers.
 */
export declare function markdownToWhatsApp(text: string): string;
