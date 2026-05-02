import type { TelegramTransport } from "./fetch.js";

type TelegramPollingTransportStateOpts = {
  log: (line: string) => void;
  initialTransport?: TelegramTransport;
  createTelegramTransport?: () => TelegramTransport;
};

export class TelegramPollingTransportState {
  #telegramTransport: TelegramTransport | undefined;
  #transportDirty = false;
  #disposed = false;

  constructor(private readonly opts: TelegramPollingTransportStateOpts) {
    this.#telegramTransport = opts.initialTransport;
  }

  markDirty() {
    this.#transportDirty = true;
  }

  async acquireForNextCycle(): Promise<TelegramTransport | undefined> {
    if (this.#disposed) {
      return undefined;
    }
    const previous = this.#telegramTransport;
    const shouldCreateTransport = this.#transportDirty || !previous;
    const nextTransport = shouldCreateTransport
      ? (this.opts.createTelegramTransport?.() ?? previous)
      : previous;
    // When the dirty flag triggered a rebuild, release the old transport's
    // dispatchers before using the replacement transport. Without this, the
    // stale keep-alive socket may still be considered the active poll session
    // by Telegram while a new getUpdates request races in on a fresh socket.
    if (this.#transportDirty && previous && nextTransport !== previous) {
      this.opts.log("[telegram][diag] closing stale transport before rebuild");
      try {
        await previous.close();
      } catch (err) {
        this.opts.log(
          `[telegram][diag] failed to close stale transport before rebuild: ${formatCloseError(err)}`,
        );
      }
    }
    if (this.#transportDirty && nextTransport) {
      this.opts.log("[telegram][diag] rebuilding transport for next polling cycle");
    }
    this.#telegramTransport = nextTransport;
    this.#transportDirty = false;
    return nextTransport;
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    const transport = this.#telegramTransport;
    this.#telegramTransport = undefined;
    if (!transport) {
      return;
    }
    try {
      await transport.close();
    } catch (err) {
      this.opts.log(
        `[telegram][diag] failed to close transport during dispose: ${formatCloseError(err)}`,
      );
    }
  }
}

function formatCloseError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
