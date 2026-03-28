#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.memory_hub.audit import build_audit_entry
from scripts.memory_hub.classifier import classify_observation
from scripts.memory_hub.event_schema import normalize_event
from scripts.memory_hub.index_db import init_db, upsert_memory_record
from scripts.memory_hub.memory_schema import build_memory_record
from scripts.memory_hub.merge import merge_record_into_db
from scripts.memory_hub.mirror_store import append_audit_entry, append_event, write_active_memory, write_candidate
from scripts.memory_hub.revision import capture_source_revision
from scripts.memory_hub.writeback import decide_writeback, execute_writeback


def derive_host_root(event: dict) -> Path:
    payload = event.get("payload", {})
    if payload.get("target_index_file"):
        return Path(payload["target_index_file"]).resolve().parent
    return Path(event["source_file"]).resolve().parent.parent


def ensure_host_roots(event: dict, host_roots: dict[str, Path]) -> dict[str, Path]:
    if event["source_host"] in host_roots:
        return host_roots
    resolved = dict(host_roots)
    resolved[event["source_host"]] = derive_host_root(event)
    return resolved


def ingest_one_event(hub_root: Path, host_roots: dict[str, Path], raw_event: dict) -> dict:
    event = normalize_event(raw_event)
    append_event(hub_root, event)
    db_path = hub_root / "hub.sqlite3"
    init_db(db_path)
    classification = classify_observation(event)
    source_revision = capture_source_revision(Path(event["source_file"]))
    record = build_memory_record(event, classification, source_revision)
    merged_record = merge_record_into_db(db_path, record)
    upsert_memory_record(db_path, merged_record)
    if classification.get("bucket") == "long_term_candidate":
        write_candidate(hub_root, merged_record)
    else:
        write_active_memory(hub_root, merged_record)
    effective_host_roots = ensure_host_roots(event, host_roots)
    writeback_action = decide_writeback(classification)
    writeback_result = execute_writeback(
        action=writeback_action,
        source_host=event["source_host"],
        host_roots=effective_host_roots,
        payload=event["payload"],
        expected_revision=source_revision,
    )
    audit = build_audit_entry(writeback_result["action"], merged_record["memory_id"], event["source_host"])
    append_audit_entry(hub_root, audit)
    return {
        "event": event,
        "classification": classification,
        "record": merged_record,
        "writeback": writeback_result,
        "host_roots": {key: str(value) for key, value in effective_host_roots.items()},
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hub-root", required=True)
    ap.add_argument("--event-json", required=True)
    args = ap.parse_args()
    raw = json.loads(Path(args.event_json).read_text(encoding="utf-8"))
    result = ingest_one_event(Path(args.hub_root), {}, raw)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
