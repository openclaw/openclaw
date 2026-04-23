from __future__ import annotations

import heapq
import json
import math
import re
import sqlite3
from dataclasses import dataclass
from typing import Any, Iterable

from .semantic import cosine_similarity
from .utils import normalize_whitespace, now_iso

ERROR_CODE_RE = re.compile(r"\b[A-Z][A-Z0-9_-]*-\d+\b")
FILE_PATH_RE = re.compile(r"(?<!\w)(?:~|/|\./|\../)[\w./\-]+")
TOKEN_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{1,}")
NONCURRENT_QUERY_RE = re.compile(r"\b(old|older|deprecated|archived|legacy|historical|previous|prior)\b", re.I)
DOCUMENT_AUTHORING_INTENT_RE = re.compile(
    r"\b("
    r"document\s+(?:this|what|what's|whats|the|it|changes?|done)"
    r"|document(?:ation)?\b.*\b(?:create|update|write|record|done)"
    r"|(?:break\s*down|breakdown|create|summari[sz]e|update|write|record)\b.*\b(?:docs?|documentation|runbook)"
    r"|runbook\s+doc"
    r")\b",
    re.I,
)

LEXICAL_CANDIDATE_LIMIT = 50
VECTOR_CANDIDATE_LIMIT = 50
STOPWORDS = {
    "a",
    "about",
    "already",
    "also",
    "an",
    "and",
    "any",
    "are",
    "as",
    "at",
    "be",
    "been",
    "but",
    "by",
    "can",
    "could",
    "did",
    "do",
    "does",
    "done",
    "for",
    "from",
    "give",
    "had",
    "has",
    "have",
    "haven",
    "here",
    "how",
    "if",
    "in",
    "into",
    "is",
    "it",
    "like",
    "me",
    "my",
    "need",
    "not",
    "of",
    "on",
    "or",
    "out",
    "plan",
    "read",
    "run",
    "setup",
    "so",
    "take",
    "that",
    "the",
    "their",
    "them",
    "then",
    "there",
    "this",
    "to",
    "up",
    "use",
    "was",
    "want",
    "way",
    "were",
    "what",
    "when",
    "where",
    "which",
    "why",
    "with",
    "would",
    "you",
    "your",
}
DOMAIN_GENERIC_TOKENS = {
    "codex",
    "create",
    "directory",
    "doc",
    "docs",
    "document",
    "documentation",
    "documents",
    "open",
    "openclaw",
    "runbook",
}
COMMAND_NAME_RE = re.compile(r"^\s*(?:sudo\s+)?([A-Za-z0-9_.+-]+)")
_CANDIDATE_COLUMNS_SQL = """
    c.chunk_id, c.doc_id, c.section_path, c.text, d.title, d.type, d.lifecycle_state,
    d.service, d.feature, d.plugin, d.environments_json, d.validation_last_validated_at,
    d.validation_review_interval_days, d.aliases_json, d.synopsis,
    d.retrieval_hints_json, d.not_for_json, d.commands_json,
    d.updated_at, d.canonical_path
""".strip()


@dataclass(slots=True)
class RetrievedDoc:
    doc_id: str
    title: str
    type: str
    lifecycle_state: str
    service: str
    plugin: str
    environments: list[str]
    last_validated_at: str
    why_matched: list[str]
    score: float
    canonical_path: str | None


@dataclass(slots=True)
class RetrievedChunk:
    chunk_id: str
    doc_id: str
    section_path: str
    text: str
    score: float
    why_matched: list[str]


def detect_hard_tokens(query: str) -> dict[str, list[str]]:
    return {
        "error_codes": ERROR_CODE_RE.findall(query),
        "file_paths": FILE_PATH_RE.findall(query),
        "tokens": TOKEN_RE.findall(query),
    }


def _meaningful_tokens(tokens: Iterable[str], *, include_domain_generic: bool = True) -> list[str]:
    meaningful: list[str] = []
    seen: set[str] = set()
    for token in tokens:
        token_l = token.lower().strip().strip(".,!?;:/")
        if not token_l or token_l in seen:
            continue
        if token_l in STOPWORDS:
            continue
        has_symbol = any(ch in token_l for ch in "/:._-")
        if len(token_l) < 3 and not has_symbol:
            continue
        if not include_domain_generic and token_l in DOMAIN_GENERIC_TOKENS:
            continue
        meaningful.append(token_l)
        seen.add(token_l)
    return meaningful


def _text_tokens(text: str, *, include_domain_generic: bool = True) -> list[str]:
    return _meaningful_tokens(TOKEN_RE.findall(text), include_domain_generic=include_domain_generic)


def _distinctive_tokens(tokens: Iterable[str]) -> list[str]:
    distinctive: list[str] = []
    for token in _meaningful_tokens(tokens, include_domain_generic=False):
        if len(token) >= 4 or any(ch in token for ch in "/:._-") or any(ch.isdigit() for ch in token):
            distinctive.append(token)
    return distinctive


def _is_specific_file_path(path: str) -> bool:
    path_l = path.lower().rstrip("/")
    if path_l in {"/documents", "~/documents", "documents"}:
        return False
    parts = [part for part in re.split(r"/+", path_l) if part and part != "~"]
    basename = parts[-1] if parts else ""
    if parts[:1] == ["documents"] and len(parts) <= 2 and "." not in basename and len(basename) < 4:
        return False
    return len(parts) >= 3 or "." in basename or len(path_l) >= 16


def _is_specific_token_path(token: str) -> bool:
    if "/" not in token:
        return True
    candidate = token if token.startswith(("/", "~", ".", "..")) else f"/{token}"
    return _is_specific_file_path(candidate)


def _document_authoring_boost(row: sqlite3.Row, query: str) -> tuple[float, list[str]]:
    if not DOCUMENT_AUTHORING_INTENT_RE.search(query):
        return 0.0, []
    service = str(row["service"] or "").lower()
    feature = str(row["feature"] or "").lower()
    plugin = str(row["plugin"] or "").lower()
    if service == "runbook-memory" and (feature == "authoring" or plugin == "runbook-memory"):
        return 2.2, ["document authoring intent"]
    return 0.0, []


def infer_filters(query: str, *, service: str | None = None, feature: str | None = None, plugin: str | None = None, environment: str | None = None, lifecycle_preference: str | None = None) -> dict[str, Any]:
    filters: dict[str, Any] = {}
    if service:
        filters["service"] = service
    if feature:
        filters["feature"] = feature
    if plugin:
        filters["plugin"] = plugin
    if environment:
        filters["environment"] = environment
    if lifecycle_preference:
        filters["lifecycle_preference"] = lifecycle_preference
    hard = detect_hard_tokens(query)
    if hard["error_codes"]:
        filters["error_codes"] = hard["error_codes"]
    if hard["file_paths"]:
        filters["file_paths"] = hard["file_paths"]
    return filters


def build_fts_query(query: str) -> str:
    hard = detect_hard_tokens(query)
    parts: list[str] = []
    for token in hard["error_codes"] + hard["file_paths"]:
        if token in hard["error_codes"] or _is_specific_file_path(token):
            parts.append(f'"{token}"')
    for token in _meaningful_tokens(hard["tokens"]):
        if len(token) > 2 and token not in {part.strip('"').lower() for part in parts}:
            parts.append(f'"{token}"' if any(ch in token for ch in "/:.-_") else token)
    if not parts:
        parts.append(query)
    return " OR ".join(parts)


def _validate_row_filters(row: sqlite3.Row, filters: dict[str, Any]) -> bool:
    if service := filters.get("service"):
        if str(row["service"] or "") != service:
            return False
    if feature := filters.get("feature"):
        if str(row["feature"] or "") != feature:
            return False
    if plugin := filters.get("plugin"):
        if str(row["plugin"] or "") != plugin:
            return False
    if environment := filters.get("environment"):
        envs = set(json.loads(row["environments_json"] or "[]"))
        if environment not in envs:
            return False
    return True


def _lifecycle_boost(lifecycle_state: str, *, lifecycle_preference: str | None = None) -> float:
    score = 0.0
    if lifecycle_state == "active":
        score += 1.0
    elif lifecycle_state == "review":
        score -= 0.1
    elif lifecycle_state == "deprecated":
        score -= 0.8
    elif lifecycle_state == "archived":
        score -= 2.0
    if lifecycle_preference and lifecycle_state == lifecycle_preference:
        score += 0.5
    return score


def _query_requests_noncurrent(query: str, lifecycle_preference: str | None = None) -> bool:
    if lifecycle_preference in {"deprecated", "archived", "review", "all"}:
        return True
    return bool(NONCURRENT_QUERY_RE.search(query))


def _freshness_boost(
    last_validated_at: str,
    updated_at: str,
    review_interval_days: int | None,
    *,
    allow_stale: bool,
) -> tuple[float, str]:
    if not last_validated_at:
        return (-0.05, "freshness: no validation date") if allow_stale else (-0.2, "freshness: no validation date")
    try:
        from datetime import date, datetime

        validated = date.fromisoformat(last_validated_at[:10])
        age_days = (date.today() - validated).days
        review_days = max(1, int(review_interval_days or 30))
        if age_days <= review_days:
            base = 0.35
        elif age_days <= review_days * 2:
            base = 0.1
        else:
            base = -0.35
        if allow_stale and base < 0:
            base = max(base, -0.05)
        if updated_at:
            try:
                updated = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
                if (datetime.now(updated.tzinfo) - updated).days <= 30:
                    base += 0.05
            except Exception:
                pass
        return base, f"freshness: validated {age_days}d ago"
    except Exception:
        return -0.1, "freshness: invalid validation date"


def _decode_json_list(raw: Any) -> list[str]:
    try:
        loaded = json.loads(raw or "[]")
    except Exception:
        return []
    if not isinstance(loaded, list):
        return []
    return [str(item).strip() for item in loaded if str(item).strip()]


def _decode_vector(raw: Any) -> list[float] | None:
    try:
        vector = raw if isinstance(raw, list) else json.loads(raw or "[]")
    except Exception:
        return None
    if not isinstance(vector, list):
        return None
    try:
        return [float(item) for item in vector]
    except Exception:
        return None


def _vector_similarity_from_json(query_vector: list[float] | None, raw_vector: Any) -> float:
    if not query_vector:
        return 0.0
    vector = _decode_vector(raw_vector)
    if not vector:
        return 0.0
    try:
        return cosine_similarity([float(item) for item in query_vector], vector)
    except Exception:
        return 0.0


def _metadata_match_adjustments(row: sqlite3.Row, query: str, hard_tokens: dict[str, list[str]]) -> tuple[float, list[str]]:
    query_l = query.lower()
    query_tokens = _meaningful_tokens(hard_tokens["tokens"])
    distinctive_query_tokens = _distinctive_tokens(hard_tokens["tokens"])
    reasons: list[str] = []
    score = 0.0
    aliases = _decode_json_list(row["aliases_json"])
    hints = _decode_json_list(row["retrieval_hints_json"])
    commands = _decode_json_list(row["commands_json"])
    not_for = _decode_json_list(row["not_for_json"])

    for alias in aliases:
        alias_l = alias.lower()
        if alias_l and alias_l in query_l:
            score += 0.8
            reasons.append(f"alias match: {alias}")
    for command in commands:
        command_l = command.lower()
        command_name = ""
        if match := COMMAND_NAME_RE.match(command_l):
            command_name = match.group(1)
        command_tokens = [
            token
            for token in distinctive_query_tokens
            if (any(ch in token for ch in "/:._-") and _is_specific_token_path(token)) or token == command_name
        ]
        if command_l and (command_l in query_l or any(token in command_l for token in command_tokens)):
            score += 0.6
            reasons.append(f"command index match: {command}")
    for hint in hints:
        hint_l = hint.lower()
        hint_tokens = set(_text_tokens(hint, include_domain_generic=False))
        overlaps = [token for token in distinctive_query_tokens if token in hint_tokens]
        if hint_l and (hint_l in query_l or len(overlaps) >= 2 or (len(hint_tokens) <= 2 and bool(overlaps))):
            score += 0.35
            reasons.append(f"retrieval hint match: {hint}")
    synopsis = str(row["synopsis"] or "").strip()
    if synopsis:
        synopsis_l = synopsis.lower()
        synopsis_hits = [token for token in query_tokens if token in synopsis_l]
        if synopsis_hits:
            score += 0.1 * min(3, len(synopsis_hits))
            reasons.append("synopsis match")
    for blocked in not_for:
        blocked_l = blocked.lower()
        blocked_tokens = set(_text_tokens(blocked, include_domain_generic=False))
        query_token_set = set(query_tokens)
        if blocked_l and (blocked_l in query_l or (blocked_tokens and blocked_tokens.issubset(query_token_set))):
            score -= 1.2
            reasons.append(f"negative routing: {blocked}")
    return score, reasons


def _hotset_counts(conn: sqlite3.Connection) -> dict[str, int]:
    counts: dict[str, int] = {}
    rows = conn.execute("SELECT result_json FROM retrieval_logs ORDER BY id DESC LIMIT 1000").fetchall()
    for row in rows:
        try:
            payload = json.loads(row["result_json"])
        except Exception:
            continue
        top_docs = payload.get("top_docs", [])
        if not isinstance(top_docs, list):
            continue
        for rank, doc in enumerate(top_docs[:5]):
            if not isinstance(doc, dict):
                continue
            doc_id = str(doc.get("doc_id") or "").strip()
            if not doc_id:
                continue
            counts[doc_id] = counts.get(doc_id, 0) + max(1, 5 - rank)
    return counts


def _exact_match_boost(row: sqlite3.Row, hard_tokens: dict[str, list[str]], query: str) -> tuple[float, list[str]]:
    reasons: list[str] = []
    score = 0.0
    haystacks = {
        "title": str(row["title"] or "").lower(),
        "service": str(row["service"] or "").lower(),
        "plugin": str(row["plugin"] or "").lower(),
        "feature": str(row["feature"] or "").lower(),
        "text": str(row["text"] or "").lower(),
        "section_path": str(row["section_path"] or "").lower(),
    }
    for error_code in hard_tokens["error_codes"]:
        if error_code.lower() in haystacks["text"] or error_code.lower() in haystacks["title"]:
            score += 1.5
            reasons.append(f"exact error code match: {error_code}")
    for file_path in hard_tokens["file_paths"]:
        if not _is_specific_file_path(file_path):
            continue
        if file_path.lower() in haystacks["text"] or file_path.lower() in haystacks["title"]:
            score += 1.5
            reasons.append(f"exact file path match: {file_path}")
    for token in _meaningful_tokens(hard_tokens["tokens"], include_domain_generic=False):
        token_l = token.lower()
        if not _is_specific_token_path(token_l):
            continue
        if token_l in haystacks["title"]:
            score += 0.5
            reasons.append(f"title match: {token}")
        elif token_l in haystacks["section_path"] or token_l in haystacks["text"]:
            score += 0.2
            reasons.append(f"text match: {token}")
    if query.strip().lower() == haystacks["title"]:
        score += 1.0
        reasons.append("exact title match")
    return score, reasons


def _vector_candidate_rows(
    conn: sqlite3.Connection,
    query_vector: list[float] | None,
    filters: dict[str, Any],
    *,
    exclude_chunk_ids: set[str],
    limit: int,
) -> list[sqlite3.Row]:
    if not query_vector or limit <= 0:
        return []
    rows: list[tuple[float, int, sqlite3.Row]] = []
    seen = 0
    for row in conn.execute(
        f"""
        SELECT {_CANDIDATE_COLUMNS_SQL}, e.vector_json
        FROM chunk_embeddings e
        JOIN chunks c ON c.chunk_id = e.chunk_id
        JOIN documents d ON d.doc_id = c.doc_id
        """
    ):
        chunk_id = str(row["chunk_id"])
        if chunk_id in exclude_chunk_ids:
            continue
        if not _validate_row_filters(row, filters):
            continue
        similarity = _vector_similarity_from_json(query_vector, row["vector_json"])
        if similarity <= 0:
            continue
        candidate = (similarity, seen, row)
        if len(rows) < limit:
            heapq.heappush(rows, candidate)
        elif similarity > rows[0][0]:
            heapq.heapreplace(rows, candidate)
        seen += 1
    rows.sort(key=lambda item: item[0], reverse=True)
    return [row for _, _, row in rows]


def _merge_candidate_rows(*groups: Iterable[sqlite3.Row]) -> list[sqlite3.Row]:
    merged: dict[str, sqlite3.Row] = {}
    for rows in groups:
        for row in rows:
            chunk_id = str(row["chunk_id"])
            if chunk_id not in merged:
                merged[chunk_id] = row
    return list(merged.values())


def _vector_similarity(conn: sqlite3.Connection, row: sqlite3.Row, query_vector: list[float] | None) -> float:
    if not query_vector:
        return 0.0
    embedding = conn.execute(
        "SELECT vector_json FROM chunk_embeddings WHERE chunk_id = ?",
        (row["chunk_id"],),
    ).fetchone()
    if not embedding:
        return 0.0
    try:
        return _vector_similarity_from_json(query_vector, embedding["vector_json"])
    except Exception:
        return 0.0


def _query_vector(query: str, embedding_model: str | None = None) -> list[float] | None:
    if not embedding_model:
        return None
    try:
        from .semantic import EmbeddingBackend

        backend = EmbeddingBackend.load(embedding_model)
        vectors = backend.encode([query]) if backend.available else None
        return vectors[0] if vectors else None
    except Exception:
        return None


def search(
    conn: sqlite3.Connection,
    query: str,
    *,
    service: str | None = None,
    feature: str | None = None,
    plugin: str | None = None,
    environment: str | None = None,
    lifecycle_preference: str | None = None,
    top_k: int = 5,
    embedding_model: str | None = None,
    use_hotset: bool = True,
    log_result: bool = True,
) -> dict[str, Any]:
    filters = infer_filters(
        query,
        service=service,
        feature=feature,
        plugin=plugin,
        environment=environment,
        lifecycle_preference=lifecycle_preference,
    )
    hard_tokens = detect_hard_tokens(query)
    lexical_query = build_fts_query(query)
    raw_lexical_rows = conn.execute(
        f"""
        SELECT {_CANDIDATE_COLUMNS_SQL}, bm25(chunk_fts) AS fts_score
        FROM chunk_fts
        JOIN chunks c ON c.chunk_id = chunk_fts.chunk_id
        JOIN documents d ON d.doc_id = c.doc_id
        WHERE chunk_fts MATCH ?
        ORDER BY fts_score
        LIMIT {LEXICAL_CANDIDATE_LIMIT}
        """,
        (lexical_query,),
    ).fetchall()

    query_vector = _query_vector(query, embedding_model)
    allow_stale = _query_requests_noncurrent(query, lifecycle_preference=lifecycle_preference)
    hotset_counts = _hotset_counts(conn) if use_hotset else {}
    lexical_rows: list[sqlite3.Row] = []
    lexical_chunk_ids: set[str] = set()
    for row in raw_lexical_rows:
        if not _validate_row_filters(row, filters):
            continue
        lexical_rows.append(row)
        lexical_chunk_ids.add(str(row["chunk_id"]))
    vector_limit = min(VECTOR_CANDIDATE_LIMIT, max(top_k * 4, 20))
    vector_rows = _vector_candidate_rows(
        conn,
        query_vector,
        filters,
        exclude_chunk_ids=lexical_chunk_ids,
        limit=vector_limit,
    )
    candidate_rows = _merge_candidate_rows(lexical_rows, vector_rows)
    ranked_chunks: list[RetrievedChunk] = []
    doc_scores: dict[str, float] = {}
    doc_reasons: dict[str, list[str]] = {}
    for row in candidate_rows:
        exact_boost, exact_reasons = _exact_match_boost(row, hard_tokens, query)
        metadata_boost, metadata_reasons = _metadata_match_adjustments(row, query, hard_tokens)
        intent_boost, intent_reasons = _document_authoring_boost(row, query)
        semantic_score = max(0.0, _vector_similarity(conn, row, query_vector))
        fts_score = row["fts_score"] if "fts_score" in row.keys() else None
        lexical_score = max(0.0, 1.0 / (1.0 + abs(float(fts_score)))) if fts_score is not None else 0.0
        score = (0.65 * lexical_score) + (0.35 * semantic_score) + exact_boost + metadata_boost + intent_boost
        score += _lifecycle_boost(str(row["lifecycle_state"] or ""), lifecycle_preference=lifecycle_preference)
        freshness_boost, freshness_reason = _freshness_boost(
            str(row["validation_last_validated_at"] or ""),
            str(row["updated_at"] or ""),
            int(row["validation_review_interval_days"] or 30),
            allow_stale=allow_stale,
        )
        score += freshness_boost
        hotset_weight = hotset_counts.get(str(row["doc_id"]), 0)
        if hotset_weight > 0:
            score += min(0.3, math.log1p(hotset_weight) * 0.06)
        reasons = list(dict.fromkeys(exact_reasons + metadata_reasons + intent_reasons))
        if semantic_score > 0:
            reasons.append(f"semantic similarity: {semantic_score:.3f}")
        reasons.append(f"lexical score: {lexical_score:.3f}")
        reasons.append(f"lifecycle: {row['lifecycle_state']}")
        reasons.append(freshness_reason)
        if hotset_weight > 0:
            reasons.append(f"hotset boost: {hotset_weight}")
        ranked_chunks.append(
            RetrievedChunk(
                chunk_id=str(row["chunk_id"]),
                doc_id=str(row["doc_id"]),
                section_path=str(row["section_path"]),
                text=str(row["text"]),
                score=round(score, 4),
                why_matched=reasons,
            )
        )
        doc_scores[row["doc_id"]] = max(doc_scores.get(row["doc_id"], float("-inf")), score)
        doc_reasons.setdefault(row["doc_id"], []).extend(reasons)

    ranked_chunks.sort(key=lambda item: item.score, reverse=True)
    top_chunks = ranked_chunks[:top_k]

    top_doc_ids = [
        doc_id
        for doc_id, _score in sorted(doc_scores.items(), key=lambda item: item[1], reverse=True)[:top_k]
    ]

    top_docs: list[RetrievedDoc] = []
    for doc_id in top_doc_ids:
        doc = conn.execute("SELECT * FROM documents WHERE doc_id = ?", (doc_id,)).fetchone()
        if not doc:
            continue
        top_docs.append(
            RetrievedDoc(
                doc_id=str(doc["doc_id"]),
                title=str(doc["title"]),
                type=str(doc["type"]),
                lifecycle_state=str(doc["lifecycle_state"]),
                service=str(doc["service"] or ""),
                plugin=str(doc["plugin"] or ""),
                environments=list(json.loads(doc["environments_json"] or "[]")),
                last_validated_at=str(doc["validation_last_validated_at"] or ""),
                why_matched=list(dict.fromkeys(doc_reasons.get(doc_id, []))),
                score=round(doc_scores.get(doc_id, 0.0), 4),
                canonical_path=str(doc["canonical_path"] or ""),
            )
        )

    confidence = 0.0
    if top_docs:
        confidence = min(1.0, max(0.05, top_docs[0].score / 5.0))
    result = {
        "query": query,
        "filters": filters,
        "top_docs": [
            {
                "doc_id": doc.doc_id,
                "title": doc.title,
                "type": doc.type,
                "lifecycle_state": doc.lifecycle_state,
                "service": doc.service,
                "plugin": doc.plugin,
                "environments": doc.environments,
                "last_validated_at": doc.last_validated_at,
                "synopsis": str(conn.execute("SELECT synopsis FROM documents WHERE doc_id = ?", (doc.doc_id,)).fetchone()["synopsis"] or ""),
                "why_matched": doc.why_matched,
                "score": doc.score,
                "canonical_path": doc.canonical_path,
            }
            for doc in top_docs
        ],
        "top_chunks": [
            {
                "chunk_id": chunk.chunk_id,
                "doc_id": chunk.doc_id,
                "section_path": chunk.section_path,
                "text": chunk.text,
                "score": chunk.score,
                "why_matched": chunk.why_matched,
            }
            for chunk in top_chunks
        ],
        "explanations": [
            "lexical FTS5 candidate generation",
            "optional semantic retrieval",
            "lifecycle and validation boosts",
            "exact token boosting",
        ],
        "confidence": round(confidence, 3),
        "retrieved_at": now_iso(),
    }
    if log_result:
        conn.execute(
            "INSERT INTO retrieval_logs(query, filters_json, result_json, confidence, created_at) VALUES (?, ?, ?, ?, ?)",
            (query, json.dumps(filters, sort_keys=True), json.dumps(result, sort_keys=True), confidence, now_iso()),
        )
        conn.commit()
    return result


def lookup_document(conn: sqlite3.Connection, identifier: str) -> sqlite3.Row | None:
    identifier = identifier.strip()
    if not identifier:
        return None
    doc = conn.execute("SELECT * FROM documents WHERE doc_id = ?", (identifier,)).fetchone()
    if doc:
        return doc
    alias = conn.execute("SELECT doc_id FROM document_aliases WHERE alias = ?", (identifier,)).fetchone()
    if alias:
        return conn.execute("SELECT * FROM documents WHERE doc_id = ?", (alias["doc_id"],)).fetchone()
    lowered = identifier.lower()
    doc = conn.execute(
        "SELECT * FROM documents WHERE lower(title) = ? OR lower(canonical_path) = ?",
        (lowered, lowered),
    ).fetchone()
    return doc


def document_payload(conn: sqlite3.Connection, doc_id: str) -> dict[str, Any]:
    doc = conn.execute("SELECT * FROM documents WHERE doc_id = ?", (doc_id,)).fetchone()
    if not doc:
        raise KeyError(doc_id)
    chunks = conn.execute(
        "SELECT * FROM chunks WHERE doc_id = ? ORDER BY ordinal",
        (doc_id,),
    ).fetchall()
    cards = conn.execute("SELECT * FROM cards WHERE doc_id = ?", (doc_id,)).fetchone()
    summaries = conn.execute(
        "SELECT section_path, summary_text FROM section_summaries WHERE doc_id = ? ORDER BY section_path",
        (doc_id,),
    ).fetchall()
    return {
        "document": dict(doc),
        "chunks": [dict(row) for row in chunks],
        "card": dict(cards) if cards else None,
        "section_summaries": [dict(row) for row in summaries],
    }
