import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
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

  acquireForNextCycle(): TelegramTransport | undefined {
    if (this.#disposed) {
      return undefined;
    }
    const previous = this.#telegramTransport;
    const nextTransport =
      this.#transportDirty || !previous
        ? (this.opts.createTelegramTransport?.() ?? previous)
        : previous;
    // When the dirty flag triggered a rebuild, release the old transport's
    // dispatchers. Without this, each network stall / recoverable error
    // leaves a full pool of keep-alive sockets to api.telegram.org dangling
    // forever — which over long-running sessions accumulates into the
    // hundreds of ESTABLISHED connections that choke per-IP upstream quotas.
    if (this.#transportDirty && previous && nextTransport !== previous) {
      this.opts.log("[telegram][diag] closing stale transport before rebuild");
      void previous.close().catch((err: unknown) => {
        this.opts.log(
          `[telegram][diag] failed to close transport (stale-transport rebuild): ${formatErrorMessage(err)}`,
        );
      });
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
        `[telegram][diag] failed to close transport during dispose: ${formatErrorMessage(err)}`,
      );
    }
  }
}
