#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from memory_store import (  # noqa: E402
    append_event,
    append_compaction_block,
    append_compaction_experiment,
    append_shadow_run,
    append_eval_run,
    append_checkpoint,
    DEFAULT_STAGE3_LEAKAGE_RISK_THRESHOLD,
    append_promotion,
    append_rollback_event,
    append_nca_snapshot,
    append_adapter_registry,
    append_reflection,
    init_db,
    bootstrap_workspace,
    compare_eval_runs_for_metric,
    gate_checkpoint_by_eval,
    list_adapters,
    list_checkpoints,
    list_eval_runs,
    list_nca_snapshots,
    list_rollback_events,
    list_compaction_blocks_for_experiment,
    list_recent_compaction_experiments,
    list_recent_events,
    list_recent_promotions,
    list_recent_reflections,
    list_shadow_runs,
    migration_report,
    retention_audit,
    set_checkpoint_status,
    status_snapshot,
    summary,
)  # noqa: E402
from document_store import (  # noqa: E402
    DEFAULT_SOURCE_RESEARCH_CORPUS_ID,
    DEFAULT_SOURCE_RESEARCH_CORPUS_ROOT,
    get_document,
    import_source_research_corpus,
    list_document_corpora,
    list_document_chunks_for_document,
    list_documents,
    search_document_chunks,
)
from retrieval_store import build_context_bundle  # noqa: E402
from semantic_store import (  # noqa: E402
    DEFAULT_COLLECTION,
    DEFAULT_TIMEOUT_SECONDS,
    DEFAULT_VECTOR_SIZE,
    DEFAULT_QDRANT_URL,
    QdrantOperationError,
    QdrantUnavailableError,
    index_reflections_in_qdrant,
    search_reflections_in_qdrant,
)  # noqa: E402


def _json_arg(value: str | None) -> dict:
    if not value:
        return {}
    try:
        loaded = json.loads(value)
    except json.JSONDecodeError as exc:
        raise argparse.ArgumentTypeError(f"invalid JSON payload: {exc}")
    if not isinstance(loaded, dict):
        raise argparse.ArgumentTypeError("payload must be a JSON object")
    return loaded


def _json_value_arg(value: str | None) -> dict | list:
    if not value:
        raise argparse.ArgumentTypeError("json argument cannot be empty")
    try:
        loaded = json.loads(value)
    except json.JSONDecodeError as exc:
        raise argparse.ArgumentTypeError(f"invalid JSON argument: {exc}")
    if not isinstance(loaded, (dict, list)):
        raise argparse.ArgumentTypeError("argument must be a JSON object or list")
    return loaded


def _default_db_path(root: str | Path) -> str:
    return str(Path(root) / "state" / "dali.sqlite3")


def _resolve_db_path(root: str | Path, explicit: str | None) -> str:
    if explicit:
        return explicit
    return _default_db_path(root)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Work with the Dali-local-v1 memory substrate.")
    parser.add_argument("--root", default=str(ROOT), help="Workspace root for dali-local-v1")

    sub = parser.add_subparsers(dest="command", required=True)

    bootstrap = sub.add_parser("bootstrap", help="Initialize the local-v1 store")
    bootstrap.add_argument("--db-path", default=None, help="Explicit sqlite database path")
    bootstrap.add_argument(
        "--seed-smoke-event",
        action="store_true",
        help="Append a smoke event after initialization",
    )

    summary_cmd = sub.add_parser("summary", help="Print counts for major tables")
    summary_cmd.add_argument("--db-path", default=None, help="sqlite database path")

    import_corpus_cmd = sub.add_parser(
        "import-source-research-corpus",
        help="Import the Source Research Corpus into the SQLite substrate",
    )
    import_corpus_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    import_corpus_cmd.add_argument(
        "--corpus-root",
        default=str(DEFAULT_SOURCE_RESEARCH_CORPUS_ROOT),
        help="Path to the Source Research Corpus root",
    )
    import_corpus_cmd.add_argument(
        "--corpus-id",
        default=DEFAULT_SOURCE_RESEARCH_CORPUS_ID,
        help="Corpus identifier stored in SQLite",
    )
    import_corpus_cmd.add_argument("--limit", type=int, default=None, help="Optional document limit")
    import_corpus_cmd.add_argument(
        "--refresh",
        action="store_true",
        help="Delete existing rows for this corpus before re-importing",
    )

    corpora_cmd = sub.add_parser("list-corpora", help="List imported corpora")
    corpora_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    corpora_cmd.add_argument("--limit", type=int, default=10, help="Number of rows")

    docs_cmd = sub.add_parser("list-documents", help="List imported documents")
    docs_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    docs_cmd.add_argument("--corpus-id", default=None, help="Optional corpus id filter")
    docs_cmd.add_argument("--topic", default=None, help="Optional topic filter")
    docs_cmd.add_argument("--limit", type=int, default=20, help="Number of rows")

    show_doc_cmd = sub.add_parser("show-document", help="Show one imported document and optional chunk preview")
    show_doc_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    show_doc_cmd.add_argument("--document-id", default=None, help="Exact document id")
    show_doc_cmd.add_argument("--hash8", default=None, help="Document hash8")
    show_doc_cmd.add_argument("--corpus-id", default=None, help="Optional corpus id filter")
    show_doc_cmd.add_argument("--chunk-limit", type=int, default=5, help="Number of chunks to preview")

    search_docs_cmd = sub.add_parser("search-documents", help="Search imported document chunks via SQLite FTS")
    search_docs_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    search_docs_cmd.add_argument("--query", required=True, help="Search query text")
    search_docs_cmd.add_argument("--corpus-id", default=None, help="Optional corpus id filter")
    search_docs_cmd.add_argument("--topic", default=None, help="Optional topic filter")
    search_docs_cmd.add_argument("--limit", type=int, default=8, help="Number of rows")

    retrieve_cmd = sub.add_parser(
        "retrieve-context",
        help="Build an integrated context bundle from document hits and local reflections",
    )
    retrieve_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    retrieve_cmd.add_argument("--query", required=True, help="Search query text")
    retrieve_cmd.add_argument("--corpus-id", default=None, help="Optional corpus id filter")
    retrieve_cmd.add_argument("--topic", default=None, help="Optional topic filter")
    retrieve_cmd.add_argument("--document-limit", type=int, default=4, help="Maximum documents")
    retrieve_cmd.add_argument("--chunk-limit", type=int, default=2, help="Maximum excerpts per document")
    retrieve_cmd.add_argument("--reflection-limit", type=int, default=3, help="Maximum reflections")
    retrieve_cmd.add_argument("--max-chars", type=int, default=6000, help="Maximum context text length")

    append_event_cmd = sub.add_parser("append-event", help="Append one event")
    append_event_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    append_event_cmd.add_argument("--type", required=True, help="Event type")
    append_event_cmd.add_argument("--source", default="manual", help="Event source")
    append_event_cmd.add_argument("--actor", default="dali", help="Event actor")
    append_event_cmd.add_argument("--conversation-id", default=None, help="Conversation id")
    append_event_cmd.add_argument("--parent-event-id", default=None, help="Parent event id")
    append_event_cmd.add_argument("--payload", default="{}", type=_json_arg, help="JSON payload object")

    reflection_cmd = sub.add_parser("append-reflection", help="Append one reflection")
    reflection_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    reflection_cmd.add_argument("--source-event-id", default=None, help="Source event id (optional)")
    reflection_cmd.add_argument("--text", required=True, help="Reflection text")
    reflection_cmd.add_argument("--durable-claim", action="append", default=[], help="Durable claim lines")
    reflection_cmd.add_argument("--uncertainty", action="append", default=[], help="Uncertainty lines")
    reflection_cmd.add_argument("--link", action="append", default=[], help="Interdisciplinary link")
    reflection_cmd.add_argument("--nca-signal", default=None, help="NCA signal")
    reflection_cmd.add_argument("--creative-fragment", default=None, help="Creative fragment")
    reflection_cmd.add_argument("--memory-score", type=float, default=None, help="Memory candidate score")
    reflection_cmd.add_argument("--payload", default="{}", type=_json_arg, help="JSON payload object")

    promotion_cmd = sub.add_parser("append-promotion", help="Append one promotion")
    promotion_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    promotion_cmd.add_argument("--reflection-id", default=None, help="Reflection id (optional)")
    promotion_cmd.add_argument("--claim", required=True, help="Promoted claim text")
    promotion_cmd.add_argument("--promoted-to", required=True, help="Destination kind (e.g. candidate_memory, nca_checkpoint)")
    promotion_cmd.add_argument("--decision", required=True, help="Promotion decision text")
    promotion_cmd.add_argument("--evidence", default="{}", type=_json_arg, help="JSON evidence object")
    promotion_cmd.add_argument("--checkpoint-id", default=None, help="Checkpoint id (optional)")
    promotion_cmd.add_argument("--payload", default="{}", type=_json_arg, help="JSON payload object")

    promotions_cmd = sub.add_parser("list-promotions", help="List latest promotions")
    promotions_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    promotions_cmd.add_argument("--limit", type=int, default=10, help="Number of rows")

    compaction_run_cmd = sub.add_parser("append-compaction-experiment", help="Append one compaction experiment")
    compaction_run_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    compaction_run_cmd.add_argument("--model-id", required=True, help="Model identifier")
    compaction_run_cmd.add_argument("--curriculum-stage", type=int, choices=[1, 2, 3], required=True, help="Curriculum stage 1-3")
    compaction_run_cmd.add_argument(
        "--approach",
        default="segmented_cot_mementos",
        choices=["summary_only", "segmented_cot_mementos", "native_block_masking"],
        help="Compaction approach",
    )
    compaction_run_cmd.add_argument("--name", default=None, help="Experiment name")
    compaction_run_cmd.add_argument("--segment-window", type=int, default=None, help="Segments per batch")
    compaction_run_cmd.add_argument("--kv-reduction", type=float, default=None, help="Observed KV reduction ratio")
    compaction_run_cmd.add_argument("--throughput-mult", type=float, default=None, help="Throughput gain")
    compaction_run_cmd.add_argument("--accuracy-delta", type=float, default=None, help="Accuracy delta vs baseline")
    compaction_run_cmd.add_argument("--leakage-risk", type=float, default=None, help="Observed side-channel leakage risk score")
    compaction_run_cmd.add_argument("--tokens-in", type=int, default=None, help="Raw token input")
    compaction_run_cmd.add_argument("--tokens-out", type=int, default=None, help="Output token target")
    compaction_run_cmd.add_argument("--notes", default=None, help="Freeform experiment notes")
    compaction_run_cmd.add_argument("--payload", default="{}", type=_json_arg, help="JSON payload object")
    compaction_run_cmd.add_argument(
        "--max-stage3-leakage-risk",
        type=float,
        default=None,
        help="Max leakage risk allowed before allowing stage-3 completion",
    )
    compaction_run_cmd.add_argument("--status", default="running", help="Run status")

    compaction_block_cmd = sub.add_parser("append-compaction-block", help="Append one compaction training block")
    compaction_block_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    compaction_block_cmd.add_argument("--experiment-id", required=True, help="Compaction experiment id")
    compaction_block_cmd.add_argument("--segment-index", type=int, required=True, help="Index of segment in sequence")
    compaction_block_cmd.add_argument("--curriculum-stage", type=int, choices=[1, 2, 3], required=True, help="Curriculum stage 1-3")
    compaction_block_cmd.add_argument("--segment", required=True, help="Original segment text")
    compaction_block_cmd.add_argument("--memento", required=False, default=None, help="Memento summary")
    compaction_block_cmd.add_argument("--prompt", default=None, help="Source question/prompt")
    compaction_block_cmd.add_argument("--expected-answer", default=None, help="Expected answer")
    compaction_block_cmd.add_argument("--side-channel", action="store_true", help="Mark that this sample shows leakage risk")
    compaction_block_cmd.add_argument("--source-event-id", default=None, help="Source event id if linked")
    compaction_block_cmd.add_argument("--source-event-turn", type=int, default=None, help="Source turn index")
    compaction_block_cmd.add_argument("--payload", default="{}", type=_json_arg, help="JSON payload object")

    compaction_runs_cmd = sub.add_parser("list-compaction-experiments", help="List latest compaction experiments")
    compaction_runs_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    compaction_runs_cmd.add_argument("--limit", type=int, default=10, help="Number of rows")

    compaction_blocks_cmd = sub.add_parser("list-compaction-blocks", help="List latest blocks for a compaction experiment")
    compaction_blocks_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    compaction_blocks_cmd.add_argument("--experiment-id", required=True, help="Compaction experiment id")
    compaction_blocks_cmd.add_argument("--limit", type=int, default=20, help="Number of rows")

    shadow_cmd = sub.add_parser("append-shadow-run", help="Append one shadow run")
    shadow_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    shadow_cmd.add_argument("--prompt-hash", default=None, help="Prompt hash")
    shadow_cmd.add_argument("--teacher", required=True, type=_json_value_arg, help="JSON teacher output object")
    shadow_cmd.add_argument("--candidates", required=True, type=_json_value_arg, help="JSON candidate outputs array")
    shadow_cmd.add_argument("--scores", required=True, type=_json_value_arg, help="JSON judge scores object")
    shadow_cmd.add_argument("--chosen-candidate-id", default=None, help="Chosen candidate id")
    shadow_cmd.add_argument("--payload", default="{}", type=_json_arg, help="JSON payload object")

    shadow_list_cmd = sub.add_parser("list-shadow-runs", help="List latest shadow runs")
    shadow_list_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    shadow_list_cmd.add_argument("--limit", type=int, default=10, help="Number of rows")

    eval_cmd = sub.add_parser("append-eval-run", help="Append one evaluation run")
    eval_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    eval_cmd.add_argument("--suite", required=True, help="Suite name")
    eval_cmd.add_argument("--target-kind", required=True, help="Target kind (checkpoint, task, run)")
    eval_cmd.add_argument("--target-id", default=None, help="Target id")
    eval_cmd.add_argument("--score-summary", required=True, type=_json_arg, help="JSON score summary object")
    eval_cmd.add_argument("--artifact-path", default=None, help="Optional artifact path")
    eval_cmd.add_argument("--payload", default="{}", type=_json_arg, help="JSON payload object")

    eval_list_cmd = sub.add_parser("list-eval-runs", help="List latest evaluation runs")
    eval_list_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    eval_list_cmd.add_argument("--suite", default=None, help="Filter by suite")
    eval_list_cmd.add_argument("--target-kind", default=None, help="Filter by target kind")
    eval_list_cmd.add_argument("--target-id", default=None, help="Filter by target id")
    eval_list_cmd.add_argument("--limit", type=int, default=10, help="Number of rows")

    eval_compare_cmd = sub.add_parser("compare-eval-runs", help="Compare eval runs and find best/worst by metric")
    eval_compare_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    eval_compare_cmd.add_argument("--suite", required=True, help="Suite name")
    eval_compare_cmd.add_argument("--metric", required=True, help="Metric key to compare")
    eval_compare_cmd.add_argument("--target-kind", default=None, help="Optional target kind filter")
    eval_compare_cmd.add_argument("--limit", type=int, default=100, help="Rows to inspect")

    gate_cmd = sub.add_parser("gate-checkpoint", help="Apply checkpoint gating based on latest eval")
    gate_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    gate_cmd.add_argument("--checkpoint-id", required=True, help="Checkpoint id")
    gate_cmd.add_argument("--suite", required=True, help="Evaluation suite name")
    gate_cmd.add_argument("--metric", required=True, help="Metric key used for gate")
    gate_cmd.add_argument("--min-improvement", type=float, default=0.0, help="Minimum delta over baseline")
    gate_cmd.add_argument("--artifact-path", default=None, help="Persisted gate artifact")

    checkpoint_cmd = sub.add_parser("append-checkpoint", help="Append one checkpoint")
    checkpoint_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    checkpoint_cmd.add_argument("--base-model-id", required=True, help="Base model identifier")
    checkpoint_cmd.add_argument("--adapter-id", default=None, help="Adapter id")
    checkpoint_cmd.add_argument("--nca-snapshot-id", default=None, help="NCA snapshot id")
    checkpoint_cmd.add_argument("--status", default="proposed", help="Checkpoint status")
    checkpoint_cmd.add_argument("--lineage", default="{}", type=_json_arg, help="JSON lineage object")
    checkpoint_cmd.add_argument("--metrics", default="{}", type=_json_arg, help="JSON metrics object")
    checkpoint_cmd.add_argument("--notes", default=None, help="Notes")

    checkpoint_list_cmd = sub.add_parser("list-checkpoints", help="List latest checkpoints")
    checkpoint_list_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    checkpoint_list_cmd.add_argument("--limit", type=int, default=10, help="Number of rows")
    checkpoint_list_cmd.add_argument("--status", default=None, help="Optional status filter")

    checkpoint_status_cmd = sub.add_parser("set-checkpoint-status", help="Update checkpoint status")
    checkpoint_status_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    checkpoint_status_cmd.add_argument("--checkpoint-id", required=True, help="Checkpoint id")
    checkpoint_status_cmd.add_argument("--status", required=True, help="New status")

    rollback_cmd = sub.add_parser("append-rollback", help="Append one rollback event")
    rollback_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    rollback_cmd.add_argument("--from-checkpoint-id", default=None, help="From checkpoint id")
    rollback_cmd.add_argument("--to-checkpoint-id", default=None, help="To checkpoint id")
    rollback_cmd.add_argument("--reason", required=True, help="Rollback reason")
    rollback_cmd.add_argument("--payload", default="{}", type=_json_arg, help="JSON payload object")

    rollback_list_cmd = sub.add_parser("list-rollbacks", help="List rollback events")
    rollback_list_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    rollback_list_cmd.add_argument("--limit", type=int, default=20, help="Number of rows")

    nca_cmd = sub.add_parser("append-nca-snapshot", help="Append one NCA snapshot")
    nca_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    nca_cmd.add_argument("--parent-snapshot-id", default=None, help="Parent snapshot id")
    nca_cmd.add_argument("--checkpoint-id", default=None, help="Checkpoint id")
    nca_cmd.add_argument("--motif-summary", default=None, help="Motif summary")
    nca_cmd.add_argument("--drift-signal", type=float, default=None, help="Drift signal")
    nca_cmd.add_argument("--anomaly-flags", default="[]", type=_json_value_arg, help="JSON anomaly flags list")
    nca_cmd.add_argument("--payload", default="{}", type=_json_arg, help="JSON payload object")

    nca_list_cmd = sub.add_parser("list-nca-snapshots", help="List latest NCA snapshots")
    nca_list_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    nca_list_cmd.add_argument("--checkpoint-id", default=None, help="Filter by checkpoint id")
    nca_list_cmd.add_argument("--limit", type=int, default=20, help="Number of rows")

    adapter_cmd = sub.add_parser("append-adapter", help="Append one adapter registry row")
    adapter_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    adapter_cmd.add_argument("--base-model-id", required=True, help="Base model id")
    adapter_cmd.add_argument("--adapter-path", required=True, help="Filesystem path to adapter")
    adapter_cmd.add_argument("--lineage", default="{}", type=_json_arg, help="JSON train corpus lineage object")
    adapter_cmd.add_argument("--validation", default="{}", type=_json_arg, help="JSON validation summary object")
    adapter_cmd.add_argument("--deployment-state", required=True, help="Deployment state")
    adapter_cmd.add_argument("--merge-state", required=True, help="Merge state")
    adapter_cmd.add_argument("--payload", default="{}", type=_json_arg, help="JSON payload object")

    adapter_list_cmd = sub.add_parser("list-adapters", help="List latest adapter registry entries")
    adapter_list_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    adapter_list_cmd.add_argument("--base-model-id", default=None, help="Filter by base model id")
    adapter_list_cmd.add_argument("--limit", type=int, default=10, help="Number of rows")

    status_cmd = sub.add_parser("status-snapshot", help="Emit status snapshot for the store")
    status_cmd.add_argument("--db-path", default=None, help="sqlite database path")

    retention_cmd = sub.add_parser("audit-retention", help="Audit retention and compaction health")
    retention_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    retention_cmd.add_argument("--days", type=int, default=180, help="Rows older than this are flagged")

    migration_cmd = sub.add_parser("migration-report", help="Report migration/schema health")
    migration_cmd.add_argument("--db-path", default=None, help="sqlite database path")

    index_cmd = sub.add_parser("index-reflections", help="Index reflections into Qdrant")
    index_cmd.add_argument("--db-path", default=None, help="sqlite database path")
    index_cmd.add_argument("--qdrant-url", default=DEFAULT_QDRANT_URL, help="Qdrant URL")
    index_cmd.add_argument("--collection", default=DEFAULT_COLLECTION, help="Qdrant collection")
    index_cmd.add_argument("--vector-size", type=int, default=DEFAULT_VECTOR_SIZE, help="Qdrant vector size")
    index_cmd.add_argument("--limit", type=int, default=200, help="Maximum reflections to index")
    index_cmd.add_argument("--refresh", action="store_true", help="Drop and recreate collection first")
    index_cmd.add_argument("--dry-run", action="store_true", help="Compute points without sending to Qdrant")
    index_cmd.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS, help="Qdrant client timeout in seconds")

    search_cmd = sub.add_parser("search-reflections", help="Search reflections from Qdrant")
    search_cmd.add_argument("--query", required=True, help="Search query text")
    search_cmd.add_argument("--qdrant-url", default=DEFAULT_QDRANT_URL, help="Qdrant URL")
    search_cmd.add_argument("--collection", default=DEFAULT_COLLECTION, help="Qdrant collection")
    search_cmd.add_argument("--vector-size", type=int, default=DEFAULT_VECTOR_SIZE, help="Qdrant vector size")
    search_cmd.add_argument("--limit", type=int, default=5, help="Number of matches")
    search_cmd.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS, help="Qdrant client timeout in seconds")

    parsed = parser.parse_args()
    if hasattr(parsed, "db_path"):
        parsed.db_path = _resolve_db_path(parsed.root, parsed.db_path)
    if parsed.command == "append-reflection" and parsed.source_event_id == "":
        parsed.source_event_id = None
    if parsed.command == "append-promotion" and parsed.reflection_id == "":
        parsed.reflection_id = None
    if hasattr(parsed, "from_checkpoint_id") and parsed.from_checkpoint_id == "":
        parsed.from_checkpoint_id = None
    if hasattr(parsed, "to_checkpoint_id") and parsed.to_checkpoint_id == "":
        parsed.to_checkpoint_id = None
    if hasattr(parsed, "adapter_id") and parsed.adapter_id == "":
        parsed.adapter_id = None
    if hasattr(parsed, "nca_snapshot_id") and parsed.nca_snapshot_id == "":
        parsed.nca_snapshot_id = None
    if hasattr(parsed, "target_id") and parsed.target_id == "":
        parsed.target_id = None
    if hasattr(parsed, "checkpoint_id") and parsed.checkpoint_id == "":
        parsed.checkpoint_id = None
    if hasattr(parsed, "parent_snapshot_id") and parsed.parent_snapshot_id == "":
        parsed.parent_snapshot_id = None
    return parsed


def ensure_db(db_path: str, root: str) -> str:
    db = Path(db_path)

    if db.exists():
        init_db(db)
        return str(db)

    bootstrap_workspace(root, db)
    return str(db)


def _error_payload(message: str, command: str) -> dict[str, str]:
    return {"command": command, "error": message}


def main() -> int:
    args = parse_args()

    if args.command in ("index-reflections", "search-reflections"):
        # search/index are optional integrations and should remain resilient when Qdrant is unavailable.
        if args.command == "index-reflections":
            args.db_path = ensure_db(args.db_path, args.root)

        try:
            if args.command == "index-reflections":
                payload = index_reflections_in_qdrant(
                    args.db_path,
                    qdrant_url=args.qdrant_url,
                    collection=args.collection,
                    vector_size=args.vector_size,
                    limit=args.limit,
                    dry_run=args.dry_run,
                    refresh=args.refresh,
                    timeout_seconds=args.timeout,
                )
                print(json.dumps(payload, indent=2))
                return 0

            payload = search_reflections_in_qdrant(
                args.query,
                qdrant_url=args.qdrant_url,
                collection=args.collection,
                vector_size=args.vector_size,
                limit=args.limit,
                timeout_seconds=args.timeout,
            )
            print(json.dumps(payload, indent=2))
            return 0
        except (QdrantUnavailableError, QdrantOperationError) as exc:
            print(json.dumps(_error_payload(str(exc), args.command), indent=2))
            return 1

    args.db_path = ensure_db(args.db_path, args.root)

    if args.command == "bootstrap":
        result = bootstrap_workspace(args.root, args.db_path)
        if args.seed_smoke_event:
            event = append_event(
                result["dbPath"],
                event_type="bootstrap_smoke",
                source="dali_store.py",
                payload={
                    "message": "Initial Dali-local-v1 bootstrap completed",
                    "root": result["root"],
                },
            )
            result["smokeEvent"] = event
            result["recentEvents"] = list_recent_events(result["dbPath"], limit=5)
        print(json.dumps(result, indent=2))
        return 0

    if args.command == "summary":
        payload = {"dbPath": args.db_path, "counts": summary(args.db_path)}
        print(json.dumps(payload, indent=2))
        return 0

    if args.command == "import-source-research-corpus":
        payload = import_source_research_corpus(
            args.db_path,
            corpus_root=args.corpus_root,
            corpus_id=args.corpus_id,
            limit=args.limit,
            refresh=args.refresh,
        )
        print(json.dumps(payload, indent=2))
        return 0

    if args.command == "list-corpora":
        print(json.dumps(list_document_corpora(args.db_path, limit=args.limit), indent=2))
        return 0

    if args.command == "list-documents":
        print(
            json.dumps(
                list_documents(
                    args.db_path,
                    corpus_id=args.corpus_id,
                    topic=args.topic,
                    limit=args.limit,
                ),
                indent=2,
            )
        )
        return 0

    if args.command == "show-document":
        try:
            document = get_document(
                args.db_path,
                document_id=args.document_id,
                hash8=args.hash8,
                corpus_id=args.corpus_id,
            )
        except ValueError as exc:
            print(json.dumps(_error_payload(str(exc), args.command), indent=2))
            return 1
        chunks = []
        if document:
            chunks = list_document_chunks_for_document(
                args.db_path,
                document_id=document["id"],
                corpus_id=args.corpus_id,
                limit=args.chunk_limit,
            )
        print(json.dumps({"document": document, "chunks": chunks}, indent=2))
        return 0

    if args.command == "search-documents":
        print(
            json.dumps(
                search_document_chunks(
                    args.db_path,
                    query=args.query,
                    corpus_id=args.corpus_id,
                    topic=args.topic,
                    limit=args.limit,
                ),
                indent=2,
            )
        )
        return 0

    if args.command == "retrieve-context":
        print(
            json.dumps(
                build_context_bundle(
                    args.db_path,
                    query=args.query,
                    corpus_id=args.corpus_id,
                    topic=args.topic,
                    document_limit=args.document_limit,
                    chunk_limit=args.chunk_limit,
                    reflection_limit=args.reflection_limit,
                    max_chars=args.max_chars,
                ),
                indent=2,
            )
        )
        return 0

    if args.command == "status-snapshot":
        print(json.dumps(status_snapshot(args.db_path), indent=2))
        return 0

    if args.command == "audit-retention":
        payload = retention_audit(
            args.db_path,
            days=args.days,
        )
        print(json.dumps(payload, indent=2))
        return 0

    if args.command == "migration-report":
        print(json.dumps(migration_report(args.db_path), indent=2))
        return 0

    if args.command == "append-event":
        event = append_event(
            args.db_path,
            event_type=args.type,
            source=args.source,
            actor=args.actor,
            conversation_id=args.conversation_id,
            parent_event_id=args.parent_event_id,
            payload=args.payload,
        )
        print(json.dumps(event, indent=2))
        return 0

    if args.command == "append-reflection":
        reflection = append_reflection(
            args.db_path,
            source_event_id=args.source_event_id,
            reflection_text=args.text,
            durable_claims=args.durable_claim,
            uncertainties=args.uncertainty,
            interdisciplinary_links=args.link,
            nca_signal=args.nca_signal,
            creative_fragment=args.creative_fragment,
            memory_candidate_score=args.memory_score,
            payload=args.payload,
        )
        print(json.dumps(reflection, indent=2))
        print(json.dumps(list_recent_reflections(args.db_path, limit=5), indent=2))
        return 0

    if args.command == "append-promotion":
        promotion = append_promotion(
            args.db_path,
            reflection_id=args.reflection_id,
            claim_text=args.claim,
            promoted_to=args.promoted_to,
            decision=args.decision,
            evidence=args.evidence,
            checkpoint_id=args.checkpoint_id,
            payload=args.payload,
        )
        print(json.dumps(promotion, indent=2))
        print(json.dumps(list_recent_promotions(args.db_path, limit=5), indent=2))
        return 0

    if args.command == "append-shadow-run":
        run = append_shadow_run(
            args.db_path,
            prompt_hash=args.prompt_hash,
            teacher_output=args.teacher,
            candidate_outputs=args.candidates,
            judge_scores=args.scores,
            chosen_candidate_id=args.chosen_candidate_id,
            payload=args.payload,
        )
        print(json.dumps(run, indent=2))
        print(json.dumps(list_shadow_runs(args.db_path, limit=5), indent=2))
        return 0

    if args.command == "list-shadow-runs":
        print(json.dumps(list_shadow_runs(args.db_path, limit=args.limit), indent=2))
        return 0

    if args.command == "append-eval-run":
        run = append_eval_run(
            args.db_path,
            suite_name=args.suite,
            target_kind=args.target_kind,
            target_id=args.target_id,
            score_summary=args.score_summary,
            artifact_path=args.artifact_path,
            payload=args.payload,
        )
        print(json.dumps(run, indent=2))
        print(json.dumps(list_eval_runs(args.db_path, suite_name=args.suite, target_kind=args.target_kind, target_id=args.target_id, limit=5), indent=2))
        return 0

    if args.command == "list-eval-runs":
        print(
            json.dumps(
                list_eval_runs(
                    args.db_path,
                    suite_name=args.suite,
                    target_kind=args.target_kind,
                    target_id=args.target_id,
                    limit=args.limit,
                ),
                indent=2,
            )
        )
        return 0

    if args.command == "compare-eval-runs":
        payload = compare_eval_runs_for_metric(
            args.db_path,
            suite_name=args.suite,
            metric=args.metric,
            target_kind=args.target_kind,
            limit=args.limit,
        )
        print(json.dumps(payload, indent=2))
        return 0

    if args.command == "gate-checkpoint":
        payload = gate_checkpoint_by_eval(
            args.db_path,
            checkpoint_id=args.checkpoint_id,
            suite_name=args.suite,
            metric=args.metric,
            min_improvement=args.min_improvement,
            artifact_path=args.artifact_path,
        )
        print(json.dumps(payload, indent=2))
        return 0

    if args.command == "append-checkpoint":
        checkpoint = append_checkpoint(
            args.db_path,
            base_model_id=args.base_model_id,
            adapter_id=args.adapter_id,
            nca_snapshot_id=args.nca_snapshot_id,
            status=args.status,
            lineage=args.lineage,
            metrics=args.metrics,
            notes=args.notes,
        )
        print(json.dumps(checkpoint, indent=2))
        print(json.dumps(list_checkpoints(args.db_path, limit=5), indent=2))
        return 0

    if args.command == "list-checkpoints":
        print(json.dumps(list_checkpoints(args.db_path, limit=args.limit, status=args.status), indent=2))
        return 0

    if args.command == "set-checkpoint-status":
        set_checkpoint_status(args.db_path, checkpoint_id=args.checkpoint_id, status=args.status)
        print(json.dumps({"checkpointId": args.checkpoint_id, "status": args.status}, indent=2))
        return 0

    if args.command == "append-rollback":
        try:
            event = append_rollback_event(
                args.db_path,
                from_checkpoint_id=args.from_checkpoint_id,
                to_checkpoint_id=args.to_checkpoint_id,
                reason=args.reason,
                payload=args.payload,
            )
        except (ValueError, sqlite3.IntegrityError) as exc:
            print(json.dumps(_error_payload(str(exc), args.command), indent=2))
            return 1
        print(json.dumps(event, indent=2))
        print(json.dumps(list_rollback_events(args.db_path, limit=10), indent=2))
        return 0

    if args.command == "list-rollbacks":
        print(json.dumps(list_rollback_events(args.db_path, limit=args.limit), indent=2))
        return 0

    if args.command == "append-nca-snapshot":
        if not isinstance(args.anomaly_flags, list):
            raise argparse.ArgumentTypeError("--anomaly-flags must be a JSON array")
        snapshot = append_nca_snapshot(
            args.db_path,
            parent_snapshot_id=args.parent_snapshot_id,
            checkpoint_id=args.checkpoint_id,
            motif_summary=args.motif_summary,
            drift_signal=args.drift_signal,
            anomaly_flags=args.anomaly_flags,
            payload=args.payload,
        )
        print(json.dumps(snapshot, indent=2))
        print(json.dumps(list_nca_snapshots(args.db_path, limit=5), indent=2))
        return 0

    if args.command == "list-nca-snapshots":
        print(json.dumps(list_nca_snapshots(args.db_path, checkpoint_id=args.checkpoint_id, limit=args.limit), indent=2))
        return 0

    if args.command == "append-adapter":
        if not args.base_model_id.strip():
            raise ValueError("base model id cannot be empty")
        adapter = append_adapter_registry(
            args.db_path,
            base_model_id=args.base_model_id,
            adapter_path=args.adapter_path,
            train_corpus_lineage=args.lineage,
            validation_summary=args.validation,
            deployment_state=args.deployment_state,
            merge_state=args.merge_state,
            payload=args.payload,
        )
        print(json.dumps(adapter, indent=2))
        print(json.dumps(list_adapters(args.db_path, limit=5), indent=2))
        return 0

    if args.command == "list-adapters":
        print(json.dumps(list_adapters(args.db_path, base_model_id=args.base_model_id, limit=args.limit), indent=2))
        return 0

    if args.command == "append-compaction-experiment":
        experiment = append_compaction_experiment(
            args.db_path,
            model_id=args.model_id,
            curriculum_stage=args.curriculum_stage,
            approach=args.approach,
            name=args.name,
            segment_window=args.segment_window,
            kv_reduction_ratio=args.kv_reduction,
            throughput_mult=args.throughput_mult,
            accuracy_delta=args.accuracy_delta,
            leakage_risk_score=args.leakage_risk,
            tokens_in=args.tokens_in,
            tokens_out=args.tokens_out,
            notes=args.notes,
            payload=args.payload,
            max_stage3_leakage_risk=(
                args.max_stage3_leakage_risk
                if args.max_stage3_leakage_risk is not None
                else DEFAULT_STAGE3_LEAKAGE_RISK_THRESHOLD
            ),
            status=args.status,
        )
        print(json.dumps(experiment, indent=2))
        print(json.dumps(list_recent_compaction_experiments(args.db_path, limit=10), indent=2))
        return 0

    if args.command == "append-compaction-block":
        block = append_compaction_block(
            args.db_path,
            experiment_id=args.experiment_id,
            segment_index=args.segment_index,
            curriculum_stage=args.curriculum_stage,
            segment_text=args.segment,
            memento_text=args.memento,
            source_prompt=args.prompt,
            expected_answer=args.expected_answer,
            side_channel_hint=args.side_channel,
            source_event_id=args.source_event_id,
            source_event_turn=args.source_event_turn,
            payload=args.payload,
        )
        print(json.dumps(block, indent=2))
        print(json.dumps(list_compaction_blocks_for_experiment(args.db_path, args.experiment_id, limit=20), indent=2))
        return 0

    if args.command == "list-compaction-experiments":
        print(json.dumps(list_recent_compaction_experiments(args.db_path, args.limit), indent=2))
        return 0

    if args.command == "list-compaction-blocks":
        print(json.dumps(list_compaction_blocks_for_experiment(args.db_path, args.experiment_id, args.limit), indent=2))
        return 0

    if args.command == "list-promotions":
        print(json.dumps(list_recent_promotions(args.db_path, args.limit), indent=2))
        return 0

    raise SystemExit("unsupported command")


if __name__ == "__main__":
    raise SystemExit(main())
