import type { KbLayer } from "./kb-types.js";

export type KbChunkInput = {
  text: string;
  citation?: string;
};

const MAX_CHUNK_CHARS = 2_400;

export function inferKbLayer(params: {
  source?: string;
  doc_type?: string;
  namespace?: string;
}): KbLayer {
  const source = (params.source ?? "").toUpperCase();
  const docType = (params.doc_type ?? "").toLowerCase();
  const namespace = (params.namespace ?? "").toLowerCase();

  if (/^(GB|GB\/T|API|ISO|SY\/T|HG\/T|SH\/T|DL\/T|IEC|ASTM)[-/\s]/.test(source)) {
    return "L0";
  }
  if (docType.includes("manual") || docType.includes("oem") || docType.includes("spec")) {
    return "L1";
  }
  if (
    namespace.includes("station") ||
    docType.includes("workorder") ||
    docType.includes("case") ||
    docType.includes("l3")
  ) {
    return "L3";
  }
  if (docType.includes("draft") || namespace.includes("draft")) {
    return "L4";
  }
  return "L2";
}

export function inferDocType(source?: string, text?: string): string | undefined {
  const hay = `${source ?? ""}\n${text ?? ""}`.toLowerCase();
  if ((source ?? "").endsWith(".pdf") && /gb|api|iso|sy\/t/.test(hay)) {
    return "standard";
  }
  if (/manual|手册|oem/.test(hay)) {
    return "manual";
  }
  if (/sop|规程|procedure/.test(hay)) {
    return "sop";
  }
  if (/price|价目|报价|quote/.test(hay)) {
    return "pricing";
  }
  if (/proposal|方案|ppt/.test(hay)) {
    return "proposal";
  }
  return undefined;
}

export function buildCitation(params: {
  source?: string;
  layer: KbLayer;
  section?: string;
  seq: number;
}): string {
  const base = params.source?.trim() || "inline";
  if (params.section?.trim()) {
    return `${base}:${params.section.trim()}`;
  }
  return `${params.layer}:${base}#chunk-${params.seq + 1}`;
}

function splitSections(text: string): Array<{ heading?: string; body: string }> {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const sections: Array<{ heading?: string; body: string }> = [];
  let currentHeading: string | undefined;
  let buffer: string[] = [];

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body) {
      sections.push({ heading: currentHeading, body });
    }
    buffer = [];
  };

  for (const line of lines) {
    const headingMatch = /^(#{1,4}\s+.+)$/.exec(line.trim());
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[1].replace(/^#+\s+/, "").trim();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections.length > 0 ? sections : [{ body: text.trim() }];
}

function splitLongBody(body: string): string[] {
  if (body.length <= MAX_CHUNK_CHARS) {
    return [body];
  }
  const parts: string[] = [];
  let start = 0;
  while (start < body.length) {
    let end = Math.min(start + MAX_CHUNK_CHARS, body.length);
    if (end < body.length) {
      const breakAt = body.lastIndexOf("\n\n", end);
      if (breakAt > start + 400) {
        end = breakAt;
      }
    }
    parts.push(body.slice(start, end).trim());
    start = end;
  }
  return parts.filter(Boolean);
}

export function chunkKbText(params: {
  text: string;
  source?: string;
  layer: KbLayer;
}): KbChunkInput[] {
  const trimmed = params.text.trim();
  if (!trimmed) {
    return [];
  }
  const chunks: KbChunkInput[] = [];
  let seq = 0;
  for (const section of splitSections(trimmed)) {
    for (const part of splitLongBody(section.body)) {
      chunks.push({
        text: section.heading ? `${section.heading}\n\n${part}` : part,
        citation: buildCitation({
          source: params.source,
          layer: params.layer,
          section: section.heading,
          seq,
        }),
      });
      seq += 1;
    }
  }
  return chunks;
}

export function deriveDocumentTitle(params: {
  title?: string;
  source?: string;
  text: string;
}): string {
  if (params.title?.trim()) {
    return params.title.trim();
  }
  if (params.source?.trim()) {
    const base = params.source.split(/[/\\]/).pop() ?? params.source;
    return base.replace(/\.[a-z0-9]+$/i, "") || base;
  }
  const firstLine = params.text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine?.slice(0, 120) ?? "Untitled document";
}
