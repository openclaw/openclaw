import type { TelegramTransport } from "./fetch.js";

type TelegramPollingTransportStateOpts = {
  log: (line: string) => void;
  initialTransport?: TelegramTransport;
  createTelegramTransport?: () => TelegramTransport;
};

export class TelegramPollingTransportState {
  #telegramTransport: TelegramTransport | undefined;
  #transportDirty = false;

  constructor(private readonly opts: TelegramPollingTransportStateOpts) {
    this.#telegramTransport = opts.initialTransport;
  }

  markDirty() {
    this.#transportDirty = true;
  }

  /** Returns the current transport without rebuilding (read-only access for heartbeat). */
  currentTransport(): TelegramTransport | undefined {
    return this.#telegramTransport;
  }

  acquireForNextCycle(): TelegramTransport | undefined {
    const shouldCreateTransport = this.#transportDirty || !this.#telegramTransport;
    const nextTransport = shouldCreateTransport
      ? (this.opts.createTelegramTransport?.() ?? this.#telegramTransport)
      : this.#telegramTransport;
    if (this.#transportDirty && nextTransport) {
      this.opts.log("[telegram][diag] rebuilding transport for next polling cycle");
    }
    this.#telegramTransport = nextTransport;
    this.#transportDirty = false;
    return nextTransport;
  }
}
