import WebSocket from "ws";
import type { AriBridge, AriChannel, AriEndpointState, AriConfig } from "./types.js";

export type AriEvent = {
  type: string;
  channel?: AriChannel;
  args?: string[];
  digit?: string;
};

export type AriWsHandler = (event: AriEvent) => void;

export class AriClient {
  private cfg: AriConfig;
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;

  constructor(cfg: AriConfig) {
    this.cfg = cfg;
  }

  async getEndpointState(resource: string): Promise<AriEndpointState> {
    return this.fetchJson<AriEndpointState>(`/endpoints/PJSIP/${encodeURIComponent(resource)}`);
  }

  async createChannel(params: {
    endpoint: string;
    app: string;
    appArgs?: string;
    callerId?: string;
  }): Promise<AriChannel> {
    return this.fetchJson<AriChannel>("/channels", {
      method: "POST",
      query: {
        endpoint: params.endpoint,
        app: params.app,
        appArgs: params.appArgs,
        callerId: params.callerId,
      },
    });
  }

  async createBridge(type: "mixing"): Promise<AriBridge> {
    return this.fetchJson<AriBridge>("/bridges", { method: "POST", query: { type } });
  }

  async listChannels(): Promise<AriChannel[]> {
    return this.fetchJson<AriChannel[]>("/channels");
  }

  async getBridge(bridgeId: string): Promise<AriBridge> {
    return this.fetchJson<AriBridge>(`/bridges/${encodeURIComponent(bridgeId)}`);
  }

  async getChannelVar(channelId: string, variable: string): Promise<string | null> {
    try {
      const res = await this.fetchJson<{ value?: string }>(
        `/channels/${encodeURIComponent(channelId)}/variable`,
        { method: "GET", query: { variable } },
      );
      return res?.value ?? null;
    } catch {
      return null;
    }
  }

  async addChannelToBridge(bridgeId: string, channelId: string): Promise<void> {
    await this.fetchJson(`/bridges/${encodeURIComponent(bridgeId)}/addChannel`, {
      method: "POST",
      query: { channel: channelId },
      allowEmpty: true,
    });
  }

  async addChannelsToBridge(bridgeId: string, channelIds: string[]): Promise<void> {
    await this.fetchJson(`/bridges/${encodeURIComponent(bridgeId)}/addChannel`, {
      method: "POST",
      query: { channel: channelIds.join(",") },
      allowEmpty: true,
    });
  }

  async createExternalMedia(params: {
    app: string;
    externalHost: string;
    format: "ulaw" | "alaw";
    direction?: "both" | "in" | "out";
    encapsulation?: "rtp" | "audiosocket";
    transport?: "udp" | "tcp";
  }): Promise<AriChannel> {
    return this.fetchJson<AriChannel>("/channels/externalMedia", {
      method: "POST",
      query: {
        app: params.app,
        external_host: params.externalHost,
        format: params.format,
        direction: params.direction,
        encapsulation: params.encapsulation,
        transport: params.transport,
      },
    });
  }

  async createSnoop(params: {
    app: string;
    channelId: string;
    spy: "in" | "out" | "both";
    whisper: "none" | "in" | "out" | "both";
    appArgs?: string;
  }): Promise<AriChannel> {
    return this.fetchJson<AriChannel>(`/channels/${encodeURIComponent(params.channelId)}/snoop`, {
      method: "POST",
      query: {
        app: params.app,
        spy: params.spy,
        whisper: params.whisper,
        appArgs: params.appArgs,
      },
    });
  }

  async deleteBridge(bridgeId: string): Promise<void> {
    await this.fetchJson(`/bridges/${encodeURIComponent(bridgeId)}`, {
      method: "DELETE",
      allowEmpty: true,
    });
  }

  async deleteChannel(channelId: string): Promise<void> {
    await this.fetchJson(`/channels/${encodeURIComponent(channelId)}`, {
      method: "DELETE",
      allowEmpty: true,
    });
  }

  async answerChannel(channelId: string): Promise<void> {
    await this.fetchJson(`/channels/${encodeURIComponent(channelId)}/answer`, {
      method: "POST",
      allowEmpty: true,
    });
  }

  async hangupChannel(channelId: string): Promise<void> {
    await this.fetchJson(`/channels/${encodeURIComponent(channelId)}/hangup`, {
      method: "POST",
      allowEmpty: true,
    });
  }

  private getHttpStatusFromError(err: unknown): number | null {
    if (!(err instanceof Error)) return null;
    const m = err.message.match(/ARI HTTP (\d{3})\b/);
    if (!m) return null;
    const code = Number(m[1]);
    return Number.isFinite(code) ? code : null;
  }

  async safeHangupChannel(channelId: string): Promise<void> {
    try {
      await this.hangupChannel(channelId);
      return;
    } catch (err) {
      const status = this.getHttpStatusFromError(err);
      if (status === 404) {
        // Channel is already gone. This happens naturally when the remote party hangs up before we
        // get a chance to send a hangup, and should not be treated as a warning.
        console.debug("[ari] hangup: channel already gone (404)", { channelId });
        return;
      }
      console.warn("[ari] hangup failed, falling back to delete", { channelId, err });
    }

    try {
      await this.deleteChannel(channelId);
    } catch (err) {
      const status = this.getHttpStatusFromError(err);
      if (status === 404) {
        console.debug("[ari] delete: channel already gone (404)", { channelId });
        return;
      }
      console.warn("[ari] delete channel failed", { channelId, err });
    }
  }

  connectWs(handler: AriWsHandler): void {
    if (this.ws) {
      return;
    }
    const wsUrl =
      this.cfg.baseUrl.replace(/^http/, "ws") +
      `/ari/events?app=${encodeURIComponent(this.cfg.app)}`;
    const ws = new WebSocket(wsUrl, {
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString("base64"),
      },
    });

    ws.onmessage = (evt) => {
      try {
        const data = JSON.parse(String(evt.data));
        handler(data as AriEvent);
      } catch {
        // ignore parse errors
      }
    };

    ws.onopen = () => {
      this.reconnectAttempts = 0;
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {}
    };

    ws.onclose = () => {
      this.ws = null;
      this.scheduleReconnect(handler);
    };

    this.ws = ws;
  }

  private scheduleReconnect(handler: AriWsHandler): void {
    if (this.reconnectTimer) return;
    const attempt = Math.min(this.reconnectAttempts, 5);
    const delay = 500 * Math.pow(2, attempt);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWs(handler);
    }, delay);
  }

  closeWs(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }

  private async fetchJson<T = unknown>(
    path: string,
    opts?: {
      method?: string;
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      allowEmpty?: boolean;
    },
  ): Promise<T> {
    const url = new URL(this.cfg.baseUrl.replace(/\/$/, "") + "/ari" + path);
    if (opts?.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }

    const res = await fetch(url.toString(), {
      method: opts?.method ?? "GET",
      headers: {
        Authorization:
          "Basic " + Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString("base64"),
        "Content-Type": "application/json",
      },
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`ARI HTTP ${res.status} ${res.statusText}${txt ? ": " + txt : ""}`);
    }

    const text = await res.text();
    if (!text) {
      if (opts?.allowEmpty) return undefined as T;
      throw new Error(`ARI HTTP ${res.status} ${res.statusText}: empty body`);
    }
    return JSON.parse(text) as T;
  }
}
