#!/usr/bin/env python3
"""company_insight_tracker.py — 기업 인사이트 누적 파이프라인 (헤르미 방법론).

새 콘텐츠가 도착하면 기존 맥락과 결합하여 기업별 점진적 이해를 구축한다.
투자 테시스, 5차원 레이팅, 볼트 프로필 노트를 자동 갱신한다.

사용법:
    python3 pipeline/company_insight_tracker.py --batch              # 일일 배치 (매일 05:00)
    python3 pipeline/company_insight_tracker.py --cross-source       # 크로스소스 (주 1회)
    python3 pipeline/company_insight_tracker.py --cross-source --report  # 주간 리포트 포함
    python3 pipeline/company_insight_tracker.py --batch --dry-run    # DB/파일 변경 없음
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.db import resolve_ops_db_path, db_connection
from shared.llm import llm_chat_direct, DIRECT_PREMIUM_CHAIN
from shared.log import make_logger
from shared.frontmatter import write_note
from shared.telegram import send_dm
from shared.vault_paths import VAULT, INBOX

# ── Constants ─────────────────────────────────────────────────────────────────

WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))
MEMORY_DIR = WORKSPACE / "memory" / "company-insights"
PROFILE_DIR = VAULT / "200 정리" / "220 기업" / "기업 프로필"
STATE_FILE = MEMORY_DIR / "state.json"
LOG_FILE = WORKSPACE / "logs" / "company_insight_tracker.log"

EXTRACT_MODELS = list(DIRECT_PREMIUM_CHAIN)
INSIGHT_TYPES = ("실적", "기술", "시장", "경쟁", "밸류에이션", "리스크")
LOOKBACK_HOURS = 24
STATE_ROLLING_DAYS = 30

KST = timezone(timedelta(hours=9))

log = make_logger(log_file=str(LOG_FILE))

# ── DB Schema ─────────────────────────────────────────────────────────────────

_CREATE_COMPANY_ENTITIES = """
CREATE TABLE IF NOT EXISTS company_entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    canonical_name TEXT NOT NULL UNIQUE,
    name_ko TEXT,
    ticker TEXT,
    exchange TEXT,
    category TEXT,
    subcategory TEXT,
    aliases TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
)
"""

_CREATE_COMPANY_INSIGHTS = """
CREATE TABLE IF NOT EXISTS company_insights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL REFERENCES company_entities(id),
    source_type TEXT,
    source_ref TEXT,
    content TEXT,
    insight_type TEXT,
    sentiment REAL,
    confidence REAL,
    date TEXT,
    created_at TEXT DEFAULT (datetime('now'))
)
"""

_CREATE_COMPANY_RATINGS = """
CREATE TABLE IF NOT EXISTS company_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id INTEGER NOT NULL UNIQUE REFERENCES company_entities(id),
    overall_score REAL,
    growth REAL,
    valuation REAL,
    momentum REAL,
    risk REAL,
    thesis_summary TEXT,
    insight_count INTEGER DEFAULT 0,
    last_insight_date TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
)
"""


def ensure_tables(conn: sqlite3.Connection) -> None:
    """Create tables if they don't exist."""
    conn.execute(_CREATE_COMPANY_ENTITIES)
    conn.execute(_CREATE_COMPANY_INSIGHTS)
    conn.execute(_CREATE_COMPANY_RATINGS)
    conn.commit()


# ── State ─────────────────────────────────────────────────────────────────────

def _load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def _save_state(state: dict) -> None:
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    # Trim processed_files to rolling window
    cutoff = (datetime.now(KST) - timedelta(days=STATE_ROLLING_DAYS)).isoformat()
    pf = state.get("processed_files", {})
    state["processed_files"] = {k: v for k, v in pf.items() if v >= cutoff}
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


# ── LLM JSON parsing ─────────────────────────────────────────────────────────

def _parse_llm_json(content: str, default: dict | None = None) -> dict:
    """Parse LLM response as JSON — robust against free-text wrapping.

    Handles:
    1. Pure JSON string
    2. ```json ... ``` code fences
    3. Free text before/after JSON (e.g. "분석합니다...\n{...}\n끝")
    4. Multiple JSON objects → pick the one with most keys
    """
    if not content:
        return default if default is not None else {}
    clean = content.strip()
    # 1. Strip markdown code fences (```json ... ``` or ``` ... ```)
    fence_m = re.search(r"```(?:json)?\s*\n?(.*?)```", clean, re.DOTALL)
    if fence_m:
        clean = fence_m.group(1).strip()
    # 2. Try direct parse (unwrap list → first dict element)
    try:
        parsed = json.loads(clean)
        if isinstance(parsed, dict):
            return parsed
        if isinstance(parsed, list) and parsed and isinstance(parsed[0], dict):
            return parsed[0]
    except json.JSONDecodeError:
        pass
    # 2b. Fix unescaped newlines inside JSON string values and retry
    fixed = re.sub(r'(?<=: ")(.*?)(?="[,\s}\]])', lambda m: m.group(0).replace("\n", " "), clean, flags=re.DOTALL)
    if fixed != clean:
        try:
            parsed = json.loads(fixed)
            if isinstance(parsed, dict):
                return parsed
            if isinstance(parsed, list) and parsed and isinstance(parsed[0], dict):
                return parsed[0]
        except json.JSONDecodeError:
            pass
    # 3. Extract all JSON object candidates from the text
    candidates = []
    depth = 0
    start = -1
    for i, ch in enumerate(clean):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start >= 0:
                try:
                    obj = json.loads(clean[start:i + 1])
                    if isinstance(obj, dict):
                        candidates.append(obj)
                except json.JSONDecodeError:
                    pass
                start = -1
    if candidates:
        # Pick the candidate with the most keys (most likely the intended output)
        return max(candidates, key=len)
    log(f"JSON parse failed: {content[:120]}", level="WARN")
    return default if default is not None else {}


# ── Company mention extraction ────────────────────────────────────────────────

def _build_alias_patterns(conn: sqlite3.Connection) -> list[dict]:
    """Load company_entities and build compiled regex patterns for each alias.

    Uses ASCII-only word boundaries so Korean particles (의/가/는/를 etc.)
    don't block matching: "NVIDIA의" and "SK하이닉스가" both match correctly.
    """
    rows = conn.execute(
        "SELECT id, canonical_name, aliases FROM company_entities"
    ).fetchall()
    patterns = []
    for row_id, canonical, aliases_json in rows:
        try:
            aliases = json.loads(aliases_json) if aliases_json else []
        except (json.JSONDecodeError, TypeError):
            aliases = []
        # Always include canonical_name as an alias
        all_names = [canonical] + [a for a in aliases if a]
        for name in all_names:
            try:
                escaped = re.escape(name)
                # ASCII-only boundaries: prevents "NVIDIAX" but allows "NVIDIA의"
                pat = re.compile(
                    r"(?<![a-zA-Z0-9])" + escaped + r"(?![a-zA-Z0-9])",
                    re.IGNORECASE,
                )
                patterns.append({
                    "company_id": row_id,
                    "canonical_name": canonical,
                    "alias": name,
                    "pattern": pat,
                })
            except re.error:
                continue
    return patterns


def extract_company_mentions(text: str, db_conn: sqlite3.Connection) -> list[dict]:
    """Extract company mentions from text using aliases in company_entities.

    Returns deduplicated list of {"company_id", "canonical_name", "matched_alias"}.
    """
    if not text or not text.strip():
        return []
    patterns = _build_alias_patterns(db_conn)
    seen: set[int] = set()
    results: list[dict] = []
    for p in patterns:
        if p["company_id"] in seen:
            continue
        if p["pattern"].search(text):
            seen.add(p["company_id"])
            results.append({
                "company_id": p["company_id"],
                "canonical_name": p["canonical_name"],
                "matched_alias": p["alias"],
            })
    return results


# ── Insight accumulation ──────────────────────────────────────────────────────

def _classify_insight(company_name: str, content: str) -> dict:
    """Use LLM to classify insight type, sentiment, confidence, and summary."""
    messages = [
        {"role": "system", "content": (
            "텍스트에서 기업 관련 인사이트를 추출. JSON으로 출력: "
            '{"insight_type": "실적|기술|시장|경쟁|밸류에이션|리스크", '
            '"sentiment": -1.0~1.0, "confidence": 0.0~1.0, "summary": "1줄 요약"}'
        )},
        {"role": "user", "content": f"기업: {company_name}\n\n{content[:2000]}"},
    ]
    resp, model, err = llm_chat_direct(
        messages, EXTRACT_MODELS, temperature=0.2, max_tokens=500, timeout=45,
    )
    if err or not resp:
        log(f"LLM classify failed for {company_name}: {err}", level="WARN")
        return {
            "insight_type": "시장",
            "sentiment": 0.0,
            "confidence": 0.3,
            "summary": content[:80],
        }
    result = _parse_llm_json(resp, {
        "insight_type": "시장", "sentiment": 0.0, "confidence": 0.3, "summary": content[:80],
    })
    # Handle unexpected list return (minimax sometimes wraps in array)
    if isinstance(result, list):
        result = result[0] if result and isinstance(result[0], dict) else {
            "insight_type": "시장", "sentiment": 0.0, "confidence": 0.3, "summary": content[:80],
        }
    # Validate insight_type
    if result.get("insight_type") not in INSIGHT_TYPES:
        result["insight_type"] = "시장"
    # Clamp numeric values
    result["sentiment"] = max(-1.0, min(1.0, float(result.get("sentiment", 0.0))))
    result["confidence"] = max(0.0, min(1.0, float(result.get("confidence", 0.3))))
    return result


def accumulate_insight(
    company_id: int,
    content: str,
    source_type: str,
    source_ref: str,
    date: str,
    db_conn: sqlite3.Connection,
    dry_run: bool = False,
) -> dict | None:
    """Classify and store a company insight. Returns classification dict or None."""
    # Fetch company name
    row = db_conn.execute(
        "SELECT canonical_name FROM company_entities WHERE id = ?", (company_id,)
    ).fetchone()
    if not row:
        log(f"Company ID {company_id} not found", level="WARN")
        return None

    company_name = row[0]
    classification = _classify_insight(company_name, content)

    if dry_run:
        log(f"[DRY-RUN] Would accumulate: {company_name} / {classification.get('insight_type')}")
        return classification

    db_conn.execute(
        """INSERT INTO company_insights
           (company_id, source_type, source_ref, content, insight_type,
            sentiment, confidence, date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            company_id,
            source_type,
            source_ref,
            content[:5000],  # cap content length
            classification.get("insight_type", "시장"),
            classification.get("sentiment", 0.0),
            classification.get("confidence", 0.3),
            date,
        ),
    )
    db_conn.commit()
    log(f"Accumulated: {company_name} [{classification.get('insight_type')}] "
        f"sentiment={classification.get('sentiment', 0):.1f}")
    return classification


# ── Thesis synthesis ──────────────────────────────────────────────────────────

def synthesize_thesis(company_id: int, db_conn: sqlite3.Connection) -> str:
    """Synthesize investment thesis from accumulated insights (Hermi methodology).

    Combines all historical insights with recent ones to build progressive understanding.
    Returns thesis text, or empty string on failure.
    """
    # Company info
    entity = db_conn.execute(
        "SELECT canonical_name, ticker FROM company_entities WHERE id = ?",
        (company_id,),
    ).fetchone()
    if not entity:
        return ""
    name, ticker = entity[0], entity[1] or ""

    # Load insights chronologically
    insights = db_conn.execute(
        """SELECT date, insight_type, sentiment, content, confidence
           FROM company_insights
           WHERE company_id = ?
           ORDER BY date ASC""",
        (company_id,),
    ).fetchall()
    if not insights:
        return ""

    # Build timeline text
    cutoff_30d = (datetime.now(KST) - timedelta(days=30)).strftime("%Y-%m-%d")
    recent = [i for i in insights if (i[0] or "") >= cutoff_30d]
    timeline_parts = []
    for date, itype, sent, content, conf in (recent if recent else insights[-10:]):
        snippet = (content or "")[:200]
        timeline_parts.append(f"[{date}] ({itype}, 감성:{sent:+.1f}) {snippet}")
    timeline = "\n".join(timeline_parts)

    # Previous rating
    rating_row = db_conn.execute(
        "SELECT overall_score, thesis_summary FROM company_ratings WHERE company_id = ?",
        (company_id,),
    ).fetchone()
    prev_rating = ""
    if rating_row:
        prev_rating = f"overall={rating_row[0]}, 이전 테시스: {rating_row[1] or ''}"

    messages = [
        {"role": "system", "content": (
            "기업의 인사이트 시계열을 분석하여 투자 테시스를 작성. "
            "이전 맥락을 결합하여 점진적 이해 구축. JSON: "
            '{"thesis": "2-3문장", "growth": 1.0~5.0, "valuation": 1.0~5.0, '
            '"momentum": 1.0~5.0, "risk": 1.0~5.0, "overall": 1.0~5.0}'
        )},
        {"role": "user", "content": (
            f"기업: {name} ({ticker})\n이전 레이팅: {prev_rating}\n\n"
            f"인사이트 시계열:\n{timeline[:3000]}"
        )},
    ]
    resp, model, err = llm_chat_direct(
        messages, EXTRACT_MODELS, temperature=0.3, max_tokens=800, timeout=60,
    )
    if err or not resp:
        log(f"Thesis synthesis failed for {name}: {err}", level="WARN")
        return ""
    return resp


# ── Rating update ─────────────────────────────────────────────────────────────

def update_rating(company_id: int, db_conn: sqlite3.Connection, dry_run: bool = False) -> dict | None:
    """Recalculate 5-dimension rating from all insights via LLM. Returns rating dict."""
    thesis_raw = synthesize_thesis(company_id, db_conn)
    if not thesis_raw:
        log(f"No thesis for company_id={company_id}, skipping rating", level="WARN")
        return None

    parsed = _parse_llm_json(thesis_raw, None)
    if not parsed or "thesis" not in parsed:
        log(f"Thesis parse failed for company_id={company_id}", level="WARN")
        return None

    def _clamp(val, lo=1.0, hi=5.0) -> float:
        try:
            return max(lo, min(hi, float(val)))
        except (TypeError, ValueError):
            return 3.0

    rating = {
        "overall_score": _clamp(parsed.get("overall", 3.0)),
        "growth": _clamp(parsed.get("growth", 3.0)),
        "valuation": _clamp(parsed.get("valuation", 3.0)),
        "momentum": _clamp(parsed.get("momentum", 3.0)),
        "risk": _clamp(parsed.get("risk", 3.0)),
        "thesis_summary": (parsed.get("thesis") or "")[:500],
    }

    # Count insights and last date
    row = db_conn.execute(
        "SELECT COUNT(*), MAX(date) FROM company_insights WHERE company_id = ?",
        (company_id,),
    ).fetchone()
    rating["insight_count"] = row[0] if row else 0
    rating["last_insight_date"] = row[1] if row else None

    if dry_run:
        log(f"[DRY-RUN] Would update rating: company_id={company_id} overall={rating['overall_score']:.1f}")
        return rating

    # UPSERT
    db_conn.execute(
        """INSERT INTO company_ratings
           (company_id, overall_score, growth, valuation, momentum, risk,
            thesis_summary, insight_count, last_insight_date, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
           ON CONFLICT(company_id) DO UPDATE SET
            overall_score = excluded.overall_score,
            growth = excluded.growth,
            valuation = excluded.valuation,
            momentum = excluded.momentum,
            risk = excluded.risk,
            thesis_summary = excluded.thesis_summary,
            insight_count = excluded.insight_count,
            last_insight_date = excluded.last_insight_date,
            updated_at = datetime('now')""",
        (
            company_id,
            rating["overall_score"],
            rating["growth"],
            rating["valuation"],
            rating["momentum"],
            rating["risk"],
            rating["thesis_summary"],
            rating["insight_count"],
            rating["last_insight_date"],
        ),
    )
    db_conn.commit()
    log(f"Rating updated: company_id={company_id} overall={rating['overall_score']:.1f}")
    return rating


# ── Vault profile note ────────────────────────────────────────────────────────

def update_vault_profile(company_id: int, db_conn: sqlite3.Connection, dry_run: bool = False) -> bool:
    """Generate/update vault profile note for a company. Idempotent full rewrite."""
    entity = db_conn.execute(
        "SELECT canonical_name, name_ko, ticker, exchange, category, subcategory "
        "FROM company_entities WHERE id = ?",
        (company_id,),
    ).fetchone()
    if not entity:
        return False
    canonical, name_ko, ticker, exchange, category, subcategory = entity

    rating = db_conn.execute(
        "SELECT overall_score, growth, valuation, momentum, risk, thesis_summary, "
        "insight_count, last_insight_date FROM company_ratings WHERE company_id = ?",
        (company_id,),
    ).fetchone()

    insights = db_conn.execute(
        """SELECT date, insight_type, sentiment, content
           FROM company_insights WHERE company_id = ?
           ORDER BY date DESC LIMIT 20""",
        (company_id,),
    ).fetchall()

    # Build frontmatter
    meta: dict[str, Any] = {
        "title": canonical,
        "ticker": ticker or "",
        "category": category or "기업",
        "subcategory": subcategory or "",
        "entity_type": "company_profile",
        "overall_rating": rating[0] if rating else 0.0,
        "last_updated": datetime.now(KST).strftime("%Y-%m-%d"),
    }
    if name_ko:
        meta["name_ko"] = name_ko

    # Build body
    body_parts: list[str] = []
    body_parts.append(f"\n# {canonical}")
    if name_ko:
        body_parts.append(f"*{name_ko}*")
    if ticker:
        body_parts.append(f"Ticker: **{ticker}** ({exchange or 'N/A'})")
    body_parts.append("")

    # Thesis
    body_parts.append("## 투자 테시스")
    if rating and rating[5]:
        body_parts.append(rating[5])
    else:
        body_parts.append("_아직 테시스가 생성되지 않았습니다._")
    body_parts.append("")

    # Rating table
    body_parts.append("## 레이팅")
    if rating:
        body_parts.append("| 항목 | 점수 |")
        body_parts.append("|------|------|")
        labels = ["종합", "성장", "밸류에이션", "모멘텀", "리스크"]
        for i, label in enumerate(labels):
            score = rating[i] if rating[i] is not None else 0.0
            body_parts.append(f"| {label} | {score:.1f} |")
        body_parts.append(f"\n인사이트 {rating[6] or 0}건 | 최종 업데이트 {rating[7] or 'N/A'}")
    else:
        body_parts.append("_레이팅 미생성_")
    body_parts.append("")

    # Insight timeline
    body_parts.append("## 인사이트 타임라인 (최근 20건)")
    if insights:
        for date, itype, sent, content in insights:
            snippet = (content or "")[:120].replace("\n", " ")
            sent_str = f"{sent:+.1f}" if sent is not None else "N/A"
            body_parts.append(f"- **[{date or 'N/A'}]** ({itype}, {sent_str}) {snippet}")
    else:
        body_parts.append("_아직 인사이트가 없습니다._")
    body_parts.append("")

    body = "\n".join(body_parts)

    if dry_run:
        log(f"[DRY-RUN] Would update profile: {canonical}")
        return True

    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    filepath = PROFILE_DIR / f"{canonical}.md"
    write_note(filepath, meta, body)
    log(f"Profile updated: {filepath.name}")
    return True


# ── Source scanners ───────────────────────────────────────────────────────────

def _strip_frontmatter(text: str) -> str:
    """Remove YAML frontmatter (---...---) from markdown text."""
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            return text[end + 4:].strip()
    return text


def _scan_inbox_files(cutoff: datetime) -> list[dict]:
    """Scan INBOX for markdown files modified within lookback window."""
    results = []
    inbox_dir = INBOX
    if not inbox_dir.exists():
        return results
    for fpath in inbox_dir.rglob("*.md"):
        try:
            mtime = datetime.fromtimestamp(fpath.stat().st_mtime, tz=KST)
            if mtime >= cutoff:
                raw = fpath.read_text(encoding="utf-8")
                text = _strip_frontmatter(raw)
                if text.strip():
                    results.append({
                        "text": text,
                        "source_type": "inbox",
                        "source_ref": str(fpath),
                        "date": mtime.strftime("%Y-%m-%d"),
                    })
        except (OSError, UnicodeDecodeError):
            continue
    return results


def _scan_telegram_topics(cutoff: datetime) -> list[dict]:
    """Scan telegram-topics JSON files within lookback window."""
    results = []
    topics_dir = WORKSPACE / "memory" / "telegram-topics"
    if not topics_dir.exists():
        return results
    for topic_dir in topics_dir.iterdir():
        if not topic_dir.is_dir():
            continue
        for fpath in topic_dir.glob("*.json"):
            try:
                mtime = datetime.fromtimestamp(fpath.stat().st_mtime, tz=KST)
                if mtime < cutoff:
                    continue
                data = json.loads(fpath.read_text(encoding="utf-8"))
                text = data.get("text", "")
                if text.strip():
                    results.append({
                        "text": text,
                        "source_type": "telegram",
                        "source_ref": data.get("url", str(fpath)),
                        "date": data.get("date", mtime.strftime("%Y-%m-%d")),
                    })
            except (OSError, json.JSONDecodeError, UnicodeDecodeError):
                continue
    return results


def _scan_report_dir(report_dir: Path, source_type: str) -> list[dict]:
    """Read latest report file from a directory."""
    if not report_dir.exists():
        return []
    files = sorted(report_dir.glob("*.md"), key=lambda f: f.stat().st_mtime, reverse=True)
    if not files:
        return []
    latest = files[0]
    try:
        text = latest.read_text(encoding="utf-8")
        if text.strip():
            mtime = datetime.fromtimestamp(latest.stat().st_mtime, tz=KST)
            return [{
                "text": text,
                "source_type": source_type,
                "source_ref": str(latest),
                "date": mtime.strftime("%Y-%m-%d"),
            }]
    except (OSError, UnicodeDecodeError):
        pass
    return []


def _scan_blog_insights() -> list[dict]:
    """Read recent blog insight files."""
    results = []
    blog_dir = WORKSPACE / "memory" / "blog-insights"
    if not blog_dir.exists():
        return results
    cutoff = datetime.now(KST) - timedelta(days=7)
    for fpath in blog_dir.glob("*.md"):
        try:
            mtime = datetime.fromtimestamp(fpath.stat().st_mtime, tz=KST)
            if mtime >= cutoff:
                text = fpath.read_text(encoding="utf-8")
                if text.strip():
                    results.append({
                        "text": text,
                        "source_type": "blog",
                        "source_ref": str(fpath),
                        "date": mtime.strftime("%Y-%m-%d"),
                    })
        except (OSError, UnicodeDecodeError):
            continue
    return results


# ── Batch mode ────────────────────────────────────────────────────────────────

def batch_mode(dry_run: bool = False) -> int:
    """Daily batch: scan recent sources, extract mentions, accumulate insights."""
    db_path = resolve_ops_db_path()
    with db_connection(db_path, row_factory=sqlite3.Row) as conn:
        ensure_tables(conn)

        state = _load_state()
        processed = state.get("processed_files", {})
        now = datetime.now(KST)
        cutoff = now - timedelta(hours=LOOKBACK_HOURS)
        today = now.strftime("%Y-%m-%d")

        # Gather sources
        sources = []
        sources.extend(_scan_inbox_files(cutoff))
        sources.extend(_scan_telegram_topics(cutoff))
        log(f"Scanned sources: {len(sources)} items (inbox + telegram-topics)")

        if not sources:
            log("No new sources found")
            return 0

        # Deduplicate by source_ref + content hash (same text from inbox & topics)
        import hashlib
        seen_hashes: set[str] = set()
        new_sources = []
        for s in sources:
            if s["source_ref"] in processed:
                continue
            text_hash = hashlib.md5(s["text"][:500].encode()).hexdigest()
            if text_hash in seen_hashes:
                continue
            seen_hashes.add(text_hash)
            new_sources.append(s)
        if not new_sources:
            log("All sources already processed")
            return 0
        log(f"New sources to process: {len(new_sources)}")

        # Process each source
        insight_count = 0
        updated_companies: dict[int, dict] = {}  # company_id -> info

        for src in new_sources:
            mentions = extract_company_mentions(src["text"], conn)
            if not mentions:
                continue

            for mention in mentions:
                cid = mention["company_id"]
                result = accumulate_insight(
                    company_id=cid,
                    content=src["text"],
                    source_type=src["source_type"],
                    source_ref=src["source_ref"],
                    date=src.get("date", today),
                    db_conn=conn,
                    dry_run=dry_run,
                )
                if result:
                    insight_count += 1
                    if cid not in updated_companies:
                        updated_companies[cid] = {
                            "canonical_name": mention["canonical_name"],
                            "new_count": 0,
                        }
                    updated_companies[cid]["new_count"] += 1

            # Mark processed
            if not dry_run:
                processed[src["source_ref"]] = now.isoformat()

        # Update ratings and profiles for affected companies
        profile_count = 0
        company_summaries: list[str] = []

        for cid, info in updated_companies.items():
            # Fetch previous rating for delta tracking
            prev_row = conn.execute(
                "SELECT overall_score FROM company_ratings WHERE company_id = ?",
                (cid,),
            ).fetchone()
            prev_overall = prev_row[0] if prev_row else None

            rating = update_rating(cid, conn, dry_run=dry_run)
            if update_vault_profile(cid, conn, dry_run=dry_run):
                profile_count += 1

            # Build summary line
            ticker_row = conn.execute(
                "SELECT ticker FROM company_entities WHERE id = ?", (cid,)
            ).fetchone()
            ticker = ticker_row[0] if ticker_row else info["canonical_name"]
            display = ticker or info["canonical_name"]

            overall = rating["overall_score"] if rating else 0.0
            delta_str = ""
            if prev_overall is not None and rating:
                delta = overall - prev_overall
                if abs(delta) >= 0.1:
                    delta_str = f" (레이팅 {'↑' if delta > 0 else '↓'}{abs(delta):.1f})"
            summary_detail = rating.get("thesis_summary", "")[:30] if rating else ""
            if not delta_str:
                delta_str = f" (신규 +{info['new_count']})"
            company_summaries.append(
                f"\u00b7 {display} \u2605{overall:.1f} \u2014 {summary_detail}{delta_str}"
            )

        # Save state
        if not dry_run:
            state["processed_files"] = processed
            state["last_batch"] = now.isoformat()
            _save_state(state)

        # Telegram DM
        if insight_count > 0 and not dry_run:
            lines = [
                f"\U0001f4ca 기업 인사이트 배치 | {today}",
                "",
                f"신규 인사이트: {insight_count}건 ({len(updated_companies)}개 기업)",
                f"프로필 업데이트: {profile_count}건",
                "",
            ]
            lines.extend(company_summaries)
            send_dm("\n".join(lines))

        log(f"Batch complete: {insight_count} insights, "
            f"{len(updated_companies)} companies, {profile_count} profiles")
        return insight_count


# ── Cross-source mode ─────────────────────────────────────────────────────────

def cross_source_mode(report: bool = False, dry_run: bool = False) -> int:
    """Weekly cross-source: scan popular-posts, twitter, blog reports."""
    db_path = resolve_ops_db_path()
    with db_connection(db_path, row_factory=sqlite3.Row) as conn:
        ensure_tables(conn)

        now = datetime.now(KST)
        today = now.strftime("%Y-%m-%d")
        week_num = now.isocalendar()[1]

        # Gather from cross-sources
        sources: list[dict] = []
        sources.extend(_scan_report_dir(
            WORKSPACE / "memory" / "popular-posts" / "reports", "popular-posts"))
        sources.extend(_scan_report_dir(
            WORKSPACE / "memory" / "twitter-collector" / "reports", "twitter"))
        sources.extend(_scan_blog_insights())
        log(f"Cross-source scan: {len(sources)} items")

        if not sources:
            log("No cross-source content found")
            return 0

        # Process
        insight_count = 0
        source_counts: dict[str, int] = {}
        updated_companies: dict[int, dict] = {}

        for src in sources:
            mentions = extract_company_mentions(src["text"], conn)
            if not mentions:
                continue
            for mention in mentions:
                cid = mention["company_id"]
                result = accumulate_insight(
                    company_id=cid,
                    content=src["text"],
                    source_type=src["source_type"],
                    source_ref=src["source_ref"],
                    date=src.get("date", today),
                    db_conn=conn,
                    dry_run=dry_run,
                )
                if result:
                    insight_count += 1
                    stype = src["source_type"]
                    source_counts[stype] = source_counts.get(stype, 0) + 1
                    if cid not in updated_companies:
                        updated_companies[cid] = {
                            "canonical_name": mention["canonical_name"],
                            "new_count": 0,
                            "prev_overall": None,
                        }
                        # Capture previous rating
                        prev = conn.execute(
                            "SELECT overall_score FROM company_ratings WHERE company_id = ?",
                            (cid,),
                        ).fetchone()
                        if prev:
                            updated_companies[cid]["prev_overall"] = prev[0]
                    updated_companies[cid]["new_count"] += 1

        # Update ratings + profiles
        for cid in updated_companies:
            update_rating(cid, conn, dry_run=dry_run)
            update_vault_profile(cid, conn, dry_run=dry_run)

        log(f"Cross-source complete: {insight_count} insights, "
            f"{len(updated_companies)} companies")

        # Weekly report DM
        if report and insight_count > 0 and not dry_run:
            sc_str = ", ".join(f"{k} {v}" for k, v in sorted(source_counts.items()))
            lines = [
                f"\U0001f4ca 주간 기업 인사이트 리포트 | W{week_num:02d}",
                "",
                f"총 {len(updated_companies)}개 기업, {insight_count}건 인사이트 ({sc_str})",
                "",
            ]

            # TOP changes
            changes: list[tuple[str, float, float, int, str]] = []
            new_entries: list[tuple[str, float, int, str]] = []

            for cid, info in updated_companies.items():
                ticker_row = conn.execute(
                    "SELECT ticker FROM company_entities WHERE id = ?", (cid,)
                ).fetchone()
                display = (ticker_row[0] if ticker_row else None) or info["canonical_name"]
                rating_row = conn.execute(
                    "SELECT overall_score, thesis_summary, insight_count "
                    "FROM company_ratings WHERE company_id = ?",
                    (cid,),
                ).fetchone()
                cur_overall = rating_row[0] if rating_row else 0.0
                thesis = (rating_row[1] or "")[:30] if rating_row else ""
                total_count = rating_row[2] if rating_row else info["new_count"]

                if info["prev_overall"] is not None:
                    delta = cur_overall - info["prev_overall"]
                    changes.append((display, info["prev_overall"], cur_overall, total_count, thesis))
                else:
                    new_entries.append((display, cur_overall, info["new_count"], thesis))

            if changes:
                changes.sort(key=lambda x: abs(x[2] - x[1]), reverse=True)
                lines.append("[TOP 변동]")
                for display, prev, cur, cnt, thesis in changes[:5]:
                    delta = cur - prev
                    sign = "+" if delta >= 0 else ""
                    lines.append(
                        f"\u00b7 {display} \u2605{prev:.1f}\u2192{cur:.1f} "
                        f"({sign}{delta:.1f}) \u2014 {cnt}건 축적, {thesis}"
                    )
                lines.append("")

            if new_entries:
                lines.append("[신규 기업]")
                for display, overall, cnt, thesis in new_entries[:5]:
                    lines.append(
                        f"\u00b7 {display} \u2605{overall:.1f} \u2014 "
                        f"{cnt}건 인사이트, {thesis}"
                    )
                lines.append("")

            send_dm("\n".join(lines))

        return insight_count


# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(
        description="기업 인사이트 누적 파이프라인 (헤르미 방법론)")
    parser.add_argument("--batch", action="store_true",
                        help="일일 배치: 수신함+텔레그램 토픽 스캔")
    parser.add_argument("--cross-source", action="store_true",
                        help="크로스소스: 인기글+트위터+블로그 스캔")
    parser.add_argument("--report", action="store_true",
                        help="--cross-source와 함께: 주간 리포트 DM 발송")
    parser.add_argument("--dry-run", action="store_true",
                        help="DB/파일 변경 없이 실행만")
    args = parser.parse_args()

    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)

    if not args.batch and not args.cross_source:
        parser.print_help()
        return 1

    total = 0
    if args.batch:
        total += batch_mode(dry_run=args.dry_run)
    if args.cross_source:
        total += cross_source_mode(report=args.report, dry_run=args.dry_run)

    if total == 0:
        log("No insights processed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
