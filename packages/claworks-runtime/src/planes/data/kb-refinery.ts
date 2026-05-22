import type { KbStore } from "./kb-store.js";
import type { KbDocumentRecord, KbLintIssue, KbLintResult } from "./kb-types.js";

export function lintKbDocument(store: KbStore, documentId: string): KbLintResult {
  const doc = store.getDocument(documentId);
  const issues: KbLintIssue[] = [];
  if (!doc) {
    return {
      document_id: documentId,
      ok: false,
      issues: [{ severity: "error", code: "NOT_FOUND", message: "Document not found" }],
    };
  }

  const chunks = store.listChunks(documentId);
  if (chunks.length === 0) {
    issues.push({
      severity: "error",
      code: "NO_CHUNKS",
      message: "Document has no chunks",
    });
  }

  if (!doc.source?.trim()) {
    issues.push({
      severity: "warning",
      code: "MISSING_SOURCE",
      message: "Document source is empty; citations may be weak",
    });
  }

  for (const chunk of chunks) {
    if (!chunk.citation?.trim()) {
      issues.push({
        severity: "warning",
        code: "MISSING_CITATION",
        message: `Chunk ${chunk.seq + 1} has no citation`,
      });
    }
    if (chunk.text.trim().length < 20) {
      issues.push({
        severity: "warning",
        code: "SHORT_CHUNK",
        message: `Chunk ${chunk.seq + 1} is very short`,
      });
    }
  }

  if (
    doc.layer === "L0" &&
    doc.source &&
    !/^(GB|GB\/T|API|ISO|SY\/T|HG\/T|SH\/T|DL\/T|IEC|ASTM)/i.test(doc.source)
  ) {
    issues.push({
      severity: "warning",
      code: "L0_SOURCE_SHAPE",
      message: "L0 document source does not look like a standard identifier",
    });
  }

  return {
    document_id: documentId,
    ok: !issues.some((issue) => issue.severity === "error"),
    issues,
  };
}

export function canPublishDocument(doc: KbDocumentRecord, lint: KbLintResult): boolean {
  if (doc.status === "published") {
    return true;
  }
  return lint.ok;
}
