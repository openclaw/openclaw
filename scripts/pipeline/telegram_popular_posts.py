#!/usr/bin/env python3
"""telegram_popular_posts.py — 텔레그램 인기게시물 리스팅 파이프라인.

~170개 공개 채널에서 게시물을 수집하고, 조회수/반응 기반으로 TOP 10 인기글을 선정하여
감성 분석 + 키워드 + 주목 종목과 함께 텔레그램으로 전송.

사용법:
    python3 telegram_popular_posts.py --notify             # 수집+분석+전송
    python3 telegram_popular_posts.py --dry-run            # 수집+분석 (전송 안 함)
    python3 telegram_popular_posts.py --stats              # 채널 통계 출력
    python3 telegram_popular_posts.py --limit-channels 5   # 채널 수 제한

아키텍처:
    [channels.json] → 다채널 HTML 스크래퍼 (t.me/s/) → PopularPostParser
    → SQLite popular_posts 테이블 → 상대적 인기도 스코어링
    → LLM 1회 배치 분석 (감성/키워드/종목/요약)
    → Bot API 직접전송 (DM + 론 토픽)
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.db import db_connection, db_transaction
from shared.llm import llm_chat_direct, DIRECT_DEFAULT_CHAIN
from shared.log import make_logger
from shared.telegram import send_dm_chunked, send_group_chunked, RON_TOPIC_ID

# ── Constants ──────────────────────────────────────────────────────────────────

BASE_URL = "https://t.me/s/"

DB_PATH = Path(os.path.expanduser("~/.openclaw/data/ops_multiagent.db"))
WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))
from shared.vault_paths import INSIGHTS as VAULT_DIR
MEMORY_DIR = WORKSPACE / "memory" / "popular-posts"
CHANNELS_FILE = MEMORY_DIR / "channels.json"
STATE_FILE = MEMORY_DIR / "state.json"
REPORTS_DIR = MEMORY_DIR / "reports"
LOG_FILE = WORKSPACE / "logs" / "popular_posts.log"

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
REQUEST_DELAY = 2  # seconds between channel requests
MAX_PAGES_PER_CHANNEL = 2
LOOKBACK_HOURS = 24
MAX_RETRIES = 3
LLM_MODELS = list(DIRECT_DEFAULT_CHAIN)
RETENTION_DAYS = 30
REPORT_RETENTION_DAYS = 90
TOP_N = 10
LLM_BATCH_SIZE = 50

log = make_logger(log_file=str(LOG_FILE))


# ── Utility ────────────────────────────────────────────────────────────────────

def _parse_count(text: str) -> int:
    """Parse human-readable counts: '12.5K' → 12500, '1.2M' → 1200000."""
    text = text.strip().upper()
    if not text:
        return 0
    multiplier = 1
    if text.endswith("K"):
        multiplier = 1_000
        text = text[:-1]
    elif text.endswith("M"):
        multiplier = 1_000_000
        text = text[:-1]
    try:
        return int(float(text) * multiplier)
    except (ValueError, OverflowError):
        return 0


def _truncate(text: str, max_len: int = 80) -> str:
    """Truncate text with ellipsis."""
    if len(text) <= max_len:
        return text
    return text[: max_len - 1] + "…"


def _format_count(n: int) -> str:
    """Format count for display: 12500 → '12.5K'."""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def _first_line(text: str, max_len: int = 60) -> str:
    """Extract first meaningful line as title summary."""
    if not text:
        return "(내용 없음)"
    line = text.split("\n")[0].strip()
    # Strip leading symbols/emojis common in Korean finance channels
    line = line.lstrip("#☞▶️ ")
    if not line:
        # Try second line
        parts = text.split("\n")
        line = parts[1].strip() if len(parts) > 1 else text[:max_len].strip()
    return _truncate(line, max_len)


# ── HTML Parser ────────────────────────────────────────────────────────────────

class PopularPostParser(HTMLParser):
    """Parse t.me/s/CHANNEL public archive for posts with view counts.

    Extracts: channel_id, msg_id, text, views, reactions, date, link.
    Also captures pagination ``before_value`` for multi-page scraping.
    """

    def __init__(self) -> None:
        super().__init__()
        self.posts: list[dict[str, Any]] = []
        self._current: dict[str, Any] | None = None
        self._in_text = False
        self._text_parts: list[str] = []
        self._text_depth = 0
        self._wrap_depth = 0
        self._in_views = False
        self._in_reaction = False
        self._reaction_count = 0
        self.before_value: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr = dict(attrs)
        cls = attr.get("class", "")

        # ── Message wrapper ──
        if tag == "div" and "tgme_widget_message_wrap" in cls:
            self._current = {
                "channel_id": "", "msg_id": 0, "text": "",
                "views": 0, "reactions": 0, "date": "", "link": "",
            }
            self._wrap_depth = 1
            self._reaction_count = 0
        elif self._current is not None and tag == "div":
            self._wrap_depth += 1

        # ── data-post for channel_id / msg_id ──
        if tag == "div" and "tgme_widget_message " in (cls + " "):
            data_post = attr.get("data-post", "")
            if data_post and self._current is not None:
                parts = data_post.split("/")
                if len(parts) == 2:
                    self._current["channel_id"] = parts[0]
                    try:
                        self._current["msg_id"] = int(parts[1])
                        self._current["link"] = f"https://t.me/{data_post}"
                    except ValueError:
                        pass

        # ── Message text ──
        if tag == "div" and "tgme_widget_message_text" in cls:
            self._in_text = True
            self._text_parts = []
            self._text_depth = 0
        if self._in_text:
            self._text_depth += 1
            if tag == "br":
                self._text_parts.append("\n")

        # ── Views ──
        if tag == "span" and "tgme_widget_message_views" in cls:
            self._in_views = True

        # ── Reactions (individual <span class="tgme_reaction">) ──
        if (tag == "span" and "tgme_reaction" in cls
                and "reactions" not in cls):
            self._in_reaction = True

        # ── Date ──
        if tag == "time" and self._current is not None:
            dt = attr.get("datetime", "")
            if dt:
                self._current["date"] = dt

        # ── Pagination link ──
        if tag == "a" and "tme_messages_more" in cls:
            before = attr.get("data-before", "")
            if before:
                self.before_value = before

    def handle_endtag(self, tag: str) -> None:
        # ── Text region close ──
        if self._in_text:
            self._text_depth -= 1
            if tag == "div" and self._text_depth <= 0:
                self._in_text = False
                if self._current is not None:
                    self._current["text"] = " ".join(
                        p for p in self._text_parts if p.strip()
                    ).strip()

        # ── Views / Reactions spans close ──
        if tag == "span":
            if self._in_views:
                self._in_views = False
            if self._in_reaction:
                self._in_reaction = False

        # ── Message wrapper close ──
        if tag == "div" and self._current is not None:
            self._wrap_depth -= 1
            if self._wrap_depth <= 0 and self._current.get("msg_id"):
                self._current["reactions"] = self._reaction_count
                self.posts.append(self._current)
                self._current = None
                self._reaction_count = 0

    def handle_data(self, data: str) -> None:
        if self._in_text:
            stripped = data.strip()
            if stripped:
                self._text_parts.append(stripped)

        if self._in_views and self._current is not None:
            self._current["views"] = _parse_count(data.strip())

        if self._in_reaction:
            stripped = data.strip()
            if stripped.isdigit():
                self._reaction_count += int(stripped)


def parse_archive_page(html: str) -> tuple[list[dict], str | None]:
    """Parse HTML and return (posts, before_value for pagination)."""
    parser = PopularPostParser()
    parser.feed(html)
    return parser.posts, parser.before_value


# ── HTTP ───────────────────────────────────────────────────────────────────────

def _fetch_page(url: str) -> str:
    """Fetch URL with retries and exponential backoff."""
    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            if attempt < MAX_RETRIES - 1:
                wait = 2 ** (attempt + 1)
                log(f"Fetch failed ({e}), retry in {wait}s...", level="WARN")
                time.sleep(wait)
            else:
                raise
    return ""


# ── Channel Management ────────────────────────────────────────────────────────

def load_channels(path: Path | None = None) -> list[dict]:
    """Load channel list from JSON file. Returns only enabled channels."""
    path = path or CHANNELS_FILE
    if not path.exists():
        log(f"Channel file not found: {path}", level="ERROR")
        return []
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        channels = data.get("channels", [])
        return [c for c in channels if c.get("enabled", True)]
    except (json.JSONDecodeError, OSError) as e:
        log(f"Failed to load channels: {e}", level="ERROR")
        return []


# ── Scraping ──────────────────────────────────────────────────────────────────

def fetch_channel_posts(channel_id: str, lookback_hours: int = LOOKBACK_HOURS,
                        max_pages: int = MAX_PAGES_PER_CHANNEL) -> list[dict]:
    """Fetch recent posts from a single channel's public archive.

    Returns posts within the lookback window.  Older posts are filtered out.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(hours=lookback_hours)
    all_posts: list[dict] = []
    url = f"{BASE_URL}{channel_id}"

    for page in range(max_pages):
        try:
            html = _fetch_page(url)
        except (urllib.error.URLError, OSError) as e:
            log(f"[{channel_id}] Fetch failed page {page + 1}: {e}", level="WARN")
            break

        posts, before_value = parse_archive_page(html)
        if not posts:
            break

        found_old = False
        for p in posts:
            if p.get("date"):
                try:
                    post_dt = datetime.fromisoformat(p["date"])
                    if post_dt.tzinfo is None:
                        post_dt = post_dt.replace(tzinfo=timezone.utc)
                    if post_dt < cutoff:
                        found_old = True
                        continue
                except (ValueError, TypeError):
                    pass
            all_posts.append(p)

        # If we found posts older than cutoff, no need to paginate further
        if found_old:
            break

        # Pagination
        if before_value:
            url = f"{BASE_URL}{channel_id}?before={before_value}"
            time.sleep(REQUEST_DELAY)
        else:
            break

    return all_posts


def scrape_all_channels(channels: list[dict], lookback_hours: int = LOOKBACK_HOURS,
                        max_pages: int = MAX_PAGES_PER_CHANNEL,
                        delay: float = REQUEST_DELAY) -> list[dict]:
    """Scrape all channels with rate limiting and error isolation."""
    all_posts: list[dict] = []
    success_count = 0
    fail_count = 0

    for i, ch in enumerate(channels):
        channel_id = ch["id"]
        channel_name = ch.get("name", channel_id)
        try:
            posts = fetch_channel_posts(channel_id, lookback_hours, max_pages)
            for p in posts:
                p["channel_name"] = channel_name
            all_posts.extend(posts)
            success_count += 1
            log(f"[{i + 1}/{len(channels)}] {channel_id}: {len(posts)} posts")
        except Exception as e:
            fail_count += 1
            log(f"[{i + 1}/{len(channels)}] {channel_id}: ERROR {e}", level="WARN")

        # Rate limit between channels (skip after last)
        if i < len(channels) - 1:
            time.sleep(delay)

    log(f"Scraping complete: {success_count} ok, {fail_count} failed, "
        f"{len(all_posts)} posts total")
    return all_posts


# ── Database ──────────────────────────────────────────────────────────────────

def init_db(db_path: Path | None = None):
    """Initialize popular_posts table and indices."""
    db = db_path or DB_PATH
    with db_transaction(db) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS popular_posts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                channel_id TEXT NOT NULL,
                channel_name TEXT,
                msg_id INTEGER NOT NULL,
                text TEXT,
                views INTEGER DEFAULT 0,
                reactions INTEGER DEFAULT 0,
                post_date TEXT,
                scraped_at TEXT DEFAULT (datetime('now','localtime')),
                popularity_score REAL DEFAULT 0,
                link TEXT,
                UNIQUE(channel_id, msg_id)
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_pp_channel_date
            ON popular_posts(channel_id, post_date)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_pp_score
            ON popular_posts(popularity_score DESC)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_pp_scraped
            ON popular_posts(scraped_at)
        """)


def save_posts(posts: list[dict], db_path: Path | None = None):
    """Save posts to DB with UPSERT (views/reactions only increase)."""
    if not posts:
        return
    db = db_path or DB_PATH
    with db_transaction(db) as conn:
        for p in posts:
            conn.execute("""
                INSERT INTO popular_posts
                    (channel_id, channel_name, msg_id, text, views, reactions,
                     post_date, link)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(channel_id, msg_id) DO UPDATE SET
                    views = MAX(popular_posts.views, excluded.views),
                    reactions = MAX(popular_posts.reactions, excluded.reactions),
                    channel_name = COALESCE(excluded.channel_name,
                                            popular_posts.channel_name),
                    scraped_at = datetime('now', 'localtime')
            """, (
                p.get("channel_id", ""), p.get("channel_name", ""),
                p.get("msg_id", 0), p.get("text", ""),
                p.get("views", 0), p.get("reactions", 0),
                p.get("date", ""), p.get("link", ""),
            ))
    log(f"Saved {len(posts)} posts to DB")


def get_all_channel_avg_views(days: int = 7, db_path: Path | None = None
                              ) -> dict[str, float]:
    """Get average views per channel over the last N days."""
    db = db_path or DB_PATH
    with db_connection(db) as conn:
        rows = conn.execute("""
            SELECT channel_id, AVG(views)
            FROM popular_posts
            WHERE scraped_at > datetime('now', 'localtime', ?)
            GROUP BY channel_id
        """, (f"-{days} days",)).fetchall()
        return {row[0]: row[1] or 0.0 for row in rows}


def get_recent_posts(hours: int = LOOKBACK_HOURS, db_path: Path | None = None
                     ) -> list[dict]:
    """Get all posts from the last N hours."""
    db = db_path or DB_PATH
    with db_connection(db, row_factory=sqlite3.Row) as conn:
        rows = conn.execute("""
            SELECT * FROM popular_posts
            WHERE scraped_at > datetime('now', 'localtime', ?)
            ORDER BY views DESC
        """, (f"-{hours} hours",)).fetchall()
        return [dict(r) for r in rows]


def update_scores(scores: dict[tuple[str, int], float],
                  db_path: Path | None = None):
    """Batch update popularity scores in DB."""
    if not scores:
        return
    db = db_path or DB_PATH
    with db_transaction(db) as conn:
        for (channel_id, msg_id), score in scores.items():
            conn.execute("""
                UPDATE popular_posts SET popularity_score = ?
                WHERE channel_id = ? AND msg_id = ?
            """, (score, channel_id, msg_id))


def cleanup_old_posts(days: int = RETENTION_DAYS, db_path: Path | None = None):
    """Remove posts older than N days."""
    db = db_path or DB_PATH
    with db_transaction(db) as conn:
        cur = conn.execute("""
            DELETE FROM popular_posts
            WHERE scraped_at < datetime('now', 'localtime', ?)
        """, (f"-{days} days",))
        if cur.rowcount > 0:
            log(f"Cleaned up {cur.rowcount} posts older than {days} days")


def get_channel_stats(db_path: Path | None = None) -> list[dict]:
    """Get per-channel statistics."""
    db = db_path or DB_PATH
    with db_connection(db, row_factory=sqlite3.Row) as conn:
        rows = conn.execute("""
            SELECT channel_id, channel_name,
                   COUNT(*) as post_count,
                   AVG(views) as avg_views,
                   MAX(views) as max_views,
                   MAX(scraped_at) as last_scraped
            FROM popular_posts
            GROUP BY channel_id
            ORDER BY avg_views DESC
        """).fetchall()
        return [dict(r) for r in rows]


# ── Scoring ───────────────────────────────────────────────────────────────────

def compute_popularity_score(views: int, reactions: int, age_hours: float,
                             channel_avg_views: float) -> float:
    """Compute relative popularity score.

    Normalizes by channel average to prevent large-channel bias.
    Reactions weighted 10x (active engagement signal).
    Recency decay with ~12h half-life.
    """
    engagement = views + (reactions * 10)
    relative = engagement / max(channel_avg_views, 1.0)
    recency = 1.0 / (1.0 + age_hours / 12.0)
    return relative * recency * 100.0


def rank_posts(hours: int = LOOKBACK_HOURS, limit: int = LLM_BATCH_SIZE,
               db_path: Path | None = None) -> list[dict]:
    """Score and rank recent posts.  Returns top N by popularity."""
    posts = get_recent_posts(hours, db_path=db_path)
    if not posts:
        return []

    avg_views = get_all_channel_avg_views(db_path=db_path)
    now = datetime.now(timezone.utc)
    scored: list[dict] = []

    for p in posts:
        age_hours = 12.0  # default
        if p.get("post_date"):
            try:
                post_dt = datetime.fromisoformat(p["post_date"])
                if post_dt.tzinfo is None:
                    post_dt = post_dt.replace(tzinfo=timezone.utc)
                age_hours = max(0.0, (now - post_dt).total_seconds() / 3600.0)
            except (ValueError, TypeError):
                pass

        ch_avg = avg_views.get(p["channel_id"], 0.0)
        score = compute_popularity_score(
            p.get("views", 0), p.get("reactions", 0), age_hours, ch_avg,
        )
        p["popularity_score"] = score
        scored.append(p)

    scored.sort(key=lambda x: x["popularity_score"], reverse=True)

    # Update scores in DB
    score_map = {}
    for p in scored[:limit]:
        score_map[(p["channel_id"], p["msg_id"])] = p["popularity_score"]
    update_scores(score_map, db_path=db_path)

    return scored[:limit]


# ── LLM Analysis ─────────────────────────────────────────────────────────────

def analyze_posts(posts: list[dict]) -> dict:
    """Batch LLM analysis of top posts → sentiment, keywords, stocks, summary.

    Single LLM call for all posts combined.  Graceful degradation on failure.
    """
    empty = {
        "sentiment": 0, "sentiment_label": "", "keywords": [],
        "stocks": [], "sectors": [], "summary": "",
    }
    if not posts:
        return empty

    # Build combined text for LLM
    lines = []
    for i, p in enumerate(posts[:LLM_BATCH_SIZE], 1):
        text = _truncate(p.get("text", ""), 200)
        views = _format_count(p.get("views", 0))
        ch = p.get("channel_name", p.get("channel_id", ""))
        lines.append(f"{i}. [{ch}] {text} ({views} views)")

    combined = "\n".join(lines)

    messages = [
        {"role": "system", "content": (
            "한국 텔레그램 투자 채널의 인기 게시물 목록을 분석하라.\n\n"
            "출력 형식 (JSON만, 설명 없이):\n"
            "{\n"
            '  "sentiment": 0,\n'
            '  "sentiment_label": "중립",\n'
            '  "keywords": [{"word": "키워드", "count": 5}, ...],\n'
            '  "stocks": [{"name": "종목명", "score": 50}, ...],\n'
            '  "sectors": [\n'
            '    {"name": "반도체", "sentiment": 30, '
            '"summary": "1줄 요약", "count": 5},\n'
            "    ...\n"
            "  ],\n"
            '  "summary": "2-3문장 종합 요약"\n'
            "}\n\n"
            "규칙:\n"
            "- sentiment: -100(극도 부정) ~ +100(극도 긍정) 정수\n"
            "- sentiment_label: 극도 부정/부정/약간 부정/중립/"
            "약간 긍정/긍정/극도 긍정\n"
            "- keywords: 상위 5-10개, 투자/경제 핵심 키워드 + 빈도수\n"
            "- stocks: 언급된 종목명 + 감성점수(-100~+100), 최대 10개\n"
            "- sectors: 관련 섹터별 그룹핑. 섹터별 감성(-100~100), "
            "1줄 요약, 해당 게시물 수\n"
            "- summary: 전체 시장 분위기 2-3줄 한국어 요약"
        )},
        {"role": "user", "content": f"인기 게시물 {len(posts)}개:\n\n{combined}"},
    ]

    content, model, err = llm_chat_direct(
        messages, LLM_MODELS, temperature=0.2, max_tokens=1200, timeout=60,
    )
    if not content:
        log(f"LLM analysis failed: {err}", level="WARN")
        return {**empty, "sentiment_label": "분석 실패",
                "summary": "LLM 분석에 실패했습니다."}

    # Strip markdown code fences
    clean = content.strip()
    if clean.startswith("```"):
        raw_lines = clean.split("\n")
        clean = "\n".join(raw_lines[1:-1]) if len(raw_lines) > 2 else clean
    try:
        result = json.loads(clean)
        log(f"LLM analysis OK via {model}")
        return result
    except json.JSONDecodeError:
        log(f"JSON parse failed from {model}: {content[:120]}", level="WARN")
        return {**empty, "sentiment_label": "파싱 실패",
                "summary": content[:200]}


# ── Report Formatting ────────────────────────────────────────────────────────

def format_report(top_posts: list[dict], analysis: dict,
                  total_channels: int, total_posts: int) -> str:
    """Format the report matching 서화백Sentiment style."""
    now = datetime.now().strftime("%Y-%m-%d %H:%M KST")
    sentiment = analysis.get("sentiment", 0)
    sentiment_label = analysis.get("sentiment_label", "")
    sign = "+" if sentiment > 0 else ""

    parts = [
        "*텔레그램 인기 분석 리포트*",
        f"━━━━━━━━━━━━━━━━",
        f"{now}",
        "",
        f"수집: {total_channels}개 채널 | {total_posts}개 게시물",
        f"종합 감성: {sign}{sentiment} ({sentiment_label})",
    ]

    # Keywords
    keywords = analysis.get("keywords", [])
    if keywords:
        parts.append("")
        parts.append("*주요 키워드*")
        kw_items = []
        for kw in keywords[:10]:
            if isinstance(kw, dict):
                kw_items.append(f"{kw.get('word', '')} ({kw.get('count', 0)})")
            elif isinstance(kw, str):
                kw_items.append(kw)
        parts.append(" · ".join(kw_items))

    # Stocks
    stocks = analysis.get("stocks", [])
    if stocks:
        parts.append("")
        parts.append("*주목 종목*")
        stock_items = []
        for s in stocks[:10]:
            if isinstance(s, dict):
                name = s.get("name", "")
                score = s.get("score", 0)
                s_sign = "+" if score > 0 else ""
                stock_items.append(f"{name} {s_sign}{score}")
        parts.append(" · ".join(stock_items))

    # Sectors
    sectors = analysis.get("sectors", [])
    if sectors:
        parts.append("")
        parts.append("─ ─ ─ ─ ─ ─ ─ ─")
        parts.append("*섹터별 동향*")
        for sec in sectors:
            if isinstance(sec, dict):
                sec_name = sec.get("name", "")
                sec_sent = sec.get("sentiment", 0)
                sec_summary = sec.get("summary", "")
                sec_count = sec.get("count", 0)
                s_sign = "+" if sec_sent > 0 else ""
                parts.append(f"  {sec_name} ({s_sign}{sec_sent}, {sec_count}건)")
                if sec_summary:
                    parts.append(f"  └ {sec_summary}")

    # Top posts
    n = min(TOP_N, len(top_posts))
    parts.append("")
    parts.append("─ ─ ─ ─ ─ ─ ─ ─")
    parts.append(f"*TOP {n} 인기 게시물*")
    for i, p in enumerate(top_posts[:TOP_N], 1):
        title = _first_line(p.get("text", ""))
        views = _format_count(p.get("views", 0))
        reactions = p.get("reactions", 0)
        link = p.get("link", "")
        ch = p.get("channel_name", p.get("channel_id", ""))

        entry = f"{i}. `{ch}` {title}"
        metrics = f"   {views} views"
        if reactions > 0:
            metrics += f" · {reactions} reactions"
        if link:
            metrics += f"\n   {link}"
        parts.append(entry)
        parts.append(metrics)

    # Summary
    summary = analysis.get("summary", "")
    if summary:
        parts.append("")
        parts.append("─ ─ ─ ─ ─ ─ ─ ─")
        parts.append(f"*종합 요약*")
        parts.append(summary)

    return "\n".join(parts)


# ── Telegram ──────────────────────────────────────────────────────────────────

def notify_telegram(report_text: str) -> bool:
    """Send report to DM and group topic."""
    ok_dm = send_dm_chunked(report_text, parse_mode="Markdown")
    if not ok_dm:
        log("DM send failed", level="WARN")
    ok_group = send_group_chunked(
        report_text, topic_id=RON_TOPIC_ID, parse_mode="Markdown",
    )
    if not ok_group:
        log("Group send failed", level="WARN")
    return ok_dm and ok_group


# ── Report Archive ────────────────────────────────────────────────────────────

def save_report(report_text: str):
    """Archive report to file."""
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    filename = datetime.now().strftime("report-%Y-%m-%d-%H%M.md")
    path = REPORTS_DIR / filename
    path.write_text(report_text, encoding="utf-8")
    log(f"Report saved: {path}")


def save_vault_note(top_posts: list[dict], analysis: dict,
                    channel_count: int, post_count: int):
    """Save TOP 50 posts + analysis as an Obsidian vault note."""
    now = datetime.now()
    date_str = now.strftime("%Y-%m-%d")
    time_str = now.strftime("%H:%M")

    # Extract tags from keywords
    keywords = analysis.get("keywords", [])
    kw_tags = []
    for kw in keywords[:8]:
        if isinstance(kw, dict):
            kw_tags.append(kw.get("keyword", ""))
        elif isinstance(kw, str):
            kw_tags.append(kw)
    kw_tags = [t.replace(" ", "-") for t in kw_tags if t]

    # Extract sector names
    sectors = analysis.get("sectors", [])
    sector_names = []
    for sec in sectors:
        if isinstance(sec, dict):
            sector_names.append(sec.get("name", ""))

    # Frontmatter
    sentiment = analysis.get("sentiment", 0)
    fm_tags = ["popular-posts"] + kw_tags
    lines = [
        "---",
        f"date: {date_str}",
        f"time: {time_str}",
        f"tags: [{', '.join(fm_tags)}]",
        f"sentiment: {sentiment}",
        f"channels: {channel_count}",
        f"posts: {post_count}",
        "type: popular-posts",
        "---",
        "",
        f"# 텔레그램 인기 게시물 ({date_str} {time_str})",
        "",
        f"수집: {channel_count}개 채널 | {post_count}개 게시물",
    ]

    # Sentiment
    s_sign = "+" if sentiment > 0 else ""
    s_label = analysis.get("sentiment_label", "")
    lines.append(f"종합 감성: {s_sign}{sentiment} ({s_label})")
    lines.append("")

    # Keywords
    if keywords:
        kw_parts = []
        for kw in keywords:
            if isinstance(kw, dict):
                name = kw.get("keyword", "")
                count = kw.get("count", 0)
                kw_parts.append(f"{name} ({count})" if count else name)
            elif isinstance(kw, str):
                kw_parts.append(kw)
        lines.append("## 주요 키워드")
        lines.append(" · ".join(kw_parts))
        lines.append("")

    # Stocks
    stocks = analysis.get("stocks", [])
    if stocks:
        stock_parts = []
        for st in stocks:
            if isinstance(st, dict):
                name = st.get("name", "")
                sent = st.get("sentiment", 0)
                s = "+" if sent > 0 else ""
                stock_parts.append(f"{name} {s}{sent}")
            elif isinstance(st, str):
                stock_parts.append(st)
        lines.append("## 주목 종목")
        lines.append(" · ".join(stock_parts))
        lines.append("")

    # Sectors
    if sectors:
        lines.append("## 섹터별 동향")
        for sec in sectors:
            if isinstance(sec, dict):
                sec_name = sec.get("name", "")
                sec_sent = sec.get("sentiment", 0)
                sec_summary = sec.get("summary", "")
                sec_count = sec.get("count", 0)
                ss = "+" if sec_sent > 0 else ""
                lines.append(f"- **{sec_name}** ({ss}{sec_sent}, {sec_count}건)")
                if sec_summary:
                    lines.append(f"  - {sec_summary}")
        lines.append("")

    # Summary
    summary = analysis.get("summary", "")
    if summary:
        lines.append("## 종합 요약")
        lines.append(summary)
        lines.append("")

    # TOP 50 posts
    n = min(LLM_BATCH_SIZE, len(top_posts))
    lines.append(f"## TOP {n} 게시물")
    lines.append("")
    for i, p in enumerate(top_posts[:LLM_BATCH_SIZE], 1):
        ch = p.get("channel_name", p.get("channel_id", ""))
        text = (p.get("text", "") or "")[:200].replace("\n", " ")
        views = p.get("views", 0)
        reactions = p.get("reactions", 0)
        score = p.get("popularity_score", 0)
        link = p.get("link", "")

        lines.append(f"### {i}. {ch}")
        lines.append(f"> {text}")
        metrics = f"조회 {views:,}"
        if reactions > 0:
            metrics += f" · 반응 {reactions}"
        metrics += f" · 스코어 {score:.1f}"
        lines.append(metrics)
        if link:
            lines.append(f"[원문]({link})")
        lines.append("")

    # Write to vault
    VAULT_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"popular-posts-{date_str}-{now.strftime('%H%M')}.md"
    path = VAULT_DIR / filename
    path.write_text("\n".join(lines), encoding="utf-8")
    log(f"Vault note saved: {path}")


def cleanup_old_reports(days: int = REPORT_RETENTION_DAYS):
    """Remove reports older than N days."""
    if not REPORTS_DIR.exists():
        return
    cutoff = datetime.now() - timedelta(days=days)
    for f in REPORTS_DIR.glob("report-*.md"):
        try:
            mtime = datetime.fromtimestamp(f.stat().st_mtime)
            if mtime < cutoff:
                f.unlink()
                log(f"Removed old report: {f.name}")
        except OSError:
            pass


# ── State Management ─────────────────────────────────────────────────────────

def load_state() -> dict:
    """Load pipeline state."""
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_state(state: dict):
    """Save pipeline state atomically."""
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(
        json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8",
    )
    tmp.replace(STATE_FILE)


# ── Main Pipeline ─────────────────────────────────────────────────────────────

def run_pipeline(notify: bool = False, dry_run: bool = False,
                 limit_channels: int = 0) -> dict:
    """Run the full pipeline: scrape → score → analyze → report → send."""
    log("=" * 50)
    log("Starting popular posts pipeline")

    # Initialize
    init_db()
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)

    # Load channels
    channels = load_channels()
    if not channels:
        log("No channels loaded, aborting", level="ERROR")
        return {"error": "no channels"}

    if limit_channels > 0:
        channels = channels[:limit_channels]
    log(f"Loaded {len(channels)} channels")

    # Scrape
    posts = scrape_all_channels(channels)
    if not posts:
        log("No posts collected", level="WARN")
        # Still update state
        state = load_state()
        state["last_run"] = datetime.now().isoformat()
        state["last_channels"] = len(channels)
        state["last_posts"] = 0
        save_state(state)
        return {"channels": len(channels), "posts": 0}

    # Save to DB
    save_posts(posts)

    # Score and rank
    top_posts = rank_posts()
    log(f"Ranked {len(top_posts)} posts, top score: "
        f"{top_posts[0]['popularity_score']:.1f}" if top_posts else "none")

    # LLM analysis
    analysis = analyze_posts(top_posts)

    # Format report
    report = format_report(top_posts, analysis, len(channels), len(posts))

    if dry_run:
        print("\n" + "=" * 60)
        print(report)
        print("=" * 60)
        log("Dry run complete (not sending)")
    else:
        # Archive
        save_report(report)
        # Save to Obsidian vault (TOP 50 + analysis)
        try:
            save_vault_note(top_posts, analysis, len(channels), len(posts))
        except Exception as e:
            log(f"Vault note save failed: {e}", level="WARN")
        # Send
        if notify:
            ok = notify_telegram(report)
            log(f"Telegram notification: {'OK' if ok else 'PARTIAL FAIL'}")

    # Cleanup
    cleanup_old_posts()
    cleanup_old_reports()

    # Update state
    state = load_state()
    state["last_run"] = datetime.now().isoformat()
    state["last_channels"] = len(channels)
    state["last_posts"] = len(posts)
    state["last_top_score"] = (top_posts[0]["popularity_score"]
                               if top_posts else 0)
    save_state(state)

    result = {
        "channels": len(channels),
        "posts": len(posts),
        "top_n": min(TOP_N, len(top_posts)),
        "sentiment": analysis.get("sentiment", 0),
    }
    log(f"Pipeline complete: {result}")
    return result


def print_stats():
    """Print channel statistics."""
    init_db()
    stats = get_channel_stats()
    if not stats:
        print("No data yet. Run the pipeline first.")
        return

    print(f"\n{'Channel':<30} {'Posts':>6} {'Avg Views':>10} "
          f"{'Max Views':>10} {'Last Scraped':<20}")
    print("-" * 80)
    for s in stats:
        name = s.get("channel_name") or s.get("channel_id", "?")
        print(f"{_truncate(name, 29):<30} "
              f"{s['post_count']:>6} "
              f"{s['avg_views']:>10.0f} "
              f"{s['max_views']:>10} "
              f"{s.get('last_scraped', 'N/A'):<20}")


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(
        description="텔레그램 인기게시물 리포트 파이프라인",
    )
    ap.add_argument("--notify", action="store_true",
                    help="텔레그램 전송 (DM + 론 토픽)")
    ap.add_argument("--dry-run", action="store_true",
                    help="수집+분석 후 stdout 출력 (전송 안 함)")
    ap.add_argument("--stats", action="store_true",
                    help="채널별 통계 출력")
    ap.add_argument("--limit-channels", type=int, default=0,
                    help="채널 수 제한 (0=전체)")
    args = ap.parse_args()

    if args.stats:
        print_stats()
        return

    result = run_pipeline(
        notify=args.notify,
        dry_run=args.dry_run,
        limit_channels=args.limit_channels,
    )
    if "error" in result:
        sys.exit(1)


if __name__ == "__main__":
    main()
