---
summary: "Systematic troubleshooting for retrieval-heavy and multi-tool OpenClaw setups"
read_when:
  - Your agent answers incorrectly even though relevant source material exists
  - Retrieval quality dropped after changing chunking, embeddings, or indexing
  - Tool calls look wrong, repetitive, or disconnected from the final answer
  - You need a symptom-first way to isolate the failing layer before changing prompts or models
title: "RAG and Agent Debugging Checklist"
---

# RAG and Agent Debugging Checklist

When an OpenClaw setup depends on retrieval, external documents, or multiple
tools, the visible failure is often not the true failure layer.

This page is a symptom-first checklist for isolating where the breakdown starts,
so you can fix the right layer before changing prompts, models, or
infrastructure.

<Tip>
Start with [Troubleshooting](/help/troubleshooting) first.

If basic gateway health is fine and the agent still behaves incorrectly, use
this page as a deeper runbook for retrieval-heavy and tool-routed failures.
</Tip>

## Quick reference

| #   | Failure mode                                                              | Likely layer          |
| --- | ------------------------------------------------------------------------- | --------------------- |
| 1   | [Documents not ingested](#1-documents-not-ingested)                       | Ingestion             |
| 2   | [Wrong or stale documents](#2-wrong-or-stale-documents)                   | Ingestion / index     |
| 3   | [Chunking boundary mismatch](#3-chunking-boundary-mismatch)               | Chunking              |
| 4   | [Missing source metadata](#4-missing-source-metadata)                     | Chunking / provenance |
| 5   | [Embedding model mismatch](#5-embedding-model-mismatch)                   | Embedding             |
| 6   | [Similarity configuration mismatch](#6-similarity-configuration-mismatch) | Vector store          |
| 7   | [Index fragmentation or staleness](#7-index-fragmentation-or-staleness)   | Vector store          |
| 8   | [Retrieval noise or low recall](#8-retrieval-noise-or-low-recall)         | Retrieval             |
| 9   | [Ranking mismatch](#9-ranking-mismatch)                                   | Retrieval             |
| 10  | [Context window pressure](#10-context-window-pressure)                    | Context               |
| 11  | [Grounding instruction drift](#11-grounding-instruction-drift)            | Prompt                |
| 12  | [Good retrieval, bad answer](#12-good-retrieval-bad-answer)               | Prompt / model        |
| 13  | [Wrong tool selected](#13-wrong-tool-selected)                            | Tool routing          |
| 14  | [Tool looping](#14-tool-looping)                                          | Tool routing          |
| 15  | [Tool output not applied](#15-tool-output-not-applied)                    | Tool routing          |
| 16  | [Multi-agent handoff failure](#16-multi-agent-handoff-failure)            | Orchestration         |

## Ingestion and indexing

### 1. Documents not ingested

**Symptom**

The source material exists, but the agent behaves as if it was never available.

**Check**

- Confirm the document actually entered your ingestion path.
- Verify the source format is readable and supported.
- Check ingestion logs for skips, parse failures, or silent drops.

**Fix**

- Re-run ingestion and watch for skipped inputs.
- Normalize file format and encoding before ingestion.
- Add a validation step that confirms the source becomes retrievable after ingest.

### 2. Wrong or stale documents

**Symptom**

The agent cites outdated, duplicated, or clearly irrelevant material.

**Check**

- Confirm updated content replaced old indexed content instead of being appended.
- Check whether deduplication uses a stable document identity.
- Verify that freshness metadata is preserved when needed.

**Fix**

- Remove or overwrite stale indexed content during re-ingestion.
- Deduplicate by stable document identity.
- Apply recency-aware filtering or boosting where freshness matters.

### 3. Chunking boundary mismatch

**Symptom**

Answers are vague, fragmented, or miss the exact supporting detail.

**Check**

- Inspect sample chunks as a human reader.
- Check whether key sentences are split across chunk boundaries.
- Compare chunk size and overlap against the content type.

**Fix**

- Add overlap between adjacent chunks.
- Split by natural boundaries when possible.
- Tune chunk shape differently for prose, specs, and code.

### 4. Missing source metadata

**Symptom**

The agent retrieves relevant text but cannot preserve source identity, section,
or provenance reliably.

**Check**

- Verify chunk-level metadata survives ingestion.
- Check whether source name, section, path, or page markers are preserved.
- Confirm provenance is visible to the answering layer when attribution matters.

**Fix**

- Attach source metadata to every chunk.
- Preserve stable section labels and source identifiers.
- Surface provenance in a model-friendly way when needed.

## Retrieval and context

### 5. Embedding model mismatch

**Symptom**

Recall drops after an embedding change, or unrelated chunks begin appearing.

**Check**

- Confirm documents and queries use the same embedding model family.
- Check vector dimensionality expectations.
- Verify no silent model switch happened during pipeline updates.

**Fix**

- Re-embed the corpus after changing embedding models.
- Pin the embedding model version.
- Validate model compatibility before indexing.

### 6. Similarity configuration mismatch

**Symptom**

Results look randomly ordered, or top hits are still obviously wrong.

**Check**

- Verify similarity settings are aligned across indexing and querying.
- Confirm the retrieval path did not change defaults unexpectedly.
- Check whether the current setup matches your embedding assumptions.

**Fix**

- Make similarity settings explicit.
- Rebuild or refresh the affected index when required.
- Keep retrieval configuration consistent across environments.

### 7. Index fragmentation or staleness

**Symptom**

Retrieval quality degrades over time even though ingestion appears to succeed.

**Check**

- Look for signs of stale segments, delayed rebuilds, or fragmented index state.
- Confirm index maintenance is part of normal operations.
- Check whether update-heavy workloads are accumulating stale state.

**Fix**

- Compact, vacuum, or rebuild the index as appropriate.
- Schedule periodic index maintenance.
- Separate fast-changing sources from stable corpora when useful.

### 8. Retrieval noise or low recall

**Symptom**

The right evidence is often missing, or too much unrelated evidence enters the
answering path.

**Check**

- Compare a smaller candidate set against a larger one.
- Check whether the relevant chunk appears at all, and where.
- Determine whether retrieval is too narrow or too noisy for the task.

**Fix**

- Tune retrieval depth conservatively.
- Reduce noisy candidate injection.
- Fix retrieval quality before changing prompts.

### 9. Ranking mismatch

**Symptom**

The correct item appears in the candidate set but does not make it into the
final context.

**Check**

- Compare raw candidate order with final injected order.
- Check whether there is a ranking step after initial retrieval.
- Verify that ranking behavior matches the task.

**Fix**

- Improve the ranking stage or add one if missing.
- Narrow the final context to the strongest supporting evidence.
- Validate ranking on representative failure cases.

### 10. Context window pressure

**Symptom**

Relevant evidence exists, but useful context gets crowded out or diluted before
answer generation.

**Check**

- Estimate how much space is consumed by retrieved context versus everything else.
- Check whether retrieval payload is oversized for the task.
- Verify that large context blocks are not reducing effective grounding.

**Fix**

- Reduce the number or size of injected chunks.
- Prefer tighter, higher-signal retrieval results.
- Compress bulky evidence before final injection when appropriate.

## Prompt and grounding

### 11. Grounding instruction drift

**Symptom**

Behavior changed after prompt or workspace updates even though retrieval still
looks reasonable.

**Check**

- Compare current instructions against a known-good baseline.
- Check whether grounding rules were removed, weakened, or buried.
- Review recent changes to bootstrap or workspace instruction files.

**Fix**

- Restore a stable grounding policy.
- Keep critical retrieval rules in a dedicated, easy-to-audit section.
- Version-control instruction changes.

### 12. Good retrieval, bad answer

**Symptom**

The system surfaces the right evidence, but the final answer still invents,
overstates, or contradicts it.

**Check**

- Confirm the answering layer is explicitly told to stay grounded in retrieved
  evidence.
- Check whether generation settings encourage speculative output.
- Verify that the strongest evidence remains visible during answering.

**Fix**

- Strengthen grounding instructions.
- Reduce settings that favor speculative output for factual tasks.
- Prefer answer formats that stay closer to source evidence.

## Tools and orchestration

### 13. Wrong tool selected

**Symptom**

A tool is invoked that does not match the task, even though a better tool is
available.

**Check**

- Review tool names and descriptions for overlap.
- Check whether multiple tools appear to solve the same problem.
- Confirm the task framing makes the intended tool obvious.

**Fix**

- Make tool purposes more distinct.
- Reduce overlap between tool descriptions.
- Gate tools by task so only relevant ones are available.

### 14. Tool looping

**Symptom**

The same tool is called repeatedly without meaningful progress.

**Check**

- Look for repeated calls with similar inputs.
- Check whether failures return actionable feedback or only generic errors.
- Confirm loop guards are enabled where available.

**Fix**

- Improve failure feedback so retries are informative.
- Add or tighten loop detection.
- Return clear terminal states for no-result conditions.

### 15. Tool output not applied

**Symptom**

A tool returns useful data, but the final answer ignores it or distorts it.

**Check**

- Inspect the raw tool result.
- Check whether the output is too large, too noisy, or too deeply nested.
- Confirm the output remains usable by the answering layer.

**Fix**

- Keep tool outputs concise and structured.
- Prefer flatter formats over deeply nested payloads.
- Return summary-first outputs when the full payload is large.

### 16. Multi-agent handoff failure

**Symptom**

Tasks are routed to the wrong agent, duplicated, or dropped between agents.

**Check**

- Review agent scope definitions.
- Check whether handoff boundaries are clear and non-overlapping.
- Verify the orchestrating layer has explicit routing intent.

**Fix**

- Give each agent a narrower, clearer role.
- Tighten handoff rules and routing descriptions.
- Test handoff behavior with varied task types.

## Minimal debugging loop

When the exact failure is unclear, use this order:

1. Reproduce the failure with one concrete input.
2. Isolate the failing layer before changing prompts or models.
3. Confirm the source is available and retrievable.
4. Confirm the retrieved evidence is relevant and compact enough to be useful.
5. Confirm instructions preserve grounding.
6. Confirm tools and handoffs match the task shape.

That order keeps the debugging path narrow and avoids random config churn.
