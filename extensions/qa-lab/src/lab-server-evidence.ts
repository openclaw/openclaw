import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readNonBlankString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { writeError } from "./bus-server.js";
import { toQaError } from "./errors.js";
import {
  QaEvidenceGalleryError,
  buildQaEvidenceGalleryModel,
  resolveQaEvidenceArtifactFileByIndex,
  resolveQaEvidenceArtifactFile,
  resolveQaEvidenceProducerFile,
} from "./evidence-gallery.js";

function parseQaEvidenceArtifactIndexText(value: string): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new QaEvidenceGalleryError("Evidence artifact index is invalid.", 400);
  }
  const index = Number(value);
  if (!Number.isSafeInteger(index) || String(index) !== value) {
    throw new QaEvidenceGalleryError("Evidence artifact index is invalid.", 400);
  }
  return index;
}

const QA_EVIDENCE_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
};

function detectQaEvidenceArtifactContentType(filePath: string): string {
  const lower = filePath.toLowerCase();
  return (
    QA_EVIDENCE_CONTENT_TYPES[lower.slice(lower.lastIndexOf("."))] ?? "application/octet-stream"
  );
}

export async function handleQaEvidenceRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  repoRoot: string;
  defaultEvidencePath?: string;
}): Promise<boolean> {
  const { req, res, url, repoRoot } = params;
  if (req.method === "GET" && url.pathname === "/api/evidence") {
    const evidencePath =
      readNonBlankString(url.searchParams.get("path")) || params.defaultEvidencePath;
    // Resolve before writing success headers so the server's error renderer can respond.
    const evidence = evidencePath
      ? await buildQaEvidenceGalleryModel({ evidencePath, repoRoot })
      : null;
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ evidence }));
    return true;
  }
  if (
    (req.method === "GET" || req.method === "HEAD") &&
    url.pathname === "/api/evidence/artifact"
  ) {
    const evidencePath = readNonBlankString(url.searchParams.get("evidencePath"));
    const artifactPath = readNonBlankString(url.searchParams.get("artifactPath"));
    const producerFile = url.searchParams.get("producerFile")?.trim();
    const entryIndexText = url.searchParams.get("entryIndex");
    const artifactIndexText = url.searchParams.get("artifactIndex");
    if (
      !evidencePath ||
      (!artifactPath && !producerFile && (!entryIndexText || !artifactIndexText))
    ) {
      writeError(res, 400, "Missing evidencePath and artifact selector");
      return true;
    }
    const artifactFile = artifactPath
      ? await resolveQaEvidenceArtifactFile({
          artifactPath,
          evidencePath,
          repoRoot,
        })
      : producerFile
        ? await resolveQaEvidenceProducerFile({
            evidencePath,
            producerFile,
            repoRoot,
          })
        : await resolveQaEvidenceArtifactFileByIndex({
            artifactIndex: parseQaEvidenceArtifactIndexText(artifactIndexText!),
            entryIndex: parseQaEvidenceArtifactIndexText(entryIndexText!),
            evidencePath,
            repoRoot,
          });
    const artifactStats = await fs.promises.stat(artifactFile);
    res.writeHead(200, {
      "content-type": detectQaEvidenceArtifactContentType(artifactFile),
      "content-length": artifactStats.size,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    fs.createReadStream(artifactFile)
      .on("error", (error) => res.destroy(toQaError(error)))
      .pipe(res);
    return true;
  }
  return false;
}
