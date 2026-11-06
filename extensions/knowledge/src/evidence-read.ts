import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { withEvidenceFile } from "./evidence-files.js";
import type { EvidenceReadInput, EvidenceReadOutput } from "./evidence-read-contract.js";
import type { Evidence, LoadedRecord } from "./model.js";

type Position = { binding: string; start: number; end: number | null; offset: number };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const encode = (cursor: Position) => Buffer.from(JSON.stringify(cursor)).toString("base64url");

// Cursors select positions only: authority always comes from the current record and scope.
function position(root: string, input: EvidenceReadInput): Position {
  const binding = hash(JSON.stringify([root, input.id, input.path, input.sha256]));
  if (!input.cursor) {
    return { binding, start: input.startLine ?? 1, end: input.endLine ?? null, offset: 0 };
  }
  let p: Position;
  try {
    p = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid evidence cursor; restart the passage read.");
  }
  if (
    !p ||
    encode(p) !== input.cursor ||
    Object.keys(p).toSorted().join(",") !== "binding,end,offset,start" ||
    p.binding !== binding ||
    !Number.isSafeInteger(p.start) ||
    p.start < 1 ||
    (p.end !== null && (!Number.isSafeInteger(p.end) || p.end < p.start)) ||
    !Number.isSafeInteger(p.offset) ||
    p.offset < 0 ||
    (input.startLine !== undefined && input.startLine !== p.start) ||
    (input.endLine !== undefined && input.endLine !== p.end)
  ) {
    throw new Error("Evidence cursor does not match this source and range.");
  }
  return p;
}

/** Read one UTF-8 passage with bounded memory; validate the entire source before returning text. */
export function readEvidence(
  root: string,
  record: LoadedRecord,
  evidence: Evidence,
  input: EvidenceReadInput,
): EvidenceReadOutput {
  const p = position(root, input),
    limit = input.maxChars ?? 3000;
  if (p.end !== null && p.end < p.start) {
    throw new Error("Invalid evidence line range.");
  }
  if (
    evidence.start_line === undefined &&
    evidence.end_line === undefined &&
    !(evidence.mediaType ?? "").startsWith("text/") &&
    !/(?:json|xml|yaml|javascript)/.test(evidence.mediaType ?? "") &&
    !/\.(txt|md|csv|json|jsonl|ya?ml|log|xml|html|ts|js)$/i.test(evidence.filename ?? evidence.path)
  ) {
    throw new Error("Source is not text; use knowledge_attachment for retained bytes.");
  }
  return withEvidenceFile(root, evidence.path, (fd, size) => {
    const digest = createHash("sha256"),
      decoder = new TextDecoder("utf-8", { fatal: true }),
      bytes = Buffer.alloc(65536);
    let line = 1,
      total = 0,
      text = "",
      pendingCR = "",
      used = 0;
    // Keep only the requested page plus one character to protect surrogate-pair boundaries.
    const collect = (part: string) => {
      if (line < p.start || (p.end !== null && line > p.end)) {
        return;
      }
      const skip = Math.max(0, p.offset - total);
      if (skip < part.length && text.length < limit + 1) {
        text += part.slice(skip, skip + limit + 1 - text.length);
      }
      total += part.length;
    };
    const consume = (decoded: string, final = false) => {
      if (decoded.includes("\u0000")) {
        throw new Error("Source contains binary data; use knowledge_attachment.");
      }
      let value = pendingCR + decoded;
      pendingCR = "";
      if (!final && value.endsWith("\r")) {
        pendingCR = "\r";
        value = value.slice(0, -1);
      }
      const parts = value.replace(/\r\n/g, "\n").split("\n");
      for (let i = 0; i < parts.length; i++) {
        collect(parts[i]!);
        if (i < parts.length - 1) {
          if (p.end === null || line < p.end) {
            collect("\n");
          }
          line++;
        }
      }
    };
    // Hash and decode the same guarded descriptor, including bytes beyond the requested passage.
    while (used < size) {
      const n = fs.readSync(fd, bytes, 0, Math.min(bytes.length, size - used), used);
      if (!n) {
        throw new Error("Evidence truncated during passage read.");
      }
      const chunk = bytes.subarray(0, n);
      digest.update(chunk);
      used += n;
      consume(decoder.decode(chunk, { stream: true }));
    }
    consume(decoder.decode(), true);
    if (
      digest.digest("hex") !== evidence.sha256 ||
      (evidence.size !== undefined && evidence.size !== size)
    ) {
      throw new Error("Evidence hash or size does not match.");
    }
    if (p.start > line || (p.end !== null && p.end > line) || p.offset > total) {
      throw new Error("Evidence range or cursor exceeds source text.");
    }
    if (text.length && /[\uDC00-\uDFFF]/.test(text[0]!)) {
      throw new Error("Evidence cursor splits a Unicode character.");
    }
    text = text.slice(0, limit);
    if (text.length && /[\uD800-\uDBFF]/.test(text.at(-1)!)) {
      text = text.slice(0, -1);
    }
    return {
      record: { id: record.id, revision: record.revision, hash: record.hash },
      source: {
        filename: evidence.filename ?? path.basename(evidence.path),
        sha256: evidence.sha256,
      },
      range: { startLine: p.start, endLine: p.end ?? line },
      text,
      offset: p.offset,
      verification: { hashMatches: true, rangeValid: true },
      nextCursor:
        p.offset + text.length < total ? encode({ ...p, offset: p.offset + text.length }) : null,
    };
  });
}
