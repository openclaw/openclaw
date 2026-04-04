/**
 * Media handler - processes media uploads
 *
 * For CFE receipts: calls the CFE API directly and returns parsed JSON
 * as content rewrite so the agent sees structured data instead of raw PDF.
 *
 * Ack text is returned separately via getAckText() so the caller can
 * send it to the user before the (potentially slow) parsing starts.
 */

import type { ExtractionStore, LeadRepository } from "../database.js";
import type { Lead } from "../database/schema.js";

export interface CFEParseContext {
  apiKey: string;
  apiUrl: string;
  db: ExtractionStore & Pick<LeadRepository, "updateReceiptData">;
  maxAttempts: number;
}

export interface MediaHandlerDeps {
  cfeParseContext?: CFEParseContext;
}

const RECEIPT_ACK =
  "Gracias por enviar su recibo. Permítame revisarlo para prepararle su cotización.";

export class MediaHandler {
  constructor(private deps: MediaHandlerDeps = {}) {}

  /**
   * Returns the acknowledgment text to send immediately (no I/O).
   * Call this before handleMedia() so the user gets instant feedback.
   */
  getAckText(lead: Lead, mediaType: string): { text: string; suppress: boolean } {
    if (this.isPotentialReceipt(mediaType) && this.isExpectingReceipt(lead)) {
      return { text: RECEIPT_ACK, suppress: false };
    }

    const typeMap: Record<string, string> = {
      image: "photo",
      video: "video",
      audio: "audio message",
      document: "document",
    };
    const mediaTypeSimple = Object.keys(typeMap).find((key) => mediaType.includes(key)) || "file";
    const mediaLabel = typeMap[mediaTypeSimple] || "file";

    return {
      text: `Thanks for the ${mediaLabel}! A team member will review it shortly.`,
      suppress: true,
    };
  }

  /**
   * Processes media — for CFE receipts with parse context, calls the API
   * and returns parsed JSON as content rewrite. Ack should already be sent.
   */
  async handleMedia(
    lead: Lead,
    mediaType: string,
    mediaPath?: string,
    _fileSize?: number,
  ): Promise<{
    suppress: boolean;
    content?: string;
  }> {
    if (this.isPotentialReceipt(mediaType) && this.isExpectingReceipt(lead)) {
      if (mediaPath && this.deps.cfeParseContext) {
        try {
          const { parseCFEReceiptTool } = await import("../tools/parse-cfe-receipt.js");
          const result = await parseCFEReceiptTool.execute(
            { leadId: lead.id, filePath: mediaPath },
            this.deps.cfeParseContext,
          );
          return { suppress: false, content: JSON.stringify(result) };
        } catch (err) {
          console.error(`[media-handler] CFE parse failed, falling back to agent:`, err);
          return { suppress: false };
        }
      }
      // No cfeParseContext — let agent handle with tool
      return { suppress: false };
    }

    // Non-receipt media — already acked with suppress: true
    return { suppress: true };
  }

  private isPotentialReceipt(mediaType: string): boolean {
    return (
      mediaType === "application/pdf" ||
      mediaType === "image/jpeg" ||
      mediaType === "image/png" ||
      mediaType === "image/webp"
    );
  }

  private isExpectingReceipt(lead: Lead): boolean {
    return !!(lead.name && lead.location && lead.status !== "handed_off");
  }
}
