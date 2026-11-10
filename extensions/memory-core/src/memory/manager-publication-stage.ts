import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MemoryPublicationFragment } from "./manager-publication-task.js";

const MEMORY_STAGE_BYTES = 32 * 1024 * 1024;
const RECORD_HEADER_BYTES = 5;

/**
 * One staged publication. Fragments stay in worker memory up to a budget; a larger
 * source spills them to a private file so its staging never grows with the worker heap.
 */
export class MemoryPublicationStage {
  private fragments: MemoryPublicationFragment[] = [];
  private bytes = 0;
  private spill: { directory: string; fd: number; size: number } | undefined;

  append(fragments: readonly MemoryPublicationFragment[]): void {
    if (this.spill) {
      this.write(fragments);
      return;
    }
    for (const fragment of fragments) {
      this.fragments.push(fragment);
      this.bytes += fragment.json.length * 2;
    }
    if (this.bytes <= MEMORY_STAGE_BYTES) {
      return;
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-memory-stage-"));
    this.spill = {
      directory,
      fd: fs.openSync(path.join(directory, "fragments"), "wx+", 0o600),
      size: 0,
    };
    const held = this.fragments;
    this.fragments = [];
    this.bytes = 0;
    this.write(held);
  }

  *read(): Generator<MemoryPublicationFragment> {
    if (!this.spill) {
      yield* this.fragments;
      return;
    }
    const { fd, size } = this.spill;
    const header = Buffer.alloc(RECORD_HEADER_BYTES);
    for (let position = 0; position < size;) {
      fs.readSync(fd, header, 0, RECORD_HEADER_BYTES, position);
      const body = Buffer.alloc(header.readUInt32LE(0));
      fs.readSync(fd, body, 0, body.length, position + RECORD_HEADER_BYTES);
      position += RECORD_HEADER_BYTES + body.length;
      yield { json: body.toString("utf8"), last: header[4] === 1 };
    }
  }

  close(): void {
    this.fragments = [];
    this.bytes = 0;
    const spill = this.spill;
    this.spill = undefined;
    if (spill) {
      try {
        fs.closeSync(spill.fd);
      } finally {
        fs.rmSync(spill.directory, { recursive: true, force: true });
      }
    }
  }

  private write(fragments: readonly MemoryPublicationFragment[]): void {
    const spill = this.spill!;
    for (const fragment of fragments) {
      const body = Buffer.from(fragment.json, "utf8");
      const header = Buffer.alloc(RECORD_HEADER_BYTES);
      header.writeUInt32LE(body.length, 0);
      header[4] = fragment.last ? 1 : 0;
      fs.writeFileSync(spill.fd, Buffer.concat([header, body]));
      spill.size += RECORD_HEADER_BYTES + body.length;
    }
  }
}
