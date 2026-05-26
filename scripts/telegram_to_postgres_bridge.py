#!/usr/bin/env python3
"""Bridge OpenClaw Telegram/Codex session turns into Zorg PostgreSQL memory."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import psycopg2


DEFAULT_WORKSPACE = Path("/home/openclaw/.openclaw/workspace")
DEFAULT_STATE_DB = Path("/home/openclaw/.openclaw/agents/main/agent/codex-home/state_5.sqlite")


@dataclass(frozen=True)
class ChatRecord:
    session_key: str
    source: str
    role: str
    message: str
    message_id: str | None
    timestamp: str | None
    rollout_path: str


def connect_pg(workspace: Path):
    cfg = json.loads((workspace / "sql_memory_map.json").read_text(encoding="utf-8"))["postgres"]
    return psycopg2.connect(
        host=cfg["host"],
        port=cfg["port"],
        dbname=cfg["database"],
        user=cfg["user"],
        password=cfg.get("password") or "",
        connect_timeout=5,
    )


def ensure_write_tables(cur) -> None:
    cur.execute("CREATE TABLE IF NOT EXISTS public.app_write_counters (counter_key TEXT PRIMARY KEY, counter_value BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())")
    cur.execute("CREATE TABLE IF NOT EXISTS public.app_write_events (id BIGSERIAL PRIMARY KEY, event_key TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_app_write_events_created_at ON public.app_write_events (created_at DESC)")
    for table in ("app_write_events", "app_activity_events"):
        cur.execute("select to_regclass(%s)", (f"public.{table}",))
        if not cur.fetchone()[0]:
            continue
        cur.execute("select pg_get_serial_sequence(%s,%s)", (f"public.{table}", "id"))
        seq = cur.fetchone()[0]
        if not seq:
            continue
        cur.execute(f"select coalesce(max(id), 0) from public.{table}")
        max_id = int(cur.fetchone()[0] or 0)
        cur.execute(f"select last_value from {seq}")
        last_value = int(cur.fetchone()[0] or 0)
        if last_value <= max_id:
            cur.execute("select setval(%s, %s, true)", (seq, max_id))


def recent_rollouts(state_db: Path, limit: int) -> list[str]:
    conn = sqlite3.connect(str(state_db))
    try:
        rows = conn.execute(
            "SELECT rollout_path FROM threads WHERE rollout_path IS NOT NULL AND rollout_path <> '' ORDER BY updated_at_ms DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [row[0] for row in rows if row and row[0] and Path(row[0]).exists()]
    finally:
        conn.close()


def content_text(payload: dict) -> str:
    parts: list[str] = []
    for item in payload.get("content") or []:
        if isinstance(item, dict) and item.get("type") in {"input_text", "output_text"}:
            text = item.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "\n".join(parts).strip()


def parse_json_block(label: str, text: str) -> dict:
    fence = chr(96) * 3
    pattern = re.compile(re.escape(label) + r"\s*" + fence + r"json\s*(\{.*?\})\s*" + fence, re.S)
    match = pattern.search(text)
    if not match:
        return {}
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError:
        return {}


def extract_current_request(text: str) -> str:
    marker = "Current user request:"
    if marker in text:
        return text.split(marker, 1)[1].strip()
    if "Conversation context (untrusted" in text:
        lines = text.splitlines()
        last_context_line = -1
        for index, line in enumerate(lines):
            if re.match(r"^#\d+\s+", line):
                last_context_line = index
        if last_context_line >= 0:
            request = "\n".join(lines[last_context_line + 1 :]).strip()
            if request:
                return request
    if "OpenClaw assembled context for this turn:" in text:
        return text.split("OpenClaw assembled context for this turn:", 1)[0].strip()
    return text.strip()


def iter_records(rollout_path: str) -> Iterable[ChatRecord]:
    path = Path(rollout_path)
    with path.open("r", encoding="utf-8") as handle:
        for raw in handle:
            try:
                row = json.loads(raw)
            except json.JSONDecodeError:
                continue
            payload = row.get("payload")
            if not isinstance(payload, dict) or payload.get("type") != "message":
                continue
            role = payload.get("role")
            if role not in {"user", "assistant"}:
                continue
            text = content_text(payload)
            if not text:
                continue
            if role == "user":
                meta = parse_json_block("Conversation info (untrusted metadata):", text)
                chat_id = str(meta.get("chat_id") or "unknown")
                message_id = str(meta.get("message_id")) if meta.get("message_id") else None
                timestamp = str(meta.get("timestamp")) if meta.get("timestamp") else row.get("timestamp")
                message = extract_current_request(text)
                source = "telegram-direct" if chat_id.startswith("telegram:") else "openclaw-session"
                session_key = chat_id if chat_id.startswith("telegram:") else "openclaw-session"
            else:
                message = text
                message_id = None
                timestamp = row.get("timestamp")
                session_key = "openclaw-session"
                source = "openclaw-session"
            if message:
                yield ChatRecord(session_key, source, role, message, message_id, timestamp, str(path))


def memory_key(record: ChatRecord) -> str:
    stable = record.message_id or f"{record.role}:{record.timestamp}:{record.message}"
    digest = hashlib.sha1(stable.encode("utf-8")).hexdigest()
    return f"chat:{record.session_key}:{record.source}:{record.role}:{digest}"


def insert_record(cur, record: ChatRecord) -> int:
    key = memory_key(record)
    category = f"chat_ingest_{record.role}"
    payload = {
        "sessionKey": record.session_key,
        "source": record.source,
        "role": record.role,
        "message": record.message,
        "messageId": record.message_id,
        "timestamp": record.timestamp,
        "recordedAt": datetime.now(timezone.utc).isoformat(),
        "rolloutPath": record.rollout_path,
        "category": category,
        "bridge": "telegram_to_postgres_bridge",
    }
    cur.execute(
        """
        WITH updated AS (
          UPDATE public.zorg_memory
          SET
            chat_session_log = %s,
            memory_value = %s,
            memory_category = %s,
            memory_priority = 'high',
            memory_active = TRUE
          WHERE memory_key = %s
            AND memory_category LIKE 'chat_ingest_%%'
          RETURNING 1
        ),
        inserted AS (
          INSERT INTO public.zorg_memory (chat_session_log, logged_at, system_prompt, memory_key, memory_value, memory_effective_date, memory_category, memory_priority, memory_active)
          SELECT %s, NOW(), NULL, %s, %s, CURRENT_DATE, %s, 'high', TRUE
          WHERE NOT EXISTS (SELECT 1 FROM updated)
            AND NOT EXISTS (SELECT 1 FROM public.zorg_memory WHERE memory_key = %s)
          RETURNING 1
        ),
        counter_upsert AS (
          INSERT INTO public.app_write_counters (counter_key, counter_value, updated_at)
          SELECT 'memory_table_writes', COUNT(*), NOW() FROM inserted WHERE EXISTS (SELECT 1 FROM inserted)
          ON CONFLICT (counter_key) DO UPDATE SET counter_value = public.app_write_counters.counter_value + EXCLUDED.counter_value, updated_at = NOW()
        ),
        event_insert AS (
          INSERT INTO public.app_write_events (event_key) SELECT %s FROM inserted RETURNING 1
        )
        SELECT COUNT(*)::int FROM inserted
        """,
        (
            record.message,
            json.dumps(payload, sort_keys=True),
            category,
            key,
            record.message,
            key,
            json.dumps(payload, sort_keys=True),
            category,
            key,
            key,
        ),
    )
    return int(cur.fetchone()[0] or 0)


def run(workspace: Path, state_db: Path, limit: int) -> tuple[int, int]:
    conn = connect_pg(workspace)
    scanned = 0
    inserted = 0
    try:
        cur = conn.cursor()
        ensure_write_tables(cur)
        for rollout in recent_rollouts(state_db, limit):
            for record in iter_records(rollout):
                scanned += 1
                inserted += insert_record(cur, record)
        conn.commit()
        cur.close()
    finally:
        conn.close()
    return scanned, inserted


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=DEFAULT_WORKSPACE)
    parser.add_argument("--state-db", type=Path, default=DEFAULT_STATE_DB)
    parser.add_argument("--limit", type=int, default=80)
    args = parser.parse_args()
    scanned, inserted = run(args.workspace, args.state_db, args.limit)
    print(json.dumps({"ok": True, "scanned": scanned, "inserted": inserted}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
