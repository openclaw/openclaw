import pRetry from "p-retry";

export class WhatsAppService {
  constructor(private opts: { accessToken: string; phoneNumberId: string; logger?: Console }) {}

  private get url() {
    return `https://graph.facebook.com/v15.0/${this.opts.phoneNumberId}/messages`;
  }

  async sendText(to: string, text: string) {
    const body = {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    };
    const headers = {
      Authorization: `Bearer ${this.opts.accessToken}`,
      "Content-Type": "application/json"
    };

    const attempt = async () => {
      const res = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      });
      let data: any = null;
      try {
        data = await res.json();
      } catch {
        // ignore parse error
      }
      if (!res.ok) {
        const err: any = new Error(`WhatsApp send failed: ${res.status}`);
        err.status = res.status;
        err.body = data;
        throw err;
      }
      this.opts.logger?.log?.("WhatsApp send OK", { to, result: data });
      return data;
    };

    // retries for transient network / 5xx errors
    return pRetry(attempt, {
      retries: 3,
      factor: 2,
      minTimeout: 500
    });
  }
}
