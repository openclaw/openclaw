import { EventEmitter } from "events";
import nkn from "nkn-sdk";
import { NKN_SEED_RPC_SERVERS, type NknConnectionState } from "./types.js";

export interface NknBusOptions {
  seed: string;
  numSubClients?: number;
}

/**
 * NKN MultiClient wrapper for D-Chat wire-format messaging.
 * Handles connect, send, receive, subscribe, and reconnection.
 */
export class NknBus extends EventEmitter {
  private client: nkn.MultiClient | null = null;
  private state: NknConnectionState = "disconnected";
  private address: string | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private seed: string | undefined;
  private numSubClients: number;
  private abortSignal: AbortSignal | undefined;

  constructor() {
    super();
    this.numSubClients = 4;
  }

  getState(): NknConnectionState {
    return this.state;
  }

  getAddress(): string | undefined {
    return this.address;
  }

  async connect(opts: NknBusOptions, abortSignal?: AbortSignal): Promise<string> {
    if (this.client) {
      await this.disconnect();
    }

    this.seed = opts.seed;
    this.numSubClients = opts.numSubClients ?? 4;
    this.abortSignal = abortSignal;
    this.setState("connecting");

    try {
      this.client = new nkn.MultiClient({
        seed: opts.seed,
        numSubClients: this.numSubClients,
        originalClient: false,
        rpcServerAddr: NKN_SEED_RPC_SERVERS[0],
      });

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("NKN connection timeout after 30s"));
        }, 30000);

        if (abortSignal?.aborted) {
          clearTimeout(timeout);
          reject(new Error("Aborted"));
          return;
        }

        const onAbort = () => {
          clearTimeout(timeout);
          reject(new Error("Aborted"));
        };
        abortSignal?.addEventListener("abort", onAbort, { once: true });

        this.client!.onConnect(() => {
          clearTimeout(timeout);
          abortSignal?.removeEventListener("abort", onAbort);
          resolve();
        });
      });

      this.address = this.client.addr;
      this.setState("connected");

      // Register message handler: src may include __N__. sub-client prefix; caller should normalize
      this.client.onMessage(({ src, payload }: { src: string; payload: Uint8Array | string }) => {
        let data: string;
        if (payload instanceof Uint8Array) {
          data = new TextDecoder().decode(payload);
        } else {
          data = payload;
        }
        this.emit("message", src, data);
      });

      return this.address;
    } catch (err) {
      this.setState("disconnected");
      if (this.client) {
        try {
          this.client.close();
        } catch {
          // ignore close errors during cleanup
        }
        this.client = null;
      }
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      try {
        this.client.close();
      } catch {
        // ignore close errors
      }
      this.client = null;
    }
    this.address = undefined;
    this.setState("disconnected");
  }

  /**
   * Send a message and wait for recipient ACK.
   * Used for direct text messages.
   */
  async send(dest: string, payload: string): Promise<void> {
    this.ensureConnected();
    await this.client!.send(dest, payload, {
      msgHoldingSeconds: 3600,
    });
  }

  /**
   * Send without waiting for ACK (fire-and-forget).
   * Used for media messages and topic broadcasts.
   */
  sendNoReply(dest: string, payload: string): void {
    this.ensureConnected();
    this.client!.send(dest, payload, {
      noReply: true,
      msgHoldingSeconds: 3600,
    });
  }

  /**
   * Send to multiple destinations (topic broadcast).
   * Fire-and-forget.
   */
  sendToMultiple(dests: string[], payload: string): void {
    this.ensureConnected();
    if (dests.length === 0) return;
    this.client!.send(dests, payload, {
      noReply: true,
      msgHoldingSeconds: 3600,
    });
  }

  /** Subscribe to a topic on the NKN blockchain. */
  async subscribe(topicHash: string, duration = 400000, fee = "0"): Promise<string> {
    this.ensureConnected();
    const txnHash = await this.client!.subscribe(topicHash, duration, "", "", {
      fee,
      attrs: undefined,
      buildOnly: undefined,
    } as nkn.TransactionOptions);
    return String(txnHash);
  }

  /** Unsubscribe from a topic. */
  async unsubscribe(topicHash: string, fee = "0"): Promise<string> {
    this.ensureConnected();
    const txnHash = await this.client!.unsubscribe(topicHash, "", {
      fee,
      attrs: undefined,
      buildOnly: undefined,
    } as nkn.TransactionOptions);
    return String(txnHash);
  }

  /** Fetch subscriber addresses for a topic. */
  async getSubscribers(topicHash: string): Promise<string[]> {
    this.ensureConnected();
    const result = await this.client!.getSubscribers(topicHash, {
      offset: 0,
      limit: 1000,
      txPool: true,
    });
    const subs = result.subscribers;
    if (Array.isArray(subs)) {
      return subs;
    }
    // Record<string, string> form — keys are addresses
    return Object.keys(subs);
  }

  /** Register a handler for incoming NKN messages. */
  onMessage(handler: (src: string, data: string) => void): void {
    this.on("message", handler);
  }

  private ensureConnected(): void {
    if (!this.client || this.state !== "connected") {
      throw new Error("NKN client not connected");
    }
  }

  private setState(next: NknConnectionState): void {
    this.state = next;
    this.emit("stateChange", next);
  }
}
