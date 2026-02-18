import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { getUrbitContext, normalizeUrbitCookie } from "./context.js";

export type UrbitSseLogger = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

type UrbitSseOptions = {
  ship?: string;
  onReconnect?: (client: UrbitSSEClient) => Promise<void> | void;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  reconnectDelay?: number;
  maxReconnectDelay?: number;
  logger?: UrbitSseLogger;
};

export class UrbitSSEClient {
  url: string;
  cookie: string;
  ship: string;
  channelId: string;
  channelUrl: string;
  subscriptions: Array<{
    id: number;
    action: "subscribe";
    ship: string;
    app: string;
    path: string;
  }> = [];
  eventHandlers = new Map<
    number,
    { event?: (data: unknown) => void; err?: (error: unknown) => void; quit?: () => void }
  >();
  aborted = false;
  streamController: AbortController | null = null;
  onReconnect: UrbitSseOptions["onReconnect"] | null;
  autoReconnect: boolean;
  reconnectAttempts = 0;
  maxReconnectAttempts: number;
  reconnectDelay: number;
  maxReconnectDelay: number;
  isConnected = false;
  logger: UrbitSseLogger;

  // Event ack tracking - must ack every ~50 events to keep channel healthy
  private lastHeardEventId = -1;
  private lastAcknowledgedEventId = -1;
  private readonly ackThreshold = 20;

  constructor(url: string, cookie: string, options: UrbitSseOptions = {}) {
    const ctx = getUrbitContext(url, options.ship);
    this.url = ctx.baseUrl;
    this.cookie = normalizeUrbitCookie(cookie);
    this.ship = ctx.ship;
    this.channelId = `${Math.floor(Date.now() / 1000)}-${randomUUID()}`;
    this.channelUrl = new URL(`/~/channel/${this.channelId}`, this.url).toString();
    this.onReconnect = options.onReconnect ?? null;
    this.autoReconnect = options.autoReconnect !== false;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
    this.reconnectDelay = options.reconnectDelay ?? 1000;
    this.maxReconnectDelay = options.maxReconnectDelay ?? 30000;
    this.logger = options.logger ?? {};
  }

  async subscribe(params: {
    app: string;
    path: string;
    event?: (data: unknown) => void;
    err?: (error: unknown) => void;
    quit?: () => void;
  }) {
    const subId = this.subscriptions.length + 1;
    const subscription = {
      id: subId,
      action: "subscribe",
      ship: this.ship,
      app: params.app,
      path: params.path,
    } as const;

    this.subscriptions.push(subscription);
    this.eventHandlers.set(subId, { event: params.event, err: params.err, quit: params.quit });

    if (this.isConnected) {
      try {
        await this.sendSubscription(subscription);
      } catch (error) {
        const handler = this.eventHandlers.get(subId);
        handler?.err?.(error);
      }
    }
    return subId;
  }

  private async sendSubscription(subscription: {
    id: number;
    action: "subscribe";
    ship: string;
    app: string;
    path: string;
  }) {
    const response = await fetch(this.channelUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: this.cookie,
      },
      body: JSON.stringify([subscription]),
    });

    if (!response.ok && response.status !== 204) {
      const errorText = await response.text();
      throw new Error(`Subscribe failed: ${response.status} - ${errorText}`);
    }
  }

  async connect() {
    const createResp = await fetch(this.channelUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: this.cookie,
      },
      body: JSON.stringify(this.subscriptions),
    });

    if (!createResp.ok && createResp.status !== 204) {
      throw new Error(`Channel creation failed: ${createResp.status}`);
    }

    const pokeResp = await fetch(this.channelUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: this.cookie,
      },
      body: JSON.stringify([
        {
          id: Date.now(),
          action: "poke",
          ship: this.ship,
          app: "hood",
          mark: "helm-hi",
          json: "Opening API channel",
        },
      ]),
    });

    if (!pokeResp.ok && pokeResp.status !== 204) {
      throw new Error(`Channel activation failed: ${pokeResp.status}`);
    }

    await this.openStream();
    this.isConnected = true;
    this.reconnectAttempts = 0;
  }

  async openStream() {
    const response = await fetch(this.channelUrl, {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        Cookie: this.cookie,
      },
    });

    if (!response.ok) {
      throw new Error(`Stream connection failed: ${response.status}`);
    }

    this.processStream(response.body).catch((error) => {
      if (!this.aborted) {
        this.logger.error?.(`Stream error: ${String(error)}`);
        for (const { err } of this.eventHandlers.values()) {
          if (err) {
            err(error);
          }
        }
      }
    });
  }

  async processStream(body: ReadableStream<Uint8Array> | Readable | null) {
    if (!body) {
      return;
    }
    // @ts-expect-error - ReadableStream type variance issue between DOM and Node types
    const stream = body instanceof ReadableStream ? Readable.fromWeb(body) : body;
    let buffer = "";

    try {
      for await (const chunk of stream) {
        if (this.aborted) {
          break;
        }
        buffer += chunk.toString();
        let eventEnd;
        while ((eventEnd = buffer.indexOf("\n\n")) !== -1) {
          const eventData = buffer.substring(0, eventEnd);
          buffer = buffer.substring(eventEnd + 2);
          this.processEvent(eventData);
        }
      }
    } finally {
      if (!this.aborted && this.autoReconnect) {
        this.isConnected = false;
        this.logger.log?.("[SSE] Stream ended, attempting reconnection...");
        await this.attemptReconnect();
      }
    }
  }

  processEvent(eventData: string) {
    const lines = eventData.split("\n");
    let data: string | null = null;
    let eventId: number | null = null;

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        data = line.substring(6);
      }
      if (line.startsWith("id: ")) {
        eventId = parseInt(line.substring(4), 10);
      }
    }

    if (!data) {
      return;
    }

    // Track event ID and send ack if needed
    if (eventId !== null && !isNaN(eventId)) {
      if (eventId > this.lastHeardEventId) {
        this.lastHeardEventId = eventId;
        if (eventId - this.lastAcknowledgedEventId > this.ackThreshold) {
          this.ack(eventId).catch((err) => {
            this.logger.error?.(`Failed to ack event ${eventId}: ${String(err)}`);
          });
        }
      }
    }

    try {
      const parsed = JSON.parse(data) as { id?: number; json?: unknown; response?: string };

      if (parsed.response === "quit") {
        if (parsed.id) {
          const handlers = this.eventHandlers.get(parsed.id);
          if (handlers?.quit) {
            handlers.quit();
          }
        }
        return;
      }

      if (parsed.id && this.eventHandlers.has(parsed.id)) {
        const { event } = this.eventHandlers.get(parsed.id) ?? {};
        if (event && parsed.json) {
          event(parsed.json);
        }
      } else if (parsed.json) {
        for (const { event } of this.eventHandlers.values()) {
          if (event) {
            event(parsed.json);
          }
        }
      }
    } catch (error) {
      this.logger.error?.(`Error parsing SSE event: ${String(error)}`);
    }
  }

  private async ack(eventId: number): Promise<void> {
    this.lastAcknowledgedEventId = eventId;

    const ackData = {
      action: "ack",
      "event-id": eventId,
    };

    const response = await fetch(this.channelUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: this.cookie,
      },
      body: JSON.stringify([ackData]),
    });

    if (!response.ok && response.status !== 204) {
      throw new Error(`Ack failed: ${response.status}`);
    }

    this.logger.log?.(`[SSE] Acked event ${eventId}`);
  }

  async poke(params: { app: string; mark: string; json: unknown }) {
    const pokeId = Date.now();
    const pokeData = {
      id: pokeId,
      action: "poke",
      ship: this.ship,
      app: params.app,
      mark: params.mark,
      json: params.json,
    };

    const response = await fetch(this.channelUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Cookie: this.cookie,
      },
      body: JSON.stringify([pokeData]),
    });

    if (!response.ok && response.status !== 204) {
      const errorText = await response.text();
      throw new Error(`Poke failed: ${response.status} - ${errorText}`);
    }

    return pokeId;
  }

  async scry(path: string) {
    const scryUrl = `${this.url}/~/scry${path}`;
    const response = await fetch(scryUrl, {
      method: "GET",
      headers: {
        Cookie: this.cookie,
      },
    });

    if (!response.ok) {
      throw new Error(`Scry failed: ${response.status} for path ${path}`);
    }

    return await response.json();
  }

  async attemptReconnect() {
    if (this.aborted || !this.autoReconnect) {
      this.logger.log?.("[SSE] Reconnection aborted or disabled");
      return;
    }

    // Reset after max attempts with extended backoff, then continue trying forever
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.log?.(
        `[SSE] Max reconnection attempts (${this.maxReconnectAttempts}) reached. Will reset and retry after extended backoff...`,
      );
      // Wait 10 seconds before resetting and trying again
      const extendedBackoff = 10000; // 10 seconds
      await new Promise((resolve) => setTimeout(resolve, extendedBackoff));
      this.reconnectAttempts = 0; // Reset counter to continue trying
      this.logger.log?.("[SSE] Reconnection attempts reset, resuming reconnection...");
    }

    this.reconnectAttempts += 1;
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay,
    );

    this.logger.log?.(
      `[SSE] Reconnection attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms...`,
    );

    await new Promise((resolve) => setTimeout(resolve, delay));

    try {
      this.channelId = `${Math.floor(Date.now() / 1000)}-${randomUUID()}`;
      this.channelUrl = new URL(`/~/channel/${this.channelId}`, this.url).toString();

      if (this.onReconnect) {
        await this.onReconnect(this);
      }

      await this.connect();
      this.logger.log?.("[SSE] Reconnection successful!");
    } catch (error) {
      this.logger.error?.(`[SSE] Reconnection failed: ${String(error)}`);
      await this.attemptReconnect();
    }
  }

  async close() {
    this.aborted = true;
    this.isConnected = false;

    try {
      const unsubscribes = this.subscriptions.map((sub) => ({
        id: sub.id,
        action: "unsubscribe",
        subscription: sub.id,
      }));

      await fetch(this.channelUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Cookie: this.cookie,
        },
        body: JSON.stringify(unsubscribes),
      });

      await fetch(this.channelUrl, {
        method: "DELETE",
        headers: {
          Cookie: this.cookie,
        },
      });
    } catch (error) {
      this.logger.error?.(`Error closing channel: ${String(error)}`);
    }
  }
}
