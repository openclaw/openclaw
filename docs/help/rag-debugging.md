---
title: "RAG and Agent Debugging Checklist"
summary: "Systematic checklist for debugging retrieval-augmented generation (RAG) and multi-tool agent failures"
read_when:
  - Your agent gives hallucinated or wrong answers despite having a knowledge base
  - Retrieved documents are irrelevant, missing, or duplicated
  - Tools are called incorrectly, in loops, or not at all
  - You changed embeddings, chunking, or vector store config and quality dropped
---

# RAG and Agent Debugging Checklist

When an OpenClaw agent backed by RAG (retrieval-augmented generation) or multiple
tools behaves unexpectedly, the root cause is often not in the model itself.
Problems tend to hide in the retrieval pipeline, data ingestion, prompt assembly,
or tool routing.

This page provides a systematic checklist you can walk through before resorting
to trial-and-error. Each item follows a **symptom, check, fix** pattern.

<Tip>
Before you start, make sure basic gateway health is fine.
Run `openclaw doctor` and `openclaw status --all` first.
See [Troubleshooting](/help/troubleshooting) for the full triage ladder.
</Tip>

## Quick-reference table

| #   | Failure mode                                                                                     | Likely layer      |
| --- | ------------------------------------------------------------------------------------------------ | ----------------- |
| 1   | [Documents not ingested](#1-documents-not-ingested)                                              | Ingestion         |
| 2   | [Wrong or stale documents retrieved](#2-wrong-or-stale-documents-retrieved)                      | Ingestion / index |
| 3   | [Chunking too coarse or too fine](#3-chunking-too-coarse-or-too-fine)                            | Chunking          |
| 4   | [Metadata lost during chunking](#4-metadata-lost-during-chunking)                                | Chunking          |
| 5   | [Embedding model mismatch](#5-embedding-model-mismatch)                                          | Embedding         |
| 6   | [Distance metric mismatch](#6-distance-metric-mismatch)                                          | Vector store      |
| 7   | [Vector index fragmentation or staleness](#7-vector-index-fragmentation-or-staleness)            | Vector store      |
| 8   | [Top-K too low or too high](#8-top-k-too-low-or-too-high)                                        | Retrieval         |
| 9   | [No reranking or bad reranking](#9-no-reranking-or-bad-reranking)                                | Retrieval         |
| 10  | [Retrieved context exceeds the context window](#10-retrieved-context-exceeds-the-context-window) | Context           |
| 11  | [System prompt drift](#11-system-prompt-drift)                                                   | Prompt            |
| 12  | [Hallucinated answers despite good retrieval](#12-hallucinated-answers-despite-good-retrieval)   | Prompt / model    |
| 13  | [Wrong tool selected](#13-wrong-tool-selected)                                                   | Tool routing      |
| 14  | [Tool called in a loop](#14-tool-called-in-a-loop)                                               | Tool routing      |
| 15  | [Tool output ignored or misinterpreted](#15-tool-output-ignored-or-misinterpreted)               | Tool routing      |
| 16  | [Multi-agent routing failure](#16-multi-agent-routing-failure)                                   | Orchestration     |

---

## Ingestion problems

### 1. Documents not ingested

**Symptom:** The agent says "I don't have information about X" even though the
source document exists.

**Check:**

- Verify the document was actually processed by your ingestion pipeline.
- Query your vector store directly (outside OpenClaw) for a known phrase from the
  document. If zero results come back, ingestion failed silently.
- Check file format support: PDFs with scanned images, password-protected files,
  or unusual encodings often fail without error.

**Fix:**

- Re-run ingestion and watch for warnings or skipped-file logs.
- For scanned PDFs, add an OCR step before embedding.
- Normalize file encodings to UTF-8 before ingestion.

### 2. Wrong or stale documents retrieved

**Symptom:** The agent cites outdated or irrelevant information even though newer
documents have been added.

**Check:**

- Confirm that re-indexed documents replaced the old vectors (not appended
  alongside them).
- Check whether your ingestion pipeline deduplicates by document ID or just
  appends.

**Fix:**

- Delete old vectors before re-ingesting updated documents, or use an
  upsert-by-ID strategy.
- Add a `last_updated` metadata field and filter or boost by recency at query
  time.

---

## Chunking problems

### 3. Chunking too coarse or too fine

**Symptom:** Answers are vague (chunks too large, relevant detail is diluted) or
miss important context (chunks too small, critical sentences split across
boundaries).

**Check:**

- Inspect a few raw chunks from your store. Read them as a human: do they make
  sense on their own?
- Look at chunk sizes in tokens. Extreme sizes (fewer than 50 tokens or more than
  2000 tokens) usually cause problems.

**Fix:**

- Use overlap (sliding window) chunking so boundary sentences appear in adjacent
  chunks.
- Tune chunk size for your content type: code benefits from function-level splits;
  prose benefits from paragraph-level splits.
- Consider semantic chunking (split on topic change) rather than fixed-length
  splits.

### 4. Metadata lost during chunking

**Symptom:** The agent retrieves a relevant snippet but cannot tell the user which
document, section, or page it came from.

**Check:**

- Inspect stored metadata alongside your vectors. Is the source filename, heading,
  or page number preserved?

**Fix:**

- Attach source metadata (filename, section heading, URL, page number) to each
  chunk at ingestion time.
- Prepend a short header to each chunk text (e.g., `[source: design-spec.md,
section: Authentication]`) so the model sees provenance even without structured
  metadata.

---

## Embedding problems

### 5. Embedding model mismatch

**Symptom:** Queries return semantically unrelated chunks, or recall drops after
switching embedding models.

**Check:**

- Confirm that the model used to embed documents at ingestion time is the same
  model used to embed queries at retrieval time. Mixing models produces vectors
  in incompatible spaces.
- Check embedding dimensionality: if your store expects 1536 dimensions but the
  model produces 768, results will be garbage.

**Fix:**

- Re-embed all documents whenever you change the embedding model.
- Pin the embedding model version in your pipeline config to prevent silent
  upgrades.

### 6. Distance metric mismatch

**Symptom:** Top results have high similarity scores but are clearly irrelevant,
or the ordering feels random.

**Check:**

- Verify the distance metric configured in your vector store (cosine, dot product,
  L2) matches the metric the embedding model was trained for.
- Most modern embedding models are trained for cosine similarity.

**Fix:**

- Set your vector store index to use cosine similarity unless the embedding model
  documentation explicitly recommends a different metric.
- After changing the metric, rebuild the index (some stores require this; others
  apply it at query time).

---

## Vector store problems

### 7. Vector index fragmentation or staleness

**Symptom:** Queries are slow, or recall degrades over time even though new
documents were ingested correctly.

**Check:**

- Check your vector store dashboard or logs for index health metrics (segment
  count, deleted vectors ratio, index build status).
- Some stores (e.g., Milvus, Qdrant) require explicit compaction or index
  rebuilds after many upserts/deletes.

**Fix:**

- Run compaction or vacuum on the vector store.
- Rebuild the index if the store supports it without downtime, or schedule
  periodic rebuilds.

---

## Retrieval problems

### 8. Top-K too low or too high

**Symptom:** With low K, the agent misses relevant documents. With high K, the
agent gets confused by irrelevant noise or exceeds the context window.

**Check:**

- Experiment with the same query at K=3, K=10, and K=20. Check whether the
  relevant chunk appears and at what rank.

**Fix:**

- Start with K=5 to K=10 and adjust based on your content density.
- Combine with a reranker (see below) so you can retrieve a larger candidate set
  and then filter down.

### 9. No reranking or bad reranking

**Symptom:** The correct document appears in the top-20 results but not in the
top-5 that the agent actually sees.

**Check:**

- Determine whether your pipeline has a reranking step between vector search and
  context injection. If not, retrieval relies entirely on embedding similarity,
  which is often not enough.

**Fix:**

- Add a cross-encoder reranker (e.g., Cohere Rerank, a local cross-encoder model)
  between the retrieval and prompt-building stages.
- If a reranker is already present, check its model version and whether it matches
  your domain.

---

## Context window problems

### 10. Retrieved context exceeds the context window

**Symptom:** The agent truncates or ignores retrieved context. Answers degrade as
more documents are added.

**Check:**

- Use `/context detail` in OpenClaw to see how much of the context window is
  consumed by system prompt, conversation history, and injected context.
- See [Context](/concepts/context) for background on window management.

**Fix:**

- Reduce the number of retrieved chunks or their size.
- Use [Compaction](/concepts/compaction) to manage conversation history size.
- Summarize retrieved chunks before injecting them (map-reduce RAG pattern).

---

## Prompt problems

### 11. System prompt drift

**Symptom:** The agent used to answer correctly but quality degraded after prompt
or configuration changes, even though retrieval still returns good results.

**Check:**

- Compare the current system prompt (visible via `/context list`) against a known
  good version.
- Look for accidental overwrites in workspace bootstrap files (`BOOTSTRAP.md`,
  `AGENTS.md`).
- See [System Prompt](/concepts/system-prompt) for the prompt assembly order.

**Fix:**

- Version-control your system prompt and workspace bootstrap files.
- Keep RAG-specific instructions (e.g., "only answer from retrieved context")
  in a dedicated section of the system prompt or a skill file so they are easy
  to audit.

### 12. Hallucinated answers despite good retrieval

**Symptom:** The retrieved chunks are correct, but the agent invents details or
contradicts the source material.

**Check:**

- Verify that your system prompt includes an explicit grounding instruction (e.g.,
  "answer only based on the provided context; if the context does not contain the
  answer, say so").
- Check the model temperature: high temperature increases hallucination risk.

**Fix:**

- Add or strengthen the grounding instruction in your system prompt.
- Lower temperature (0.0 to 0.3 for factual Q&A workloads).
- Ask the model to quote or cite the retrieved chunk to force grounding.

---

## Tool routing problems

### 13. Wrong tool selected

**Symptom:** The agent calls a search tool when it should call a database tool, or
vice versa. Tool names or descriptions are ambiguous.

**Check:**

- Review the tool schemas visible to the model (`/context detail` shows tool
  schema sizes and names).
- Look for overlapping or vague tool descriptions.

**Fix:**

- Make tool names and descriptions unambiguous. Each tool should have a clear,
  non-overlapping purpose.
- Reduce the total number of tools available to the agent. Fewer tools means
  less confusion.
- Use skill-based tool gating so only relevant tools are loaded per task.
  See [Skills](/tools/skills).

### 14. Tool called in a loop

**Symptom:** The agent calls the same tool repeatedly with the same or similar
inputs, burning tokens without making progress.

**Check:**

- Enable [Tool-loop detection](/tools/loop-detection) and check whether it fires.
- Review session logs (`openclaw logs --follow`) for repeated tool-call patterns.

**Fix:**

- Enable the built-in loop detection guard:
  ```json5
  {
    tools: {
      loopDetection: {
        enabled: true,
        repeatThreshold: 3,
        criticalThreshold: 6,
      },
    },
  }
  ```
- Improve the tool's error messages so the model gets actionable feedback on
  failure rather than a generic error.
- Add a "no results found" path in the tool response so the model knows to stop
  retrying.

### 15. Tool output ignored or misinterpreted

**Symptom:** The tool returns correct data, but the agent's final answer does not
reflect it.

**Check:**

- Inspect the raw tool output in session logs. Is the output too large, causing
  truncation? Is the format difficult for the model to parse (e.g., deeply nested
  JSON)?
- Check whether the tool output arrives after context window limits are hit.

**Fix:**

- Keep tool output concise. Summarize or truncate large outputs before returning
  them.
- Use structured but flat output formats (key-value pairs, Markdown tables) rather
  than deeply nested JSON.
- If tool output is very large, consider returning a summary with a reference ID
  the agent can use to fetch details in a follow-up call.

---

## Multi-agent problems

### 16. Multi-agent routing failure

**Symptom:** Tasks are sent to the wrong sub-agent, or agents duplicate work
because routing is unclear.

**Check:**

- Review your agent routing configuration and agent descriptions.
- Check whether the orchestrator agent has clear instructions on which sub-agent
  handles which domain.
- See [Multi-agent](/concepts/multi-agent) and [Subagents](/tools/subagents) for
  configuration details.

**Fix:**

- Give each agent a clear, non-overlapping description of its scope.
- Add routing instructions to the orchestrator's system prompt.
- Test routing by sending a range of queries and checking which agent handles
  each one.

---

## General debugging workflow

When none of the specific checks above match your problem, follow this general
workflow:

1. **Reproduce** the failure with a specific query.
2. **Check retrieval** independently: query your vector store directly (outside
   the agent) and verify the results make sense.
3. **Check context**: use `/context detail` to see what the model actually
   receives.
4. **Check tool calls**: review session logs (`openclaw logs --follow`) for
   unexpected tool invocations.
5. **Check the prompt**: compare your system prompt and workspace files against a
   known good state.
6. **Isolate the layer**: if retrieval is good but answers are bad, the problem is
   in the prompt or model configuration. If retrieval is bad, fix the pipeline
   first.

## Further reading

- [Troubleshooting](/help/troubleshooting) -- general OpenClaw triage ladder
- [Context](/concepts/context) -- what the model sees and how to inspect it
- [Compaction](/concepts/compaction) -- managing conversation history size
- [System Prompt](/concepts/system-prompt) -- how the prompt is assembled
- [Tool-loop detection](/tools/loop-detection) -- built-in loop guardrails
- [Skills](/tools/skills) -- task-specific tool and instruction loading
- [Multi-agent](/concepts/multi-agent) -- multi-agent orchestration
- [Logging](/logging) -- gateway and agent log access
