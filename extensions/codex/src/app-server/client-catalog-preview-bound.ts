import { SESSION_PREVIEW_PREFIX_LENGTH } from "../session-catalog-parsing.js";

type ObjectFrame = {
  kind: "object";
  expect: "key" | "colon" | "value" | "comma";
  lastKey?: string;
};
type ArrayFrame = {
  kind: "array";
  expect: "value" | "comma";
};
type Frame = ObjectFrame | ArrayFrame;

/** Truncate native `preview` strings before JSON.parse so catalog pages stay bounded. */
export class CodexCatalogPreviewBounder {
  private inString = false;
  private escape = false;
  private unicodeLeft = 0;
  private capturingKey = false;
  private currentKey = "";
  private previewValue = false;
  private previewChars = 0;
  private skipping = false;
  private readonly stack: Frame[] = [];

  constructor(private readonly maxPreviewChars = SESSION_PREVIEW_PREFIX_LENGTH) {}

  get isSkipping(): boolean {
    return this.skipping;
  }

  reset(): void {
    this.inString = false;
    this.escape = false;
    this.unicodeLeft = 0;
    this.capturingKey = false;
    this.currentKey = "";
    this.previewValue = false;
    this.previewChars = 0;
    this.skipping = false;
    this.stack.length = 0;
  }

  push(chunk: string): string {
    if (!chunk) {
      return chunk;
    }
    const kept: string[] = [];
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      const character = chunk[index]!;
      if (this.skipping) {
        if (this.consumeEscape(character)) {
          continue;
        }
        if (character === "\\") {
          this.escape = true;
          continue;
        }
        if (character === '"') {
          this.finishString();
          start = index;
        }
        continue;
      }
      if (this.inString) {
        if (this.consumeEscape(character)) {
          if (this.capturingKey) {
            this.currentKey += character;
          } else if (this.notePreviewChar(chunk, start, index, kept)) {
            start = chunk.length;
          }
          continue;
        }
        if (character === "\\") {
          this.escape = true;
          if (this.capturingKey) {
            this.currentKey += character;
          } else if (this.notePreviewChar(chunk, start, index, kept, false)) {
            start = chunk.length;
          }
          continue;
        }
        if (character === '"') {
          this.finishString();
          continue;
        }
        if (this.capturingKey) {
          this.currentKey += character;
        } else if (this.notePreviewChar(chunk, start, index, kept)) {
          start = chunk.length;
        }
        continue;
      }
      if (character === '"') {
        this.beginString();
        continue;
      }
      if (character === "{") {
        this.finishValue();
        this.stack.push({ kind: "object", expect: "key" });
        continue;
      }
      if (character === "[") {
        this.finishValue();
        this.stack.push({ kind: "array", expect: "value" });
        continue;
      }
      if (character === "}") {
        if (this.stack.at(-1)?.kind === "object") {
          this.stack.pop();
        }
        this.afterValue();
        continue;
      }
      if (character === "]") {
        if (this.stack.at(-1)?.kind === "array") {
          this.stack.pop();
        }
        this.afterValue();
        continue;
      }
      if (character === ":") {
        const frame = this.stack.at(-1);
        if (frame?.kind === "object" && frame.expect === "colon") {
          frame.expect = "value";
        }
        continue;
      }
      if (character === ",") {
        const frame = this.stack.at(-1);
        if (frame) {
          frame.expect = frame.kind === "object" ? "key" : "value";
          if (frame.kind === "object") {
            frame.lastKey = undefined;
          }
        }
        continue;
      }
    }
    if (start < chunk.length && !this.skipping) {
      kept.push(chunk.slice(start));
    }
    return kept.join("");
  }

  private beginString(): void {
    const frame = this.stack.at(-1);
    this.inString = true;
    this.escape = false;
    this.unicodeLeft = 0;
    this.capturingKey = frame?.kind === "object" && frame.expect === "key";
    this.currentKey = "";
    this.previewValue =
      frame?.kind === "object" && frame.expect === "value" && frame.lastKey === "preview";
    this.previewChars = 0;
    this.skipping = false;
  }

  private finishString(): void {
    const frame = this.stack.at(-1);
    this.inString = false;
    this.escape = false;
    this.unicodeLeft = 0;
    this.skipping = false;
    if (this.capturingKey && frame?.kind === "object") {
      frame.lastKey = this.currentKey;
      frame.expect = "colon";
    } else {
      this.afterValue();
    }
    this.capturingKey = false;
    this.currentKey = "";
    this.previewValue = false;
    this.previewChars = 0;
  }

  private finishValue(): void {
    const frame = this.stack.at(-1);
    if (frame?.expect === "value") {
      frame.expect = "comma";
      if (frame.kind === "object") {
        frame.lastKey = undefined;
      }
    }
  }

  private afterValue(): void {
    const frame = this.stack.at(-1);
    if (!frame) {
      return;
    }
    frame.expect = "comma";
    if (frame.kind === "object") {
      frame.lastKey = undefined;
    }
  }

  private notePreviewChar(
    chunk: string,
    start: number,
    index: number,
    kept: string[],
    includeCurrent = true,
  ): boolean {
    if (!this.previewValue) {
      return false;
    }
    this.previewChars++;
    if (this.previewChars < this.maxPreviewChars || this.escape || this.unicodeLeft > 0) {
      return false;
    }
    kept.push(chunk.slice(start, includeCurrent ? index + 1 : index));
    this.skipping = true;
    return true;
  }

  private consumeEscape(character: string): boolean {
    if (this.unicodeLeft > 0) {
      this.unicodeLeft--;
      if (this.unicodeLeft === 0) {
        this.escape = false;
      }
      return true;
    }
    if (!this.escape) {
      return false;
    }
    if (character === "u") {
      this.unicodeLeft = 4;
    } else {
      this.escape = false;
    }
    return true;
  }
}
