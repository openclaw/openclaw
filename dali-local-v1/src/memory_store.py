from __future__ import annotations

import json
import re
import sqlite3
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

REQUIRED_TABLES = [
    "adapter_registry",
    "checkpoints",
    "document_chunks",
    "document_corpora",
    "documents",
    "eval_runs",
    "compaction_blocks",
    "compaction_experiments",
    "events",
    "nca_snapshots",
    "promotions",
    "reflections",
    "rollback_events",
    "shadow_runs",
]

ALLOWED_CHECKPOINT_STATUSES = {
    "proposed",
    "training",
    "validated",
    "approved",
    "deployed",
    "rejected",
    "archived",
}

DEFAULT_RETENTION_DAYS = 180
DEFAULT_LEAKAGE_RISK_WARNING = 0.4

ALLOWED_COMPACTION_APPROACHES = {
    "summary_only",
    "segmented_cot_mementos",
    "native_block_masking",
}

DEFAULT_STAGE3_LEAKAGE_RISK_THRESHOLD = 0.2

SCHEMA_PATH = Path(__file__).resolve().parents[1] / "sql" / "schema.sql"
QUERY_TOKEN_RE = re.compile(r"[A-Za-z0-9_]+")


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _json_payload(payload: dict[str, Any] | list[Any] | None) -> str:
    if payload is None:
        payload = {}
    return json.dumps(payload, sort_keys=True)


def connect(db_path: str | Path) -> sqlite3.Connection:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    return conn


def init_db(db_path: str | Path) -> Path:
    db_path = Path(db_path)
    schema = SCHEMA_PATH.read_text(encoding="utf-8")
    with connect(db_path) as conn:
        conn.executescript(schema)
        conn.commit()
    return db_path


def list_tables(db_path: str | Path) -> list[str]:
    with connect(db_path) as conn:
        rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()
    return [row[0] for row in rows]


def bootstrap_workspace(root: str | Path, db_path: str | Path | None = None) -> dict[str, Any]:
    root = Path(root)
    created_dirs: list[str] = []
    for rel in ("state", "logs", "artifacts"):
        path = root / rel
        path.mkdir(parents=True, exist_ok=True)
        created_dirs.append(str(path))
    resolved_db_path = Path(db_path) if db_path else root / "state" / "dali.sqlite3"
    init_db(resolved_db_path)
    return {
        "root": str(root),
        "dbPath": str(resolved_db_path),
        "createdDirs": created_dirs,
        "tables": list_tables(resolved_db_path),
    }


def append_event(
    db_path: str | Path,
    *,
    event_type: str,
    payload: dict[str, Any],
    source: str = "bootstrap",
    actor: str | None = "dali",
    conversation_id: str | None = None,
    parent_event_id: str | None = None,
) -> dict[str, Any]:
    record = {
        "id": str(uuid.uuid4()),
        "created_at": utc_now(),
        "event_type": event_type,
        "source": source,
        "actor": actor,
        "conversation_id": conversation_id,
        "parent_event_id": parent_event_id,
        "payload_json": _json_payload(payload),
    }
    with connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO events (
              id, created_at, event_type, source, actor, conversation_id, parent_event_id, payload_json
            ) VALUES (
              :id, :created_at, :event_type, :source, :actor, :conversation_id, :parent_event_id, :payload_json
            )
            """,
            record,
        )
        conn.commit()
    return record


def append_reflection(
    db_path: str | Path,
    *,
    source_event_id: str | None,
    reflection_text: str,
    durable_claims: list[str] | None = None,
    uncertainties: list[str] | None = None,
    interdisciplinary_links: list[str] | None = None,
    nca_signal: str | None = None,
    creative_fragment: str | None = None,
    memory_candidate_score: float | None = None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    record = {
        "id": str(uuid.uuid4()),
        "created_at": utc_now(),
        "source_event_id": source_event_id,
        "reflection_text": reflection_text,
        "durable_claims_json": _json_payload(durable_claims or []),
        "uncertainties_json": _json_payload(uncertainties or []),
        "interdisciplinary_links_json": _json_payload(interdisciplinary_links or []),
        "nca_signal": nca_signal,
        "creative_fragment": creative_fragment,
        "memory_candidate_score": memory_candidate_score,
        "payload_json": _json_payload(payload or {}),
    }
    with connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO reflections (
              id, created_at, source_event_id, reflection_text, durable_claims_json,
              uncertainties_json, interdisciplinary_links_json, nca_signal, creative_fragment,
              memory_candidate_score, payload_json
            ) VALUES (
              :id, :created_at, :source_event_id, :reflection_text, :durable_claims_json,
              :uncertainties_json, :interdisciplinary_links_json, :nca_signal, :creative_fragment,
              :memory_candidate_score, :payload_json
            )
            """,
            record,
        )
        conn.commit()
    return record


def append_promotion(
    db_path: str | Path,
    *,
    reflection_id: str | None,
    claim_text: str,
    promoted_to: str,
    decision: str,
    evidence: dict[str, Any] | None,
    checkpoint_id: str | None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    def _row_exists(conn: sqlite3.Connection, table: str, row_id: str | None) -> bool:
        if row_id is None:
            return True
        row = conn.execute(f"SELECT 1 FROM {table} WHERE id = ? LIMIT 1", (row_id,)).fetchone()
        return row is not None

    record = {
        "id": str(uuid.uuid4()),
        "created_at": utc_now(),
        "reflection_id": reflection_id,
        "claim_text": claim_text,
        "promoted_to": promoted_to,
        "decision": decision,
        "evidence_json": _json_payload(evidence),
        "checkpoint_id": checkpoint_id,
        "payload_json": _json_payload(payload or {}),
    }
    with connect(db_path) as conn:
        if not _row_exists(conn, "reflections", reflection_id):
            raise ValueError(f"reflection not found: {reflection_id}")
        if not _row_exists(conn, "checkpoints", checkpoint_id):
            raise ValueError(f"checkpoint not found: {checkpoint_id}")

        conn.execute(
            """
            INSERT INTO promotions (
              id, created_at, reflection_id, claim_text, promoted_to,
              decision, evidence_json, checkpoint_id, payload_json
            ) VALUES (
              :id, :created_at, :reflection_id, :claim_text, :promoted_to,
              :decision, :evidence_json, :checkpoint_id, :payload_json
            )
            """,
            record,
        )
        conn.commit()
    return record


def append_compaction_experiment(
    db_path: str | Path,
    *,
    model_id: str,
    curriculum_stage: int,
    approach: str,
    name: str | None,
    segment_window: int | None,
    kv_reduction_ratio: float | None,
    throughput_mult: float | None,
    accuracy_delta: float | None,
    leakage_risk_score: float | None,
    tokens_in: int | None,
    tokens_out: int | None,
    notes: str | None,
    payload: dict[str, Any] | None = None,
    max_stage3_leakage_risk: float = DEFAULT_STAGE3_LEAKAGE_RISK_THRESHOLD,
    status: str = "running",
) -> dict[str, Any]:
    if curriculum_stage < 1 or curriculum_stage > 3:
        raise ValueError("curriculum_stage must be 1, 2, or 3")

    if approach not in ALLOWED_COMPACTION_APPROACHES:
        raise ValueError("approach must be one of: summary_only, segmented_cot_mementos, native_block_masking")

    normalized_status = status.lower()
    if normalized_status == "completed" and curriculum_stage == 3:
        if leakage_risk_score is None:
            raise ValueError("stage-3 experiments cannot be marked completed without leakage_risk_score")
        if leakage_risk_score > max_stage3_leakage_risk:
            raise ValueError(
                "stage-3 experiments exceed leakage risk threshold for completed status"
            )

    record = {
        "id": str(uuid.uuid4()),
        "created_at": utc_now(),
        "model_id": model_id,
        "curriculum_stage": curriculum_stage,
        "approach": approach,
        "name": name,
        "segment_window": segment_window,
        "kv_reduction_ratio": kv_reduction_ratio,
        "throughput_mult": throughput_mult,
        "accuracy_delta": accuracy_delta,
        "leakage_risk_score": leakage_risk_score,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "notes_json": _json_payload({"note": notes} if notes else {}),
        "payload_json": _json_payload(payload or {}),
        "status": normalized_status,
    }

    with connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO compaction_experiments (
              id, created_at, model_id, curriculum_stage, approach,
              name, segment_window, kv_reduction_ratio, throughput_mult,
              accuracy_delta, leakage_risk_score, tokens_in, tokens_out,
              notes_json, payload_json, status
            ) VALUES (
              :id, :created_at, :model_id, :curriculum_stage, :approach,
              :name, :segment_window, :kv_reduction_ratio, :throughput_mult,
              :accuracy_delta, :leakage_risk_score, :tokens_in, :tokens_out,
              :notes_json, :payload_json, :status
            )
            """,
            record,
        )
        conn.commit()
    return record


def append_compaction_block(
    db_path: str | Path,
    *,
    experiment_id: str,
    segment_index: int,
    curriculum_stage: int,
    segment_text: str,
    memento_text: str | None,
    source_prompt: str | None,
    expected_answer: str | None,
    side_channel_hint: bool | None,
    source_event_id: str | None,
    source_event_turn: int | None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if curriculum_stage < 1 or curriculum_stage > 3:
        raise ValueError("curriculum_stage must be 1, 2, or 3")

    record = {
        "id": str(uuid.uuid4()),
        "created_at": utc_now(),
        "experiment_id": experiment_id,
        "segment_index": segment_index,
        "curriculum_stage": curriculum_stage,
        "segment_text": segment_text,
        "memento_text": memento_text,
        "source_prompt": source_prompt,
        "expected_answer": expected_answer,
        "side_channel_hint": 1 if side_channel_hint else 0,
        "source_event_id": source_event_id,
        "source_event_turn": source_event_turn,
        "notes_json": _json_payload({}),
        "payload_json": _json_payload(payload or {}),
    }

    with connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO compaction_blocks (
              id, created_at, experiment_id, segment_index, curriculum_stage,
              segment_text, memento_text, source_prompt, expected_answer, side_channel_hint,
              source_event_id, source_event_turn, notes_json, payload_json
            ) VALUES (
              :id, :created_at, :experiment_id, :segment_index, :curriculum_stage,
              :segment_text, :memento_text, :source_prompt, :expected_answer, :side_channel_hint,
              :source_event_id, :source_event_turn, :notes_json, :payload_json
            )
            """,
            record,
        )
        conn.commit()
    return record


def append_shadow_run(
    db_path: str | Path,
    *,
    prompt_hash: str | None,
    teacher_output: dict[str, Any] | list[Any],
    candidate_outputs: list[dict[str, Any]],
    judge_scores: dict[str, Any],
    chosen_candidate_id: str | None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    record = {
        "id": str(uuid.uuid4()),
        "created_at": utc_now(),
        "prompt_hash": prompt_hash,
        "teacher_output_json": _json_payload(teacher_output),
        "candidate_outputs_json": _json_payload(candidate_outputs),
        "judge_scores_json": _json_payload(judge_scores),
        "chosen_candidate_id": chosen_candidate_id,
        "payload_json": _json_payload(payload or {}),
    }

    with connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO shadow_runs (
              id, created_at, prompt_hash, teacher_output_json, candidate_outputs_json,
              judge_scores_json, chosen_candidate_id, payload_json
            ) VALUES (
              :id, :created_at, :prompt_hash, :teacher_output_json, :candidate_outputs_json,
              :judge_scores_json, :chosen_candidate_id, :payload_json
            )
            """,
            record,
        )
        conn.commit()
    return record


def append_eval_run(
    db_path: str | Path,
    *,
    suite_name: str,
    target_kind: str,
    target_id: str | None,
    score_summary: dict[str, Any],
    artifact_path: str | None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    record = {
        "id": str(uuid.uuid4()),
        "created_at": utc_now(),
        "suite_name": suite_name,
        "target_kind": target_kind,
        "target_id": target_id,
        "score_summary_json": _json_payload(score_summary),
        "artifact_path": artifact_path,
        "payload_json": _json_payload(payload or {}),
    }

    with connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO eval_runs (
              id, created_at, suite_name, target_kind, target_id,
              score_summary_json, artifact_path, payload_json
            ) VALUES (
              :id, :created_at, :suite_name, :target_kind, :target_id,
              :score_summary_json, :artifact_path, :payload_json
            )
            """,
            record,
        )
        conn.commit()
    return record


def append_checkpoint(
    db_path: str | Path,
    *,
    base_model_id: str,
    adapter_id: str | None,
    nca_snapshot_id: str | None,
    status: str,
    lineage: dict[str, Any] | None,
    metrics: dict[str, Any] | None,
    notes: str | None,
) -> dict[str, Any]:
    if status not in ALLOWED_CHECKPOINT_STATUSES:
        raise ValueError(f"invalid checkpoint status: {status}")

    record = {
        "id": str(uuid.uuid4()),
        "created_at": utc_now(),
        "base_model_id": base_model_id,
        "adapter_id": adapter_id,
        "nca_snapshot_id": nca_snapshot_id,
        "status": status,
        "lineage_json": _json_payload(lineage),
        "metrics_json": _json_payload(metrics),
        "notes": notes,
    }

    with connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO checkpoints (
              id, created_at, base_model_id, adapter_id, nca_snapshot_id,
              status, lineage_json, metrics_json, notes
            ) VALUES (
              :id, :created_at, :base_model_id, :adapter_id, :nca_snapshot_id,
              :status, :lineage_json, :metrics_json, :notes
            )
            """,
            record,
        )
        conn.commit()
    return record


def set_checkpoint_status(db_path: str | Path, checkpoint_id: str, status: str) -> None:
    if status not in ALLOWED_CHECKPOINT_STATUSES:
        raise ValueError(f"invalid checkpoint status: {status}")

    with connect(db_path) as conn:
        cursor = conn.execute(
            "UPDATE checkpoints SET status = ? WHERE id = ?",
            (status, checkpoint_id),
        )
        if cursor.rowcount == 0:
            raise ValueError("checkpoint not found")
        conn.commit()


def append_rollback_event(
    db_path: str | Path,
    *,
    from_checkpoint_id: str | None,
    to_checkpoint_id: str | None,
    reason: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if from_checkpoint_id is None and to_checkpoint_id is None:
        raise ValueError("at least one of from_checkpoint_id or to_checkpoint_id must be provided")

    record = {
        "id": str(uuid.uuid4()),
        "created_at": utc_now(),
        "from_checkpoint_id": from_checkpoint_id,
        "to_checkpoint_id": to_checkpoint_id,
        "reason": reason,
        "payload_json": _json_payload(payload or {}),
    }

    def _checkpoint_exists(conn, checkpoint_id: str | None) -> bool:
        if checkpoint_id is None:
            return True
        row = conn.execute("SELECT 1 FROM checkpoints WHERE id = ? LIMIT 1", (checkpoint_id,)).fetchone()
        return row is not None

    with connect(db_path) as conn:
        if not _checkpoint_exists(conn, from_checkpoint_id):
            raise ValueError(f"from checkpoint not found: {from_checkpoint_id}")
        if not _checkpoint_exists(conn, to_checkpoint_id):
            raise ValueError(f"to checkpoint not found: {to_checkpoint_id}")

        conn.execute(
            """
            INSERT INTO rollback_events (
              id, created_at, from_checkpoint_id, to_checkpoint_id,
              reason, payload_json
            ) VALUES (
              :id, :created_at, :from_checkpoint_id, :to_checkpoint_id,
              :reason, :payload_json
            )
            """,
            record,
        )
        conn.commit()
    return record


def append_nca_snapshot(
    db_path: str | Path,
    *,
    parent_snapshot_id: str | None,
    checkpoint_id: str | None,
    motif_summary: str | None,
    drift_signal: float | None,
    anomaly_flags: list[str] | None,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    def _row_exists(conn: sqlite3.Connection, table: str, row_id: str | None) -> bool:
        if row_id is None:
            return True
        row = conn.execute(f"SELECT 1 FROM {table} WHERE id = ? LIMIT 1", (row_id,)).fetchone()
        return row is not None

    record = {
        "id": str(uuid.uuid4()),
        "created_at": utc_now(),
        "parent_snapshot_id": parent_snapshot_id,
        "checkpoint_id": checkpoint_id,
        "motif_summary": motif_summary,
        "drift_signal": drift_signal,
        "anomaly_flags_json": _json_payload(anomaly_flags or []),
        "payload_json": _json_payload(payload or {}),
    }

    with connect(db_path) as conn:
        if not _row_exists(conn, "nca_snapshots", parent_snapshot_id):
            raise ValueError(f"parent nca snapshot not found: {parent_snapshot_id}")
        if not _row_exists(conn, "checkpoints", checkpoint_id):
            raise ValueError(f"checkpoint not found: {checkpoint_id}")

        conn.execute(
            """
            INSERT INTO nca_snapshots (
              id, created_at, parent_snapshot_id, checkpoint_id,
              motif_summary, drift_signal, anomaly_flags_json, payload_json
            ) VALUES (
              :id, :created_at, :parent_snapshot_id, :checkpoint_id,
              :motif_summary, :drift_signal, :anomaly_flags_json, :payload_json
            )
            """,
            record,
        )
        conn.commit()
    return record


def append_adapter_registry(
    db_path: str | Path,
    *,
    base_model_id: str,
    adapter_path: str,
    train_corpus_lineage: dict[str, Any] | list[Any] | None,
    validation_summary: dict[str, Any] | None,
    deployment_state: str,
    merge_state: str,
    payload: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if not base_model_id.strip():
        raise ValueError("base_model_id cannot be empty")
    if not adapter_path.strip():
        raise ValueError("adapter_path cannot be empty")

    record = {
        "id": str(uuid.uuid4()),
        "created_at": utc_now(),
        "base_model_id": base_model_id,
        "adapter_path": adapter_path,
        "train_corpus_lineage_json": _json_payload(train_corpus_lineage),
        "validation_summary_json": _json_payload(validation_summary),
        "deployment_state": deployment_state,
        "merge_state": merge_state,
        "payload_json": _json_payload(payload or {}),
    }

    with connect(db_path) as conn:
        conn.execute(
            """
            INSERT INTO adapter_registry (
              id, created_at, base_model_id, adapter_path, train_corpus_lineage_json,
              validation_summary_json, deployment_state, merge_state, payload_json
            ) VALUES (
              :id, :created_at, :base_model_id, :adapter_path, :train_corpus_lineage_json,
              :validation_summary_json, :deployment_state, :merge_state, :payload_json
            )
            """,
            record,
        )
        conn.commit()
    return record


def list_recent_events(db_path: str | Path, limit: int = 10) -> list[dict[str, Any]]:
    with connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT id, created_at, event_type, source, actor, conversation_id, parent_event_id, payload_json
            FROM events
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]


def list_recent_reflections(db_path: str | Path, limit: int = 10) -> list[dict[str, Any]]:
    with connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT id, created_at, source_event_id, reflection_text, durable_claims_json, uncertainties_json,
                   interdisciplinary_links_json, nca_signal, creative_fragment, memory_candidate_score, payload_json
            FROM reflections
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]


def search_reflections_text(db_path: str | Path, query: str, limit: int = 10) -> list[dict[str, Any]]:
    tokens = [token.lower() for token in QUERY_TOKEN_RE.findall(query or "")]
    if not tokens:
        raise ValueError("query must include at least one alphanumeric token")

    clauses = ["LOWER(reflection_text) LIKE ?" for _ in tokens]
    values = [f"%{token}%" for token in tokens]

    with connect(db_path) as conn:
        rows = conn.execute(
            f"""
            SELECT id, created_at, source_event_id, reflection_text, durable_claims_json,
                   uncertainties_json, interdisciplinary_links_json, nca_signal,
                   creative_fragment, memory_candidate_score, payload_json
            FROM reflections
            WHERE {' OR '.join(clauses)}
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (*values, max(limit * 4, limit)),
        ).fetchall()

    scored: list[dict[str, Any]] = []
    for row in rows:
        payload = dict(row)
        haystack = (payload.get("reflection_text") or "").lower()
        score = sum(1 for token in tokens if token in haystack)
        payload["text_score"] = score
        scored.append(payload)

    scored.sort(key=lambda item: (int(item["text_score"]), item["created_at"], item["id"]), reverse=True)
    return scored[:limit]


def list_recent_compaction_experiments(db_path: str | Path, limit: int = 10) -> list[dict[str, Any]]:
    with connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT id, created_at, model_id, curriculum_stage, approach, name, segment_window,
                   kv_reduction_ratio, throughput_mult, accuracy_delta, leakage_risk_score,
                   tokens_in, tokens_out, status, notes_json, payload_json
            FROM compaction_experiments
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]


def list_shadow_runs(db_path: str | Path, limit: int = 10) -> list[dict[str, Any]]:
    with connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT id, created_at, prompt_hash, teacher_output_json, candidate_outputs_json,
                   judge_scores_json, chosen_candidate_id, payload_json
            FROM shadow_runs
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]


def list_eval_runs(
    db_path: str | Path,
    limit: int = 10,
    suite_name: str | None = None,
    target_kind: str | None = None,
    target_id: str | None = None,
) -> list[dict[str, Any]]:
    clauses = []
    values: list[Any] = []

    if suite_name is not None:
        clauses.append("suite_name = ?")
        values.append(suite_name)
    if target_kind is not None:
        clauses.append("target_kind = ?")
        values.append(target_kind)
    if target_id is not None:
        clauses.append("target_id = ?")
        values.append(target_id)

    where = f" WHERE {' AND '.join(clauses)}" if clauses else ""

    sql = f"""
            SELECT id, created_at, suite_name, target_kind, target_id,
                   score_summary_json, artifact_path, payload_json
            FROM eval_runs
            {where}
            ORDER BY created_at DESC
            LIMIT ?
            """
    values.append(limit)

    with connect(db_path) as conn:
        rows = conn.execute(sql, values).fetchall()
    return [dict(row) for row in rows]


def list_checkpoints(db_path: str | Path, limit: int = 10, status: str | None = None) -> list[dict[str, Any]]:
    with connect(db_path) as conn:
        if status is None:
            rows = conn.execute(
                """
                SELECT id, created_at, base_model_id, adapter_id, nca_snapshot_id,
                       status, lineage_json, metrics_json, notes
                FROM checkpoints
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, created_at, base_model_id, adapter_id, nca_snapshot_id,
                       status, lineage_json, metrics_json, notes
                FROM checkpoints
                WHERE status = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (status, limit),
            ).fetchall()

    return [dict(row) for row in rows]


def get_checkpoint(db_path: str | Path, checkpoint_id: str) -> dict[str, Any] | None:
    with connect(db_path) as conn:
        row = conn.execute(
            """
            SELECT id, created_at, base_model_id, adapter_id, nca_snapshot_id,
                   status, lineage_json, metrics_json, notes
            FROM checkpoints
            WHERE id = ?
            """,
            (checkpoint_id,),
        ).fetchone()

    return dict(row) if row else None


def list_rollback_events(db_path: str | Path, limit: int = 20) -> list[dict[str, Any]]:
    with connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT id, created_at, from_checkpoint_id, to_checkpoint_id, reason, payload_json
            FROM rollback_events
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

    return [dict(row) for row in rows]


def list_nca_snapshots(db_path: str | Path, limit: int = 20, checkpoint_id: str | None = None) -> list[dict[str, Any]]:
    with connect(db_path) as conn:
        if checkpoint_id is None:
            rows = conn.execute(
                """
                SELECT id, created_at, parent_snapshot_id, checkpoint_id, motif_summary,
                       drift_signal, anomaly_flags_json, payload_json
                FROM nca_snapshots
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, created_at, parent_snapshot_id, checkpoint_id, motif_summary,
                       drift_signal, anomaly_flags_json, payload_json
                FROM nca_snapshots
                WHERE checkpoint_id = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (checkpoint_id, limit),
            ).fetchall()

    return [dict(row) for row in rows]


def list_adapters(db_path: str | Path, limit: int = 10, base_model_id: str | None = None) -> list[dict[str, Any]]:
    with connect(db_path) as conn:
        if base_model_id is None:
            rows = conn.execute(
                """
                SELECT id, created_at, base_model_id, adapter_path, train_corpus_lineage_json,
                       validation_summary_json, deployment_state, merge_state, payload_json
                FROM adapter_registry
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, created_at, base_model_id, adapter_path, train_corpus_lineage_json,
                       validation_summary_json, deployment_state, merge_state, payload_json
                FROM adapter_registry
                WHERE base_model_id = ?
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (base_model_id, limit),
            ).fetchall()
    return [dict(row) for row in rows]


def list_compaction_blocks_for_experiment(db_path: str | Path, experiment_id: str, limit: int = 50) -> list[dict[str, Any]]:
    with connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT id, created_at, experiment_id, segment_index, curriculum_stage,
                   segment_text, memento_text, source_prompt, expected_answer,
                   side_channel_hint, source_event_id, source_event_turn, notes_json, payload_json
            FROM compaction_blocks
            WHERE experiment_id = ?
            ORDER BY segment_index ASC
            LIMIT ?
            """,
            (experiment_id, limit),
        ).fetchall()
    return [dict(row) for row in rows]


def list_recent_promotions(db_path: str | Path, limit: int = 10) -> list[dict[str, Any]]:
    with connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT id, created_at, reflection_id, claim_text, promoted_to, decision, evidence_json,
                   checkpoint_id, payload_json
            FROM promotions
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [dict(row) for row in rows]


def summary(db_path: str | Path) -> dict[str, int]:
    with connect(db_path) as conn:
        existing_rows = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
        existing = {row[0] for row in existing_rows}

        counts: dict[str, int] = {}
        for table in REQUIRED_TABLES:
            if table not in existing:
                counts[table] = 0
            else:
                row = conn.execute(f"SELECT COUNT(*) as c FROM {table}").fetchone()
                counts[table] = int(row[0])
    return counts


def status_snapshot(db_path: str | Path) -> dict[str, Any]:
    db_tables = set(list_tables(db_path))
    existing_rows: dict[str, int] = {}
    missing_tables = [table for table in REQUIRED_TABLES if table not in db_tables]

    with connect(db_path) as conn:
        for table in db_tables:
            try:
                row = conn.execute(f"SELECT COUNT(*) as c FROM {table}").fetchone()
                existing_rows[table] = int(row[0])
            except sqlite3.Error:
                existing_rows[table] = -1

    return {
        "dbPath": str(Path(db_path)),
        "tables": sorted(db_tables),
        "missingRequiredTables": missing_tables,
        "counts": existing_rows,
    }


def migration_report(db_path: str | Path) -> dict[str, Any]:
    tables = set(list_tables(db_path))
    extras = sorted([table for table in tables if table not in REQUIRED_TABLES])
    missing = [table for table in REQUIRED_TABLES if table not in tables]

    return {
        "dbPath": str(Path(db_path)),
        "requiredTables": REQUIRED_TABLES,
        "presentRequired": [table for table in REQUIRED_TABLES if table in tables],
        "missingTables": missing,
        "extraTables": extras,
        "isMigrated": len(missing) == 0,
    }


def _table_oldest_newest(conn: sqlite3.Connection, table: str) -> tuple[str | None, str | None]:
    oldest_row = conn.execute(
        f"SELECT created_at FROM {table} ORDER BY created_at ASC LIMIT 1"
    ).fetchone()
    newest_row = conn.execute(
        f"SELECT created_at FROM {table} ORDER BY created_at DESC LIMIT 1"
    ).fetchone()
    return (
        oldest_row[0] if oldest_row else None,
        newest_row[0] if newest_row else None,
    )


def _rows_older_than_days(conn: sqlite3.Connection, table: str, days: int) -> int:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat().replace("+00:00", "Z")
    row = conn.execute(
        f"SELECT COUNT(*) as c FROM {table} WHERE created_at < ?",
        (cutoff,),
    ).fetchone()
    return int(row[0])


def retention_audit(
    db_path: str | Path,
    days: int = DEFAULT_RETENTION_DAYS,
) -> dict[str, Any]:
    report: dict[str, Any] = {
        "dbPath": str(Path(db_path)),
        "retentionDays": days,
        "tableCounts": {},
        "tableAges": {},
        "olderThanWindow": {},
        "compaction": {},
    }

    with connect(db_path) as conn:
        for table in REQUIRED_TABLES:
            row = conn.execute(f"SELECT COUNT(*) as c FROM {table}").fetchone()
            total = int(row[0])
            report["tableCounts"][table] = total
            report["olderThanWindow"][table] = _rows_older_than_days(conn, table, days) if total else 0

            if total:
                oldest, newest = _table_oldest_newest(conn, table)
                report["tableAges"][table] = {
                    "oldest": oldest,
                    "newest": newest,
                }
            else:
                report["tableAges"][table] = {
                    "oldest": None,
                    "newest": None,
                }

        compaction_counts = conn.execute(
            "SELECT curriculum_stage, status, COUNT(*) FROM compaction_experiments GROUP BY curriculum_stage, status"
        ).fetchall()
        report["compaction"]["stageStatusCounts"] = {
            f"stage_{row[0]}:{row[1]}": row[2] for row in compaction_counts
        }
        report["compaction"]["highLeakageCompleted"] = conn.execute(
            """
            SELECT COUNT(*) as c
            FROM compaction_experiments
            WHERE curriculum_stage = 3
              AND status = 'completed'
              AND leakage_risk_score IS NOT NULL
              AND leakage_risk_score > ?
            """,
            (DEFAULT_LEAKAGE_RISK_WARNING,),
        ).fetchone()[0]
        report["compaction"]["missingLeakageCompleted"] = conn.execute(
            """
            SELECT COUNT(*) as c
            FROM compaction_experiments
            WHERE curriculum_stage = 3
              AND status = 'completed'
              AND leakage_risk_score IS NULL
            """
        ).fetchone()[0]

        report["compaction"]["blocksPerExperiment"] = {
            row[0]: row[1]
            for row in conn.execute(
                "SELECT experiment_id, COUNT(*) FROM compaction_blocks GROUP BY experiment_id"
            ).fetchall()
        }

    return report


def _extract_metric(score_summary: dict[str, Any], metric_name: str) -> float | None:
    if metric_name in score_summary:
        value = score_summary[metric_name]
        if isinstance(value, (int, float)):
            return float(value)
    for key in ["overall", "overall_score", "score", "mean"]:
        value = score_summary.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    return None


def compare_eval_runs_for_metric(
    db_path: str | Path,
    suite_name: str,
    metric: str,
    target_kind: str | None = None,
    limit: int = 100,
) -> dict[str, Any]:
    rows = list_eval_runs(db_path, limit=limit, suite_name=suite_name, target_kind=target_kind)
    parsed: list[tuple[float, dict[str, Any]]] = []

    for row in rows:
        try:
            score_summary = json.loads(row["score_summary_json"])
        except (TypeError, json.JSONDecodeError):
            continue
        if not isinstance(score_summary, dict):
            continue

        score = _extract_metric(score_summary, metric)
        if score is not None:
            parsed.append((score, dict(row)))

    if not parsed:
        return {
            "suiteName": suite_name,
            "metric": metric,
            "count": 0,
            "rows": [],
            "best": None,
            "worst": None,
            "delta": None,
        }

    best = max(parsed, key=lambda item: item[0])
    worst = min(parsed, key=lambda item: item[0])

    return {
        "suiteName": suite_name,
        "metric": metric,
        "count": len(parsed),
        "rows": [
            {
                "runId": run["id"],
                "createdAt": run["created_at"],
                "targetId": run["target_id"],
                "targetKind": run["target_kind"],
                "score": score,
            }
            for score, run in parsed
        ],
        "best": {
            "runId": best[1]["id"],
            "score": best[0],
            "createdAt": best[1]["created_at"],
            "targetId": best[1]["target_id"],
        },
        "worst": {
            "runId": worst[1]["id"],
            "score": worst[0],
            "createdAt": worst[1]["created_at"],
            "targetId": worst[1]["target_id"],
        },
        "delta": best[0] - worst[0],
    }


def gate_checkpoint_by_eval(
    db_path: str | Path,
    checkpoint_id: str,
    suite_name: str,
    metric: str,
    min_improvement: float = 0.0,
    artifact_path: str | None = None,
) -> dict[str, Any]:
    checkpoint = get_checkpoint(db_path, checkpoint_id)
    if checkpoint is None:
        raise ValueError("checkpoint not found")

    checkpoint_runs = list_eval_runs(
        db_path,
        suite_name=suite_name,
        target_kind="checkpoint",
        limit=500,
    )

    relevant_runs = [run for run in checkpoint_runs if run["target_id"] == checkpoint_id]
    if not relevant_runs:
        raise ValueError("checkpoint has no eval run for gate target suite")

    try:
        latest_run = relevant_runs[0]
        latest_score_summary = json.loads(latest_run["score_summary_json"])
        candidate_score = _extract_metric(latest_score_summary, metric)
    except (json.JSONDecodeError, TypeError):
        candidate_score = None

    if candidate_score is None:
        raise ValueError("checkpoint latest eval score missing or non-numeric")

    if len(relevant_runs) > 1:
        previous_scores = [
            run
            for run in checkpoint_runs
            if run["created_at"] < latest_run["created_at"] and run["id"] != latest_run["id"]
        ]
    else:
        previous_scores = []

    baseline = None
    baseline_run_id = None
    for run in previous_scores:
        try:
            score_summary = json.loads(run["score_summary_json"])
        except (json.JSONDecodeError, TypeError):
            continue
        score = _extract_metric(score_summary, metric)
        if score is None:
            continue
        if baseline is None or score > baseline:
            baseline = score
            baseline_run_id = run["id"]

    baseline = 0.0 if baseline is None else baseline
    delta = candidate_score - baseline
    approved = delta >= min_improvement
    new_status = "approved" if approved else "rejected"
    set_checkpoint_status(db_path, checkpoint_id, new_status)

    gate_payload = {
        "suiteName": suite_name,
        "metric": metric,
        "minImprovement": min_improvement,
        "candidateScore": candidate_score,
        "baseline": baseline,
        "baselineRunId": baseline_run_id,
        "delta": delta,
        "approved": approved,
    }
    gate_run = append_eval_run(
        db_path,
        suite_name=suite_name,
        target_kind="checkpoint_gate",
        target_id=checkpoint_id,
        score_summary={
            "gate_metric": metric,
            "candidate_score": candidate_score,
            "baseline": baseline,
            "delta": delta,
            "approved": approved,
            "min_improvement": min_improvement,
        },
        artifact_path=artifact_path,
        payload=gate_payload,
    )

    return {
        "checkpointId": checkpoint_id,
        "status": new_status,
        "approved": approved,
        "candidateScore": candidate_score,
        "baseline": baseline,
        "delta": delta,
        "run": gate_run,
    }
