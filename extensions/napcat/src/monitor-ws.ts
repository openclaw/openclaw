import { WebSocket } from "ws";
import type { ChannelAccountSnapshot, OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk";
import { processNapCatEvent } from "./inbound.js";
import type { OneBotMessageEvent, ResolvedNapCatAccount } from "./types.js";

export type NapCatWsMonitorOptions = {
  account: ResolvedNapCatAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  statusSink?: (patch: Partial<ChannelAccountSnapshot>) => void;
};

export type NapCatWsMonitorHandle = {
  stop: () => void;
};

export function startNapCatWsMonitor(options: NapCatWsMonitorOptions): NapCatWsMonitorHandle {
  let ws: WebSocket | null = null;
  let stopped = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const controlsConnectivity = !options.account.transport.http.enabled;

  const clearTimer = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (stopped) {
      return;
    }
    clearTimer();
    reconnectTimer = setTimeout(connect, options.account.transport.ws.reconnectMs);
  };

  const connect = () => {
    if (stopped) {
      return;
    }
    if (!options.account.transport.ws.url.trim()) {
      options.runtime.error?.("[napcat] WebSocket url is empty");
      return;
    }
    if (!options.account.token) {
      options.runtime.error?.("[napcat] WebSocket token is missing");
      return;
    }

    try {
      ws = new WebSocket(options.account.transport.ws.url, {
        headers: {
          authorization: `Bearer ${options.account.token}`,
          "x-access-token": options.account.token,
        },
      });
    } catch (err) {
      reconnectAttempts += 1;
      options.statusSink?.({
        ...(controlsConnectivity ? { connected: false } : {}),
        reconnectAttempts,
        lastError: String(err),
      });
      scheduleReconnect();
      return;
    }

    ws.on("open", () => {
      reconnectAttempts = 0;
      options.statusSink?.({
        ...(controlsConnectivity ? { connected: true } : {}),
        reconnectAttempts: 0,
        lastConnectedAt: Date.now(),
        lastError: null,
      });
    });

    ws.on("message", (data) => {
      const payloadText = Buffer.isBuffer(data) ? data.toString("utf-8") : String(data);
      let parsed: unknown;
      try {
        parsed = JSON.parse(payloadText);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      const event = parsed as OneBotMessageEvent;
      void processNapCatEvent({
        event,
        account: options.account,
        config: options.config,
        runtime: options.runtime,
        statusSink: options.statusSink,
      }).catch((err) => {
        options.runtime.error?.(`[napcat] inbound ws processing failed: ${String(err)}`);
      });
    });

    ws.on("error", (err) => {
      options.statusSink?.({
        lastError: String(err),
      });
      options.runtime.error?.(`[napcat] ws error: ${String(err)}`);
    });

    ws.on("close", (code, reason) => {
      const reasonText =
        typeof reason === "string"
          ? reason
          : Buffer.isBuffer(reason)
            ? reason.toString("utf-8")
            : "";
      options.statusSink?.({
        ...(controlsConnectivity ? { connected: false } : {}),
        lastDisconnect: {
          at: Date.now(),
          status: code,
          error: reasonText || undefined,
        },
      });
      ws = null;
      if (!stopped) {
        reconnectAttempts += 1;
        options.statusSink?.({ reconnectAttempts });
        scheduleReconnect();
      }
    });
  };

  connect();

  return {
    stop: () => {
      stopped = true;
      clearTimer();
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore shutdown close errors
        }
      }
      ws = null;
      if (controlsConnectivity) {
        options.statusSink?.({ connected: false });
      }
    },
  };
}
