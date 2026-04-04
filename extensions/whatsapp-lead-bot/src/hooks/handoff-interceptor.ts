/**
 * Handoff interceptor — silently captures media (especially CFE receipts)
 * and logs text messages when a lead is in handed_off status.
 * No response is ever sent to the lead.
 */

import type { Lead } from "../database/schema.js";
import type { CFEParseContext } from "../media/handler.js";
import type { AgentNotifier } from "../notifications/agent-notify.js";
import type { PluginHookMessageReceivedEvent, PluginHookMessageReceivedResult } from "../types.js";

export interface HandoffInterceptorDeps {
  agentNotifier: AgentNotifier;
  cfeParseContext?: CFEParseContext;
}

interface HandoffInput {
  event: PluginHookMessageReceivedEvent;
  lead: Lead;
}

export class HandoffInterceptor {
  constructor(private deps: HandoffInterceptorDeps) {}

  async handle(input: HandoffInput): Promise<PluginHookMessageReceivedResult | null> {
    const { lead, event } = input;
    if (lead.status !== "handed_off") return null;

    const { mediaType, mediaPath } = this.extractMedia(event);

    if (mediaType && this.isPotentialReceipt(mediaType)) {
      await this.processCFEReceipt(lead, mediaPath);
    } else if (mediaType) {
      await this.deps.agentNotifier.notifyHandoffCapture(lead, "media");
    }
    // Text messages: already stored via raw message listener, no notification needed

    return { suppress: true };
  }

  private extractMedia(event: PluginHookMessageReceivedEvent): {
    mediaType?: string;
    mediaPath?: string;
  } {
    let mediaType = (event.metadata?.MediaType || event.metadata?.mediaType) as string | undefined;
    let mediaPath = event.metadata?.mediaPath as string | undefined;

    if (!mediaType && event.content.includes("[media attached:")) {
      const match = event.content.match(/\[media attached: (.+?) \((.+?)\)\]/);
      if (match) {
        mediaPath = match[1];
        mediaType = match[2];
      }
    }

    if (mediaType === "text/plain") mediaType = undefined;
    return { mediaType, mediaPath };
  }

  private isPotentialReceipt(mediaType: string): boolean {
    return (
      mediaType === "application/pdf" ||
      mediaType === "image/jpeg" ||
      mediaType === "image/png" ||
      mediaType === "image/webp"
    );
  }

  private async processCFEReceipt(lead: Lead, mediaPath?: string): Promise<void> {
    if (!mediaPath || !this.deps.cfeParseContext) {
      await this.deps.agentNotifier.notifyHandoffCapture(lead, "media");
      return;
    }

    try {
      const { parseCFEReceiptTool } = await import("../tools/parse-cfe-receipt.js");
      const result = await parseCFEReceiptTool.execute(
        { leadId: lead.id, filePath: mediaPath },
        this.deps.cfeParseContext,
      );

      const detail = result.success
        ? `Tarifa ${result.data?.tariff || "?"}, ${result.data?.annual_kwh || "?"} kWh/yr`
        : undefined;
      await this.deps.agentNotifier.notifyHandoffCapture(lead, "receipt", detail);
    } catch (err) {
      console.error("[handoff-interceptor] CFE parse failed silently:", err);
      await this.deps.agentNotifier.notifyHandoffCapture(lead, "media");
    }
  }
}
