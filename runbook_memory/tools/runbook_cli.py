from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

try:
    from ..config_loader import load_config
    from ..frontmatter import (
        build_default_frontmatter,
        dump_frontmatter,
        parse_frontmatter,
        validate_frontmatter,
    )
    from ..indexer import (
        index_markdown_file,
        index_roots,
        resolve_target_path,
        write_runbook_file,
    )
    from ..maintenance import (
        changed_docs_index,
        duplicate_scan,
        eval_label_queue,
        eval_suite,
        health_report,
        hotset_index,
        low_confidence_review_queue,
        stale_doc_queue,
        transcript_eval_set_from_history,
        update_eval_label,
    )
    from ..migration import import_docs
    from ..retrieval import document_payload, lookup_document, search
    from ..schema import open_database
    from ..utils import ensure_dir, repo_root, slugify
except ImportError:
    package_root = Path(__file__).resolve().parents[2]
    if str(package_root) not in sys.path:
        sys.path.insert(0, str(package_root))
    from runbook_memory.config_loader import load_config
    from runbook_memory.frontmatter import (
        build_default_frontmatter,
        dump_frontmatter,
        parse_frontmatter,
        validate_frontmatter,
    )
    from runbook_memory.indexer import (
        index_markdown_file,
        index_roots,
        resolve_target_path,
        write_runbook_file,
    )
    from runbook_memory.maintenance import (
        changed_docs_index,
        duplicate_scan,
        eval_label_queue,
        eval_suite,
        health_report,
        hotset_index,
        low_confidence_review_queue,
        stale_doc_queue,
        transcript_eval_set_from_history,
        update_eval_label,
    )
    from runbook_memory.migration import import_docs
    from runbook_memory.retrieval import document_payload, lookup_document, search
    from runbook_memory.schema import open_database
    from runbook_memory.utils import ensure_dir, repo_root, slugify

RUNBOOK_TYPES = [
    "incident_runbook",
    "feature_runbook",
    "plugin_runbook",
    "ops_sop",
    "troubleshooting_note",
    "change_record",
    "migration_guide",
    "reference_card",
]


def resolve_runtime_paths(cfg: dict[str, Any], config_path: Path | None = None) -> dict[str, Any]:
    root = Path(cfg.get("repo_root") or repo_root()).expanduser().resolve()
    runbooks_root = Path(cfg.get("runbooks_root") or (root / "runbooks")).expanduser().resolve()
    db_path = Path(cfg.get("database_path") or (root / "runbook_memory" / "db" / "runbook_memory.sqlite3")).expanduser().resolve()
    reports_dir = Path(cfg.get("reports_dir") or (root / "runbook_memory" / "reports")).expanduser().resolve()
    source_roots = [Path(p).expanduser().resolve() for p in cfg.get("source_roots", [Path.home() / "Documents"])]
    embedding_cfg = cfg.get("embedding", {}) if isinstance(cfg.get("embedding"), dict) else {}
    embedding_model = None
    if embedding_cfg.get("enabled") or cfg.get("embedding_model"):
        embedding_model = str(embedding_cfg.get("model_name") or cfg.get("embedding_model") or "").strip() or None
    index_cfg = cfg.get("index", {}) if isinstance(cfg.get("index"), dict) else {}
    max_chunk_chars = int(index_cfg.get("max_chunk_chars") or 1200)
    top_k = int(index_cfg.get("top_k") or 5)
    return {
        "repo_root": root,
        "runbooks_root": runbooks_root,
        "db_path": db_path,
        "reports_dir": reports_dir,
        "source_roots": source_roots,
        "embedding_model": embedding_model,
        "max_chunk_chars": max_chunk_chars,
        "top_k": top_k,
        "config_path": config_path,
    }


def load_runtime(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any]]:
    config_path = Path(args.config).expanduser().resolve() if getattr(args, "config", None) else None
    cfg = load_config(config_path)
    runtime = resolve_runtime_paths(cfg, config_path)
    return cfg, runtime


def apply_runtime_overrides(runtime: dict[str, Any], overrides: dict[str, Any] | None) -> dict[str, Any]:
    if not overrides:
        return runtime

    updated = dict(runtime)
    if repo_root := overrides.get("repoRoot"):
        updated["repo_root"] = Path(str(repo_root)).expanduser().resolve()
    if runbooks_root := overrides.get("runbooksRoot"):
        updated["runbooks_root"] = Path(str(runbooks_root)).expanduser().resolve()
    if db_path := overrides.get("dbPath"):
        updated["db_path"] = Path(str(db_path)).expanduser().resolve()
    if reports_dir := overrides.get("reportsDir"):
        updated["reports_dir"] = Path(str(reports_dir)).expanduser().resolve()
    return updated


def open_conn(runtime: dict[str, Any]):
    ensure_dir(runtime["db_path"].parent)
    conn = open_database(runtime["db_path"])
    ensure_dir(runtime["runbooks_root"])
    for folder in ["services", "plugins", "infrastructure", "incidents", "archived", "templates"]:
        ensure_dir(runtime["runbooks_root"] / folder)
    ensure_dir(runtime["reports_dir"])
    return conn


def json_print(payload: Any) -> None:
    sys.stdout.write(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n")


def text_print(payload: str) -> None:
    sys.stdout.write(payload.rstrip() + "\n")


def resolve_existing_document_path(doc: Any) -> Path | None:
    candidates: list[Path] = []
    for key in ("canonical_path", "source_path"):
        raw = str(doc[key] or "").strip() if key in doc.keys() else ""
        if not raw:
            continue
        candidates.append(Path(raw))
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0] if candidates else None


def resolve_write_path(runtime: dict[str, Any], args: argparse.Namespace, metadata: dict[str, Any]) -> Path:
    if getattr(args, "output", None):
        return Path(args.output).expanduser().resolve()
    return resolve_target_path(runtime["runbooks_root"], metadata)


def build_body_from_args(args: argparse.Namespace) -> str:
    if getattr(args, "body_file", None):
        return Path(args.body_file).expanduser().read_text(encoding="utf-8")
    if getattr(args, "body", None):
        return str(args.body)
    return "\n".join(
        [
            "# Purpose",
            "",
            "Describe the purpose of this runbook.",
            "",
            "# When to use",
            "",
            "Describe the conditions that should route here.",
            "",
            "# Prerequisites",
            "",
            "List prerequisites.",
            "",
            "# Triage",
            "",
            "Provide first-response steps.",
            "",
            "# Validation",
            "",
            "Explain how to verify the fix.",
        ]
    )


def cmd_init(args: argparse.Namespace) -> int:
    _, runtime = load_runtime(args)
    conn = open_conn(runtime)
    conn.commit()
    json_print(
        {
            "ok": True,
            "repo_root": str(runtime["repo_root"]),
            "runbooks_root": str(runtime["runbooks_root"]),
            "database_path": str(runtime["db_path"]),
            "reports_dir": str(runtime["reports_dir"]),
        }
    )
    return 0


def cmd_search(args: argparse.Namespace) -> int:
    cfg, runtime = load_runtime(args)
    conn = open_conn(runtime)
    result = search(
        conn,
        args.query,
        service=args.service,
        feature=args.feature,
        plugin=args.plugin,
        environment=args.environment,
        lifecycle_preference=args.lifecycle_preference,
        top_k=args.top_k or runtime["top_k"],
        embedding_model=runtime["embedding_model"],
    )
    json_print(result)
    return 0


def cmd_get(args: argparse.Namespace) -> int:
    cfg, runtime = load_runtime(args)
    conn = open_conn(runtime)
    doc = lookup_document(conn, args.identifier)
    if not doc:
        text_print(f"document not found: {args.identifier}")
        return 1
    if args.json:
        json_print(document_payload(conn, str(doc["doc_id"])))
        return 0
    path = resolve_existing_document_path(doc)
    if path and path.exists():
        text_print(path.read_text(encoding="utf-8"))
        return 0
    json_print(document_payload(conn, str(doc["doc_id"])))
    return 0


def cmd_create(args: argparse.Namespace) -> int:
    _, runtime = load_runtime(args)
    conn = open_conn(runtime)
    title = args.title.strip()
    metadata = build_default_frontmatter(
        title=title,
        doc_type=args.type,
        lifecycle_state=args.lifecycle_state,
        owners_primary=args.owners_primary,
        service=args.service or "",
        feature=args.feature or "",
        plugin=args.plugin or "",
        environments=args.environments or [],
        provenance_source_type=args.source_type,
        provenance_source_ref=args.source_ref or "",
        validation_last_validated_at=args.validated_at or "",
        validation_review_interval_days=args.review_interval_days,
        tags=args.tags or [],
        aliases=args.aliases or [],
        retrieval_synopsis=args.retrieval_synopsis or "",
        retrieval_hints=args.retrieval_hints or [],
        retrieval_not_for=args.retrieval_not_for or [],
        retrieval_commands=args.retrieval_commands or [],
    )
    body = build_body_from_args(args)
    target = resolve_write_path(runtime, args, metadata)
    write_runbook_file(target, metadata, body)
    index_markdown_file(
        conn,
        target,
        runbooks_root=runtime["runbooks_root"],
        embedding_model=runtime["embedding_model"],
        max_chunk_chars=runtime["max_chunk_chars"],
    )
    conn.commit()
    json_print({"ok": True, "doc_id": metadata["doc_id"], "path": str(target)})
    return 0


def cmd_update(args: argparse.Namespace) -> int:
    _, runtime = load_runtime(args)
    conn = open_conn(runtime)
    doc = lookup_document(conn, args.identifier)
    if not doc:
        text_print(f"document not found: {args.identifier}")
        return 1
    doc_path = resolve_existing_document_path(doc)
    if doc_path is None or not doc_path.exists():
        text_print(f"document file not found: {doc_path}")
        return 1
    parsed = parse_frontmatter(doc_path.read_text(encoding="utf-8"))
    metadata = validate_frontmatter(parsed.metadata)
    if args.title:
        metadata["title"] = args.title
    if args.lifecycle_state:
        metadata["lifecycle_state"] = args.lifecycle_state
    if args.service is not None:
        metadata["scope"]["service"] = args.service
    if args.feature is not None:
        metadata["scope"]["feature"] = args.feature
    if args.plugin is not None:
        metadata["scope"]["plugin"] = args.plugin
    if args.add_environment:
        envs = list(metadata["scope"].get("environments", []))
        for env in args.add_environment:
            if env not in envs:
                envs.append(env)
        metadata["scope"]["environments"] = envs
    if args.validated_at is not None:
        metadata["validation"]["last_validated_at"] = args.validated_at
    if args.review_interval_days is not None:
        metadata["validation"]["review_interval_days"] = args.review_interval_days
    if args.source_ref is not None:
        metadata["provenance"]["source_ref"] = args.source_ref
    if args.aliases is not None:
        metadata["aliases"] = list(args.aliases)
    if args.retrieval_synopsis is not None:
        metadata["retrieval"]["synopsis"] = args.retrieval_synopsis
    if args.retrieval_hints is not None:
        metadata["retrieval"]["hints"] = list(args.retrieval_hints)
    if args.retrieval_not_for is not None:
        metadata["retrieval"]["not_for"] = list(args.retrieval_not_for)
    if args.retrieval_commands is not None:
        metadata["retrieval"]["commands"] = list(args.retrieval_commands)
    body = parsed.body.rstrip()
    if args.body_append:
        body = body + "\n\n" + args.body_append.strip()
    doc_path.write_text(dump_frontmatter(metadata) + body.strip() + "\n", encoding="utf-8")
    index_markdown_file(
        conn,
        doc_path,
        runbooks_root=runtime["runbooks_root"],
        embedding_model=runtime["embedding_model"],
        max_chunk_chars=runtime["max_chunk_chars"],
    )
    conn.commit()
    json_print({"ok": True, "doc_id": metadata["doc_id"], "path": str(doc_path)})
    return 0


def cmd_review_queue(args: argparse.Namespace) -> int:
    _, runtime = load_runtime(args)
    conn = open_conn(runtime)
    payload = {
        "stale_docs": stale_doc_queue(conn),
        "duplicate_candidates": duplicate_scan(conn),
        "low_confidence_queries": low_confidence_review_queue(conn),
        "health": health_report(conn),
    }
    json_print(payload)
    return 0


def cmd_reindex(args: argparse.Namespace) -> int:
    _, runtime = load_runtime(args)
    conn = open_conn(runtime)
    if args.changed:
        payload = changed_docs_index(
            conn,
            roots=[Path(p).expanduser().resolve() for p in (args.source_root or runtime["source_roots"])],
            runbooks_root=runtime["runbooks_root"],
            embedding_model=runtime["embedding_model"],
        )
        json_print(payload)
        return 0
    results = index_roots(
        conn,
        [Path(p).expanduser().resolve() for p in (args.source_root or runtime["source_roots"])],
        runbooks_root=runtime["runbooks_root"],
        embedding_model=runtime["embedding_model"],
        max_chunk_chars=runtime["max_chunk_chars"],
    )
    json_print({"indexed_docs": len(results), "docs": results})
    return 0


def cmd_migrate(args: argparse.Namespace) -> int:
    _, runtime = load_runtime(args)
    conn = open_conn(runtime)
    source_roots = [Path(p).expanduser().resolve() for p in (args.source_root or runtime["source_roots"])]
    report = import_docs(
        conn,
        source_roots=source_roots,
        runbooks_root=runtime["runbooks_root"],
        embedding_model=runtime["embedding_model"],
    )
    report_path = runtime["reports_dir"] / f"migration_report_{slugify(args.name or 'latest')}.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False), encoding="utf-8")
    json_print({**report, "report_path": str(report_path)})
    return 0


def cmd_maintenance(args: argparse.Namespace) -> int:
    _, runtime = load_runtime(args)
    conn = open_conn(runtime)
    if args.maintenance_command == "changed-docs":
        result = changed_docs_index(
            conn,
            roots=[Path(p).expanduser().resolve() for p in (args.source_root or runtime["source_roots"])],
            runbooks_root=runtime["runbooks_root"],
            embedding_model=runtime["embedding_model"],
        )
    elif args.maintenance_command == "stale-doc-queue":
        result = stale_doc_queue(conn)
    elif args.maintenance_command == "duplicate-scan":
        result = duplicate_scan(conn)
    elif args.maintenance_command == "health-report":
        result = health_report(conn)
    elif args.maintenance_command == "hotset-index":
        result = hotset_index(conn, limit=args.limit)
        if getattr(args, "write_report", False):
            report_path = runtime["reports_dir"] / "hotset_index.md"
            lines = ["# Runbook Hotset Index", "", f"Generated: {result['generated_at']}", ""]
            docs = result.get("docs", [])
            if docs:
                for index, doc in enumerate(docs, start=1):
                    lines.append(
                        f"{index}. `{doc['doc_id']}` | {doc['title']} | score={doc['hotset_score']} | path=`{doc['canonical_path']}`"
                    )
                    for query in doc.get("example_queries", []):
                        lines.append(f"   query: {query}")
            else:
                lines.append("No retrieval logs yet. Re-run after agents use `runbook_search` or the CLI search flow.")
            report_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
            result["report_path"] = str(report_path)
    elif args.maintenance_command == "transcript-eval-set":
        history_path = Path(args.history_path).expanduser().resolve()
        output_path = Path(args.output).expanduser().resolve() if args.output else runtime["reports_dir"] / "real_agent_queries_eval_set.jsonl"
        result = transcript_eval_set_from_history(
            history_path,
            output_path=output_path,
            limit=args.limit,
        )
    elif args.maintenance_command == "eval-suite":
        eval_set_path = (
            Path(args.eval_set).expanduser().resolve()
            if getattr(args, "eval_set", None)
            else runtime["reports_dir"] / "real_agent_queries_eval_set.jsonl"
        )
        result = eval_suite(
            conn,
            eval_set_path=eval_set_path,
            top_k=args.top_k,
            embedding_model=runtime["embedding_model"],
        )
    elif args.maintenance_command == "eval-labels":
        eval_set_path = (
            Path(args.eval_set).expanduser().resolve()
            if getattr(args, "eval_set", None)
            else runtime["reports_dir"] / "real_agent_queries_eval_set.jsonl"
        )
        if args.query_id:
            result = update_eval_label(
                eval_set_path=eval_set_path,
                query_id=args.query_id,
                expected_doc_ids=args.expected_doc_id or [],
                needs_runbook=True if args.needs_runbook else None,
                clear=args.clear,
            )
        else:
            result = eval_label_queue(
                conn,
                eval_set_path=eval_set_path,
                top_k=args.top_k,
                limit=args.limit,
                only_unlabeled=not args.all,
                embedding_model=runtime["embedding_model"],
            )
    else:
        raise SystemExit(f"unknown maintenance command: {args.maintenance_command}")
    json_print(result)
    return 0


def cmd_action(args: argparse.Namespace) -> int:
    cfg, runtime = load_runtime(args)
    payload_raw = getattr(args, "payload_json", None) or "{}"
    payload = json.loads(payload_raw)
    if not isinstance(payload, dict):
        raise ValueError("payload_json must decode to an object")

    action = str(getattr(args, "action", "")).strip()
    params = payload.get("params", {})
    runtime_overrides = payload.get("runtime", {})
    if not isinstance(params, dict):
        raise ValueError("payload params must be an object")
    if runtime_overrides is not None and not isinstance(runtime_overrides, dict):
        raise ValueError("payload runtime must be an object")

    runtime = apply_runtime_overrides(runtime, runtime_overrides)
    conn = open_conn(runtime)

    if action == "search":
        query = str(params.get("query", "")).strip()
        if not query:
            raise ValueError("search query is required")
        result = search(
            conn,
            query,
            service=str(params.get("service") or "").strip() or None,
            feature=str(params.get("feature") or "").strip() or None,
            plugin=str(params.get("plugin") or "").strip() or None,
            environment=str(params.get("environment") or "").strip() or None,
            lifecycle_preference=str(params.get("lifecycle_preference") or "").strip() or None,
            top_k=int(params.get("top_k") or runtime["top_k"]),
            embedding_model=runtime["embedding_model"],
        )
        json_print(result)
        return 0

    if action == "get":
        identifier = str(params.get("doc_id") or params.get("alias") or "").strip()
        if not identifier:
            raise ValueError("doc_id or alias is required")
        doc = lookup_document(conn, identifier)
        if not doc:
            json_print({"ok": False, "error": f"document not found: {identifier}"})
            return 1
        result = document_payload(conn, str(doc["doc_id"]))
        section = str(params.get("section") or "").strip()
        if section:
            wanted = section.lower()
            result["chunks"] = [
                chunk
                for chunk in result.get("chunks", [])
                if str(chunk.get("section_path", "")).lower().startswith(wanted)
            ]
            result["section_summaries"] = [
                summary
                for summary in result.get("section_summaries", [])
                if str(summary.get("section_path", "")).lower().startswith(wanted)
            ]
        json_print(result)
        return 0

    if action == "create":
        title = str(params.get("title") or "").strip()
        doc_type = str(params.get("type") or "").strip()
        if not title or not doc_type:
            raise ValueError("create requires title and type")
        if doc_type not in RUNBOOK_TYPES:
            raise ValueError(f"unsupported runbook type: {doc_type}")

        scope = params.get("scope", {})
        scope = scope if isinstance(scope, dict) else {}
        metadata = build_default_frontmatter(
            title=title,
            doc_type=doc_type,
            lifecycle_state="draft",
            owners_primary="platform",
            service=str(scope.get("service") or "").strip(),
            feature=str(scope.get("feature") or "").strip(),
            plugin=str(scope.get("plugin") or "").strip(),
            environments=[
                str(env).strip()
                for env in (scope.get("environments") or [])
                if str(env).strip()
            ],
            provenance_source_type="human_or_agent",
            provenance_source_ref="tool:runbook_create",
            validation_last_validated_at="",
            validation_review_interval_days=30,
            tags=[str(item).strip() for item in (params.get("tags") or []) if str(item).strip()],
            aliases=[str(item).strip() for item in (params.get("aliases") or []) if str(item).strip()],
            retrieval_synopsis=str(params.get("retrieval_synopsis") or "").strip(),
            retrieval_hints=[str(item).strip() for item in (params.get("retrieval_hints") or []) if str(item).strip()],
            retrieval_not_for=[str(item).strip() for item in (params.get("retrieval_not_for") or []) if str(item).strip()],
            retrieval_commands=[str(item).strip() for item in (params.get("retrieval_commands") or []) if str(item).strip()],
        )
        notes = str(params.get("notes") or "").strip()
        related_files = params.get("related_files") or []
        related_docs = params.get("related_docs") or []
        body_sections = [notes] if notes else []
        if isinstance(related_files, list) and related_files:
            body_sections.append(
                "## Related files\n\n" + "\n".join(f"- `{str(item).strip()}`" for item in related_files if str(item).strip())
            )
        if isinstance(related_docs, list) and related_docs:
            body_sections.append(
                "## Related docs\n\n" + "\n".join(f"- `{str(item).strip()}`" for item in related_docs if str(item).strip())
            )
        body = "\n\n".join(part for part in body_sections if part).strip() or build_body_from_args(args)
        target = resolve_target_path(runtime["runbooks_root"], metadata)
        write_runbook_file(target, metadata, body)
        index_markdown_file(
            conn,
            target,
            runbooks_root=runtime["runbooks_root"],
            embedding_model=runtime["embedding_model"],
            max_chunk_chars=runtime["max_chunk_chars"],
        )
        conn.commit()
        json_print({"ok": True, "doc_id": metadata["doc_id"], "path": str(target)})
        return 0

    if action == "update":
        identifier = str(params.get("doc_id") or params.get("alias") or "").strip()
        if not identifier:
            raise ValueError("update requires doc_id or alias")
        doc = lookup_document(conn, identifier)
        if not doc:
            json_print({"ok": False, "error": f"document not found: {identifier}"})
            return 1
        doc_path = resolve_existing_document_path(doc)
        if doc_path is None or not doc_path.exists():
            raise FileNotFoundError(f"document file not found: {doc_path}")
        parsed = parse_frontmatter(doc_path.read_text(encoding="utf-8"))
        metadata = validate_frontmatter(parsed.metadata)
        if "aliases" in params:
            metadata["aliases"] = [str(item).strip() for item in (params.get("aliases") or []) if str(item).strip()]
        if "retrieval_synopsis" in params:
            metadata["retrieval"]["synopsis"] = str(params.get("retrieval_synopsis") or "").strip()
        if "retrieval_hints" in params:
            metadata["retrieval"]["hints"] = [str(item).strip() for item in (params.get("retrieval_hints") or []) if str(item).strip()]
        if "retrieval_not_for" in params:
            metadata["retrieval"]["not_for"] = [str(item).strip() for item in (params.get("retrieval_not_for") or []) if str(item).strip()]
        if "retrieval_commands" in params:
            metadata["retrieval"]["commands"] = [str(item).strip() for item in (params.get("retrieval_commands") or []) if str(item).strip()]
        note_parts = [
            str(params.get("update_intent") or "").strip(),
            str(params.get("evidence") or "").strip(),
            str(params.get("notes") or "").strip(),
        ]
        changed_sections = params.get("changed_sections") or []
        if isinstance(changed_sections, list) and changed_sections:
            note_parts.append(
                "Changed sections: " + ", ".join(str(item).strip() for item in changed_sections if str(item).strip())
            )
        note = "\n".join(part for part in note_parts if part).strip()
        body = parsed.body.rstrip()
        if note:
            body = body + "\n\n## Change note\n\n" + note
        doc_path.write_text(dump_frontmatter(metadata) + body.strip() + "\n", encoding="utf-8")
        index_markdown_file(
            conn,
            doc_path,
            runbooks_root=runtime["runbooks_root"],
            embedding_model=runtime["embedding_model"],
            max_chunk_chars=runtime["max_chunk_chars"],
        )
        conn.commit()
        json_print({"ok": True, "doc_id": metadata["doc_id"], "path": str(doc_path)})
        return 0

    if action == "review_queue":
        top_k = int(params.get("top_k") or 100)
        confidence_threshold = float(params.get("confidence_threshold") or 0.35)
        stale_docs = stale_doc_queue(conn)
        duplicate_candidates = duplicate_scan(conn)
        payload_result = {
            "stale_docs": stale_docs[:top_k],
            "duplicate_candidates": duplicate_candidates[:top_k],
            "low_confidence_queries": low_confidence_review_queue(
                conn,
                threshold=confidence_threshold,
                limit=top_k,
            ),
            "health": health_report(conn),
        }
        json_print(payload_result)
        return 0

    if action == "reindex":
        mode = str(params.get("mode") or "full").strip().lower()
        raw_doc_ids = params.get("doc_ids") or []
        doc_ids = [
            str(doc_id).strip()
            for doc_id in raw_doc_ids
            if str(doc_id).strip()
        ] if isinstance(raw_doc_ids, list) else []
        if doc_ids:
            indexed: list[dict[str, Any]] = []
            errors: list[dict[str, str]] = []
            for doc_id in doc_ids:
                doc = lookup_document(conn, doc_id)
                if not doc:
                    errors.append({"doc_id": doc_id, "error": "document not found"})
                    continue
                doc_path = resolve_existing_document_path(doc)
                if doc_path is None or not doc_path.exists():
                    errors.append({"doc_id": doc_id, "error": f"document file not found: {doc_path}"})
                    continue
                metadata = index_markdown_file(
                    conn,
                    doc_path,
                    runbooks_root=runtime["runbooks_root"],
                    embedding_model=runtime["embedding_model"],
                    max_chunk_chars=runtime["max_chunk_chars"],
                )
                indexed.append({
                    "doc_id": str(metadata["doc_id"]),
                    "path": str(doc_path),
                })
            conn.commit()
            json_print({
                "mode": mode,
                "targeted": True,
                "indexed_docs": len(indexed),
                "docs": indexed,
                "errors": errors,
                "ok": not errors,
            })
            return 0 if not errors else 1
        if mode == "changed":
            result = changed_docs_index(
                conn,
                roots=runtime["source_roots"],
                runbooks_root=runtime["runbooks_root"],
                embedding_model=runtime["embedding_model"],
            )
            json_print(result)
            return 0

        # For full/cards/embeddings we currently run a full rebuild pipeline.
        results = index_roots(
            conn,
            runtime["source_roots"],
            runbooks_root=runtime["runbooks_root"],
            embedding_model=runtime["embedding_model"],
            max_chunk_chars=runtime["max_chunk_chars"],
        )
        json_print(
            {
                "mode": mode,
                "indexed_docs": len(results),
                "docs": results,
            }
        )
        return 0

    raise ValueError(f"unsupported action: {action}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="runbook-cli", description="OpenClaw runbook memory backend")
    parser.add_argument("--config", help="Path to runbook memory config file")
    parser.add_argument("--action", help="Machine-mode action for plugin wrappers")
    parser.add_argument("--payload-json", help="Machine-mode payload JSON")
    subparsers = parser.add_subparsers(dest="command", required=False)

    init_parser = subparsers.add_parser("init", help="Create directories and initialize the database")
    init_parser.set_defaults(func=cmd_init)

    search_parser = subparsers.add_parser("search", help="Search runbooks")
    search_parser.add_argument("query")
    search_parser.add_argument("--service")
    search_parser.add_argument("--feature")
    search_parser.add_argument("--plugin")
    search_parser.add_argument("--environment")
    search_parser.add_argument("--lifecycle-preference")
    search_parser.add_argument("--top-k", type=int)
    search_parser.set_defaults(func=cmd_search)

    get_parser = subparsers.add_parser("get", help="Get a runbook by doc_id or alias")
    get_parser.add_argument("identifier")
    get_parser.add_argument("--json", action="store_true")
    get_parser.set_defaults(func=cmd_get)

    create_parser = subparsers.add_parser("create", help="Create a runbook")
    create_parser.add_argument("--title", required=True)
    create_parser.add_argument("--type", required=True, choices=RUNBOOK_TYPES)
    create_parser.add_argument("--lifecycle-state", default="draft", choices=["draft", "review", "active", "deprecated", "archived"])
    create_parser.add_argument("--owners-primary", default="platform")
    create_parser.add_argument("--service")
    create_parser.add_argument("--feature")
    create_parser.add_argument("--plugin")
    create_parser.add_argument("--environment", dest="environments", action="append")
    create_parser.add_argument("--tag", dest="tags", action="append")
    create_parser.add_argument("--alias", dest="aliases", action="append")
    create_parser.add_argument("--source-ref")
    create_parser.add_argument("--source-type", default="human_or_agent")
    create_parser.add_argument("--validated-at")
    create_parser.add_argument("--review-interval-days", type=int, default=30)
    create_parser.add_argument("--retrieval-synopsis")
    create_parser.add_argument("--retrieval-hint", dest="retrieval_hints", action="append")
    create_parser.add_argument("--not-for", dest="retrieval_not_for", action="append")
    create_parser.add_argument("--command-token", dest="retrieval_commands", action="append")
    create_parser.add_argument("--body")
    create_parser.add_argument("--body-file")
    create_parser.add_argument("--output")
    create_parser.set_defaults(func=cmd_create)

    update_parser = subparsers.add_parser("update", help="Update a runbook")
    update_parser.add_argument("identifier")
    update_parser.add_argument("--title")
    update_parser.add_argument("--lifecycle-state", choices=["draft", "review", "active", "deprecated", "archived"])
    update_parser.add_argument("--service")
    update_parser.add_argument("--feature")
    update_parser.add_argument("--plugin")
    update_parser.add_argument("--add-environment", action="append")
    update_parser.add_argument("--alias", dest="aliases", action="append")
    update_parser.add_argument("--validated-at")
    update_parser.add_argument("--review-interval-days", type=int)
    update_parser.add_argument("--source-ref")
    update_parser.add_argument("--retrieval-synopsis")
    update_parser.add_argument("--retrieval-hint", dest="retrieval_hints", action="append")
    update_parser.add_argument("--not-for", dest="retrieval_not_for", action="append")
    update_parser.add_argument("--command-token", dest="retrieval_commands", action="append")
    update_parser.add_argument("--body-append")
    update_parser.set_defaults(func=cmd_update)

    review_parser = subparsers.add_parser("review-queue", help="Show stale, duplicate, and low-confidence docs")
    review_parser.set_defaults(func=cmd_review_queue)

    reindex_parser = subparsers.add_parser("reindex", help="Rebuild indexes")
    reindex_parser.add_argument("--changed", action="store_true")
    reindex_parser.add_argument("--source-root", action="append")
    reindex_parser.set_defaults(func=cmd_reindex)

    migrate_parser = subparsers.add_parser("migrate", help="Import legacy docs")
    migrate_parser.add_argument("--source-root", action="append")
    migrate_parser.add_argument("--name")
    migrate_parser.set_defaults(func=cmd_migrate)

    maintenance_parser = subparsers.add_parser("maintenance", help="Run maintenance jobs")
    maintenance_sub = maintenance_parser.add_subparsers(dest="maintenance_command", required=True)
    changed_docs_parser = maintenance_sub.add_parser("changed-docs")
    changed_docs_parser.add_argument("--source-root", action="append")
    changed_docs_parser.set_defaults(func=cmd_maintenance)

    for name in ["stale-doc-queue", "duplicate-scan", "health-report"]:
        sub = maintenance_sub.add_parser(name)
        sub.set_defaults(func=cmd_maintenance)

    eval_parser = maintenance_sub.add_parser("eval-suite")
    eval_parser.add_argument("--eval-set")
    eval_parser.add_argument("--top-k", type=int, default=5)
    eval_parser.set_defaults(func=cmd_maintenance)

    eval_labels_parser = maintenance_sub.add_parser("eval-labels")
    eval_labels_parser.add_argument("--eval-set")
    eval_labels_parser.add_argument("--top-k", type=int, default=5)
    eval_labels_parser.add_argument("--limit", type=int, default=20)
    eval_labels_parser.add_argument("--all", action="store_true", help="Show labeled and unlabeled cases.")
    eval_labels_parser.add_argument("--query-id", help="Update one eval case instead of listing cases.")
    eval_labels_parser.add_argument("--expected-doc-id", action="append", help="Expected doc_id for --query-id; repeat for multiple accepted docs.")
    eval_labels_parser.add_argument("--needs-runbook", action="store_true", help="Mark --query-id as a documentation gap.")
    eval_labels_parser.add_argument("--clear", action="store_true", help="Clear existing label fields before applying a new label.")
    eval_labels_parser.set_defaults(func=cmd_maintenance)

    hotset_parser = maintenance_sub.add_parser("hotset-index")
    hotset_parser.add_argument("--limit", type=int, default=20)
    hotset_parser.add_argument("--write-report", action="store_true")
    hotset_parser.set_defaults(func=cmd_maintenance)

    transcript_parser = maintenance_sub.add_parser("transcript-eval-set")
    transcript_parser.add_argument("--history-path", default=str(Path.home() / ".codex" / "history.jsonl"))
    transcript_parser.add_argument("--output")
    transcript_parser.add_argument("--limit", type=int, default=20)
    transcript_parser.set_defaults(func=cmd_maintenance)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if getattr(args, "action", None):
        try:
            return int(cmd_action(args))
        except Exception as exc:
            json_print({"ok": False, "error": str(exc)})
            return 1
    if not hasattr(args, "func"):
        parser.print_help(sys.stderr)
        return 2
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
