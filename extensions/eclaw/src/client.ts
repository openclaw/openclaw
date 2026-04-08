/**
 * HTTP client for the E-Claw Channel API.
 *
 * Ported from the standalone @eclaw/openclaw-channel npm package
 * (https://github.com/HankHuang0516/openclaw-channel-eclaw).
 *
 * Handles all communication between the OpenClaw plugin and the E-Claw
 * backend: callback registration, entity slot binding, outbound messages,
 * and entity-to-entity messaging.
 *
 * Response validation (sendMessage / speakTo) is strict: a non-2xx HTTP
 * status or a `{success:false}` JSON body throws with a diagnostic
 * snippet of the upstream body (capped at 200 chars). This is required
 * by the channel plugin reply contract — the dispatcher treats a
 * resolved outbound call as a successful delivery, so silently-swallowed
 * failures become undetected message loss. See PR #62934 review round 3
 * (codex `sendMessage` / `speakTo` P2 items) and
 * `docs/plugins/sdk-channel-plugins.md` §"Reply pipeline".
 *
 * Doc references (OpenClaw repo):
 *   - docs/plugins/sdk-channel-plugins.md §"Reply pipeline" —
 *     outbound delivery errors must surface as rejected promises so the
 *     dispatcher's `onError` hook runs.
 *   - docs/plugins/architecture.md §"Channel boundary" — clients
 *     live inside the extension package; core never calls HTTP on
 *     behalf of a channel.
 */

import type {
  EclawBindResponse,
  EclawMessageResponse,
  EclawRegisterResponse,
  ResolvedEclawAccount,
} from "./types.js";

export interface EclawClientState {
  deviceId: string | null;
  botSecret: string | null;
  entityId: number | undefined;
}

/**
 * Best-effort capture of an upstream error body for diagnostic messages.
 * Caps at 200 chars so stack traces stay readable even for HTML error pages.
 */
async function readErrorSnippet(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) {
      return "";
    }
    const trimmed = text.replaceAll(/\s+/gu, " ").trim().slice(0, 200);
    return trimmed ? `: ${trimmed}` : "";
  } catch {
    return "";
  }
}

export class EclawClient {
  readonly #apiBase: string;
  readonly #apiKey: string;
  readonly #state: EclawClientState = {
    deviceId: null,
    botSecret: null,
    entityId: undefined,
  };

  constructor(account: Pick<ResolvedEclawAccount, "apiBase" | "apiKey">) {
    this.#apiBase = account.apiBase;
    this.#apiKey = account.apiKey;
  }

  get state(): Readonly<EclawClientState> {
    return this.#state;
  }

  /** Register callback URL with E-Claw backend. */
  async registerCallback(
    callbackUrl: string,
    callbackToken: string,
  ): Promise<EclawRegisterResponse> {
    const res = await fetch(`${this.#apiBase}/api/channel/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel_api_key: this.#apiKey,
        callback_url: callbackUrl,
        callback_token: callbackToken,
      }),
    });

    const data = (await res.json()) as EclawRegisterResponse;
    if (!data.success) {
      throw new Error(data.message || `E-Claw register failed (HTTP ${res.status})`);
    }

    this.#state.deviceId = data.deviceId;
    return data;
  }

  /**
   * Bind an entity slot via channel API.
   * When `entityId` is omitted, the backend auto-selects the first free slot.
   */
  async bindEntity(
    entityId?: number,
    name?: string,
  ): Promise<EclawBindResponse> {
    const body: Record<string, unknown> = { channel_api_key: this.#apiKey };
    if (entityId !== undefined) {
      body.entityId = entityId;
    }
    if (name) {
      body.name = name;
    }

    const res = await fetch(`${this.#apiBase}/api/channel/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = (await res.json()) as EclawBindResponse;
    if (!data.success) {
      if (res.status === 409 && data.entities) {
        const list = data.entities
          .map(
            (e) =>
              `  slot ${e.entityId} (${e.character})${e.name ? ` "${e.name}"` : ""}`,
          )
          .join("\n");
        throw new Error(
          `${data.message ?? "E-Claw slots full"}\nCurrent entities:\n${list}\n` +
            "Add entityId to your channel config to target a specific slot after unbinding it.",
        );
      }
      throw new Error(data.message || `E-Claw bind failed (HTTP ${res.status})`);
    }

    this.#state.botSecret = data.botSecret;
    this.#state.deviceId = data.deviceId;
    this.#state.entityId = data.entityId;
    return data;
  }

  /** Send a bot message to the user that owns the current entity. */
  async sendMessage(
    message: string,
    state = "IDLE",
    mediaType?: string,
    mediaUrl?: string,
  ): Promise<EclawMessageResponse> {
    const { deviceId, botSecret, entityId } = this.#state;
    if (!deviceId || !botSecret) {
      throw new Error("E-Claw client not bound — call bindEntity() first");
    }

    const res = await fetch(`${this.#apiBase}/api/channel/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel_api_key: this.#apiKey,
        deviceId,
        entityId,
        botSecret,
        message,
        state,
        ...(mediaType ? { mediaType } : {}),
        ...(mediaUrl ? { mediaUrl } : {}),
      }),
    });

    if (!res.ok) {
      const snippet = await readErrorSnippet(res);
      throw new Error(
        `E-Claw sendMessage failed (HTTP ${res.status})${snippet}`,
      );
    }

    const data = (await res.json()) as EclawMessageResponse;
    if (!data.success) {
      throw new Error(
        data.message || `E-Claw sendMessage rejected (HTTP ${res.status})`,
      );
    }
    return data;
  }

  /** Bot-to-bot message to another entity on the same device. */
  async speakTo(
    toEntityId: number,
    text: string,
    expectsReply = false,
  ): Promise<void> {
    const { deviceId, botSecret, entityId } = this.#state;
    if (!deviceId || !botSecret) {
      throw new Error("E-Claw client not bound — call bindEntity() first");
    }

    const res = await fetch(`${this.#apiBase}/api/entity/speak-to`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deviceId,
        fromEntityId: entityId,
        toEntityId,
        botSecret,
        text,
        expects_reply: expectsReply,
      }),
    });

    if (!res.ok) {
      const snippet = await readErrorSnippet(res);
      throw new Error(
        `E-Claw speakTo failed (HTTP ${res.status})${snippet}`,
      );
    }

    // speakTo returns { success: boolean, message?: string } on the happy path;
    // if the backend signals a rejection via success=false even on HTTP 200,
    // treat it as a delivery failure so the dispatcher can report it. An
    // empty 2xx body is tolerated (treated as success).
    let data: { success?: boolean; message?: string } | null = null;
    try {
      data = (await res.json()) as { success?: boolean; message?: string };
    } catch {
      // Empty / non-JSON body on a 2xx response: treat as success.
      return;
    }
    if (data?.success === false) {
      throw new Error(
        data.message || `E-Claw speakTo rejected (HTTP ${res.status})`,
      );
    }
  }

  /** Unregister this callback on shutdown. Best-effort. */
  async unregisterCallback(): Promise<void> {
    try {
      await fetch(`${this.#apiBase}/api/channel/register`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_api_key: this.#apiKey }),
      });
    } catch {
      /* best-effort */
    }
  }
}
