/** Request chunks stay outside the stream's internal queue so their byte budget is explicit. */
export class UiRequestBody {
  readonly stream: ReadableStream<Uint8Array>;
  readonly #chunks: Uint8Array[] = [];
  readonly #reserve: (bytes: number) => void;
  readonly #release: (bytes: number) => void;
  #wake?: () => void;
  #ended = false;
  #error?: Error;

  constructor(reserve: (bytes: number) => void, release: (bytes: number) => void) {
    this.#reserve = reserve;
    this.#release = release;
    this.stream = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          if (!this.#chunks.length && !this.#ended) {
            await new Promise<void>((resolve) => {
              this.#wake = resolve;
            });
          }
          if (this.#error) {
            controller.error(this.#error);
            return;
          }
          const chunk = this.#chunks.shift();
          if (chunk) {
            this.#release(chunk.byteLength + 64);
            controller.enqueue(chunk);
          } else if (this.#ended) {
            controller.close();
          }
        },
        cancel: () => this.discard(),
      },
      { highWaterMark: 0 },
    );
  }

  push(bytes: Uint8Array, more: boolean): void {
    if (this.#ended) {
      throw new Error("HTTP request body is already complete");
    }
    if (bytes.byteLength) {
      this.#reserve(bytes.byteLength + 64);
      this.#chunks.push(bytes);
    }
    this.#ended = !more;
    this.#wake?.();
    this.#wake = undefined;
  }

  discard(error?: Error): void {
    for (const chunk of this.#chunks) {
      this.#release(chunk.byteLength + 64);
    }
    this.#chunks.length = 0;
    this.#ended = true;
    this.#error = error;
    this.#wake?.();
    this.#wake = undefined;
  }
}
