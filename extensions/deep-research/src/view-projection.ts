import { hash, terminal, type ResearchJob } from "./job-state.js";
import type { ResearchView, ResearchViewSource } from "./view-contract.js";

/** Only locally recorded evidence, never tool transcripts or provider answer prose. */
export function projectResearchJob(job: ResearchJob): ResearchView {
  const result = job.result;
  const sources: ResearchViewSource[] = (result?.sources ?? job.observation?.sources ?? []).map(
    (source) => ({
      id: source.id,
      title: source.title,
      url: source.url,
      provenance: source.extraction === "supplied-text-v1" ? "supplied-document" : "retrieved-text",
      retrievalStatus: "retained",
      retrievedAt: source.retrievedAt,
      excerpt: source.text,
    }),
  );
  const citations: ResearchView["citations"] = [];
  for (const [index, citation] of (result?.providerCitations ?? []).entries()) {
    const id = `P${index + 1}`;
    sources.push({
      id,
      title: citation.title ?? citation.url,
      url: citation.url,
      provenance: "provider-cited",
      retrievalStatus: "not-fetched",
    });
    if (result && validByteRange(result.report, citation.startByte, citation.endByte)) {
      citations.push({ sourceId: id, startByte: citation.startByte!, endByte: citation.endByte! });
    }
  }
  // Portable ranges are emitted by the report producer, not inferred from arbitrary
  // bracketed user/model text. Provider ranges remain distinct from fetched evidence.
  citations.push(...(result?.reportCitations ?? []));
  const projection = {
    version: 1 as const,
    jobId: job.id,
    question: job.request.question,
    title: job.request.question.slice(0, 160),
    state: job.state,
    phase: terminal(job) ? job.state : (job.observation?.phase ?? job.state),
    summary: job.progress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt ?? job.createdAt,
    cancelRequested: !terminal(job) && (job.cancelRequested ?? false),
    actions:
      terminal(job) || job.recovery !== "ready"
        ? []
        : [
            ...(!job.cancelRequested ? ["cancel" as const] : []),
            ...(job.state === "paused" && job.recovery === "ready" && !job.cancelRequested
              ? ["resume" as const]
              : []),
          ],
    ...(result?.engine === "portable"
      ? {
          counts: {
            searches: result.usage.searches,
            fetches: result.usage.fetches,
            modelCalls: result.usage.modelCalls,
            sources: result.sources.length,
          },
        }
      : job.observation
        ? { counts: job.observation.counts }
        : {}),
    sources,
    findings: result?.findings ?? [],
    gaps: result?.gaps ?? [],
    limitations: result?.limitations ?? [],
    ...(result ? { report: result.report } : {}),
    citations,
  };
  return { ...projection, revision: hash(JSON.stringify(projection)) };
}

function validByteRange(text: string, start?: number, end?: number): boolean {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start! < 0 || end! <= start!) {
    return false;
  }
  const bytes = Buffer.from(text);
  if (end! > bytes.length) {
    return false;
  }
  // A continuation byte at either endpoint would split a UTF-8 scalar.
  return [start!, end!].every(
    (offset) => offset === bytes.length || (bytes[offset]! & 0xc0) !== 0x80,
  );
}
