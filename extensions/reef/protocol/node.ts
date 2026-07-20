import {
  mkdir,
  open as openFile,
  rename as renameFile,
  unlink as unlinkFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { gcm } from "@noble/ciphers/aes.js";
import { concatBytes, randomBytes } from "@noble/hashes/utils.js";
import { createAuditEntry, verifyChain, type AuditEntry, type AuditStore } from "./audit.js";
import { canonicalBytes } from "./canonical.js";
import { base64, decodeUtf8, fromBase64 } from "./encoding.js";
import { validateMessageBody, type MessageBody } from "./envelope.js";
import type { SignedReceipt } from "./receipts.js";
import type { CompletedReplay, ReplayClaim, ReplayStore } from "./replay.js";

export class JsonlAuditStore implements AuditStore {
  readonly #auditKey: Uint8Array;
  readonly #rng: (length: number) => Uint8Array;
  readonly #entries: AuditEntry[] = [];
  #head = { hash: "", seq: 0 };
  #loaded = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    auditKey: Uint8Array,
    rng: (length: number) => Uint8Array = randomBytes,
  ) {
    if (auditKey.length !== 32) {
      throw new Error("audit key must be 32 bytes");
    }
    this.#auditKey = auditKey.slice();
    this.#rng = rng;
  }

  async appendEvent(
    type: string,
    payload: unknown,
    ts = Math.floor(Date.now() / 1000),
  ): Promise<AuditEntry> {
    return this.#withLock(async () => {
      await this.#load();
      const entry = createAuditEntry(type, payload, ts, this.#auditKey, this.#head, this.#rng);
      await appendDurably(this.path, `${JSON.stringify(entry)}\n`);
      this.#entries.push(entry);
      this.#head = { hash: entry.entryHash, seq: entry.event.seq };
      return structuredClone(entry);
    });
  }

  async entries(): Promise<AuditEntry[]> {
    return this.#withLock(async () => {
      await this.#load();
      return structuredClone(this.#entries);
    });
  }

  async #load(): Promise<void> {
    if (this.#loaded) {
      return;
    }
    const entries = await readJsonl<AuditEntry>(this.path);
    if (!verifyChain(entries)) {
      throw new Error("invalid audit chain");
    }
    this.#entries.push(...entries);
    const last = entries.at(-1);
    this.#head = { hash: last?.entryHash ?? "", seq: last?.event.seq ?? 0 };
    this.#loaded = true;
  }

  #withLock<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

interface FileReplayRecord {
  envelopeHash: string;
  state: "available" | "in_flight" | "completed" | "consumed";
  receipt?: SignedReceipt;
  body?: MessageBody;
}

interface EncryptedReplayBody {
  enc: string;
}

type ReplayLogRecord =
  | { op: "claim"; peer: string; id: string; envelopeHash: string }
  | { op: "complete"; peer: string; id: string; receipt: SignedReceipt; body?: EncryptedReplayBody }
  | { op: "consume"; peer: string; id: string }
  | { op: "release"; peer: string; id: string };

export class FileReplayStore implements ReplayStore {
  readonly #bodyKey: Uint8Array;
  readonly #rng: (length: number) => Uint8Array;
  readonly #bindings = new Map<string, FileReplayRecord>();
  #loaded = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    readonly path: string,
    bodyKey: Uint8Array,
    rng: (length: number) => Uint8Array = randomBytes,
  ) {
    if (bodyKey.length !== 32) {
      throw new Error("replay body key must be 32 bytes");
    }
    this.#bodyKey = bodyKey.slice();
    this.#rng = rng;
  }

  async claim(peer: string, id: string, envelopeHash: string): Promise<ReplayClaim> {
    return this.#withLock(async () => {
      await this.#load();
      const key = replayKey(peer, id);
      const existing = this.#bindings.get(key);
      if (existing === undefined) {
        await this.#append({ op: "claim", peer, id, envelopeHash });
        this.#bindings.set(key, { envelopeHash, state: "in_flight" });
        return "new";
      }
      if (existing.envelopeHash !== envelopeHash) {
        return "mismatch";
      }
      if (existing.state === "completed" || existing.state === "consumed") {
        return "duplicate";
      }
      if (existing.state === "in_flight") {
        return "in_flight";
      }
      await this.#append({ op: "claim", peer, id, envelopeHash });
      existing.state = "in_flight";
      return "new";
    });
  }

  async refresh(_peer: string, _id: string): Promise<void> {}

  async complete(
    peer: string,
    id: string,
    receipt: SignedReceipt,
    body?: MessageBody,
  ): Promise<void> {
    return this.#withLock(async () => {
      await this.#load();
      const existing = this.#bindings.get(replayKey(peer, id));
      if (existing?.state !== "in_flight") {
        throw new Error("replay claim is not in flight");
      }
      if (receipt.id !== id) {
        throw new Error("receipt id does not match replay claim");
      }
      validateCompletion(receipt, body);
      const record: ReplayLogRecord =
        body === undefined
          ? { op: "complete", peer, id, receipt }
          : {
              op: "complete",
              peer,
              id,
              receipt,
              body: encryptReplayBody(body, this.#bodyKey, this.#rng),
            };
      await this.#append(record);
      existing.state = "completed";
      existing.receipt = structuredClone(receipt);
      if (body !== undefined) {
        existing.body = structuredClone(body);
      }
    });
  }

  async consume(peer: string, id: string): Promise<void> {
    return this.#withLock(async () => {
      await this.#load();
      const existing = this.#bindings.get(replayKey(peer, id));
      if (existing?.state !== "in_flight") {
        throw new Error("replay claim is not in flight");
      }
      await this.#append({ op: "consume", peer, id });
      existing.state = "consumed";
      delete existing.receipt;
      delete existing.body;
    });
  }

  async release(peer: string, id: string): Promise<void> {
    return this.#withLock(async () => {
      await this.#load();
      const existing = this.#bindings.get(replayKey(peer, id));
      if (existing?.state === "in_flight") {
        await this.#append({ op: "release", peer, id });
        existing.state = "available";
      }
    });
  }

  async completed(peer: string, id: string): Promise<CompletedReplay | undefined> {
    return this.#withLock(async () => {
      await this.#load();
      const existing = this.#bindings.get(replayKey(peer, id));
      if (existing?.state !== "completed" || existing.receipt === undefined) {
        return undefined;
      }
      return existing.body === undefined
        ? { receipt: structuredClone(existing.receipt) }
        : { receipt: structuredClone(existing.receipt), body: structuredClone(existing.body) };
    });
  }

  async #append(record: ReplayLogRecord): Promise<void> {
    await appendDurably(this.path, `${JSON.stringify(record)}\n`);
  }

  async #load(): Promise<void> {
    if (this.#loaded) {
      return;
    }
    for (const record of await readJsonl<ReplayLogRecord>(this.path, { failClosed: true })) {
      if (record.op === "claim") {
        const key = replayKey(record.peer, record.id);
        const existing = this.#bindings.get(key);
        if (existing !== undefined && existing.envelopeHash !== record.envelopeHash) {
          throw new Error("corrupt replay binding store");
        }
        this.#bindings.set(key, { envelopeHash: record.envelopeHash, state: "available" });
      } else if (record.op === "complete") {
        const existing = this.#bindings.get(replayKey(record.peer, record.id));
        if (existing === undefined) {
          throw new Error("completed replay lacks claim");
        }
        const body =
          record.body === undefined ? undefined : decryptReplayBody(record.body, this.#bodyKey);
        validateCompletion(record.receipt, body);
        existing.state = "completed";
        existing.receipt = record.receipt;
        if (body !== undefined) {
          existing.body = body;
        }
      } else if (record.op === "consume") {
        const existing = this.#bindings.get(replayKey(record.peer, record.id));
        if (existing === undefined) {
          throw new Error("consumed replay lacks claim");
        }
        existing.state = "consumed";
        delete existing.receipt;
        delete existing.body;
      } else {
        const existing = this.#bindings.get(replayKey(record.peer, record.id));
        if (existing === undefined) {
          throw new Error("released replay lacks claim");
        }
        existing.state = "available";
      }
    }
    this.#loaded = true;
  }

  #withLock<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function replayKey(peer: string, id: string): string {
  return `${peer}\n${id}`;
}

async function appendDurably(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await openFile(path, "a", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function encryptReplayBody(
  body: MessageBody,
  key: Uint8Array,
  rng: (length: number) => Uint8Array,
): EncryptedReplayBody {
  validateMessageBody(body);
  const nonce = rng(12);
  if (nonce.length !== 12) {
    throw new Error("replay body rng returned invalid nonce");
  }
  const ciphertext = gcm(key, nonce).encrypt(canonicalBytes(body));
  return { enc: base64(concatBytes(nonce, ciphertext)) };
}

function decryptReplayBody(body: EncryptedReplayBody, key: Uint8Array): MessageBody {
  const packed = fromBase64(body.enc);
  if (packed.length < 28) {
    throw new Error("invalid encrypted replay body");
  }
  const plaintext = gcm(key, packed.slice(0, 12)).decrypt(packed.slice(12));
  const value = JSON.parse(decodeUtf8(plaintext)) as unknown;
  validateMessageBody(value);
  return value;
}

function validateCompletion(receipt: SignedReceipt, body: MessageBody | undefined): void {
  if ((receipt.status === "accepted") !== (body !== undefined)) {
    throw new Error("accepted replay completion requires body; rejected completion forbids body");
  }
}

// Bound audit/replay JSONL reads to prevent buffering an unbounded file
// into memory. Normal stores stay well below this limit; a file past it
// signals a runaway store, corruption, or an accidental large-file path.
//
// The read is bounded through streaming chunks (not stat()+readFile())
// so that growth after the handle is opened cannot bypass the cap.
//
// failClosed: when false (audit history), the reader stops at the cap and
// returns complete records up to that point with a warning — existing
// oversized stores remain partially readable.
// When true (replay ledger), the reader auto-compacts: it reads the bounded
// prefix, parses complete records, and atomically rewrites the file so
// existing oversized ledgers are recovered on first load instead of failing
// hard. No receipt record is silently omitted — the compacted file contains
// every complete record from the prefix.
const MAX_JSONL_FILE_BYTES = 32 * 1024 * 1024;
const JSONL_READ_CHUNK = 64 * 1024; // 64 KiB — balances syscall count and memory

async function readJsonl<T>(path: string, opts?: { failClosed?: boolean }): Promise<T[]> {
  const compact = opts?.failClosed ?? false;
  try {
    const handle = await openFile(path, "r");
    let contents: string;
    let overCap = false;
    try {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let position = 0;
      while (true) {
        const buf = Buffer.alloc(JSONL_READ_CHUNK);
        const { bytesRead } = await handle.read(buf, 0, JSONL_READ_CHUNK, position);
        if (bytesRead === 0) {
          break;
        }
        totalBytes += bytesRead;
        if (totalBytes > MAX_JSONL_FILE_BYTES) {
          // Best-effort: include bytes up to the cap, then stop.
          const keep = bytesRead - (totalBytes - MAX_JSONL_FILE_BYTES);
          chunks.push(buf.subarray(0, keep));
          overCap = true;
          break;
        }
        chunks.push(bytesRead < JSONL_READ_CHUNK ? buf.subarray(0, bytesRead) : buf);
        position += bytesRead;
      }
      contents = Buffer.concat(chunks).toString("utf8");
      if (overCap) {
        // Find the last complete newline so we do not split a JSON line.
        const lastNewline = contents.lastIndexOf("\n");
        if (lastNewline !== -1) {
          contents = contents.slice(0, lastNewline);
        }
      }
    } finally {
      await handle.close();
    }
    const lines = contents.split("\n");
    let finalNonempty = -1;
    for (let index = lines.length - 1; index >= 0; index--) {
      if (lines[index]!.length > 0) {
        finalNonempty = index;
        break;
      }
    }
    const records: T[] = [];
    let characterOffset = 0;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      const lineStart = characterOffset;
      characterOffset += line.length + (index < lines.length - 1 ? 1 : 0);
      if (line.length === 0) {
        continue;
      }
      try {
        records.push(JSON.parse(line) as T);
      } catch (error) {
        if (index !== finalNonempty) {
          throw error;
        }
        await truncateDurably(path, new TextEncoder().encode(contents.slice(0, lineStart)).length);
        break;
      }
    }
    if (overCap) {
      if (compact) {
        // Replay ledger: atomically compact the file to restore normal
        // operation. Write the retained records to a temp file and rename
        // so the operator never sees a partial write.
        const tmp = `${path}.compact-${Math.random().toString(36).slice(2, 8)}`;
        try {
          const linesOut =
            records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
          const tmpHandle = await openFile(tmp, "wx");
          try {
            await tmpHandle.write(Buffer.from(linesOut), 0, undefined, 0);
            await tmpHandle.sync();
          } finally {
            await tmpHandle.close();
          }
          await renameFile(tmp, path);
        } catch (tmpErr) {
          // Clean up temp file on failure; don't mask the original error.
          try {
            await unlinkFile(tmp);
          } catch {
            // best-effort cleanup
          }
          throw tmpErr;
        }
        console.warn(
          `Replay ledger at ${path} exceeded ${MAX_JSONL_FILE_BYTES} bytes; ` +
            `compacted to ${records.length} records. ` +
            `Rotate ledgers regularly to prevent recurrence.`,
        );
      } else {
        console.warn(
          `JSONL store file at ${path} exceeds ${MAX_JSONL_FILE_BYTES} bytes; ` +
            `reading truncated prefix. Rotate or compact the store to restore full visibility.`,
        );
      }
    }
    return records;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function truncateDurably(path: string, length: number): Promise<void> {
  const handle = await openFile(path, "r+");
  try {
    await handle.truncate(length);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
