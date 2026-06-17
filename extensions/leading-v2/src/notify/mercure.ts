import type { PluginLogger } from "../../api.js";

export interface MercureConfig {
  hubUrl: string;
  jwtSecret: string;
}

/**
 * Minimal Mercure publisher for proactive chat delivery in the web-frontend
 * deployment (no gateway channels). Mirrors the rabbitmq-consumer plugin's chat
 * push: a `{type:"text"}` event (historyId optional) on the user's topic, then a
 * `{type:"done"}`. Self-contained per the extension boundary (no cross-extension import).
 */
export class MercurePusher {
  constructor(
    private readonly config: MercureConfig,
    private readonly logger?: PluginLogger,
  ) {}

  /**
   * Publish a generic `notification` event to the user's topic. The web frontend
   * renders this however it likes (chat bubble / toast) via a single new handler;
   * see plan-notifier-delivery.md §3.1 for the contract.
   */
  async sendNotification(topic: string, data: Record<string, unknown>): Promise<boolean> {
    return this.send(topic, { type: "notification", ...data });
  }

  private async send(topic: string, data: Record<string, unknown>): Promise<boolean> {
    const token = await this.publisherJwt();
    const body = new URLSearchParams({ topic, data: JSON.stringify(data) });
    const res = await fetch(this.config.hubUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`Mercure push failed: ${res.status} ${res.statusText}`);
    }
    return true;
  }

  /** HS256 publisher JWT — same scheme as the report-generator/rabbitmq-consumer plugins. */
  private async publisherJwt(): Promise<string> {
    const enc = new TextEncoder();
    const header = this.b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
    const payload = this.b64url(enc.encode(JSON.stringify({ mercure: { publish: ["*"] } })));
    const signingInput = `${header}.${payload}`;
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(this.config.jwtSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signingInput));
    return `${signingInput}.${this.b64url(new Uint8Array(sig))}`;
  }

  private b64url(data: Uint8Array): string {
    let binary = "";
    for (const byte of data) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
}

/** Resolve Mercure config from plugin config or env; undefined when not configured. */
export function resolveMercureConfig(pluginConfig: Record<string, unknown>): MercureConfig | undefined {
  const block = pluginConfig.mercure as Record<string, unknown> | undefined;
  const hubUrl = (block?.hubUrl as string) ?? process.env.MERCURE_HUB_URL ?? "";
  const jwtSecret = (block?.jwtSecret as string) ?? process.env.MERCURE_JWT_SECRET ?? "";
  if (!hubUrl || !jwtSecret) {
    return undefined;
  }
  return { hubUrl, jwtSecret };
}
