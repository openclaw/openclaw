#!/usr/bin/env python3
"""念·固 — Memory Consolidation Task

Runs nightly at 02:30. Maintains agent memory health:
1. Archives episodes older than 30 days
2. Deduplicates facts (detect & report only — no auto-remove in v1)
3. Reports memory stats per agent

Usage:
    python3 sentinel/tasks/memory_consolidation.py --dry-run
"""

import os
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SENTINEL_ROOT = Path(__file__).resolve().parent.parent
WORKSPACE = SENTINEL_ROOT.parent / "workspace"
AGENTS_DIR = WORKSPACE / "agents"

sys.path.insert(0, str(SENTINEL_ROOT))
from lib.logging_util import setup_logger, log_event  # noqa: E402

logger = setup_logger("memory_consolidation")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
ARCHIVE_AFTER_DAYS = 30
# Similarity threshold for near-duplicate detection (ratio 0-1)
SIMILARITY_THRESHOLD = 0.85
# Date header pattern in episodes.md: ## 2026-02-01 or ## 2026-02-01 — title
DATE_HEADER_RE = re.compile(r"^##\s+(\d{4}-\d{2}-\d{2})")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _simple_similarity(a: str, b: str) -> float:
    """Cheap string similarity using character bigram overlap (Dice coefficient).

    Good enough for detecting near-duplicate fact lines without external deps.
    """
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0

    def bigrams(s: str) -> set:
        s = s.lower().strip()
        return {s[i:i+2] for i in range(len(s) - 1)} if len(s) >= 2 else {s}

    ba, bb = bigrams(a), bigrams(b)
    if not ba or not bb:
        return 0.0
    return 2 * len(ba & bb) / (len(ba) + len(bb))


def _parse_episodes_by_date(text: str) -> dict[str, list[str]]:
    """Parse episodes.md into {date_str: [lines]} sections.

    Each section starts with a ## YYYY-MM-DD header.
    Lines before the first date header are stored under key "__preamble__".
    """
    sections: dict[str, list[str]] = {"__preamble__": []}
    current_key = "__preamble__"

    for line in text.splitlines():
        m = DATE_HEADER_RE.match(line)
        if m:
            current_key = m.group(1)
            sections.setdefault(current_key, [])
        sections[current_key].append(line)

    return sections


def _archive_old_episodes(
    episodes_path: Path,
    archive_dir: Path,
    cutoff: datetime,
    dry_run: bool = False,
) -> dict:
    """Move episode sections older than cutoff to monthly archive files.

    Returns stats dict: {archived_sections, archived_lines}.
    """
    stats = {"archived_sections": 0, "archived_lines": 0}

    if not episodes_path.exists():
        return stats

    try:
        text = episodes_path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        logger.warning("cannot read %s: %s", episodes_path, exc)
        return stats

    if not text.strip():
        return stats

    sections = _parse_episodes_by_date(text)
    cutoff_str = cutoff.strftime("%Y-%m-%d")

    keep_lines: list[str] = []
    # Bucket old sections by month for archive files
    to_archive: dict[str, list[str]] = {}  # "YYYY-MM" → lines

    for date_str, lines in sections.items():
        if date_str == "__preamble__":
            keep_lines.extend(lines)
            continue

        if date_str < cutoff_str:
            month_key = date_str[:7]  # "YYYY-MM"
            to_archive.setdefault(month_key, []).extend(lines)
            stats["archived_sections"] += 1
            stats["archived_lines"] += len(lines)
        else:
            keep_lines.extend(lines)

    if not to_archive:
        return stats

    if dry_run:
        for month_key, lines in to_archive.items():
            logger.info(
                "[dry-run] would archive %d lines from %s to episodes-%s.md",
                len(lines), episodes_path.name, month_key,
            )
        return stats

    # Write archive files
    archive_dir.mkdir(parents=True, exist_ok=True)
    for month_key, lines in to_archive.items():
        archive_path = archive_dir / f"episodes-{month_key}.md"
        content = "\n".join(lines) + "\n"
        try:
            with open(archive_path, "a", encoding="utf-8") as f:
                f.write(content)
            logger.info(
                "archived %d lines → %s", len(lines), archive_path.name,
            )
        except OSError as exc:
            logger.warning("failed to write archive %s: %s", archive_path, exc)

    # Rewrite episodes.md with only kept sections
    try:
        episodes_path.write_text("\n".join(keep_lines) + "\n", encoding="utf-8")
    except OSError as exc:
        logger.warning("failed to rewrite %s: %s", episodes_path, exc)

    return stats


def _detect_duplicate_facts(facts_path: Path) -> list[tuple[str, str, float]]:
    """Detect near-duplicate lines in facts.md.

    Returns list of (line_a, line_b, similarity_score) tuples.
    Only compares non-empty, non-header lines.
    """
    duplicates: list[tuple[str, str, float]] = []

    if not facts_path.exists():
        return duplicates

    try:
        text = facts_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return duplicates

    # Extract meaningful lines (skip headers, blanks, and very short lines)
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or len(stripped) < 10:
            continue
        # Normalize bullet prefixes for comparison
        clean = re.sub(r"^[-*]\s+", "", stripped)
        lines.append((stripped, clean))

    # O(n^2) but facts.md should be small — cap at 500 lines
    check_lines = lines[:500]
    seen_pairs: set[tuple[int, int]] = set()

    for i in range(len(check_lines)):
        for j in range(i + 1, len(check_lines)):
            if (i, j) in seen_pairs:
                continue
            sim = _simple_similarity(check_lines[i][1], check_lines[j][1])
            if sim >= SIMILARITY_THRESHOLD:
                duplicates.append((
                    check_lines[i][0],
                    check_lines[j][0],
                    round(sim, 3),
                ))
                seen_pairs.add((i, j))

    return duplicates


def _count_memory_stats(memory_dir: Path) -> dict:
    """Count lines in each memory file. Returns {filename: line_count}."""
    stats: dict[str, int] = {}
    if not memory_dir.is_dir():
        return stats

    for p in sorted(memory_dir.iterdir()):
        if p.is_file() and p.suffix == ".md":
            try:
                line_count = len(p.read_text(encoding="utf-8", errors="replace").splitlines())
                stats[p.name] = line_count
            except OSError:
                stats[p.name] = -1

    return stats


# ---------------------------------------------------------------------------
# Per-agent processing
# ---------------------------------------------------------------------------

def _process_agent(agent_dir: Path, cutoff: datetime, dry_run: bool = False) -> dict | None:
    """Process one agent's memory directory.

    Returns None if agent has no memory/ dir.
    """
    memory_dir = agent_dir / "memory"
    if not memory_dir.is_dir():
        return None

    agent_id = agent_dir.name
    result = {
        "agent_id": agent_id,
        "episodes_archived": {},
        "facts_duplicates": [],
        "stats": {},
    }

    # 1. Archive old episodes
    episodes_path = memory_dir / "episodes.md"
    archive_dir = memory_dir / "archive"
    try:
        archive_stats = _archive_old_episodes(
            episodes_path, archive_dir, cutoff, dry_run=dry_run,
        )
        result["episodes_archived"] = archive_stats
    except Exception as exc:
        logger.error("episodes archival failed for %s: %s", agent_id, exc)
        result["episodes_archived"] = {"error": str(exc)}

    # 2. Detect duplicate facts
    facts_path = memory_dir / "facts.md"
    try:
        dupes = _detect_duplicate_facts(facts_path)
        if dupes:
            result["facts_duplicates"] = [
                {"a": a, "b": b, "sim": s} for a, b, s in dupes
            ]
            logger.info(
                "%s: %d near-duplicate fact pairs detected", agent_id, len(dupes),
            )
    except Exception as exc:
        logger.error("facts dedup failed for %s: %s", agent_id, exc)
        result["facts_duplicates"] = [{"error": str(exc)}]

    # 3. Memory stats
    result["stats"] = _count_memory_stats(memory_dir)

    return result


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run(config: dict, state: dict) -> dict:
    """Main entry point called by sentinel.py."""
    logger.info("=== memory_consolidation (念·固): start ===")

    cutoff = datetime.now() - timedelta(days=ARCHIVE_AFTER_DAYS)
    dry_run = False

    agents_processed = 0
    total_archived_sections = 0
    total_duplicates = 0
    per_agent: dict[str, dict] = {}

    if not AGENTS_DIR.is_dir():
        logger.warning("agents dir not found: %s", AGENTS_DIR)
        return {"agents_processed": 0, "error": "agents dir not found"}

    for agent_dir in sorted(AGENTS_DIR.iterdir()):
        if not agent_dir.is_dir():
            continue
        # Skip hidden dirs and known non-agent dirs
        if agent_dir.name.startswith(".") or agent_dir.name.startswith("_"):
            continue

        result = _process_agent(agent_dir, cutoff, dry_run=dry_run)
        if result is None:
            continue

        agent_id = result["agent_id"]
        per_agent[agent_id] = result
        agents_processed += 1

        archived = result.get("episodes_archived", {})
        total_archived_sections += archived.get("archived_sections", 0)
        total_duplicates += len(result.get("facts_duplicates", []))

    summary = {
        "agents_processed": agents_processed,
        "total_archived_sections": total_archived_sections,
        "total_duplicates_detected": total_duplicates,
        "agents": per_agent,
    }

    # Persist to state
    sentinel_state = state.setdefault("sentinel", {})
    sentinel_state["memory_consolidation"] = {
        "last_run": datetime.now().isoformat(),
        "agents_processed": agents_processed,
        "archived_sections": total_archived_sections,
        "duplicates_detected": total_duplicates,
    }

    log_event(
        logger, "memory_consolidation_done",
        task_name="memory_consolidation",
        detail=(
            f"agents={agents_processed} "
            f"archived={total_archived_sections} "
            f"dupes={total_duplicates}"
        ),
    )
    logger.info("=== memory_consolidation (念·固): done ===")
    return summary


# ---------------------------------------------------------------------------
# Standalone execution
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse
    import json

    parser = argparse.ArgumentParser(
        description="念·固 — Memory consolidation (archive old episodes, detect duplicate facts)",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print what would happen without making changes",
    )
    parser.add_argument(
        "--agent", type=str, default=None,
        help="Process only a specific agent (by directory name)",
    )
    parser.add_argument(
        "--days", type=int, default=ARCHIVE_AFTER_DAYS,
        help=f"Archive episodes older than N days (default: {ARCHIVE_AFTER_DAYS})",
    )
    args = parser.parse_args()

    import logging
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    cutoff = datetime.now() - timedelta(days=args.days)

    if args.agent:
        agent_dir = AGENTS_DIR / args.agent
        if not agent_dir.is_dir():
            print(f"Agent directory not found: {agent_dir}")
            sys.exit(1)
        result = _process_agent(agent_dir, cutoff, dry_run=args.dry_run)
        if result is None:
            print(f"{args.agent}: no memory/ directory")
        else:
            print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
    else:
        # Run all agents
        state: dict = {}
        state_path = SENTINEL_ROOT / "state.json"
        if state_path.exists():
            state = json.loads(state_path.read_text())

        prefix = "[dry-run] " if args.dry_run else ""
        total_agents = 0
        total_sections = 0
        total_dupes = 0

        for agent_dir in sorted(AGENTS_DIR.iterdir()):
            if not agent_dir.is_dir():
                continue
            if agent_dir.name.startswith(".") or agent_dir.name.startswith("_"):
                continue

            result = _process_agent(agent_dir, cutoff, dry_run=args.dry_run)
            if result is None:
                continue

            agent_id = result["agent_id"]
            archived = result.get("episodes_archived", {})
            arch_n = archived.get("archived_sections", 0)
            dupes_n = len(result.get("facts_duplicates", []))
            stats = result.get("stats", {})
            total_lines = sum(v for v in stats.values() if isinstance(v, int) and v > 0)

            print(f"\n{agent_id}:")
            print(f"  memory files: {len(stats)}, total lines: {total_lines}")
            if arch_n:
                print(f"  {prefix}archived: {arch_n} sections")
            if dupes_n:
                print(f"  near-duplicates: {dupes_n} pairs")
                for d in result["facts_duplicates"][:3]:
                    if "error" not in d:
                        print(f"    sim={d['sim']}: {d['a'][:60]}")
                        print(f"           ↔ {d['b'][:60]}")

            total_agents += 1
            total_sections += arch_n
            total_dupes += dupes_n

        print(f"\n{prefix}Total: {total_agents} agents, "
              f"{total_sections} sections archived, "
              f"{total_dupes} duplicate pairs detected")
