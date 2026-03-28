from __future__ import annotations

from copy import deepcopy
from uuid import uuid4

from scripts.memory_hub.index_db import get_memory_record_by_canonical_key, get_source_bindings, upsert_source_binding


def build_source_binding(memory_id: str, incoming: dict) -> dict:
    return {
        "binding_id": incoming.get("binding_id", str(uuid4())),
        "memory_id": memory_id,
        "source_host": incoming["source_host"],
        "source_file": incoming["source_file"],
        "binding_status": incoming.get("binding_status", "active"),
        "source_revision_mtime": incoming.get("source_revision_mtime", 0.0),
        "source_revision_hash": incoming.get("source_revision_hash", ""),
        "created_at": incoming.get("created_at", ""),
        "updated_at": incoming.get("updated_at", ""),
    }


def merge_into_canonical(existing: dict, incoming: dict) -> dict | None:
    if existing.get("canonical_key") != incoming.get("canonical_key"):
        return None
    result = deepcopy(existing)
    bindings = list(result.get("bindings", []))
    pair = (incoming["source_host"], incoming["source_file"])
    known = {(item["source_host"], item["source_file"]) for item in bindings}
    if pair not in known:
        bindings.append(build_source_binding(result["memory_id"], incoming))
    result["bindings"] = bindings
    return result


def merge_record_into_db(db_path, record: dict) -> dict:
    existing = get_memory_record_by_canonical_key(db_path, record["canonical_key"])
    incoming = {
        "canonical_key": record["canonical_key"],
        "source_host": record["source_host"],
        "source_file": record["source_file"],
        "source_revision_mtime": record["source_revision"]["mtime"],
        "source_revision_hash": record["source_revision"]["sha256"],
        "created_at": record["created_at"],
        "updated_at": record["updated_at"],
    }
    if not existing:
        binding = build_source_binding(record["memory_id"], incoming)
        upsert_source_binding(db_path, binding)
        result = dict(record)
        result["bindings"] = [binding]
        return result

    existing_bindings = get_source_bindings(db_path, existing["memory_id"])
    if not existing_bindings:
        existing_bindings = [
            build_source_binding(
                existing["memory_id"],
                {
                    "source_host": existing["source_host"],
                    "source_file": existing["source_file"],
                    "source_revision_mtime": 0.0,
                    "source_revision_hash": "",
                    "created_at": existing["created_at"],
                    "updated_at": existing["updated_at"],
                },
            )
        ]

    merged = merge_into_canonical(
        {
            **existing,
            "bindings": existing_bindings,
        },
        incoming,
    )
    if not merged:
        binding = build_source_binding(record["memory_id"], incoming)
        upsert_source_binding(db_path, binding)
        result = dict(record)
        result["bindings"] = [binding]
        return result

    for binding in merged["bindings"]:
        upsert_source_binding(db_path, binding)
    merged_record = dict(record)
    merged_record["memory_id"] = existing["memory_id"]
    merged_record["bindings"] = merged["bindings"]
    return merged_record
