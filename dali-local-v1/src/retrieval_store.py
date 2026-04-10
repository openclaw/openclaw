from __future__ import annotations

from typing import Any

from document_store import get_document, search_document_chunks
from memory_store import search_reflections_text


def _truncate(text: str | None, max_chars: int) -> str:
    normalized = (text or "").strip()
    if len(normalized) <= max_chars:
        return normalized
    return normalized[: max_chars - 1].rstrip() + "…"


def build_context_bundle(
    db_path: str,
    *,
    query: str,
    corpus_id: str | None = None,
    topic: str | None = None,
    document_limit: int = 4,
    chunk_limit: int = 2,
    reflection_limit: int = 3,
    max_chars: int = 6000,
) -> dict[str, Any]:
    document_hits = search_document_chunks(
        db_path,
        query=query,
        corpus_id=corpus_id,
        topic=topic,
        limit=max(document_limit * max(chunk_limit, 1) * 3, document_limit),
    )

    grouped_documents: dict[str, dict[str, Any]] = {}
    for hit in document_hits:
        document_id = hit["document_id"]
        entry = grouped_documents.get(document_id)
        if entry is None:
            document = get_document(db_path, document_id=document_id, corpus_id=corpus_id)
            if document is None:
                continue
            entry = {"document": document, "matches": []}
            grouped_documents[document_id] = entry
        if len(entry["matches"]) < chunk_limit:
            entry["matches"].append(
                {
                    "chunk_index": hit["chunk_index"],
                    "snippet": hit["snippet"],
                    "score": hit["score"],
                    "source_chunk_id": hit["source_chunk_id"],
                }
            )
        if len(grouped_documents) >= document_limit and all(
            len(item["matches"]) >= chunk_limit for item in grouped_documents.values()
        ):
            break

    document_results: list[dict[str, Any]] = []
    blocks: list[str] = []
    for entry in list(grouped_documents.values())[:document_limit]:
        document = entry["document"]
        result = {
            "id": document["id"],
            "hash8": document["hash8"],
            "title": document["title"],
            "topic": document["topic"],
            "published": document["published"],
            "arxiv_id": document["arxiv_id"],
            "summary_text": document.get("summary_text"),
            "matches": entry["matches"],
        }
        document_results.append(result)

        lines = [
            f"[Document] {document['title']}",
            f"hash8: {document['hash8']}",
        ]
        if document.get("topic"):
            lines.append(f"topic: {document['topic']}")
        if document.get("published"):
            lines.append(f"published: {document['published']}")
        if document.get("arxiv_id"):
            lines.append(f"arxiv: {document['arxiv_id']}")
        if document.get("summary_text"):
            lines.append(f"summary: {_truncate(document['summary_text'], 600)}")
        for match in entry["matches"]:
            lines.append(f"excerpt {match['chunk_index']}: {_truncate(match['snippet'], 500)}")
        blocks.append("\n".join(lines))

    reflection_hits = search_reflections_text(db_path, query=query, limit=reflection_limit)
    reflection_results: list[dict[str, Any]] = []
    for hit in reflection_hits:
        reflection_results.append(
            {
                "id": hit["id"],
                "created_at": hit["created_at"],
                "memory_candidate_score": hit["memory_candidate_score"],
                "text_score": hit["text_score"],
                "reflection_text": hit["reflection_text"],
            }
        )
        blocks.append(
            "\n".join(
                [
                    f"[Reflection] {hit['id']}",
                    f"created_at: {hit['created_at']}",
                    f"text: {_truncate(hit['reflection_text'], 500)}",
                ]
            )
        )

    context_parts: list[str] = []
    used_chars = 0
    for block in blocks:
        candidate = block if not context_parts else f"\n\n{block}"
        if used_chars + len(candidate) > max_chars:
            break
        context_parts.append(candidate if not context_parts else block)
        used_chars += len(candidate)
    context_text = "\n\n".join(context_parts)

    return {
        "query": query,
        "documents": document_results,
        "reflections": reflection_results,
        "contextText": context_text,
    }
