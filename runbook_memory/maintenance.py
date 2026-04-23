from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path
from typing import Any, Iterable

from .indexer import compute_duplicate_candidates
from .migration import missing_metadata_counts, scan_stale_docs, update_changed_docs
from .retrieval import search
from .utils import normalize_whitespace, now_iso

LOW_CONFIDENCE_REVIEW_THRESHOLD = 0.35
LOW_CONFIDENCE_REVIEW_LIMIT = 10
LOW_CONFIDENCE_REVIEW_TOP_DOCS = 3


def changed_docs_index(
    conn,
    *,
    roots: Iterable[Path],
    runbooks_root: Path,
    embedding_model: str | None = None,
) -> dict[str, Any]:
    changed = update_changed_docs(
        conn,
        roots=roots,
        runbooks_root=runbooks_root,
        embedding_model=embedding_model,
    )
    return {"changed_docs": changed, "count": len(changed)}


def stale_doc_queue(conn) -> list[dict[str, Any]]:
    return scan_stale_docs(conn)


def duplicate_scan(conn) -> list[dict[str, Any]]:
    return compute_duplicate_candidates(conn)


def _low_confidence_review_top_docs(result_json: str, *, limit: int) -> list[dict[str, str]]:
    if limit <= 0:
        return []
    try:
        payload = json.loads(result_json)
    except Exception:
        return []
    top_docs = payload.get("top_docs", [])
    if not isinstance(top_docs, list):
        return []
    docs: list[dict[str, str]] = []
    for doc in top_docs:
        if not isinstance(doc, dict):
            continue
        doc_id = str(doc.get("doc_id") or "").strip()
        if not doc_id:
            continue
        docs.append(
            {
                "doc_id": doc_id,
                "title": str(doc.get("title") or "").strip(),
            }
        )
        if len(docs) >= limit:
            break
    return docs


def low_confidence_review_queue(
    conn,
    *,
    threshold: float = LOW_CONFIDENCE_REVIEW_THRESHOLD,
    limit: int = LOW_CONFIDENCE_REVIEW_LIMIT,
    top_docs_limit: int = LOW_CONFIDENCE_REVIEW_TOP_DOCS,
) -> dict[str, Any]:
    threshold = max(0.0, min(1.0, float(threshold)))
    limit = max(0, int(limit))
    top_docs_limit = max(0, int(top_docs_limit))
    rows = conn.execute(
        """
        SELECT query, result_json, confidence, created_at
        FROM retrieval_logs
        WHERE confidence < ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
        """,
        (threshold, limit),
    ).fetchall()
    items = []
    for row in rows:
        items.append(
            {
                "query": normalize_whitespace(str(row["query"] or "")),
                "confidence": round(float(row["confidence"] or 0.0), 3),
                "created_at": str(row["created_at"] or ""),
                "top_docs": _low_confidence_review_top_docs(str(row["result_json"] or ""), limit=top_docs_limit),
            }
        )
    return {
        "threshold": round(threshold, 3),
        "limit": limit,
        "count": len(items),
        "items": items,
    }


def health_report(conn) -> dict[str, Any]:
    docs = conn.execute("SELECT COUNT(*) AS count FROM documents").fetchone()["count"]
    chunks = conn.execute("SELECT COUNT(*) AS count FROM chunks").fetchone()["count"]
    cards = conn.execute("SELECT COUNT(*) AS count FROM cards").fetchone()["count"]
    return {
        "documents": docs,
        "chunks": chunks,
        "cards": cards,
        "stale_docs": len(scan_stale_docs(conn)),
        "duplicate_candidates": len(compute_duplicate_candidates(conn)),
        "missing_metadata_counts": missing_metadata_counts(conn),
        "low_confidence_review_queue": low_confidence_review_queue(conn),
    }


def hotset_index(conn, *, limit: int = 20) -> dict[str, Any]:
    counts: Counter[str] = Counter()
    example_queries: dict[str, list[str]] = {}
    rows = conn.execute("SELECT query, result_json FROM retrieval_logs ORDER BY id DESC LIMIT 5000").fetchall()
    for row in rows:
        try:
            payload = json.loads(row["result_json"])
        except Exception:
            continue
        top_docs = payload.get("top_docs", [])
        if not isinstance(top_docs, list):
            continue
        query = str(row["query"] or "").strip()
        for rank, doc in enumerate(top_docs[:5]):
            if not isinstance(doc, dict):
                continue
            doc_id = str(doc.get("doc_id") or "").strip()
            if not doc_id:
                continue
            counts[doc_id] += max(1, 5 - rank)
            if query:
                example_queries.setdefault(doc_id, [])
                if query not in example_queries[doc_id] and len(example_queries[doc_id]) < 3:
                    example_queries[doc_id].append(query)

    docs: list[dict[str, Any]] = []
    for doc_id, score in counts.most_common(limit):
        row = conn.execute(
            "SELECT doc_id, title, type, canonical_path, lifecycle_state, validation_last_validated_at FROM documents WHERE doc_id = ?",
            (doc_id,),
        ).fetchone()
        if not row:
            continue
        docs.append(
            {
                "doc_id": str(row["doc_id"]),
                "title": str(row["title"]),
                "type": str(row["type"]),
                "canonical_path": str(row["canonical_path"] or ""),
                "lifecycle_state": str(row["lifecycle_state"] or ""),
                "last_validated_at": str(row["validation_last_validated_at"] or ""),
                "hotset_score": int(score),
                "example_queries": example_queries.get(doc_id, []),
            }
        )
    return {
        "generated_at": now_iso(),
        "logs_considered": len(rows),
        "limit": limit,
        "docs": docs,
    }


DEFAULT_EVAL_KEYWORDS = [
    "doc",
    "docs",
    "runbook",
    "openclaw",
    "plugin",
    "signal",
    "calendar",
    "oauth",
    "config",
    "command",
    "error",
    "redact",
    "privacy",
    "memory",
]
SHELL_PROMPT_RE = re.compile(r"\b[a-z0-9_.-]+@[a-z0-9_.-]+:[^\n]*\$", re.I)


def transcript_eval_set_from_history(
    history_path: Path,
    *,
    output_path: Path,
    limit: int = 20,
    keywords: Iterable[str] | None = None,
) -> dict[str, Any]:
    keys = [str(item).strip().lower() for item in (keywords or DEFAULT_EVAL_KEYWORDS) if str(item).strip()]
    kept: list[dict[str, Any]] = []
    seen_queries: set[str] = set()
    total = 0
    for line in history_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        total += 1
        try:
            payload = json.loads(line)
        except Exception:
            continue
        query = normalize_whitespace(str(payload.get("text") or ""))
        if len(query) < 24:
            continue
        if len(query) > 450:
            continue
        if SHELL_PROMPT_RE.search(query):
            continue
        if query.count(" sudo ") > 2:
            continue
        lowered = query.lower()
        if keys and not any(key in lowered for key in keys):
            continue
        if query in seen_queries:
            continue
        seen_queries.add(query)
        matched_tags = [key for key in keys if key in lowered][:6]
        kept.append(
            {
                "query_id": f"eval_{len(kept) + 1:03d}",
                "query": query,
                "source": "codex_history",
                "session_id": str(payload.get("session_id") or ""),
                "ts": int(payload.get("ts") or 0),
                "tags": matched_tags,
            }
        )
        if len(kept) >= limit:
            break
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("".join(json.dumps(item, ensure_ascii=False) + "\n" for item in kept), encoding="utf-8")
    return {
        "generated_at": now_iso(),
        "history_path": str(history_path),
        "output_path": str(output_path),
        "records_considered": total,
        "queries_written": len(kept),
    }


def _load_eval_cases(eval_set_path: Path) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    if not eval_set_path.exists():
        return cases
    for line_number, line in enumerate(eval_set_path.read_text(encoding="utf-8").splitlines(), start=1):
        line = line.strip()
        if not line:
            continue
        try:
            payload = json.loads(line)
        except Exception:
            cases.append({
                "query_id": f"invalid_{line_number}",
                "query": "",
                "error": "invalid json",
            })
            continue
        if isinstance(payload, dict):
            cases.append(payload)
    return cases


def _write_eval_cases(eval_set_path: Path, cases: list[dict[str, Any]]) -> None:
    eval_set_path.parent.mkdir(parents=True, exist_ok=True)
    text = "".join(json.dumps(case, sort_keys=True, ensure_ascii=False) + "\n" for case in cases)
    eval_set_path.write_text(text, encoding="utf-8")


def _expected_doc_ids(case: dict[str, Any]) -> list[str]:
    expected = case.get("expected_doc_ids")
    if expected is None:
        expected = case.get("expected_docs")
    if expected is None and case.get("expected_doc_id"):
        expected = [case.get("expected_doc_id")]
    if not isinstance(expected, list):
        return []
    return [str(item).strip() for item in expected if str(item).strip()]


def _eval_case_needs_label(case: dict[str, Any]) -> bool:
    return not _expected_doc_ids(case) and not bool(case.get("needs_runbook"))


def eval_label_queue(
    conn,
    *,
    eval_set_path: Path,
    top_k: int = 5,
    limit: int = 20,
    only_unlabeled: bool = True,
    embedding_model: str | None = None,
) -> dict[str, Any]:
    top_k = max(1, int(top_k))
    limit = max(1, int(limit))
    cases = _load_eval_cases(eval_set_path)
    items: list[dict[str, Any]] = []
    for index, case in enumerate(cases, start=1):
        query = normalize_whitespace(str(case.get("query") or ""))
        if not query:
            continue
        needs_label = _eval_case_needs_label(case)
        if only_unlabeled and not needs_label:
            continue
        result = search(
            conn,
            query,
            top_k=top_k,
            embedding_model=embedding_model,
            use_hotset=False,
            log_result=False,
        )
        top_docs = []
        for doc in result.get("top_docs", []):
            if not isinstance(doc, dict):
                continue
            doc_id = str(doc.get("doc_id") or "").strip()
            if not doc_id:
                continue
            top_docs.append(
                {
                    "doc_id": doc_id,
                    "title": str(doc.get("title") or "").strip(),
                    "score": doc.get("score", 0),
                }
            )
        items.append(
            {
                "query_id": str(case.get("query_id") or f"eval_{index:03d}"),
                "query": query,
                "expected_doc_ids": _expected_doc_ids(case),
                "needs_runbook": bool(case.get("needs_runbook")),
                "needs_label": needs_label,
                "top_docs": top_docs,
                "confidence": result.get("confidence", 0),
            }
        )
        if len(items) >= limit:
            break
    return {
        "eval_set_path": str(eval_set_path),
        "top_k": top_k,
        "limit": limit,
        "only_unlabeled": only_unlabeled,
        "count": len(items),
        "items": items,
    }


def update_eval_label(
    *,
    eval_set_path: Path,
    query_id: str,
    expected_doc_ids: list[str] | None = None,
    needs_runbook: bool | None = None,
    clear: bool = False,
) -> dict[str, Any]:
    query_id = str(query_id).strip()
    if not query_id:
        raise ValueError("query_id is required")
    cases = _load_eval_cases(eval_set_path)
    for index, case in enumerate(cases):
        current_query_id = str(case.get("query_id") or f"eval_{index + 1:03d}")
        if current_query_id != query_id:
            continue
        updated = dict(case)
        if clear:
            updated.pop("expected_doc_ids", None)
            updated.pop("expected_doc_id", None)
            updated.pop("expected_docs", None)
            updated.pop("needs_runbook", None)
        doc_ids = [str(item).strip() for item in (expected_doc_ids or []) if str(item).strip()]
        if doc_ids:
            updated["expected_doc_ids"] = doc_ids
            updated.pop("needs_runbook", None)
        elif needs_runbook is not None:
            updated["needs_runbook"] = bool(needs_runbook)
            if needs_runbook:
                updated.pop("expected_doc_ids", None)
                updated.pop("expected_doc_id", None)
                updated.pop("expected_docs", None)
        cases[index] = updated
        _write_eval_cases(eval_set_path, cases)
        return {
            "ok": True,
            "eval_set_path": str(eval_set_path),
            "query_id": query_id,
            "case": updated,
        }
    return {
        "ok": False,
        "eval_set_path": str(eval_set_path),
        "query_id": query_id,
        "error": "query_id not found",
    }


def eval_suite(
    conn,
    *,
    eval_set_path: Path,
    top_k: int = 5,
    embedding_model: str | None = None,
) -> dict[str, Any]:
    top_k = max(1, int(top_k))
    cases = _load_eval_cases(eval_set_path)
    results: list[dict[str, Any]] = []
    labeled = 0
    hits = 0
    reciprocal_rank_total = 0.0
    top1_hits = 0
    invalid = 0

    for index, case in enumerate(cases, start=1):
        query = normalize_whitespace(str(case.get("query") or ""))
        query_id = str(case.get("query_id") or f"eval_{index:03d}")
        expected_doc_ids = _expected_doc_ids(case)
        if not query:
            invalid += 1
            results.append({
                "query_id": query_id,
                "query": query,
                "error": case.get("error") or "missing query",
            })
            continue

        search_result = search(
            conn,
            query,
            top_k=top_k,
            embedding_model=embedding_model,
            use_hotset=False,
            log_result=False,
        )
        top_docs = search_result.get("top_docs", [])
        top_doc_ids = [
            str(doc.get("doc_id") or "")
            for doc in top_docs
            if isinstance(doc, dict) and str(doc.get("doc_id") or "")
        ]
        rank = None
        if expected_doc_ids:
            labeled += 1
            expected_set = set(expected_doc_ids)
            for position, doc_id in enumerate(top_doc_ids, start=1):
                if doc_id in expected_set:
                    rank = position
                    break
            if rank is not None:
                hits += 1
                reciprocal_rank_total += 1.0 / rank
                if rank == 1:
                    top1_hits += 1
        results.append({
            "query_id": query_id,
            "query": query,
            "expected_doc_ids": expected_doc_ids,
            "top_doc_ids": top_doc_ids,
            "hit": rank is not None if expected_doc_ids else None,
            "rank": rank,
            "confidence": search_result.get("confidence", 0),
        })

    metrics = {
        "total_cases": len(cases),
        "labeled_cases": labeled,
        "unlabeled_cases": len(cases) - labeled - invalid,
        "invalid_cases": invalid,
        f"recall_at_{top_k}": round(hits / labeled, 4) if labeled else None,
        "top1_accuracy": round(top1_hits / labeled, 4) if labeled else None,
        "mrr": round(reciprocal_rank_total / labeled, 4) if labeled else None,
    }
    note = None
    if not cases:
        note = "No eval set found. Generate one with maintenance transcript-eval-set, then add expected_doc_ids for scored metrics."
    elif labeled == 0:
        note = "Eval set has no expected_doc_ids, so only retrieval outputs were recorded."
    return {
        "generated_at": now_iso(),
        "eval_set_path": str(eval_set_path),
        "top_k": top_k,
        "metrics": metrics,
        "results": results,
        "note": note,
    }
