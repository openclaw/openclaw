#!/usr/bin/env python3
"""daily_report.py — 데일리 마켓 인텔리전스 리포트 파이프라인.

기존 파이프라인(popular_posts, tweets, telegram-topics, filtered-ideas, hypotheses)이
수집한 데이터를 일일 통합 다이제스트로 요약하여 지식사랑방 데일리 리포트 토픽에 전송.

사용법:
    python3 daily_report.py --notify    # 집계+분석+전송
    python3 daily_report.py --dry-run   # 집계+분석 (전송 안 함, stdout 출력)

데이터 소스:
    1. popular_posts (SQLite) — ~170개 공개 채널 인기글
    2. tweets (SQLite) — X/Twitter 팔로잉 트윗
    3. telegram-topics/ (JSON) — 지식사랑방 학습 토픽 공유 (7개 토픽)
    4. filtered-ideas/ (JSON) — 필터된 발견
    5. hypotheses/ (JSON) — 생성된 가설
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
from shared.db import db_connection
from shared.llm import llm_chat_direct, DIRECT_PREMIUM_CHAIN
from shared.log import make_logger
from shared.telegram import send_group_chunked, DAILY_REPORT_TOPIC_ID

# ── Constants ──────────────────────────────────────────────────────────────────

DB_PATH = Path(os.path.expanduser("~/.openclaw/data/ops_multiagent.db"))
WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))
MEMORY_DIR = WORKSPACE / "memory" / "daily-report"
STATE_FILE = MEMORY_DIR / "state.json"
LOG_FILE = WORKSPACE / "logs" / "daily_report.log"

FILTERED_IDEAS_DIR = WORKSPACE / "memory" / "filtered-ideas"
HYPOTHESES_DIR = WORKSPACE / "memory" / "hypotheses"
TELEGRAM_TOPICS_DIR = WORKSPACE / "memory" / "telegram-topics"

GROUP_TOPICS = ["analysis", "articles", "insights", "nepcon",
                "x_twitter", "llm", "thesis_ideas"]
TOPIC_LABELS = {
    "analysis": "분석", "articles": "기사", "insights": "인사이트",
    "nepcon": "넵콘", "x_twitter": "X", "llm": "LLM",
    "thesis_ideas": "아이디어",
}

MODEL_CHAIN = list(DIRECT_PREMIUM_CHAIN)
LOOKBACK_HOURS = 48  # 48h for tweets (collector runs 2x/day)
POST_LOOKBACK_HOURS = 24  # 24h for popular_posts
MIN_TEXT_LENGTH = 30

KST = timezone(timedelta(hours=9))
WEEKDAYS_KO = ["월", "화", "수", "목", "금", "토", "일"]

log = make_logger(log_file=str(LOG_FILE))

# URL pattern for cleanup
_URL_RE = re.compile(r'https?://\S+')


# ── Helpers ───────────────────────────────────────────────────────────────────

def _is_url_only(text: str) -> bool:
    """Check if text is just a URL with no real content."""
    stripped = text.strip()
    return bool(_URL_RE.fullmatch(stripped))


def _first_line(text: str, max_len: int = 120) -> str:
    """Extract first meaningful line, truncated."""
    for line in text.strip().split("\n"):
        line = line.strip()
        if line and len(line) > 10:
            return line[:max_len] + ("…" if len(line) > max_len else "")
    return text[:max_len]


def _classify_group_share(item: dict) -> str:
    """Classify a group share into content type for display."""
    text = item.get("text") or ""
    if _is_url_only(text):
        if "x.com" in text or "twitter.com" in text:
            return "tweet"
        if "youtube.com" in text or "youtu.be" in text:
            return "video"
        return "link"
    return "text"


# ── Stage 1: Aggregation ──────────────────────────────────────────────────────

def fetch_top_posts(limit: int = 20, hours: int = POST_LOOKBACK_HOURS,
                    db_path: Path | None = None) -> list[dict]:
    """Fetch top popular posts from SQLite, ranked by popularity_score."""
    db = db_path or DB_PATH
    if not db.exists():
        log("DB not found, skipping popular_posts", level="WARN")
        return []
    with db_connection(db, row_factory=sqlite3.Row) as conn:
        cutoff = (datetime.now() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
        rows = conn.execute("""
            SELECT channel_name, text, views, reactions, popularity_score, link
            FROM popular_posts
            WHERE scraped_at >= ?
            ORDER BY popularity_score DESC
            LIMIT ?
        """, (cutoff, limit)).fetchall()
    return [dict(r) for r in rows]


def fetch_top_tweets(limit: int = 15, hours: int = LOOKBACK_HOURS,
                     db_path: Path | None = None) -> list[dict]:
    """Fetch top tweets from SQLite, ranked by engagement_score."""
    db = db_path or DB_PATH
    if not db.exists():
        log("DB not found, skipping tweets", level="WARN")
        return []
    with db_connection(db, row_factory=sqlite3.Row) as conn:
        cutoff = (datetime.now() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
        rows = conn.execute("""
            SELECT author_name, author_handle, text, likes, retweets,
                   views, engagement_score, url
            FROM tweets
            WHERE collected_at >= ?
            ORDER BY engagement_score DESC
            LIMIT ?
        """, (cutoff, limit)).fetchall()
    return [dict(r) for r in rows]


def load_today_files(directory: Path, date_str: str | None = None) -> list[dict]:
    """Load JSON files matching today's date from a memory directory."""
    if not directory.exists():
        return []
    today = date_str or datetime.now().strftime("%Y-%m-%d")
    items = []
    for fp in sorted(directory.iterdir()):
        if not fp.name.endswith(".json") or today not in fp.name:
            continue
        try:
            data = json.loads(fp.read_text(encoding="utf-8"))
            if isinstance(data, list):
                items.extend(data)
            elif isinstance(data, dict):
                items.append(data)
        except (json.JSONDecodeError, OSError) as e:
            log(f"Failed to load {fp}: {e}", level="WARN")
    # Deduplicate by content
    seen: set[str] = set()
    unique: list[dict] = []
    for item in items:
        key = (item.get("hypothesis") or item.get("text") or
               item.get("discovery_text") or json.dumps(item, sort_keys=True))[:200]
        if key not in seen:
            seen.add(key)
            unique.append(item)
    return unique


def fetch_group_shares(date_str: str | None = None,
                       topics_dir: Path | None = None,
                       lookback_days: int = 1) -> list[dict]:
    """Load messages shared in 지식사랑방 learning topics (today + lookback)."""
    base = topics_dir or TELEGRAM_TOPICS_DIR
    today = datetime.now()
    dates = set()
    if date_str:
        dates.add(date_str)
    else:
        for d in range(lookback_days + 1):
            dates.add((today - timedelta(days=d)).strftime("%Y-%m-%d"))

    items = []
    for topic in GROUP_TOPICS:
        topic_dir = base / topic
        if not topic_dir.exists():
            continue
        for fp in sorted(topic_dir.iterdir()):
            if not fp.name.endswith(".json"):
                continue
            if not any(dt in fp.name for dt in dates):
                continue
            try:
                data = json.loads(fp.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    text = data.get("text") or ""
                    if len(text.strip()) < MIN_TEXT_LENGTH:
                        continue
                    data["_topic"] = topic
                    data["_topic_label"] = TOPIC_LABELS.get(topic, topic)
                    data["_content_type"] = _classify_group_share(data)
                    items.append(data)
            except (json.JSONDecodeError, OSError):
                continue
    # Deduplicate and sort: text content first, links last
    seen: set[str] = set()
    unique: list[dict] = []
    for item in items:
        key = (item.get("text") or "")[:200]
        if key and key not in seen:
            seen.add(key)
            unique.append(item)
    # Prioritize: text > link/tweet/video
    unique.sort(key=lambda x: (0 if x.get("_content_type") == "text" else 1,
                                -len(x.get("text") or "")))
    log(f"Group shares: {len(unique)} messages from {len(GROUP_TOPICS)} topics "
        f"(dates: {sorted(dates)})")
    return unique


def count_channels(hours: int = POST_LOOKBACK_HOURS,
                   db_path: Path | None = None) -> int:
    """Count distinct channels that posted in the lookback window."""
    db = db_path or DB_PATH
    if not db.exists():
        return 0
    with db_connection(db) as conn:
        cutoff = (datetime.now() - timedelta(hours=hours)).strftime("%Y-%m-%d %H:%M:%S")
        row = conn.execute("""
            SELECT COUNT(DISTINCT channel_id) FROM popular_posts
            WHERE scraped_at >= ?
        """, (cutoff,)).fetchone()
    return row[0] if row else 0


def aggregate(db_path: Path | None = None,
              topics_dir: Path | None = None) -> dict:
    """Stage 1: Collect all data sources into a single dict."""
    posts = fetch_top_posts(db_path=db_path)
    tweets = fetch_top_tweets(db_path=db_path)
    ideas = load_today_files(FILTERED_IDEAS_DIR)
    hypotheses = load_today_files(HYPOTHESES_DIR)
    group_shares = fetch_group_shares(topics_dir=topics_dir)
    channel_count = count_channels(db_path=db_path)

    log(f"Aggregated: {len(posts)} posts, {len(tweets)} tweets, "
        f"{len(group_shares)} group shares, "
        f"{len(ideas)} ideas, {len(hypotheses)} hypotheses, "
        f"{channel_count} channels")

    return {
        "posts": posts,
        "tweets": tweets,
        "group_shares": group_shares,
        "ideas": ideas,
        "hypotheses": hypotheses,
        "channel_count": channel_count,
    }


# ── Stage 2: LLM Analysis ────────────────────────────────────────────────────

def _build_analysis_prompt(data: dict) -> str:
    """Build the LLM analysis prompt from aggregated data."""
    parts = []

    for i, p in enumerate(data["posts"][:15], 1):
        text = (p.get("text") or "")[:150]
        ch = p.get("channel_name") or "?"
        views = p.get("views", 0)
        parts.append(f"[채널#{i}] {ch} (조회 {views}): {text}")

    for i, t in enumerate(data["tweets"][:10], 1):
        text = (t.get("text") or "")[:150]
        author = t.get("author_name") or t.get("author_handle") or "?"
        likes = t.get("likes", 0)
        parts.append(f"[트윗#{i}] {author} (♥{likes}): {text}")

    # Group shares — text content only (skip URL-only)
    text_shares = [g for g in data.get("group_shares", [])
                   if g.get("_content_type") == "text"]
    for i, g in enumerate(text_shares[:7], 1):
        text = (g.get("text") or "")[:150]
        topic = g.get("_topic_label") or "?"
        parts.append(f"[그룹/{topic}#{i}]: {text}")

    for item in data["ideas"][:3]:
        text = (item.get("text") or item.get("discovery_text") or "")[:120]
        parts.append(f"[발견] {text}")

    for item in data["hypotheses"][:3]:
        hyp = (item.get("hypothesis") or "")[:120]
        parts.append(f"[가설] {hyp}")

    combined = "\n".join(parts)

    return f"""아래는 최근 수집된 텔레그램 인기글, X/Twitter 트윗, 지식사랑방 그룹 공유, 발견, 가설이다.
분석하여 아래 JSON으로 응답하라. 한국어. JSON만 출력.

{combined}

{{"keywords": [{{"keyword": "키워드", "count": N}}, ...8개], "sectors": ["섹터"...5개], "sentiment": -1.0~+1.0, "sentiment_label": "극부정/부정/중립/긍정/극긍정", "tickers": [{{"name": "종목", "direction": "↑|↓|→"}}...5개], "highlights": [{{"rank": 1, "source": "출처", "title": "제목", "views": N, "reactions": N, "summary": "1줄"}}...5개], "tweet_highlights": [{{"author": "작성자", "text": "내용요약", "likes": N}}...3개], "group_highlights": [{{"topic": "토픽", "author": "작성자", "summary": "내용요약"}}...3개], "summary": "4-5문장 종합요약"}}"""


def analyze(data: dict) -> dict:
    """Stage 2: Send aggregated data to LLM for analysis."""
    has_data = (data["posts"] or data["tweets"] or
                data.get("group_shares"))
    if not has_data:
        log("No data to analyze, returning empty analysis")
        return _empty_analysis()

    prompt = _build_analysis_prompt(data)
    messages = [{"role": "user", "content": prompt}]

    content, model, error = llm_chat_direct(
        messages, MODEL_CHAIN, temperature=0.2, max_tokens=3000, timeout=90,
    )

    if not content:
        log(f"LLM failed: {error}", level="ERROR")
        return _empty_analysis()

    log(f"LLM analysis done (model: {model})")
    return _parse_analysis(content)


def _empty_analysis() -> dict:
    return {
        "keywords": [], "sectors": [], "sentiment": 0.0,
        "sentiment_label": "데이터 없음", "tickers": [],
        "highlights": [], "tweet_highlights": [], "group_highlights": [],
        "summary": "데이터가 충분하지 않아 분석을 생성하지 못했습니다.",
    }


def _parse_analysis(content: str) -> dict:
    """Parse LLM JSON response, tolerant of markdown code fences."""
    text = content.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        lines = [l for l in lines if not l.strip().startswith("```")]
        text = "\n".join(lines)
    try:
        result = json.loads(text)
        if isinstance(result, dict):
            return result
    except json.JSONDecodeError:
        log(f"Failed to parse LLM JSON, using empty analysis", level="WARN")
    return _empty_analysis()


# ── Stage 3: Formatting ──────────────────────────────────────────────────────

def format_report(data: dict, analysis: dict) -> str:
    """Stage 3: Build the Markdown report text — designed for readability."""
    now = datetime.now(KST)
    date_str = now.strftime("%Y-%m-%d")
    weekday = WEEKDAYS_KO[now.weekday()]

    channel_count = data.get("channel_count", 0)
    n_posts = len(data.get("posts", []))
    n_tweets = len(data.get("tweets", []))
    n_group = len(data.get("group_shares", []))
    n_total = n_posts + n_tweets + n_group

    sentiment = analysis.get("sentiment", 0.0)
    sentiment_label = analysis.get("sentiment_label", "중립")

    # ── Header
    lines = [
        f"*데일리 마켓 인텔리전스*",
        f"{date_str} ({weekday})",
        "━━━━━━━━━━━━━━━━━━━━━━━",
        "",
    ]

    # ── Stats bar
    stat_parts = []
    if channel_count:
        stat_parts.append(f"채널 {channel_count}개")
    if n_posts:
        stat_parts.append(f"인기글 {n_posts}")
    if n_tweets:
        stat_parts.append(f"트윗 {n_tweets}")
    if n_group:
        stat_parts.append(f"그룹공유 {n_group}")
    lines.append(" · ".join(stat_parts))
    lines.append(f"감성: {sentiment:+.1f} ({sentiment_label})")
    lines.append("")

    # ── Keywords + Tickers (compact block)
    keywords = analysis.get("keywords", [])
    tickers = analysis.get("tickers", [])
    if keywords:
        kw_parts = []
        for kw in keywords[:8]:
            if isinstance(kw, dict):
                kw_parts.append(f"*{kw.get('keyword', '?')}*({kw.get('count', 0)})")
            elif isinstance(kw, str):
                kw_parts.append(f"*{kw}*")
        lines.append(" · ".join(kw_parts))
    if tickers:
        tk_parts = []
        for tk in tickers[:6]:
            if isinstance(tk, dict):
                d = tk.get("direction", "→")
                tk_parts.append(f"{tk.get('name', '?')}{d}")
            elif isinstance(tk, str):
                tk_parts.append(tk)
        lines.append(" | ".join(tk_parts))

    # ── Section 1: TOP 채널 인기글
    highlights = analysis.get("highlights", [])
    if highlights:
        lines.append("")
        lines.append("━━━ *채널 인기글 TOP 5* ━━━")
        lines.append("")
        for i, h in enumerate(highlights[:5], 1):
            if isinstance(h, dict):
                src = h.get("source", "?")
                title = h.get("title", "")
                views = h.get("views", 0)
                reactions = h.get("reactions", 0)
                summary = h.get("summary", "")
                stat = f"조회 {views:,}" if views else ""
                if reactions:
                    stat += f" · 반응 {reactions}"
                lines.append(f"*{i}.* [{src}]")
                lines.append(f"    {title}")
                if stat:
                    lines.append(f"    _{stat}_")
                if summary:
                    lines.append(f"    → {summary}")
                lines.append("")

    # ── Section 2: X/Twitter
    tweet_highlights = analysis.get("tweet_highlights", [])
    raw_tweets = data.get("tweets", [])
    if tweet_highlights or raw_tweets:
        lines.append("━━━ *X/Twitter* ━━━")
        lines.append("")
        if tweet_highlights:
            for i, th in enumerate(tweet_highlights[:5], 1):
                if isinstance(th, dict):
                    author = th.get("author", "?")
                    text = th.get("text", "")
                    likes = th.get("likes", 0)
                    lines.append(f"*{i}.* @{author} ♥{likes}")
                    lines.append(f"    {text}")
                    lines.append("")
        elif raw_tweets:
            # Fallback: format raw tweets if LLM didn't produce highlights
            for i, t in enumerate(raw_tweets[:5], 1):
                author = t.get("author_name") or t.get("author_handle") or "?"
                text = _first_line(t.get("text") or "", 100)
                likes = t.get("likes", 0)
                rt = t.get("retweets", 0)
                lines.append(f"*{i}.* @{author} ♥{likes} RT{rt}")
                lines.append(f"    {text}")
                lines.append("")

    # ── Section 3: 지식사랑방 공유
    group_shares = data.get("group_shares", [])
    group_highlights = analysis.get("group_highlights", [])
    if group_shares:
        lines.append("━━━ *지식사랑방* ({n}건) ━━━".format(n=len(group_shares)))
        lines.append("")

        # LLM-generated group highlights first
        if group_highlights:
            for gh in group_highlights[:3]:
                if isinstance(gh, dict):
                    topic = gh.get("topic", "?")
                    author = gh.get("author", "?")
                    summary = gh.get("summary", "")
                    lines.append(f"▸ [{topic}] {author}")
                    lines.append(f"  {summary}")
                    lines.append("")

        # Then list remaining shares (text content prioritized)
        shown_summaries = {(gh.get("author", ""), gh.get("topic", ""))
                          for gh in (group_highlights or []) if isinstance(gh, dict)}
        remaining = [g for g in group_shares
                     if (g.get("author", ""), g.get("_topic_label", ""))
                     not in shown_summaries]
        for g in remaining[:5]:
            topic = g.get("_topic_label") or "?"
            author = g.get("author") or "?"
            ctype = g.get("_content_type", "text")
            text = g.get("text") or ""

            if ctype == "text":
                display = _first_line(text, 100)
                lines.append(f"▸ [{topic}] {author}: {display}")
            elif ctype == "tweet":
                lines.append(f"▸ [{topic}] {author}: X 공유 {text[:60]}")
            else:
                lines.append(f"▸ [{topic}] {author}: {text[:60]}")
        lines.append("")

    # ── Section 4: 가설/발견
    ideas = data.get("ideas", [])
    hypotheses = data.get("hypotheses", [])
    if ideas or hypotheses:
        lines.append("━━━ *오늘의 발견/가설* ━━━")
        lines.append("")
        for item in ideas[:3]:
            text = _first_line(
                item.get("text") or item.get("discovery_text") or "", 100)
            if text:
                lines.append(f"💡 {text}")
        for item in hypotheses[:2]:
            hyp = _first_line(item.get("hypothesis") or "", 100)
            if hyp:
                lines.append(f"🔬 {hyp}")
        lines.append("")

    # ── Summary
    summary = analysis.get("summary", "")
    if summary:
        lines.append("━━━ *종합* ━━━")
        lines.append("")
        lines.append(summary)

    return "\n".join(lines)


# ── Stage 4: Archive ──────────────────────────────────────────────────────────

def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def save_state(state: dict) -> None:
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(STATE_FILE)


def archive_report(report_text: str, analysis: dict) -> Path:
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now(KST)
    date_str = now.strftime("%Y-%m-%d")
    report_path = MEMORY_DIR / f"report-{date_str}.md"
    report_path.write_text(report_text, encoding="utf-8")
    analysis_path = MEMORY_DIR / f"analysis-{date_str}.json"
    analysis_path.write_text(
        json.dumps(analysis, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"Archived: {report_path.name}, {analysis_path.name}")
    return report_path


def is_already_sent_today(state: dict) -> bool:
    today = datetime.now(KST).strftime("%Y-%m-%d")
    return state.get("last_sent_date") == today


# ── Main Pipeline ─────────────────────────────────────────────────────────────

def run_pipeline(notify: bool = False, dry_run: bool = False,
                 db_path: Path | None = None) -> str:
    log("=== Daily Report Pipeline Start ===")

    state = load_state()
    if not dry_run and is_already_sent_today(state):
        log("Report already sent today, skipping (idempotent)")
        return ""

    data = aggregate(db_path=db_path)
    analysis = analyze(data)
    report = format_report(data, analysis)
    log(f"Report formatted: {len(report)} chars")

    if dry_run:
        print("\n" + "=" * 60)
        print("DRY RUN — Report Preview:")
        print("=" * 60)
        print(report)
        print("=" * 60 + "\n")
        log("Dry run complete (not sent)")
        return report

    if notify:
        all_ok = send_group_chunked(
            report, topic_id=DAILY_REPORT_TOPIC_ID, parse_mode="Markdown",
        )
        log("Sent successfully" if all_ok else "Some chunks failed")

    archive_report(report, analysis)
    state["last_sent_date"] = datetime.now(KST).strftime("%Y-%m-%d")
    state["last_sent_at"] = datetime.now(KST).isoformat()
    state["last_post_count"] = len(data["posts"])
    state["last_tweet_count"] = len(data["tweets"])
    state["last_group_count"] = len(data.get("group_shares", []))
    save_state(state)

    log("=== Daily Report Pipeline Complete ===")
    return report


def main():
    parser = argparse.ArgumentParser(description="데일리 마켓 인텔리전스 리포트")
    parser.add_argument("--notify", action="store_true", help="전송 모드")
    parser.add_argument("--dry-run", action="store_true", help="미리보기 (전송 안 함)")
    args = parser.parse_args()

    if not args.notify and not args.dry_run:
        parser.print_help()
        sys.exit(1)

    run_pipeline(notify=args.notify, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
