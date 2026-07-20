import fs from "node:fs/promises";
import path from "node:path";

const LEVELDB_FOOTER_BYTES = 48;
const LEVELDB_BLOCK_TRAILER_BYTES = 5;
const MAX_LEVELDB_FILE_BYTES = 16 * 1024 * 1024;
const MAX_LEVELDB_FILES = 256;
const MAX_LEVELDB_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_SNAPPY_BLOCK_BYTES = 16 * 1024 * 1024;

type ParsedGroups = {
  groups: Map<string, string>;
  assignments: Map<string, string>;
};

function readVarint(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  for (let index = 0; index < 10; index += 1) {
    const byte = bytes[offset];
    if (byte === undefined) {
      throw new Error("unexpected end of LevelDB varint");
    }
    offset += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return [value, offset];
    }
    shift += 7;
  }
  throw new Error("invalid LevelDB varint");
}

function decodeSnappy(compressed: Uint8Array): Uint8Array {
  let offset = 0;
  const [expectedLength, afterLength] = readVarint(compressed, offset);
  offset = afterLength;
  if (expectedLength > MAX_SNAPPY_BLOCK_BYTES) {
    throw new Error("Claude Desktop LevelDB block is too large");
  }
  const output = new Uint8Array(expectedLength);
  let written = 0;
  while (offset < compressed.length) {
    const tag = compressed[offset];
    if (tag === undefined) {
      throw new Error("unexpected end of Snappy block");
    }
    offset += 1;
    const kind = tag & 0x03;
    if (kind === 0) {
      let length = tag >>> 2;
      if (length < 60) {
        length += 1;
      } else {
        const count = length - 59;
        if (offset + count > compressed.length) {
          throw new Error("invalid Snappy literal length");
        }
        length = 1;
        for (let index = 0; index < count; index += 1) {
          length += (compressed[offset + index] ?? 0) * 2 ** (8 * index);
        }
        offset += count;
      }
      if (offset + length > compressed.length || written + length > output.length) {
        throw new Error("invalid Snappy literal");
      }
      output.set(compressed.subarray(offset, offset + length), written);
      offset += length;
      written += length;
      continue;
    }
    let length: number;
    let copyOffset: number;
    if (kind === 1) {
      length = ((tag >>> 2) & 0x07) + 4;
      copyOffset = ((tag >>> 5) << 8) | (compressed[offset] ?? 0);
      offset += 1;
    } else if (kind === 2) {
      length = (tag >>> 2) + 1;
      copyOffset = (compressed[offset] ?? 0) | ((compressed[offset + 1] ?? 0) << 8);
      offset += 2;
    } else {
      length = (tag >>> 2) + 1;
      copyOffset =
        (compressed[offset] ?? 0) |
        ((compressed[offset + 1] ?? 0) << 8) |
        ((compressed[offset + 2] ?? 0) << 16) |
        ((compressed[offset + 3] ?? 0) << 24);
      offset += 4;
    }
    if (copyOffset <= 0 || copyOffset > written || written + length > output.length) {
      throw new Error("invalid Snappy copy offset");
    }
    for (let index = 0; index < length; index += 1) {
      output[written] = output[written - copyOffset] ?? 0;
      written += 1;
    }
  }
  if (written !== output.length) {
    throw new Error("incomplete Snappy block");
  }
  return output;
}

function readBlock(file: Uint8Array, offset: number, size: number): Uint8Array {
  const trailerOffset = offset + size;
  if (offset < 0 || size < 0 || trailerOffset + LEVELDB_BLOCK_TRAILER_BYTES > file.length) {
    throw new Error("invalid LevelDB block handle");
  }
  const block = file.subarray(offset, trailerOffset);
  switch (file[trailerOffset]) {
    case 0:
      return block;
    case 1:
      return decodeSnappy(block);
    default:
      throw new Error("unsupported LevelDB compression");
  }
}

function levelDbDataBlocks(file: Uint8Array): Uint8Array[] {
  if (file.length < LEVELDB_FOOTER_BYTES) {
    return [];
  }
  const footer = file.subarray(file.length - LEVELDB_FOOTER_BYTES);
  let offset = 0;
  [, offset] = readVarint(footer, offset);
  [, offset] = readVarint(footer, offset);
  const [indexOffset, afterIndexOffset] = readVarint(footer, offset);
  const [indexSize] = readVarint(footer, afterIndexOffset);
  const index = readBlock(file, indexOffset, indexSize);
  if (index.length < 4) {
    return [];
  }
  const restartCount = new DataView(index.buffer, index.byteOffset + index.length - 4, 4).getUint32(
    0,
    true,
  );
  const entriesEnd = index.length - 4 - restartCount * 4;
  if (entriesEnd < 0) {
    return [];
  }
  const blocks: Uint8Array[] = [];
  offset = 0;
  while (offset < entriesEnd) {
    const [, afterShared] = readVarint(index, offset);
    const [unshared, afterUnshared] = readVarint(index, afterShared);
    const [valueLength, afterValueLength] = readVarint(index, afterUnshared);
    const valueOffset = afterValueLength + unshared;
    if (valueOffset + valueLength > entriesEnd) {
      throw new Error("invalid LevelDB index entry");
    }
    const handle = index.subarray(valueOffset, valueOffset + valueLength);
    const [blockOffset, afterBlockOffset] = readVarint(handle, 0);
    const [blockSize] = readVarint(handle, afterBlockOffset);
    blocks.push(readBlock(file, blockOffset, blockSize));
    offset = valueOffset + valueLength;
  }
  return blocks;
}

function scanGroupRecords(raw: Uint8Array, parsed: ParsedGroups): void {
  const text = Buffer.from(raw).toString("latin1").replaceAll("\0", "");
  for (const match of text.matchAll(/"id":"(cg-[a-f0-9-]+)","name":"([^"\\]{1,500})"/gi)) {
    const [, id, name] = match;
    if (id && name && !parsed.groups.has(id)) {
      parsed.groups.set(id, name);
    }
  }
  for (const match of text.matchAll(/"code:(local_[a-f0-9-]+)":"(cg-[a-f0-9-]+)"/gi)) {
    const [, sessionId, groupId] = match;
    if (sessionId && groupId && !parsed.assignments.has(sessionId)) {
      parsed.assignments.set(sessionId, groupId);
    }
  }
}

/**
 * Claude Desktop stores Code custom groups in Chromium Local Storage, not beside the session JSON.
 * This reads only labels and local-session assignments; it never mutates Desktop account state.
 */
export async function readClaudeDesktopCustomGroups(homeDir: string): Promise<Map<string, string>> {
  const root = path.join(
    homeDir,
    "Library",
    "Application Support",
    "Claude",
    "Local Storage",
    "leveldb",
  );
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && /\.(ldb|log)$/.test(entry.name))
      .map(async (entry) => {
        const filePath = path.join(root, entry.name);
        const stat = await fs.stat(filePath).catch(() => undefined);
        return stat && stat.size <= MAX_LEVELDB_FILE_BYTES
          ? { filePath, mtimeMs: stat.mtimeMs, size: stat.size }
          : undefined;
      }),
  );
  const parsed: ParsedGroups = { groups: new Map(), assignments: new Map() };
  let remainingBytes = MAX_LEVELDB_TOTAL_BYTES;
  for (const file of files
    .filter(
      (candidate): candidate is { filePath: string; mtimeMs: number; size: number } =>
        candidate !== undefined,
    )
    .toSorted(
      (left, right) => right.mtimeMs - left.mtimeMs || right.filePath.localeCompare(left.filePath),
    )
    .slice(0, MAX_LEVELDB_FILES)) {
    if (file.size > remainingBytes) {
      continue;
    }
    remainingBytes -= file.size;
    const raw = await fs.readFile(file.filePath).catch(() => undefined);
    if (!raw) {
      continue;
    }
    scanGroupRecords(raw, parsed);
    if (!file.filePath.endsWith(".ldb")) {
      continue;
    }
    try {
      for (const block of levelDbDataBlocks(raw)) {
        scanGroupRecords(block, parsed);
      }
    } catch {
      // Chromium can compact while discovery is reading its local store.
    }
  }
  const assignments = new Map<string, string>();
  for (const [sessionId, groupId] of parsed.assignments) {
    const group = parsed.groups.get(groupId);
    if (group) {
      assignments.set(sessionId, group);
    }
  }
  return assignments;
}
