/**
 * Vector Persistence
 *
 * Save/load embedding vectors as binary files for fast restart.
 * Format: [header: 16 bytes] [entries: variable]
 *
 * Header: magic(4) + version(4) + dim(4) + count(4)
 * Entry:  idLen(2) + id(utf8) + vector(dim * 4 bytes float32)
 */

import fs from "node:fs";
import { join } from "node:path";

const MAGIC = 0x4d454d56; // "MEMV"
const VERSION = 1;

export interface VectorEntry {
  id: string;
  vector: number[];
}

/**
 * Save vectors to a binary file.
 */
export function saveVectors(filePath: string, entries: VectorEntry[], dim: number): void {
  if (entries.length === 0) {
    // Write empty file with just header
    const header = Buffer.alloc(16);
    header.writeUInt32LE(MAGIC, 0);
    header.writeUInt32LE(VERSION, 4);
    header.writeUInt32LE(dim, 8);
    header.writeUInt32LE(0, 12);
    fs.writeFileSync(filePath, header);
    return;
  }

  // Calculate total size
  let totalSize = 16; // header
  for (const entry of entries) {
    const idBytes = Buffer.byteLength(entry.id, "utf8");
    totalSize += 2 + idBytes + dim * 4;
  }

  const buf = Buffer.alloc(totalSize);
  let offset = 0;

  // Write header
  buf.writeUInt32LE(MAGIC, offset);
  offset += 4;
  buf.writeUInt32LE(VERSION, offset);
  offset += 4;
  buf.writeUInt32LE(dim, offset);
  offset += 4;
  buf.writeUInt32LE(entries.length, offset);
  offset += 4;

  // Write entries
  for (const entry of entries) {
    const idBuf = Buffer.from(entry.id, "utf8");
    buf.writeUInt16LE(idBuf.length, offset);
    offset += 2;
    idBuf.copy(buf, offset);
    offset += idBuf.length;

    for (let i = 0; i < dim; i++) {
      buf.writeFloatLE(entry.vector[i] ?? 0, offset);
      offset += 4;
    }
  }

  fs.writeFileSync(filePath, buf);
}

/**
 * Load vectors from a binary file.
 * Returns null if file doesn't exist or is invalid.
 */
export function loadVectors(filePath: string): {
  dim: number;
  entries: VectorEntry[];
} | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const buf = fs.readFileSync(filePath);
  if (buf.length < 16) {
    return null;
  }

  let offset = 0;
  const magic = buf.readUInt32LE(offset);
  offset += 4;
  if (magic !== MAGIC) {
    return null;
  }

  const version = buf.readUInt32LE(offset);
  offset += 4;
  if (version !== VERSION) {
    return null;
  }

  const dim = buf.readUInt32LE(offset);
  offset += 4;
  const count = buf.readUInt32LE(offset);
  offset += 4;

  const entries: VectorEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (offset + 2 > buf.length) {
      break;
    }
    const idLen = buf.readUInt16LE(offset);
    offset += 2;

    if (offset + idLen > buf.length) {
      break;
    }
    const id = buf.toString("utf8", offset, offset + idLen);
    offset += idLen;

    if (offset + dim * 4 > buf.length) {
      break;
    }
    const vector: number[] = Array.from({ length: dim });
    for (let j = 0; j < dim; j++) {
      vector[j] = buf.readFloatLE(offset);
      offset += 4;
    }
    entries.push({ id, vector });
  }

  return { dim, entries };
}

/**
 * Get the default vector persistence path for a storage directory.
 */
export function getVectorPath(storageDir: string): string {
  return join(storageDir, "vectors.bin");
}
