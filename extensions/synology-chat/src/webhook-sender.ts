import { formatErrorMessage } from "../../../src/infra/errors.js";

export class SynologyNasWebhookSender {
  constructor(private nasIncomingWebhookUrl: string) {
    if (!this.isValidUrl(nasIncomingWebhookUrl)) {
      throw new Error(`Invalid NAS incoming webhook URL: ${nasIncomingWebhookUrl}`);
    }
  }

  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return url.startsWith("http://") || url.startsWith("https://");
    } catch {
      return false;
    }
  }

  async sendText(text: string): Promise<void> {
    const payload = { text };
    const data = { payload: JSON.stringify(payload) };

    try {
      const response = await fetch(this.nasIncomingWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(data).toString(),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (error) {
      throw new Error(`Failed to send to Synology Chat: ${formatErrorMessage(error)}`, {
        cause: error,
      });
    }
  }
}

// Keep original class for backward compatibility
export class SynologyWebhookSender extends SynologyNasWebhookSender {}
