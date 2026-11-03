import { UiTunnelError } from "./ui-tunnel-protocol.js";

export class UiRequestBody {
  readonly stream: ReadableStream<Uint8Array>;
  readonly #controller: ReadableStreamDefaultController<Uint8Array>;
  #receivedBytes = 0;
  #ended = false;
  #hasBody = false;

  constructor() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    this.stream = new ReadableStream<Uint8Array>({
      start: (value) => {
        controller = value;
      },
      cancel: () => {
        this.#ended = true;
      },
    });
    this.#controller = controller;
  }

  get hasBody(): boolean {
    return this.#hasBody;
  }

  push(bytes: Uint8Array, more: boolean): void {
    if (this.#ended) {
      throw new UiTunnelError("invalid", "The HTTP request body is already complete.");
    }
    this.#receivedBytes += bytes.byteLength;
    if (this.#receivedBytes > 100 * 1024 * 1024) {
      throw new UiTunnelError("limit_exceeded", "HTTP request bodies must not exceed 100 MiB.");
    }
    this.#hasBody ||= bytes.byteLength > 0 || more;
    if (bytes.byteLength) {
      this.#controller.enqueue(bytes);
    }
    if (!more) {
      this.#ended = true;
      this.#controller.close();
    }
  }

  discard(error: Error): void {
    if (!this.#ended) {
      this.#ended = true;
      this.#controller.error(error);
    }
  }
}
