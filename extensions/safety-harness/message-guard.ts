export type MessageScanResult = {
  flagged: boolean;
  reason?: string;
};

const EMAIL_PATTERN = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const PHONE_PATTERN = /\+?\d[\d\s\-().]{7,}\d/g;
const BULK_DATA_THRESHOLD = 500;
const STRUCTURED_ITEM_THRESHOLD = 10;

/**
 * Scan an outbound message for patterns indicating data exfiltration.
 * Returns { flagged: true, reason } if suspicious content detected.
 */
export function scanOutboundMessage(content: string): MessageScanResult {
  // Short messages are never flagged
  if (content.length > BULK_DATA_THRESHOLD) {
    const emailMatches = content.match(EMAIL_PATTERN) ?? [];
    const phoneMatches = content.match(PHONE_PATTERN) ?? [];
    const totalStructured = emailMatches.length + phoneMatches.length;

    if (totalStructured >= STRUCTURED_ITEM_THRESHOLD) {
      return {
        flagged: true,
        reason: `Outbound message contains bulk structured data (${totalStructured} items detected)`,
      };
    }

    // Check for JSON array dumps
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed) && parsed.length >= STRUCTURED_ITEM_THRESHOLD) {
        return {
          flagged: true,
          reason: `Outbound message contains JSON array with ${parsed.length} items`,
        };
      }
    } catch {
      // Not JSON — continue
    }
  }

  return { flagged: false };
}
