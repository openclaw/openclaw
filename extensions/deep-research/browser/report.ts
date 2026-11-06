import type { ResearchView } from "../src/view-contract.js";

export function safeSourceUrl(raw?: string): string | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const url = new URL(raw);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function sourceDomain(raw?: string) {
  const safe = safeSourceUrl(raw);
  return safe ? new URL(safe).hostname : "No external link";
}

/** Text-only semantic rendering: no HTML, image, preview or privileged URL retrieval. */
export function reportSegments(
  job: Pick<ResearchView, "report" | "citations" | "sources">,
): Array<{ text: string; sourceId?: string }> {
  const bytes = new TextEncoder().encode(job.report ?? "");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const segments: Array<{ text: string; sourceId?: string }> = [];
  let offset = 0;
  for (const citation of job.citations.toSorted((a, b) => a.startByte - b.startByte)) {
    if (
      citation.startByte < offset ||
      citation.endByte > bytes.length ||
      citation.endByte <= citation.startByte ||
      !job.sources.some((source) => source.id === citation.sourceId)
    ) {
      continue;
    }
    try {
      const before = decoder.decode(bytes.slice(offset, citation.startByte));
      const text = decoder.decode(bytes.slice(citation.startByte, citation.endByte));
      segments.push({ text: before }, { text, sourceId: citation.sourceId });
      offset = citation.endByte;
    } catch {
      /* An invalid range remains ordinary report text. */
    }
  }
  segments.push({ text: decoder.decode(bytes.slice(offset)) });
  return segments;
}

/** Headings are presentation only; citation offsets always refer to the original report bytes. */
export function reportBlocks(job: Pick<ResearchView, "report" | "citations" | "sources">) {
  const lines: Array<Array<{ text: string; sourceId?: string }>> = [[]];
  for (const segment of reportSegments(job)) {
    for (const [index, text] of segment.text.split("\n").entries()) {
      if (index > 0) {
        lines.push([]);
      }
      lines[lines.length - 1]!.push({ ...segment, text });
    }
  }
  return lines
    .filter((line) => line.some((segment) => segment.text))
    .map((segments) => {
      const first = segments[0]!;
      const heading = !first.sourceId && /^(#{1,6})[ \t]+/u.exec(first.text);
      if (heading) {
        first.text = first.text.slice(heading[0].length);
      }
      return { heading: heading ? heading[1]!.length : 0, segments };
    });
}
