#!/usr/bin/env python3
"""Conversation sync — incremental backup of group messages to SQLite.

Runs every 4h. Zero AI cost. Stores messages with FTS5 for full-text search.

Usage:
    python3 sentinel/tasks/conversation_sync.py --dry-run
"""

import json
import logging
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

SENTINEL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SENTINEL_ROOT))

from lib.conversation import fetch_messages, get_groups, init_bot_ids, is_bot

logger = logging.getLogger("sentinel.conversation_sync")

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    chat_name TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    sender_id INTEGER NOT NULL,
    sender_name TEXT NOT NULL,
    is_bot INTEGER DEFAULT 0,
    text TEXT,
    has_media INTEGER DEFAULT 0,
    agent_id TEXT,
    bridge TEXT,
    synced_at TEXT NOT NULL,
    UNIQUE(chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_ts ON messages(chat_id, timestamp DESC);
"""

FTS_SQL = """
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    text, sender_name, chat_name,
    content=messages, content_rowid=id
);
"""

# FTS triggers for auto-sync
FTS_TRIGGERS = """
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text, sender_name, chat_name)
    VALUES (new.id, new.text, new.sender_name, new.chat_name);
END;
"""


def _init_db(db_path: str) -> sqlite3.Connection:
    """Create/open SQLite database and ensure schema exists."""
    os.makedirs(os.path.dirname(db_path), exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA_SQL)
    # FTS5 table — may fail on systems without FTS5 extension
    try:
        conn.executescript(FTS_SQL)
        conn.executescript(FTS_TRIGGERS)
    except sqlite3.OperationalError as e:
        logger.warning("FTS5 not available, skipping full-text index: %s", e)
    return conn


def _get_last_synced_id(state: dict, chat_id: str) -> int:
    """Get the last synced message_id for a chat from state."""
    sync_state = state.get("sentinel", {}).get("conversation_sync", {})
    return sync_state.get("last_synced", {}).get(chat_id, 0)


def _set_last_synced_id(state: dict, chat_id: str, msg_id: int):
    """Update the last synced message_id in state."""
    sentinel = state.setdefault("sentinel", {})
    sync_state = sentinel.setdefault("conversation_sync", {})
    last_synced = sync_state.setdefault("last_synced", {})
    last_synced[chat_id] = msg_id


def _sync_group(conn: sqlite3.Connection, chat_id: str, group: dict,
                state: dict, limit: int, dry_run: bool = False,
                full: bool = False) -> int:
    """Sync one group with pagination. Returns count of new messages inserted.

    Args:
        full: If True, paginate through ALL available history (backfill mode).
              If False, only fetch the latest `limit` messages (incremental mode).
    """
    last_id = _get_last_synced_id(state, chat_id)
    now_iso = datetime.now().isoformat()
    inserted = 0
    max_id = last_id
    offset_id = 0  # Start from newest
    page = 0
    max_pages = 50 if full else 1  # Safety cap: 50 pages × 500 = 25,000 msgs max

    while page < max_pages:
        messages = fetch_messages(group["bridge_url"], chat_id,
                                  limit=limit, offset_id=offset_id)
        if not messages:
            break

        new_msgs = [m for m in messages if m.get("id", 0) > last_id]

        if dry_run:
            if page == 0:
                logger.info("[dry-run] %s: page %d, %d msgs (%d new, last_id=%d)",
                             group["name"], page, len(messages), len(new_msgs), last_id)
            inserted += len(new_msgs)
            if not full:
                break
            # Paginate: use the smallest message id as next offset
            msg_ids = [m.get("id", 0) for m in messages]
            min_id = min(msg_ids) if msg_ids else 0
            if min_id <= 0 or min_id == offset_id:
                break
            offset_id = min_id
            page += 1
            if not new_msgs:
                break  # Reached messages we already have
            continue

        for msg in new_msgs:
            msg_id = msg.get("id", 0)
            try:
                conn.execute(
                    """INSERT OR IGNORE INTO messages
                       (chat_id, chat_name, message_id, timestamp, sender_id,
                        sender_name, is_bot, text, has_media, agent_id, bridge, synced_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        chat_id,
                        group["name"],
                        msg_id,
                        msg.get("timestamp", msg.get("date", now_iso)),
                        msg.get("sender_id", 0),
                        msg.get("sender_name", ""),
                        1 if is_bot(msg) else 0,
                        msg.get("text", ""),
                        1 if msg.get("has_media") or msg.get("media") else 0,
                        group.get("agent_id"),
                        group["bridge"],
                        now_iso,
                    ),
                )
                if conn.total_changes:
                    inserted += 1
            except sqlite3.Error as e:
                logger.warning("Insert error for msg %d in %s: %s", msg_id, chat_id, e)

            if msg_id > max_id:
                max_id = msg_id

        conn.commit()

        if not full:
            break  # Incremental: one page is enough

        # Paginate: use the smallest message id as next offset_id
        msg_ids = [m.get("id", 0) for m in messages]
        min_id = min(msg_ids) if msg_ids else 0
        if min_id <= 0 or min_id == offset_id:
            break  # No more pages
        if len(messages) < limit:
            break  # Last page was partial — we've reached the end

        offset_id = min_id
        page += 1
        logger.debug("%s: page %d, offset_id=%d", group["name"], page, offset_id)

    if max_id > last_id:
        _set_last_synced_id(state, chat_id, max_id)

    return inserted


def _load_scan_config() -> dict:
    """Load config.json (groups, bridges, detection patterns)."""
    cfg_path = SENTINEL_ROOT / "config.json"
    with open(cfg_path) as f:
        return json.load(f)


def run(config: dict, state: dict) -> dict:
    """Main entry point called by sentinel.py.

    Note: `config` is sentinel.yaml. Groups/bridges live in config.json.
    """
    logger.info("=== conversation_sync: start ===")

    scan_cfg = _load_scan_config()
    sync_cfg = scan_cfg.get("sync", {})
    db_path = sync_cfg.get("db_path", "data/conversations.db")
    if not os.path.isabs(db_path):
        db_path = str(SENTINEL_ROOT / db_path)
    limit = sync_cfg.get("incremental_limit", 100)

    init_bot_ids(scan_cfg)
    groups = get_groups(scan_cfg)

    conn = _init_db(db_path)
    result = {"groups_synced": 0, "new_messages": 0, "errors": [], "db_size_mb": 0}

    try:
        for chat_id, group in groups.items():
            try:
                n = _sync_group(conn, chat_id, group, state, limit)
                result["new_messages"] += n
                result["groups_synced"] += 1
                logger.info("%s: +%d messages", group["name"], n)
            except Exception as e:
                result["errors"].append(f"{group['name']}: {e}")
                logger.error("Sync error for %s: %s", group["name"], e)
    finally:
        conn.close()

    # DB size
    try:
        result["db_size_mb"] = round(os.path.getsize(db_path) / 1048576, 2)
    except OSError:
        pass

    # Per-group stats from DB
    group_stats = {}
    try:
        conn2 = sqlite3.connect(db_path)
        for row in conn2.execute(
            "SELECT chat_id, chat_name, COUNT(*), MIN(timestamp), MAX(timestamp), agent_id "
            "FROM messages GROUP BY chat_id"
        ):
            chat_id_val, chat_name, cnt, earliest, latest, agent_id = row
            # Freshness: hours since latest message
            fresh_h = None
            if latest:
                try:
                    lt = datetime.fromisoformat(str(latest).replace("Z", "+00:00"))
                    if lt.tzinfo is None:
                        lt = lt.replace(tzinfo=timezone.utc)
                    fresh_h = round((datetime.now(timezone.utc) - lt).total_seconds() / 3600, 1)
                except (ValueError, TypeError):
                    pass
            group_stats[chat_id_val] = {
                "name": chat_name,
                "count": cnt,
                "earliest": str(earliest)[:10] if earliest else None,
                "latest": str(latest)[:10] if latest else None,
                "fresh_h": fresh_h,
                "agent_id": agent_id,
            }

        # Recent messages per group (20 most recent, text truncated to 200 chars)
        for chat_id_val in group_stats:
            recent = []
            for row in conn2.execute(
                "SELECT sender_name, text, timestamp FROM messages "
                "WHERE chat_id = ? ORDER BY timestamp DESC LIMIT 20",
                (chat_id_val,),
            ):
                sender_name, text, ts = row
                recent.append({
                    "sender": sender_name or "",
                    "text": (text or "")[:200],
                    "ts": ts or "",
                })
            group_stats[chat_id_val]["recent_messages"] = recent

        conn2.close()
    except Exception as e:
        logger.warning("Failed to collect group stats: %s", e)

    # Store result summary in state
    sentinel = state.setdefault("sentinel", {})
    sync_state = sentinel.setdefault("conversation_sync", {})
    sync_state["last_run"] = datetime.now().isoformat()
    sync_state["last_result"] = {
        "groups_synced": result["groups_synced"],
        "new_messages": result["new_messages"],
        "errors": result["errors"][:5],
        "db_size_mb": result["db_size_mb"],
        "group_stats": group_stats,
    }

    logger.info("=== conversation_sync: done — %d groups, +%d msgs, %.1f MB ===",
                result["groups_synced"], result["new_messages"], result["db_size_mb"])
    return result


# ---------------------------------------------------------------------------
# Standalone
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import argparse

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    parser = argparse.ArgumentParser(description="Conversation sync (standalone)")
    parser.add_argument("--dry-run", action="store_true", help="Show what would sync without writing")
    parser.add_argument("--full", action="store_true",
                        help="Full backfill: paginate through ALL available history")
    parser.add_argument("--config", default=str(SENTINEL_ROOT / "config.json"))
    args = parser.parse_args()

    with open(args.config) as f:
        cfg = json.load(f)

    state_path = SENTINEL_ROOT / "state.json"
    st = {}
    if state_path.exists():
        with open(state_path) as f:
            st = json.load(f)

    if args.dry_run:
        init_bot_ids(cfg)
        groups = get_groups(cfg)
        sync_cfg = cfg.get("sync", {})
        db_path = sync_cfg.get("db_path", "data/conversations.db")
        if not os.path.isabs(db_path):
            db_path = str(SENTINEL_ROOT / db_path)
        limit = sync_cfg.get("incremental_limit", 500)

        conn = _init_db(db_path)
        total = 0
        for chat_id, group in groups.items():
            n = _sync_group(conn, chat_id, group, st, limit,
                            dry_run=True, full=args.full)
            total += n
        conn.close()
        print(f"\n[dry-run] Total: {total} new messages across {len(groups)} groups")
    elif args.full:
        # Full backfill mode: reset tracking, paginate all history
        sentinel_st = st.setdefault("sentinel", {})
        sentinel_st.setdefault("conversation_sync", {})["last_synced"] = {}

        scan_cfg = _load_scan_config()
        sync_cfg = scan_cfg.get("sync", {})
        db_path = sync_cfg.get("db_path", "data/conversations.db")
        if not os.path.isabs(db_path):
            db_path = str(SENTINEL_ROOT / db_path)
        limit = sync_cfg.get("incremental_limit", 500)

        init_bot_ids(scan_cfg)
        groups = get_groups(scan_cfg)
        conn = _init_db(db_path)

        total = 0
        for chat_id, group in groups.items():
            try:
                n = _sync_group(conn, chat_id, group, st, limit, full=True)
                total += n
                logger.info("%s: +%d messages (full)", group["name"], n)
            except Exception as e:
                logger.error("Full sync error for %s: %s", group["name"], e)
        conn.close()

        # Recompute group_stats from DB after backfill
        group_stats = {}
        try:
            conn2 = sqlite3.connect(db_path)
            for row in conn2.execute(
                "SELECT chat_id, chat_name, COUNT(*), MIN(timestamp), MAX(timestamp), agent_id "
                "FROM messages GROUP BY chat_id"
            ):
                chat_id_val, chat_name, cnt, earliest, latest, agent_id = row
                fresh_h = None
                if latest:
                    try:
                        lt = datetime.fromisoformat(str(latest).replace("Z", "+00:00").replace("+00:00", ""))
                        fresh_h = round((datetime.now() - lt).total_seconds() / 3600, 1)
                    except (ValueError, TypeError):
                        pass
                group_stats[chat_id_val] = {
                    "name": chat_name,
                    "count": cnt,
                    "earliest": str(earliest)[:10] if earliest else None,
                    "latest": str(latest)[:10] if latest else None,
                    "fresh_h": fresh_h,
                    "agent_id": agent_id,
                }
            conn2.close()
        except Exception as e:
            logger.warning("Failed to collect group stats: %s", e)

        sync_state = sentinel_st.setdefault("conversation_sync", {})
        sync_state["last_run"] = datetime.now().isoformat()
        sync_state["last_result"] = {
            "groups_synced": len(groups),
            "new_messages": total,
            "errors": [],
            "db_size_mb": round(os.path.getsize(db_path) / 1048576, 2),
            "group_stats": group_stats,
        }

        # Save state
        with open(state_path, "w") as f:
            json.dump(st, f, indent=2, ensure_ascii=False)
        print(f"\n[full] Total: +{total} new messages across {len(groups)} groups")
    else:
        result = run(cfg, st)
        # Save state
        with open(state_path, "w") as f:
            json.dump(st, f, indent=2, ensure_ascii=False)
        print(json.dumps(result, indent=2, ensure_ascii=False))
