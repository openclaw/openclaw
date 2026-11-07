#!/usr/bin/env python3
"""Build synthetic agent fixtures for transcript-active-facts.ts.

Requires Python 3.14+ (compression.zstd) and SQLite with STRICT/FTS5 support.
Example from the repository root, using a schema exported from the pinned base:
  python3 scripts/perf/transcript-active-facts.py \
    --output .local/active-facts --schema .local/active-facts/base-schema.sql \
    --name team --rows 6300000 --mode full --file-bytes 70000000000

Never reads live state or overwrites an existing fixture. Full mode allocates and
frees real SQLite pages before appends to fragment overflow chains. Optional
file-bytes grows the real allocation high-water with temporary rows, then drops
those rows; it never truncates a file to a larger size or creates sparse padding.
Only synthetic-0 is finalized for hydration. Other sessions provide storage and
index cardinality. Fixture preparation is excluded from measured operations.
Hybrid mode uses full payloads on the four long paths and compact cardinality
rows elsewhere. Use --schema-version 41 with the current canonical schema for
backfill proof; the default remains the predecessor schema 40.
"""

import argparse
import hashlib
import json
import os
import random
import re
import sqlite3
import time
from compression import zstd
from pathlib import Path


CHUNK = 10_000
SESSION_ID = "synthetic-0"


def emit(value):
    print(json.dumps(value), flush=True)


def json_text(value):
    return json.dumps(value, separators=(",", ":"))


def file_facts(db, filename):
    page_size = db.execute("PRAGMA page_size").fetchone()[0]
    pages = db.execute("PRAGMA page_count").fetchone()[0]
    free = db.execute("PRAGMA freelist_count").fetchone()[0]
    stat = filename.stat()
    return {
        "file_bytes": stat.st_size,
        "allocated_bytes": stat.st_blocks * 512,
        "page_size": page_size,
        "page_count": pages,
        "freelist_count": free,
        "freelist_bytes": free * page_size,
        "nonfree_page_bytes": (pages - free) * page_size,
    }


def session_sizes(total, longest=50000):
    longs = [34153, 20000, longest, 40000] if total >= 150_000 else [min(total, 34153)]
    remaining = total - sum(longs)
    short_count = max(1, round(remaining / 245)) if remaining else 0
    short = [remaining // short_count] * short_count if short_count else []
    for index in range(remaining % short_count if short_count else 0):
        short[index] += 1
    return longs, longs + short


def payload_pool(mode):
    rng = random.Random(696)
    pool = {}
    for kind in ("message", "custom"):
        for quantile in range(100):
            target = 512 if mode == "compact" else (
                7000 if quantile < 50 else 14000 if quantile < 95 else 70000
            )
            navigation = {"type": kind, "id": "synthetic", "parentId": "synthetic-parent"}
            if kind == "custom":
                navigation.update(
                    customType="openclaw.background-result-placement",
                    data={"afterEntryId": None, "resultEntryIds": ["synthetic-result"]},
                )
            else:
                navigation["message"] = {"role": "assistant"}
            event = dict(navigation)
            event["syntheticPayload"] = rng.randbytes(target).hex()[:target]
            raw = json_text(event).encode()
            compressed = zstd.compress(raw, level=3)
            envelope = json_text({
                "version": 1,
                "report": {"kind": "canonical"},
                "navigation": navigation,
                "reset": navigation,
                "model": navigation,
                "modelBytes": len(raw),
                "modelWithoutCheckpointBytes": len(raw),
                "withoutCustomDataBytes": len(raw),
            })
            pool[kind, quantile] = (
                compressed, len(raw), envelope, kind, None, 1,
                "assistant" if kind == "message" else None, kind, None, 1,
            )
    return pool


def seed_sessions(db, sizes):
    sessions = [f"synthetic-{index}" for index in range(len(sizes))]
    for session_id in sessions:
        key = "agent:main:" + session_id
        db.execute(
            "INSERT INTO session_nodes "
            "(session_key,current_session_id,entry_json,updated_at,entry_valid) VALUES(?,?,?,?,1)",
            (key, session_id, json_text({"sessionId": session_id, "updatedAt": 1}), 1),
        )
        db.execute(
            "INSERT INTO session_windows(session_id,session_key,created_at,updated_at) "
            "VALUES(?,?,1,1)", (session_id, key),
        )
    db.commit()
    return sessions


def fragment(db, total, filename, started):
    rows = max(40_000, min(3_500_000, total // 2))
    db.execute("CREATE TABLE synthetic_fragmentation_ballast(id INTEGER PRIMARY KEY, data BLOB) STRICT")
    for offset in range(0, rows, CHUNK):
        db.executemany(
            "INSERT INTO synthetic_fragmentation_ballast VALUES(?,zeroblob(3000))",
            ((index,) for index in range(offset, min(offset + CHUNK, rows))),
        )
        db.commit()
    db.execute("DELETE FROM synthetic_fragmentation_ballast WHERE id%2=0")
    db.commit()
    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    emit({"phase": "fragmented", "elapsed_s": time.monotonic() - started, **file_facts(db, filename)})


def append_rows(db, sizes, sessions, pool, filename, started, compact_pool=None):
    rows = 0
    # Round robin long tails compete for the scattered free pages.
    for first in range(0, len(sizes), 64):
        cohort = range(first, min(first + 64, len(sizes)))
        for seq in range(max(sizes[index] for index in cohort)):
            for index in cohort:
                if seq >= sizes[index]:
                    continue
                # Historical markers exercise dependency scans, not artifact replay.
                # Keep them outside the measured 512-event suffix, including tiny fixtures.
                custom = index == 0 and 0 < seq < min(31200, sizes[0] - 512) and seq % 200 == 0
                kind = "custom" if custom else "message"
                quantile = ((seq // 200) * 37 + 17) % 100 if kind == "custom" else (seq * 37 + index * 17) % 100
                session_id = sessions[index]
                raw_seq = seq + 1 if index == 0 else seq
                db.execute(
                    "INSERT INTO transcript_events VALUES(?,?,NULL,1,?,?,?,?,?,?,?,?,?,?)",
                    (session_id, raw_seq,
                     *(compact_pool if compact_pool is not None and index >= 4 else pool)[kind, quantile]),
                )
                db.execute(
                    "INSERT INTO transcript_event_identities "
                    "(session_id,event_id,seq,event_type,parent_id,created_at) VALUES(?,?,?,?,?,1)",
                    (session_id, f"event-{seq}", raw_seq, kind, f"event-{seq - 1}" if seq else None),
                )
                db.execute(
                    "INSERT INTO session_transcript_active_events VALUES(?,?,?,?,1)",
                    (session_id, seq, raw_seq, seq),
                )
                rows += 1
                if rows % CHUNK == 0:
                    db.commit()
                    if rows % 100_000 == 0:
                        emit({
                            "phase": "rows", "rows": rows,
                            "elapsed_s": time.monotonic() - started,
                            "file_bytes": filename.stat().st_size, "load": os.getloadavg(),
                        })
    db.commit()
    return rows


def grow_highwater(db, filename, target):
    started = time.monotonic()
    rows = 0
    db.execute("CREATE TABLE synthetic_highwater(id INTEGER PRIMARY KEY, data BLOB) STRICT")
    while db.execute("PRAGMA page_count").fetchone()[0] * 4096 < target:
        db.executemany(
            "INSERT INTO synthetic_highwater VALUES(?,?)",
            ((index, b"z" * 3000) for index in range(rows, rows + CHUNK)),
        )
        rows += CHUNK
        db.commit()
        if rows % 100_000 == 0:
            emit({"phase": "highwater", "rows": rows, "elapsed_s": time.monotonic() - started,
                  "file_bytes": filename.stat().st_size})
    db.execute("DROP TABLE synthetic_highwater")
    db.commit()
    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    return {"rows": rows, "elapsed_s": time.monotonic() - started, **file_facts(db, filename)}


def finalize_measured_session(db, sizes):
    """Give the measured path unique identities without changing overflow layout deliberately."""
    started = time.monotonic()
    rows = db.execute(
        "SELECT seq,event_zstd,navigation_json FROM transcript_events WHERE session_id=? AND event_zstd IS NOT NULL ORDER BY seq",
        (SESSION_ID,),
    ).fetchall()
    messages = 0
    for seq, blob, navigation_json in rows:
        position = seq - 1
        event = json.loads(zstd.decompress(blob))
        envelope = json.loads(navigation_json)
        event["id"] = f"event-{position}"
        event["parentId"] = f"event-{position - 1}" if position else None
        if event["type"] == "custom":
            event["data"] = {"afterEntryId": None, "resultEntryIds": [f"event-{position - 1}"]}
        for key in ("navigation", "model", "reset"):
            envelope[key]["id"] = event["id"]
            envelope[key]["parentId"] = event["parentId"]
            if event["type"] == "custom":
                envelope[key]["data"] = event["data"]
        if event["type"] == "message":
            event["message"]["content"] = [{"type": "text", "text": f"synthetic message {position}"}]
        raw = json_text(event).encode()
        compressed = zstd.compress(raw, level=3)
        for key in ("modelBytes", "modelWithoutCheckpointBytes", "withoutCustomDataBytes"):
            envelope[key] = len(raw)
        db.execute(
            "UPDATE transcript_events SET event_zstd=?,event_utf8_bytes=?,navigation_json=? "
            "WHERE session_id=? AND seq=?",
            (compressed, len(raw), json_text(envelope), SESSION_ID, seq),
        )
        db.execute(
            "UPDATE session_transcript_active_events SET message_position=? WHERE session_id=? AND event_seq=?",
            (messages if event["type"] == "message" else None, SESSION_ID, seq),
        )
        messages += event["type"] == "message"
        if position % 1000 == 0:
            db.commit()
    db.commit()
    for index, count in enumerate(sizes):
        session_id = f"synthetic-{index}"
        db.execute("INSERT INTO transcript_rewrite_watermarks VALUES(?,?,1)",
                   (session_id, "synthetic-generation"))
        db.execute("INSERT INTO session_transcript_index_state VALUES(?,?,?,0,?,?,1)",
                   (session_id, count if index == 0 else count - 1, f"event-{count - 1}", count, messages if index == 0 else count))
        db.execute("UPDATE session_windows SET transcript_updated_at=1 WHERE session_id=?", (session_id,))
    db.commit()
    db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    return {"rows_rewritten": len(rows), "elapsed_s": time.monotonic() - started}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--schema", required=True, type=Path)
    parser.add_argument("--name", required=True)
    parser.add_argument("--rows", required=True, type=int)
    parser.add_argument("--mode", choices=("compact", "full", "hybrid"), required=True)
    parser.add_argument("--schema-version", type=int, choices=(40, 41), default=40)
    parser.add_argument("--longest-session-rows", type=int, default=50000)
    parser.add_argument("--file-bytes", type=int, default=0)
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", args.name) or args.rows < 1 or args.file_bytes < 0:
        parser.error("name must be lowercase letters/digits/hyphens; rows must be positive; file-bytes nonnegative")
    if not 1 <= args.longest_session_rows <= 50000:
        parser.error("longest-session-rows must be between 1 and 50000")
    schema = args.schema.read_text()
    args.output.mkdir(parents=True, exist_ok=True)
    filename = args.output / (args.name + ".sqlite")
    # Exclusive creation also refuses an existing symlink or a failed prior run.
    filename.open("xb").close()
    started = time.monotonic()
    pool = payload_pool(args.mode)
    db = sqlite3.connect(filename)
    try:
        db.executescript(
            "PRAGMA page_size=4096; PRAGMA auto_vacuum=INCREMENTAL; PRAGMA journal_mode=WAL; "
            "PRAGMA synchronous=NORMAL; PRAGMA cache_size=-16384; PRAGMA foreign_keys=ON;"
        )
        db.executescript(schema)
        has_facts = db.execute("SELECT 1 FROM sqlite_schema WHERE name='session_transcript_active_event_facts'").fetchone() is not None
        if has_facts != (args.schema_version == 41):
            raise ValueError("schema-version must match the supplied active-facts table shape")
        db.execute("INSERT INTO schema_meta VALUES ('primary','agent',?,'main','synthetic',1,1)",
                   (args.schema_version,))
        db.execute(f"PRAGMA user_version={args.schema_version}")
        longs, sizes = session_sizes(args.rows, args.longest_session_rows)
        sessions = seed_sessions(db, sizes)
        header = {"type": "session", "version": 3, "id": SESSION_ID,
                  "timestamp": "2026-11-05T00:00:00.000Z", "cwd": "/synthetic"}
        db.execute("INSERT INTO transcript_events(session_id,seq,event_json,created_at) VALUES(?,0,?,1)",
                   (SESSION_ID, json_text(header)))
        db.execute("INSERT INTO transcript_event_identities "
                   "(session_id,event_id,seq,event_type,parent_id,created_at) VALUES(?,?,0,'session',NULL,1)",
                   (SESSION_ID, SESSION_ID))
        db.commit()
        if args.mode != "compact":
            fragment(db, args.rows, filename, started)
        rows = append_rows(db, sizes, sessions, pool, filename, started,
                           payload_pool("compact") if args.mode == "hybrid" else None)
        if args.mode != "compact":
            db.execute("DROP TABLE synthetic_fragmentation_ballast")
            db.commit()
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        highwater = grow_highwater(db, filename, args.file_bytes) if args.file_bytes else None
        finalization = finalize_measured_session(db, sizes)
        report = {
            "name": args.name, "mode": args.mode, "schema_version": args.schema_version, "rows": rows,
            "sessions": len(sizes), "long_sessions": longs,
            "elapsed_s": time.monotonic() - started,
            "historical_custom_markers": sum(
                0 < position < min(31200, sizes[0] - 512) and position % 200 == 0
                for position in range(sizes[0])
            ),
            "schema_sha256": hashlib.sha256(schema.encode()).hexdigest(),
            "sqlite": sqlite3.sqlite_version, "load": os.getloadavg(),
            "highwater": highwater, "finalization": finalization,
            "payload_sizes": [{"raw": value[1], "compressed": len(value[0])}
                              for (kind, _), value in pool.items() if kind == "message"],
            **file_facts(db, filename),
        }
    finally:
        db.close()
    (args.output / (args.name + "-fixture.json")).write_text(json.dumps(report, indent=2) + "\n")
    emit(report)


if __name__ == "__main__":
    main()
