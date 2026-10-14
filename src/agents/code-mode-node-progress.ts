import type { CodeModeOutputSource } from "./code-mode-json.js";

// One task owns this bounded prefix. The host reads it only after Worker termination.
// Alternate headers publish complete entries even if termination interrupts an append.
const HEADER_BYTES = 64;
export class CodeModeNodeProgress {
  readonly buffer: SharedArrayBuffer;
  private readonly state: Int32Array;
  private readonly headers: DataView;
  private readonly bytes: Buffer;

  constructor(buffer: SharedArrayBuffer | number) {
    this.buffer =
      typeof buffer === "number" ? new SharedArrayBuffer(HEADER_BYTES + buffer) : buffer;
    this.state = new Int32Array(this.buffer, 0, 2);
    this.headers = new DataView(this.buffer);
    this.bytes = Buffer.from(this.buffer, HEADER_BYTES);
  }

  get deadline(): number {
    return this.headers.getFloat64(56);
  }

  set deadline(value: number) {
    this.headers.setFloat64(56, value);
  }

  get networkContentObserved(): boolean {
    return Atomics.load(this.state, 1) === 1;
  }

  observeNetworkContent(): void {
    Atomics.store(this.state, 1, 1);
  }

  append(json: string): void {
    const active = Atomics.load(this.state, 0);
    const [count, originalBytes, length] = this.header(active);
    const part = (count === 0 ? "[" : ",") + json;
    const total = originalBytes + Buffer.byteLength(part);
    const written = originalBytes === length ? this.bytes.write(part, length) : 0;
    const next = 8 + (1 - active) * 24;
    this.headers.setFloat64(next, count + 1);
    this.headers.setFloat64(next + 8, total);
    this.headers.setFloat64(next + 16, length + written);
    Atomics.store(this.state, 0, 1 - active);
  }

  resetOutput(): void {
    const next = 1 - Atomics.load(this.state, 0);
    for (let field = 0; field < 3; field++) {
      this.headers.setFloat64(8 + next * 24 + field * 8, 0);
    }
    Atomics.store(this.state, 0, next);
  }

  output(): CodeModeOutputSource {
    const [count, originalBytes, length] = this.header(Atomics.load(this.state, 0));
    const json = count === 0 ? "[]" : this.bytes.toString("utf8", 0, length);
    return {
      count,
      source:
        count === 0 || originalBytes + 1 <= this.bytes.length
          ? { kind: "complete", json: count === 0 ? json : json + "]" }
          : { kind: "prefix", json, originalBytes: originalBytes + 1 },
    };
  }

  private header(index: number) {
    const offset = 8 + index * 24;
    return [
      this.headers.getFloat64(offset),
      this.headers.getFloat64(offset + 8),
      this.headers.getFloat64(offset + 16),
    ] as const;
  }
}
