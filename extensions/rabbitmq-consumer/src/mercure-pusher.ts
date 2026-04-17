import type { MercureConfig } from "./types.js";

/**
 * Mercure Hub push client.
 *
 * Ported from Python mercure_manager.py MercureManager.
 * Uses Node.js native fetch() to POST to the Mercure Hub.
 */
export class MercurePusher {
  private readonly hubUrl: string;
  private readonly jwtSecret: string;

  constructor(config: MercureConfig) {
    this.hubUrl = config.hubUrl;
    this.jwtSecret = config.jwtSecret;
  }

  /**
   * Generate a publisher JWT token (HS256).
   * Uses the Web Crypto API available in Node 22+.
   */
  private async generatePublisherJwt(): Promise<string> {
    const encoder = new TextEncoder();

    const header = encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = encoder.encode(
      JSON.stringify({ mercure: { publish: ["*"] } }),
    );

    const headerB64 = this.base64UrlEncode(header);
    const payloadB64 = this.base64UrlEncode(payload);
    const signingInput = `${headerB64}.${payloadB64}`;

    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(this.jwtSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );

    const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
    const signatureB64 = this.base64UrlEncode(new Uint8Array(signature));

    return `${signingInput}.${signatureB64}`;
  }

  private base64UrlEncode(data: Uint8Array | ArrayBuffer): string {
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /** Push a text chunk (typewriter effect) */
  async pushText(topic: string, content: string): Promise<boolean> {
    return this.sendToMercure(topic, { type: "text", content });
  }

  /** Push a done signal (frontend stops animation) */
  async pushDone(topic: string): Promise<boolean> {
    return this.sendToMercure(topic, { type: "done" });
  }

  /** Push an error signal */
  async pushError(topic: string, error: string): Promise<boolean> {
    return this.sendToMercure(topic, { type: "error", error });
  }

  private async sendToMercure(
    topic: string,
    data: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      const token = await this.generatePublisherJwt();

      const params = new URLSearchParams();
      params.set("topic", topic);
      params.set("data", JSON.stringify(data));

      const response = await fetch(this.hubUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: params.toString(),
        signal: AbortSignal.timeout(30_000),
      });

      return response.ok;
    } catch {
      return false;
    }
  }
}
