import WebSocket from "ws";
import type { AgentP2PConfig, AgentP2PMessage } from "./types.js";

export type AgentP2PClientOptions = {
  config: AgentP2PConfig;
  onMessage?: (message: AgentP2PMessage) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Error) => void;
};

export class AgentP2PClient {
  private ws: WebSocket | null = null;
  private config: AgentP2PConfig;
  private options: AgentP2PClientOptions;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;

  constructor(options: AgentP2PClientOptions) {
    this.config = options.config;
    this.options = options;
  }

  async connect(): Promise<void> {
    const wsUrl = `${this.config.portalUrl.replace("https://", "wss://").replace("http://", "ws://")}/ws/agent`;
    
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsUrl, {
          headers: {
            "X-API-Key": this.config.apiKey,
          },
        });

        this.ws.on("open", () => {
          console.log(`[Agent P2P] Connected to ${this.config.portalUrl}`);
          this.options.onConnect?.();
          resolve();
        });

        this.ws.on("message", (data) => {
          try {
            const message = JSON.parse(data.toString()) as AgentP2PMessage;
            this.options.onMessage?.(message);
          } catch (err) {
            console.error("[Agent P2P] Failed to parse message:", err);
          }
        });

        this.ws.on("close", () => {
          console.log("[Agent P2P] Connection closed");
          this.options.onDisconnect?.();
          this.scheduleReconnect();
        });

        this.ws.on("error", (err) => {
          console.error("[Agent P2P] WebSocket error:", err);
          this.options.onError?.(err);
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    
    console.log("[Agent P2P] Reconnecting in 5 seconds...");
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((err) => {
        console.error("[Agent P2P] Reconnect failed:", err);
      });
    }, 5000);
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}

export function createAgentP2PClient(options: AgentP2PClientOptions): AgentP2PClient {
  return new AgentP2PClient(options);
}
