#!/opt/homebrew/bin/python3.13
"""twitter_collector.py — X/Twitter 트윗 수집 리포트 파이프라인.

팔로잉 계정의 트윗을 twikit으로 수집하고, 인게이지먼트 스코어링 후
LLM 분석(감성/키워드/종목/섹터)과 함께 텔레그램으로 리포트 전송.

사용법:
    python3.13 twitter_collector.py --notify             # 수집+분석+전송
    python3.13 twitter_collector.py --dry-run             # 수집+분석 (전송 안 함)
    python3.13 twitter_collector.py --stats               # 계정 통계 출력
    python3.13 twitter_collector.py --limit 5             # 계정 수 제한
    python3.13 twitter_collector.py --fetch-following      # 팔로잉 목록 가져오기

아키텍처:
    [accounts.json] → twikit async collector (쿠키 인증)
    → SQLite tweets 테이블 → 인게이지먼트 스코어링
    → LLM 1회 배치 분석 (감성/키워드/종목/섹터별 요약)
    → Bot API 직접전송 (DM + 론 토픽)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.db import db_connection, db_transaction
from shared.llm import llm_chat_direct, DIRECT_DEFAULT_CHAIN
from shared.log import make_logger
from shared.telegram import send_dm_chunked, send_group_chunked, RON_TOPIC_ID

# ── Constants ──────────────────────────────────────────────────────────────────

DB_PATH = Path(os.path.expanduser("~/.openclaw/data/ops_multiagent.db"))
WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))
MEMORY_DIR = WORKSPACE / "memory" / "twitter-collector"
ACCOUNTS_FILE = MEMORY_DIR / "accounts.json"
STATE_FILE = MEMORY_DIR / "state.json"
REPORTS_DIR = MEMORY_DIR / "reports"
COOKIE_CACHE = MEMORY_DIR / "cookies_cache.json"
LOG_FILE = WORKSPACE / "logs" / "twitter_collector.log"

REQUEST_DELAY = 3  # seconds between account requests
LOOKBACK_HOURS = 24
TWEETS_PER_ACCOUNT = 20
LLM_MODELS = list(DIRECT_DEFAULT_CHAIN)
RETENTION_DAYS = 30
REPORT_RETENTION_DAYS = 90
TOP_N = 10
LLM_BATCH_SIZE = 30

KST = timezone(timedelta(hours=9))
log = make_logger(log_file=str(LOG_FILE))


# ── Utility ────────────────────────────────────────────────────────────────────

def _truncate(text: str, max_len: int = 80) -> str:
    if len(text) <= max_len:
        return text
    return text[: max_len - 1] + "\u2026"


def _format_count(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}K"
    return str(n)


def _first_line(text: str, max_len: int = 80) -> str:
    if not text:
        return "(내용 없음)"
    line = text.split("\n")[0].strip()
    line = line.lstrip("#☞▶️ ")
    if not line:
        parts = text.split("\n")
        line = parts[1].strip() if len(parts) > 1 else text[:max_len].strip()
    return _truncate(line, max_len)


def _clean_tweet_text(text: str) -> str:
    """Remove t.co URLs from tweet text for cleaner display."""
    return re.sub(r"https?://t\.co/\S+", "", text).strip()


# ── Cookie Management ─────────────────────────────────────────────────────────

def load_cookies() -> dict:
    """Extract X.com cookies from Chrome. Falls back to cache file."""
    try:
        import browser_cookie3
        cj = browser_cookie3.chrome(domain_name=".x.com")
        cookies = {c.name: c.value for c in cj if c.name in ("auth_token", "ct0")}
        if cookies.get("auth_token"):
            COOKIE_CACHE.parent.mkdir(parents=True, exist_ok=True)
            tmp = COOKIE_CACHE.with_suffix(".tmp")
            tmp.write_text(json.dumps(cookies), encoding="utf-8")
            tmp.replace(COOKIE_CACHE)
            log("Cookies loaded from Chrome")
            return cookies
    except Exception as e:
        log(f"Chrome cookie extraction failed: {e}", level="WARN")

    if COOKIE_CACHE.exists():
        try:
            cookies = json.loads(COOKIE_CACHE.read_text(encoding="utf-8"))
            if cookies.get("auth_token"):
                log("Cookies loaded from cache")
                return cookies
        except Exception:
            pass

    raise RuntimeError(
        "X cookies not found. Log in to X.com in Chrome first."
    )


# ── Account Management ────────────────────────────────────────────────────────

def load_accounts(path: Path | None = None) -> list[dict]:
    """Load account list from JSON file."""
    path = path or ACCOUNTS_FILE
    if not path.exists():
        log(f"Accounts file not found: {path}", level="ERROR")
        return []
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    accounts = data.get("accounts", [])
    log(f"Loaded {len(accounts)} accounts")
    return accounts


def save_accounts(accounts: list[dict], path: Path | None = None) -> None:
    """Save account list to JSON file."""
    path = path or ACCOUNTS_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "version": "1.0",
        "description": "X/Twitter 팔로잉 수집 대상 계정 목록",
        "my_user_id": "1643456450394726400",
        "accounts": accounts,
    }
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
    log(f"Saved {len(accounts)} accounts to {path}")


async def fetch_following(cookies: dict | None = None) -> list[dict]:
    """Fetch following list from X using twikit."""
    import twikit

    if cookies is None:
        cookies = load_cookies()
    client = twikit.Client("ko")
    client.set_cookies(cookies)

    my_id = "1643456450394726400"
    all_users: list[dict] = []
    cursor = None

    log("Fetching following list...")
    prev_count = 0
    while True:
        result = await client.get_user_following(my_id, count=100, cursor=cursor)
        for user in result:
            all_users.append({
                "id": user.id,
                "handle": user.screen_name,
                "name": user.name,
            })
        log(f"  Fetched {len(all_users)} followings so far")

        # Break if no new users added (pagination exhausted or empty)
        if len(all_users) == prev_count:
            break
        prev_count = len(all_users)

        # Check for next page cursor
        if not result.next_cursor:
            break
        cursor = result.next_cursor
        await asyncio.sleep(2)

    log(f"Total followings fetched: {len(all_users)}")
    return all_users


def sync_accounts(fresh: list[dict], existing: list[dict]) -> tuple[list[dict], int, int]:
    """Merge fresh following list with existing accounts.

    New followings are added. Unfollowed accounts are removed.
    Returns (merged_list, added_count, removed_count).
    """
    existing_ids = {a.get("id") or a.get("handle") for a in existing}
    fresh_ids = {a.get("id") or a.get("handle") for a in fresh}

    fresh_by_key: dict[str, dict] = {}
    for a in fresh:
        key = a.get("id") or a.get("handle")
        fresh_by_key[key] = a

    merged = list(fresh_by_key.values())
    added = fresh_ids - existing_ids
    removed = existing_ids - fresh_ids

    if added:
        log(f"New followings: {len(added)}")
    if removed:
        log(f"Unfollowed: {len(removed)}")

    return merged, len(added), len(removed)


# ── Tweet Collection ──────────────────────────────────────────────────────────

def _normalize_tweet(tweet: Any, handle: str, name: str) -> dict:
    """Normalize a twikit Tweet object to a flat dict."""
    created_at = ""
    if hasattr(tweet, "created_at_datetime") and tweet.created_at_datetime:
        created_at = tweet.created_at_datetime.isoformat()
    elif hasattr(tweet, "created_at") and tweet.created_at:
        created_at = tweet.created_at

    return {
        "tweet_id": str(tweet.id),
        "author_id": "",
        "author_handle": handle,
        "author_name": name,
        "text": tweet.full_text or tweet.text or "",
        "likes": tweet.favorite_count or 0,
        "retweets": tweet.retweet_count or 0,
        "replies": tweet.reply_count or 0,
        "views": _parse_view_count(tweet),
        "created_at": created_at,
        "url": f"https://x.com/{handle}/status/{tweet.id}",
    }


def _parse_view_count(tweet: Any) -> int:
    """Safely parse view count from tweet object."""
    vc = getattr(tweet, "view_count", None)
    if vc is None:
        return 0
    if isinstance(vc, int):
        return vc
    try:
        return int(vc)
    except (ValueError, TypeError):
        return 0


async def collect_tweets(
    accounts: list[dict],
    cookies: dict | None = None,
    lookback_hours: int = LOOKBACK_HOURS,
    tweets_per_account: int = TWEETS_PER_ACCOUNT,
    delay: float = REQUEST_DELAY,
) -> list[dict]:
    """Collect tweets from accounts using twikit async API.

    Error isolation: one account failure doesn't stop others.
    """
    import twikit

    if cookies is None:
        cookies = load_cookies()
    client = twikit.Client("ko")
    client.set_cookies(cookies)

    cutoff = datetime.now(timezone.utc) - timedelta(hours=lookback_hours)
    all_tweets: list[dict] = []
    success_count = 0
    fail_count = 0

    for i, account in enumerate(accounts):
        handle = account.get("handle", "")
        name = account.get("name", handle)
        user_id = account.get("id", "")

        if not user_id and not handle:
            continue

        try:
            if user_id:
                tweets = await client.get_user_tweets(
                    user_id, "Tweets", count=tweets_per_account
                )
            else:
                # Search by handle as fallback
                user = await client.get_user_by_screen_name(handle)
                tweets = await client.get_user_tweets(
                    user.id, "Tweets", count=tweets_per_account
                )

            count = 0
            for tweet in tweets:
                # Skip retweets
                if hasattr(tweet, "retweeted_tweet") and tweet.retweeted_tweet:
                    continue
                normalized = _normalize_tweet(tweet, handle, name)
                # Filter by time if we can parse it
                if normalized["created_at"]:
                    try:
                        tweet_dt = datetime.fromisoformat(
                            normalized["created_at"].replace("Z", "+00:00")
                        )
                        if tweet_dt.tzinfo is None:
                            tweet_dt = tweet_dt.replace(tzinfo=timezone.utc)
                        if tweet_dt < cutoff:
                            continue
                    except (ValueError, TypeError):
                        pass
                all_tweets.append(normalized)
                count += 1

            success_count += 1
            if count > 0:
                log(f"  @{handle}: {count} tweets")

        except Exception as e:
            fail_count += 1
            err_str = str(e)[:100]
            log(f"  @{handle}: error - {err_str}", level="WARN")

        if i < len(accounts) - 1:
            await asyncio.sleep(delay)

    log(f"Collection done: {success_count} ok, {fail_count} failed, {len(all_tweets)} tweets")
    return all_tweets


# ── Database ──────────────────────────────────────────────────────────────────

def init_db(db_path: Path | None = None) -> None:
    """Initialize tweets table and indices."""
    db = db_path or DB_PATH
    with db_transaction(db) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tweets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tweet_id TEXT NOT NULL UNIQUE,
                author_id TEXT NOT NULL,
                author_handle TEXT NOT NULL,
                author_name TEXT,
                text TEXT,
                likes INTEGER DEFAULT 0,
                retweets INTEGER DEFAULT 0,
                replies INTEGER DEFAULT 0,
                views INTEGER DEFAULT 0,
                created_at TEXT,
                collected_at TEXT DEFAULT (datetime('now','localtime')),
                url TEXT,
                engagement_score REAL DEFAULT 0
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_tweets_author
            ON tweets(author_handle, created_at)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_tweets_score
            ON tweets(engagement_score DESC)
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_tweets_collected
            ON tweets(collected_at)
        """)
    log("DB initialized")


def save_tweets(tweets: list[dict], db_path: Path | None = None) -> int:
    """Save tweets to DB with UPSERT (engagement metrics only increase).
    Returns number of inserted/updated tweets.
    """
    if not tweets:
        return 0
    db = db_path or DB_PATH
    count = 0
    with db_transaction(db) as conn:
        for t in tweets:
            conn.execute(
                """
                INSERT INTO tweets
                    (tweet_id, author_id, author_handle, author_name,
                     text, likes, retweets, replies, views,
                     created_at, url)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(tweet_id) DO UPDATE SET
                    likes = MAX(tweets.likes, excluded.likes),
                    retweets = MAX(tweets.retweets, excluded.retweets),
                    replies = MAX(tweets.replies, excluded.replies),
                    views = MAX(tweets.views, excluded.views),
                    collected_at = datetime('now', 'localtime')
                """,
                (
                    t.get("tweet_id", ""),
                    t.get("author_id", ""),
                    t.get("author_handle", ""),
                    t.get("author_name", ""),
                    t.get("text", ""),
                    t.get("likes", 0),
                    t.get("retweets", 0),
                    t.get("replies", 0),
                    t.get("views", 0),
                    t.get("created_at", ""),
                    t.get("url", ""),
                ),
            )
            count += 1
    log(f"Saved {count} tweets to DB")
    return count


def get_recent_tweets(hours: int = LOOKBACK_HOURS, db_path: Path | None = None) -> list[dict]:
    """Get all tweets from the last N hours."""
    db = db_path or DB_PATH
    with db_connection(db) as conn:
        rows = conn.execute(
            """
            SELECT tweet_id, author_id, author_handle, author_name,
                   text, likes, retweets, replies, views,
                   created_at, url, engagement_score, collected_at
            FROM tweets
            WHERE collected_at >= datetime('now', 'localtime', ?)
            ORDER BY collected_at DESC
            """,
            (f"-{hours} hours",),
        ).fetchall()
    cols = [
        "tweet_id", "author_id", "author_handle", "author_name",
        "text", "likes", "retweets", "replies", "views",
        "created_at", "url", "engagement_score", "collected_at",
    ]
    return [dict(zip(cols, row)) for row in rows]


def update_scores(scores: dict[str, float], db_path: Path | None = None) -> None:
    """Batch update engagement scores by tweet_id."""
    if not scores:
        return
    db = db_path or DB_PATH
    with db_transaction(db) as conn:
        for tweet_id, score in scores.items():
            conn.execute(
                "UPDATE tweets SET engagement_score = ? WHERE tweet_id = ?",
                (score, tweet_id),
            )
    log(f"Updated {len(scores)} scores")


def cleanup_old_tweets(days: int = RETENTION_DAYS, db_path: Path | None = None) -> int:
    """Remove tweets older than N days. Returns count deleted."""
    db = db_path or DB_PATH
    with db_transaction(db) as conn:
        cur = conn.execute(
            "DELETE FROM tweets WHERE collected_at < datetime('now', 'localtime', ?)",
            (f"-{days} days",),
        )
        if cur.rowcount > 0:
            log(f"Cleaned up {cur.rowcount} tweets older than {days} days")
        return cur.rowcount


def get_account_stats(db_path: Path | None = None) -> list[dict]:
    """Get per-account statistics."""
    db = db_path or DB_PATH
    with db_connection(db) as conn:
        rows = conn.execute(
            """
            SELECT author_handle, author_name,
                   COUNT(*) as tweet_count,
                   AVG(likes) as avg_likes,
                   MAX(likes) as max_likes,
                   AVG(engagement_score) as avg_score
            FROM tweets
            GROUP BY author_handle
            ORDER BY avg_score DESC
            """
        ).fetchall()
    cols = ["author_handle", "author_name", "tweet_count", "avg_likes", "max_likes", "avg_score"]
    return [dict(zip(cols, row)) for row in rows]


# ── Scoring ───────────────────────────────────────────────────────────────────

def compute_engagement_score(
    likes: int,
    retweets: int,
    replies: int,
    views: int,
    age_hours: float,
) -> float:
    """Compute engagement score with recency decay.

    Weights: likes=1, retweets=5, replies=2.
    Recency: 12h half-life decay.
    """
    raw = likes + (retweets * 5) + (replies * 2)
    recency = 1.0 / (1.0 + age_hours / 12.0)
    return raw * recency


def rank_tweets(
    hours: int = LOOKBACK_HOURS,
    limit: int = TOP_N,
    db_path: Path | None = None,
) -> list[dict]:
    """Score and rank recent tweets. Returns top N by engagement."""
    tweets = get_recent_tweets(hours, db_path=db_path)
    if not tweets:
        return []

    now = datetime.now(timezone.utc)
    scored: list[tuple[float, dict]] = []

    for t in tweets:
        age_hours = 0.0
        if t.get("created_at"):
            try:
                created = datetime.fromisoformat(
                    t["created_at"].replace("Z", "+00:00")
                )
                if created.tzinfo is None:
                    created = created.replace(tzinfo=timezone.utc)
                age_hours = max(0, (now - created).total_seconds() / 3600)
            except (ValueError, TypeError):
                age_hours = 12.0
        else:
            age_hours = 12.0

        score = compute_engagement_score(
            t.get("likes", 0),
            t.get("retweets", 0),
            t.get("replies", 0),
            t.get("views", 0),
            age_hours,
        )
        t["engagement_score"] = score
        scored.append((score, t))

    scored.sort(key=lambda x: x[0], reverse=True)

    # Update scores in DB
    score_map = {t["tweet_id"]: s for s, t in scored if t.get("tweet_id")}
    if score_map:
        update_scores(score_map, db_path=db_path)

    return [t for _, t in scored[:limit]]


# ── LLM Analysis ─────────────────────────────────────────────────────────────

def analyze_tweets(tweets: list[dict]) -> dict:
    """Batch LLM analysis → sentiment, keywords, stocks, sectors, summary.

    Single LLM call for all tweets. Graceful degradation on failure.
    """
    empty: dict[str, Any] = {
        "sentiment": 0,
        "sentiment_label": "",
        "keywords": [],
        "stocks": [],
        "sectors": [],
        "summary": "",
    }
    if not tweets:
        return empty

    lines: list[str] = []
    for i, t in enumerate(tweets[:LLM_BATCH_SIZE], 1):
        text = _truncate(_clean_tweet_text(t.get("text", "")), 200)
        handle = t.get("author_handle", "")
        likes = _format_count(t.get("likes", 0))
        rt = t.get("retweets", 0)
        lines.append(f"{i}. @{handle}: {text} (likes={likes}, RT={rt})")

    combined = "\n".join(lines)
    messages = [
        {
            "role": "system",
            "content": (
                "X/Twitter 투자/경제 트윗 목록을 분석하라.\n\n"
                "출력 형식 (JSON만, 설명 없이):\n"
                "{\n"
                '  "sentiment": 0,\n'
                '  "sentiment_label": "중립",\n'
                '  "keywords": [{"word": "키워드", "count": 5}, ...],\n'
                '  "stocks": [{"name": "종목명", "score": 50}, ...],\n'
                '  "sectors": [\n'
                '    {"name": "반도체", "sentiment": 30, "summary": "1줄 요약", "count": 5},\n'
                "    ...\n"
                "  ],\n"
                '  "summary": "2-3문장 종합 요약"\n'
                "}\n\n"
                "규칙:\n"
                "- sentiment: -100(극도 부정) ~ +100(극도 긍정) 정수\n"
                "- sentiment_label: 극도 부정/부정/약간 부정/중립/약간 긍정/긍정/극도 긍정\n"
                "- keywords: 상위 5-10개, 투자/경제 핵심 키워드 + 빈도수\n"
                "- stocks: 언급된 종목명 + 감성점수(-100~+100), 최대 10개\n"
                "- sectors: 관련 섹터별 그룹핑. 섹터별 감성(-100~100), 1줄 요약, 해당 트윗 수\n"
                "- summary: 전체 시장 분위기 2-3줄 한국어 요약"
            ),
        },
        {
            "role": "user",
            "content": f"트윗 {len(tweets[:LLM_BATCH_SIZE])}개:\n\n{combined}",
        },
    ]

    content, model, err = llm_chat_direct(
        messages, LLM_MODELS, temperature=0.2, max_tokens=1500, timeout=60
    )
    if err or not content:
        log(f"LLM analysis failed: {err}", level="WARN")
        return empty

    # Parse JSON from response
    try:
        # Try to extract JSON from markdown code blocks
        json_match = re.search(r"```(?:json)?\s*\n?(.*?)```", content, re.DOTALL)
        if json_match:
            content = json_match.group(1).strip()
        result = json.loads(content)
        if isinstance(result, dict):
            for key in empty:
                if key not in result:
                    result[key] = empty[key]
            return result
    except json.JSONDecodeError:
        log(f"LLM returned invalid JSON: {content[:200]}", level="WARN")

    return empty


# ── Report Formatting ─────────────────────────────────────────────────────────

def format_report(
    top_tweets: list[dict],
    analysis: dict,
    total_accounts: int,
    total_tweets: int,
) -> str:
    """Format the report with sector grouping."""
    now = datetime.now(KST).strftime("%Y-%m-%d %H:%M KST")
    sentiment = analysis.get("sentiment", 0)
    sentiment_label = analysis.get("sentiment_label", "")
    sign = "+" if sentiment > 0 else ""

    parts: list[str] = [
        "*X/Twitter 트윗 리포트*",
        "\u2501" * 16,
        now,
        "",
        f"수집: {total_accounts}명 | {total_tweets}개 트윗",
        f"종합 감성: {sign}{sentiment} ({sentiment_label})",
    ]

    # Keywords
    keywords = analysis.get("keywords", [])
    if keywords:
        parts.append("")
        parts.append("*주요 키워드*")
        kw_items: list[str] = []
        for kw in keywords[:10]:
            if isinstance(kw, dict):
                kw_items.append(f"{kw.get('word', '')} ({kw.get('count', 0)})")
            elif isinstance(kw, str):
                kw_items.append(kw)
        parts.append(" \u00b7 ".join(kw_items))

    # Stocks
    stocks = analysis.get("stocks", [])
    if stocks:
        parts.append("")
        parts.append("*주목 종목*")
        stock_items: list[str] = []
        for s in stocks[:10]:
            if isinstance(s, dict):
                name = s.get("name", "")
                score = s.get("score", 0)
                s_sign = "+" if score > 0 else ""
                stock_items.append(f"{name} {s_sign}{score}")
        parts.append(" \u00b7 ".join(stock_items))

    # Sectors
    sectors = analysis.get("sectors", [])
    if sectors:
        parts.append("")
        parts.append("\u2500 \u2500 \u2500 \u2500 \u2500 \u2500 \u2500 \u2500")
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
                    parts.append(f"  \u2514 {sec_summary}")

    # Top tweets
    n = min(TOP_N, len(top_tweets))
    if n > 0:
        parts.append("")
        parts.append("\u2500 \u2500 \u2500 \u2500 \u2500 \u2500 \u2500 \u2500")
        parts.append(f"*TOP {n} 인기 트윗*")
        for i, t in enumerate(top_tweets[:TOP_N], 1):
            handle = t.get("author_handle", "")
            title = _first_line(_clean_tweet_text(t.get("text", "")))
            likes = _format_count(t.get("likes", 0))
            rt = t.get("retweets", 0)
            url = t.get("url", "")
            entry = f"{i}. @{handle} \u2014 {title}"
            metrics = f"   {likes} likes"
            if rt > 0:
                metrics += f" \u00b7 {rt} RT"
            if url:
                metrics += f"\n   {url}"
            parts.append(entry)
            parts.append(metrics)

    # Summary
    summary = analysis.get("summary", "")
    if summary:
        parts.append("")
        parts.append("\u2500 \u2500 \u2500 \u2500 \u2500 \u2500 \u2500 \u2500")
        parts.append("*종합 요약*")
        parts.append(summary)

    return "\n".join(parts)


def format_dm_summary(
    analysis: dict,
    total_accounts: int,
    total_tweets: int,
) -> str:
    """Short DM summary (under 500 chars)."""
    now = datetime.now(KST).strftime("%m/%d %H:%M")
    sentiment = analysis.get("sentiment", 0)
    sign = "+" if sentiment > 0 else ""
    label = analysis.get("sentiment_label", "")

    parts: list[str] = [
        f"X 리포트 {now}",
        f"{total_accounts}명 | {total_tweets}건 | 감성 {sign}{sentiment} ({label})",
    ]

    kws = analysis.get("keywords", [])[:5]
    if kws:
        kw_str = " \u00b7 ".join(
            k.get("word", k) if isinstance(k, dict) else str(k) for k in kws
        )
        parts.append(f"키워드: {kw_str}")

    stocks = analysis.get("stocks", [])[:5]
    if stocks:
        stock_items: list[str] = []
        for s in stocks:
            if isinstance(s, dict):
                name = s.get("name", "")
                score = s.get("score", 0)
                s_sign = "+" if score > 0 else ""
                stock_items.append(f"{name} {s_sign}{score}")
        if stock_items:
            stock_str = " \u00b7 ".join(stock_items)
            parts.append(f"종목: {stock_str}")

    sectors = analysis.get("sectors", [])[:5]
    if sectors:
        sec_items: list[str] = []
        for s in sectors:
            if isinstance(s, dict):
                sn = s.get("name", "")
                ss = s.get("sentiment", 0)
                s_sign = "+" if ss > 0 else ""
                sec_items.append(f"{sn}({s_sign}{ss})")
        if sec_items:
            sec_str = " \u00b7 ".join(sec_items)
            parts.append(f"섹터: {sec_str}")

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


# ── Report Persistence ────────────────────────────────────────────────────────

def save_report(report_text: str) -> None:
    """Archive report to file."""
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    filename = datetime.now(KST).strftime("report-%Y-%m-%d-%H%M.md")
    path = REPORTS_DIR / filename
    path.write_text(report_text, encoding="utf-8")
    log(f"Report saved: {path}")


def cleanup_old_reports(days: int = REPORT_RETENTION_DAYS) -> None:
    """Remove reports older than N days."""
    if not REPORTS_DIR.exists():
        return
    cutoff = datetime.now() - timedelta(days=days)
    for f in REPORTS_DIR.iterdir():
        if f.is_file() and f.stat().st_mtime < cutoff.timestamp():
            f.unlink()
            log(f"Removed old report: {f.name}")


# ── State Management ─────────────────────────────────────────────────────────

def load_state() -> dict:
    """Load pipeline state from JSON file."""
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def save_state(state: dict) -> None:
    """Save pipeline state to JSON file."""
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(STATE_FILE)


def _maybe_sync_following(cookies: dict | None = None) -> bool:
    """Sync following list if stale (>24h since last sync).

    Returns True if sync succeeded, False otherwise.
    """
    state = load_state()
    last_sync = state.get("last_following_sync", "")

    if last_sync:
        try:
            last_dt = datetime.fromisoformat(last_sync)
            if datetime.now(KST) - last_dt < timedelta(hours=24):
                return True  # Still fresh
        except (ValueError, TypeError):
            pass

    try:
        existing = load_accounts()
        fresh = asyncio.run(fetch_following(cookies))
        if fresh:
            merged, added, removed = sync_accounts(fresh, existing)
            save_accounts(merged)
            state["last_following_sync"] = datetime.now(KST).isoformat()
            save_state(state)
            log(f"Following synced: {len(merged)} accounts (+{added} -{removed})")
            return True
    except Exception as e:
        log(f"Following sync failed: {e}", level="WARN")

    return False


# ── Pipeline ──────────────────────────────────────────────────────────────────

def run_pipeline(
    notify: bool = False,
    dry_run: bool = False,
    limit: int = 0,
    sync_following: bool = False,
) -> bool:
    """Run the full pipeline: collect → score → analyze → report → send."""
    log("=" * 50)
    log("Starting Twitter collector pipeline")

    init_db()
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)

    # Optional following sync
    if sync_following:
        _maybe_sync_following()

    # Load accounts
    accounts = load_accounts()
    if not accounts:
        log("No accounts to collect from. Run --fetch-following first.", level="ERROR")
        return False

    if limit > 0:
        accounts = accounts[:limit]
    total_accounts = len(accounts)
    log(f"Collecting from {total_accounts} accounts")

    # Collect tweets
    try:
        cookies = load_cookies()
    except RuntimeError as e:
        log(f"Cookie error: {e}", level="ERROR")
        return False

    tweets = asyncio.run(collect_tweets(accounts, cookies))
    if not tweets:
        log("No tweets collected")
        return False

    # Save to DB
    saved = save_tweets(tweets)
    total_tweets = len(tweets)

    # Score and rank
    top_tweets = rank_tweets(LOOKBACK_HOURS, LLM_BATCH_SIZE)

    # LLM analysis
    analysis = analyze_tweets(top_tweets)

    # Get top N for display
    display_tweets = top_tweets[:TOP_N]

    # Format report
    report = format_report(display_tweets, analysis, total_accounts, total_tweets)

    # Save report
    save_report(report)

    # Cleanup old data
    cleanup_old_tweets()
    cleanup_old_reports()

    # Update state
    state = load_state()
    state["last_run"] = datetime.now(KST).isoformat()
    state["last_tweet_count"] = total_tweets
    state["last_account_count"] = total_accounts
    save_state(state)

    if dry_run:
        print(report)
        log("Dry run complete")
        return True

    if notify:
        ok = notify_telegram(report)
        if ok:
            log("Report sent to Telegram")
        else:
            log("Telegram send had errors", level="WARN")
        return ok

    print(report)
    log("Pipeline complete")
    return True


# ── CLI ───────────────────────────────────────────────────────────────────────

def print_stats() -> None:
    """Print account statistics."""
    init_db()
    stats = get_account_stats()
    if not stats:
        print("No data yet. Run the pipeline first.")
        return

    print(
        f"\n{'Handle':<25} {'Name':<20} {'Tweets':>7} "
        f"{'Avg Likes':>10} {'Max Likes':>10} {'Avg Score':>10}"
    )
    print("-" * 90)
    for s in stats:
        handle = f"@{s.get('author_handle', '?')}"
        name = _truncate(s.get("author_name") or "", 19)
        print(
            f"{handle:<25} {name:<20} {s['tweet_count']:>7} "
            f"{s['avg_likes']:>10.0f} {s['max_likes']:>10} {s['avg_score']:>10.1f}"
        )


def main() -> None:
    ap = argparse.ArgumentParser(description="X/Twitter 트윗 수집 리포트 파이프라인")
    ap.add_argument("--notify", action="store_true", help="텔레그램 전송 (DM + 론 토픽)")
    ap.add_argument("--dry-run", action="store_true", help="수집+분석 후 stdout 출력 (전송 안 함)")
    ap.add_argument("--stats", action="store_true", help="계정별 통계 출력")
    ap.add_argument("--limit", type=int, default=0, help="계정 수 제한 (0=전체)")
    ap.add_argument(
        "--fetch-following",
        action="store_true",
        help="X 팔로잉 목록을 accounts.json에 저장 (최초 1회)",
    )
    ap.add_argument(
        "--sync-following",
        action="store_true",
        help="크론 실행 시 팔로잉 목록 자동 갱신 (24h 간격)",
    )
    args = ap.parse_args()

    if args.stats:
        print_stats()
        return

    if args.fetch_following:
        try:
            cookies = load_cookies()
            users = asyncio.run(fetch_following(cookies))
            if users:
                existing = load_accounts() if ACCOUNTS_FILE.exists() else []
                merged, added, removed = sync_accounts(users, existing)
                save_accounts(merged)
                print(f"Saved {len(merged)} accounts (+{added} new, -{removed} removed)")
                state = load_state()
                state["last_following_sync"] = datetime.now(KST).isoformat()
                save_state(state)
            else:
                print("No followings found")
        except Exception as e:
            print(f"Error: {e}")
            sys.exit(1)
        return

    ok = run_pipeline(
        notify=args.notify,
        dry_run=args.dry_run,
        limit=args.limit,
        sync_following=args.sync_following,
    )
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
