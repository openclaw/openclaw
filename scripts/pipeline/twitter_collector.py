# Source Generated with Decompyle++
# File: twitter_collector.cpython-39.pyc (Python 3.9)

'''twitter_collector.py — X/Twitter 트윗 수집 리포트 파이프라인.

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
'''
from __future__ import annotations
import argparse
import asyncio
import json
import os
import sqlite3
import sys
import time
import urllib.error as urllib
import urllib.request as urllib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.db import db_connection, db_transaction
from shared.llm import llm_chat_with_fallback
from shared.log import make_logger
BOT_TOKEN = '8554125313:AAGC5Zzb9nCbPYgmOVqs3pVn-qzIA2oOtkI'
DM_CHAT_ID = '492860021'
GROUP_CHAT_ID = '-1003076685086'
RON_TOPIC_ID = 30413
DB_PATH = Path(os.path.expanduser('~/.openclaw/data/ops_multiagent.db'))
WORKSPACE = Path(os.path.expanduser('~/.openclaw/workspace'))
MEMORY_DIR = WORKSPACE / 'memory' / 'twitter-collector'
ACCOUNTS_FILE = MEMORY_DIR / 'accounts.json'
STATE_FILE = MEMORY_DIR / 'state.json'
REPORTS_DIR = MEMORY_DIR / 'reports'
COOKIE_CACHE = MEMORY_DIR / 'cookies_cache.json'
LOG_FILE = WORKSPACE / 'logs' / 'twitter_collector.log'
REQUEST_DELAY = 3
LOOKBACK_HOURS = 24
TWEETS_PER_ACCOUNT = 20
LLM_MODELS = [
    'gpt-5-mini',
    'qwen3:8b']
RETENTION_DAYS = 30
REPORT_RETENTION_DAYS = 90
TOP_N = 10
LLM_BATCH_SIZE = 30
KST = timezone(timedelta(9, **('hours',)))
log = make_logger(str(LOG_FILE), **('log_file',))

def _truncate(text = None, max_len = None):
    if len(text) <= max_len:
        return text
    return None[:max_len - 1] + '…'


def _format_count(n = None):
    if n >= 1000000:
        return f'''{n / 1000000:.1f}M'''
    if None >= 1000:
        return f'''{n / 1000:.1f}K'''
    return any(  # FIXME: check if any/all/sum
n)


def _first_line(text = None, max_len = None):
    if not text:
        return '(내용 없음)'
    line = None.split('\n')[0].strip()
    line = line.lstrip('#☞▶️ ')
    if not line:
        parts = text.split('\n')
        line = parts[1].strip() if len(parts) > 1 else text[:max_len].strip()
    return _truncate(line, max_len)


def _clean_tweet_text(text = None):
    '''Remove t.co URLs from tweet text for cleaner display.'''
    import re
    return re.sub('https?://t\\.co/\\S+', '', text).strip()


def load_cookies():
    '''Extract X.com cookies from Chrome. Falls back to cache file.'''
    pass
# WARNING: Decompyle incomplete


def load_accounts(path = None):
    '''Load account list from JSON file.'''
    if not path:
        pass
    path = ACCOUNTS_FILE
    if not path.exists():
        log(f'''Accounts file not found: {path}''', 'ERROR', **('level',))
        return []
    with open(path, 'r', 'utf-8', **('encoding',)) as f:
        data = json.load(f)
        any(  # FIXME: check if any/all/sum
None, None, None)
# WARNING: Decompyle incomplete


def save_accounts(accounts = None, path = None):
    '''Save account list to JSON file.'''
    if not path:
        pass
    path = ACCOUNTS_FILE
    path.parent.mkdir(True, True, **('parents', 'exist_ok'))
    data = {
        'version': '1.0',
        'description': 'X/Twitter 팔로잉 수집 대상 계정 목록',
        'my_user_id': '393527902',
        'accounts': accounts }
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, 2, False, **('indent', 'ensure_ascii')), 'utf-8', **('encoding',))
    tmp.replace(path)
    log(f'''Saved {len(accounts)} accounts to {path}''')


async def fetch_following(cookies = None):
    '''Fetch following list from X using twikit.'''
    import twikit
    if cookies is None:
        cookies = load_cookies()
    client = twikit.Client('ko')
    client.set_cookies(cookies)
    my_id = '393527902'
# WARNING: Decompyle incomplete


def sync_accounts(fresh = None, existing = None):
    '''Merge fresh following list with existing accounts.

    - New followings are added.
    - Unfollowed accounts are removed.
    - Returns (merged_list, added_count, removed_count).
    '''
    # FIXME-SYNTAX: existing_ids = (lambda .0: pass# WARNING: Decompyle incomplete
# FIXME-SYNTAX: )(existing)
    # FIXME-SYNTAX: fresh_ids = (lambda .0: pass# WARNING: Decompyle incomplete
# FIXME-SYNTAX: )(fresh)
    fresh_by_id = { }
    for a in fresh:
        if not a.get('id'):
            pass
        key = a.get('handle')
        fresh_by_id[key] = a
    merged = []
    for a in fresh:
        if not a.get('id'):
            pass
        key = a.get('handle')
        merged.append(a)
    added = fresh_ids - existing_ids
    removed = existing_ids - fresh_ids
    if added:
        log(f'''New followings: {len(added)}''')
    if removed:
        log(f'''Unfollowed: {len(removed)}''')
    return (merged, len(added), len(removed))


def _normalize_tweet(tweet = None, handle = None, name = None):
    '''Normalize a twikit Tweet object to a flat dict.'''
    pass
# WARNING: Decompyle incomplete


async def collect_tweets(accounts = None, cookies = None, lookback_hours = None, tweets_per_account = (None, LOOKBACK_HOURS, TWEETS_PER_ACCOUNT, REQUEST_DELAY), delay = {
    'accounts': 'list[dict]',
    'cookies': 'dict | None',
    'lookback_hours': 'int',
    'tweets_per_account': 'int',
    'delay': 'float',
    'return': 'list[dict]' }):
    """Collect tweets from accounts using twikit async API.

    Error isolation: one account failure doesn't stop others.
    """
    import twikit
    if cookies is None:
        cookies = load_cookies()
    client = twikit.Client('ko')
    client.set_cookies(cookies)
    cutoff = datetime.now(timezone.utc) - timedelta(lookback_hours, **('hours',))
    all_tweets = []
    success_count = 0
    fail_count = 0
# WARNING: Decompyle incomplete


def init_db(db_path = None):
    '''Initialize tweets table and indices.'''
    if not db_path:
        pass
    db = DB_PATH
    with db_transaction(db) as conn:
        conn.execute("\n            CREATE TABLE IF NOT EXISTS tweets (\n                id INTEGER PRIMARY KEY AUTOINCREMENT,\n                tweet_id TEXT NOT NULL UNIQUE,\n                author_id TEXT NOT NULL,\n                author_handle TEXT NOT NULL,\n                author_name TEXT,\n                text TEXT,\n                likes INTEGER DEFAULT 0,\n                retweets INTEGER DEFAULT 0,\n                replies INTEGER DEFAULT 0,\n                views INTEGER DEFAULT 0,\n                created_at TEXT,\n                collected_at TEXT DEFAULT (datetime('now','localtime')),\n                url TEXT,\n                engagement_score REAL DEFAULT 0\n            )\n        ")
        conn.execute('\n            CREATE INDEX IF NOT EXISTS idx_tweets_author\n            ON tweets(author_handle, created_at)\n        ')
        conn.execute('\n            CREATE INDEX IF NOT EXISTS idx_tweets_score\n            ON tweets(engagement_score DESC)\n        ')
        conn.execute('\n            CREATE INDEX IF NOT EXISTS idx_tweets_collected\n            ON tweets(collected_at)\n        ')
        any(  # FIXME: check if any/all/sum
None, None, None)
# WARNING: Decompyle incomplete


def save_tweets(tweets = None, db_path = None):
    '''Save tweets to DB with UPSERT (engagement metrics only increase).'''
    if not tweets:
        return None
    if not None:
        pass
    db = DB_PATH
    with db_transaction(db) as conn:
        for t in tweets:
            conn.execute("\n                INSERT INTO tweets\n                    (tweet_id, author_id, author_handle, author_name,\n                     text, likes, retweets, replies, views,\n                     created_at, url)\n                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\n                ON CONFLICT(tweet_id) DO UPDATE SET\n                    likes = MAX(tweets.likes, excluded.likes),\n                    retweets = MAX(tweets.retweets, excluded.retweets),\n                    replies = MAX(tweets.replies, excluded.replies),\n                    views = MAX(tweets.views, excluded.views),\n                    collected_at = datetime('now', 'localtime')\n            ", (t.get('tweet_id', ''), t.get('author_id', ''), t.get('author_handle', ''), t.get('author_name', ''), t.get('text', ''), t.get('likes', 0), t.get('retweets', 0), t.get('replies', 0), t.get('views', 0), t.get('created_at', ''), t.get('url', '')))
        any(  # FIXME: check if any/all/sum
None, None, None)
# WARNING: Decompyle incomplete


def get_recent_tweets(hours = None, db_path = None):
    '''Get all tweets from the last N hours.'''
    if not db_path:
        pass
    db = DB_PATH
# WARNING: Decompyle incomplete


def update_scores(scores = None, db_path = None):
    '''Batch update engagement scores by tweet_id.'''
    if not scores:
        return None
    if not None:
        pass
    db = DB_PATH
    with db_transaction(db) as conn:
        for tweet_id, score in scores.items():
            conn.execute('\n                UPDATE tweets SET engagement_score = ?\n                WHERE tweet_id = ?\n            ', (score, tweet_id))
        any(  # FIXME: check if any/all/sum
None, None, None)
# WARNING: Decompyle incomplete


def cleanup_old_tweets(days = None, db_path = None):
    '''Remove tweets older than N days.'''
    if not db_path:
        pass
    db = DB_PATH
    with db_transaction(db) as conn:
        cur = conn.execute("\n            DELETE FROM tweets\n            WHERE collected_at < datetime('now', 'localtime', ?)\n        ", (f'''-{days} days''',))
        if cur.rowcount > 0:
            log(f'''Cleaned up {cur.rowcount} tweets older than {days} days''')
        any(  # FIXME: check if any/all/sum
None, None, None)
# WARNING: Decompyle incomplete


def get_account_stats(db_path = None):
    '''Get per-account statistics.'''
    if not db_path:
        pass
    db = DB_PATH
# WARNING: Decompyle incomplete


def compute_engagement_score(likes, retweets = None, replies = None, views = None, age_hours = {
    'likes': 'int',
    'retweets': 'int',
    'replies': 'int',
    'views': 'int',
    'age_hours': 'float',
    'return': 'float' }):
    '''Compute engagement score with recency decay.

    Weights: likes=1, retweets=5, replies=2.
    Recency: 12h half-life decay.
    '''
    raw = likes + retweets * 5 + replies * 2
    recency = 1 / (1 + age_hours / 12)
    return raw * recency


def rank_tweets(hours = None, limit = None, db_path = None):
    '''Score and rank recent tweets. Returns top N by engagement.'''
    tweets = get_recent_tweets(hours, db_path, **('db_path',))
    if not tweets:
        return []
    now = None.now(timezone.utc)
    scored = []
# WARNING: Decompyle incomplete


def analyze_tweets(tweets = None):
    '''Batch LLM analysis → sentiment, keywords, stocks, sectors, summary.

    Single LLM call for all tweets. Graceful degradation on failure.
    '''
    empty = {
        'sentiment': 0,
        'sentiment_label': '',
        'keywords': [],
        'stocks': [],
        'sectors': [],
        'summary': '' }
    if not tweets:
        return empty
    lines = None
    for i, t in enumerate(tweets[:LLM_BATCH_SIZE], 1):
        text = _truncate(_clean_tweet_text(t.get('text', '')), 200)
        handle = t.get('author_handle', '')
        likes = _format_count(t.get('likes', 0))
        rt = t.get('retweets', 0)
        lines.append(f'''{i}. @{handle}: {text} (likes={likes}, RT={rt})''')
    combined = '\n'.join(lines)
    messages = [
        {
            'role': 'system',
            'content': 'X/Twitter 투자/경제 트윗 목록을 분석하라.\n\n출력 형식 (JSON만, 설명 없이):\n{\n  "sentiment": 0,\n  "sentiment_label": "중립",\n  "keywords": [{"word": "키워드", "count": 5}, ...],\n  "stocks": [{"name": "종목명", "score": 50}, ...],\n  "sectors": [\n    {"name": "반도체", "sentiment": 30, "summary": "1줄 요약", "count": 5},\n    ...\n  ],\n  "summary": "2-3문장 종합 요약"\n}\n\n규칙:\n- sentiment: -100(극도 부정) ~ +100(극도 긍정) 정수\n- sentiment_label: 극도 부정/부정/약간 부정/중립/약간 긍정/긍정/극도 긍정\n- keywords: 상위 5-10개, 투자/경제 핵심 키워드 + 빈도수\n- stocks: 언급된 종목명 + 감성점수(-100~+100), 최대 10개\n- sectors: 관련 섹터별 그룹핑 (반도체/조선/에너지/AI/금융/부동산/바이오/자동차/소비재/정치경제 등). 섹터별 감성(-100~100), 1줄 요약, 해당 트윗 수\n- summary: 전체 시장 분위기 2-3줄 한국어 요약' },
        {
            'role': 'user',
            'content': f'''트윗 {len(tweets)}개:\n\n{combined}''' }]
    (content, model, err) = llm_chat_with_fallback(messages, LLM_MODELS, 0.2, 1500, 60, **('temperature', 'max_tokens', 'timeout'))
# WARNING: Decompyle incomplete


def format_report(top_tweets = None, analysis = None, total_accounts = None, total_tweets = {
    'top_tweets': 'list[dict]',
    'analysis': 'dict',
    'total_accounts': 'int',
    'total_tweets': 'int',
    'return': 'str' }):
    '''Format the report with sector grouping.'''
    now = datetime.now(KST).strftime('%Y-%m-%d %H:%M KST')
    sentiment = analysis.get('sentiment', 0)
    sentiment_label = analysis.get('sentiment_label', '')
    sign = '+' if sentiment > 0 else ''
    parts = [
        '*X/Twitter 트윗 리포트*',
        '━━━━━━━━━━━━━━━━',
        now,
        '',
        f'''수집: {total_accounts}명 | {total_tweets}개 트윗''',
        f'''종합 감성: {sign}{sentiment} ({sentiment_label})''']
    keywords = analysis.get('keywords', [])
    if keywords:
        parts.append('')
        parts.append('*주요 키워드*')
        kw_items = []
        for kw in keywords[:10]:
            if isinstance(kw, dict):
                kw_items.append(f'''{kw.get('word', '')} ({kw.get('count', 0)})''')
                continue
            if isinstance(kw, str):
                kw_items.append(kw)
                continue
                parts.append(' · '.join(kw_items))
                stocks = analysis.get('stocks', [])
                if stocks:
                    parts.append('')
                    parts.append('*주목 종목*')
                    stock_items = []
                    for s in stocks[:10]:
                        if isinstance(s, dict):
                            name = s.get('name', '')
                            score = s.get('score', 0)
                        s_sign = '+' if score > 0 else ''
                        stock_items.append(f'''{name} {s_sign}{score}''')
                    parts.append(' · '.join(stock_items))
    sectors = analysis.get('sectors', [])
    if sectors:
        parts.append('')
        parts.append('─ ─ ─ ─ ─ ─ ─ ─')
        parts.append('*섹터별 동향*')
        for sec in sectors:
            if isinstance(sec, dict):
                sec_name = sec.get('name', '')
                sec_sent = sec.get('sentiment', 0)
                sec_summary = sec.get('summary', '')
                sec_count = sec.get('count', 0)
            s_sign = '+' if sec_sent > 0 else ''
            parts.append(f'''  {sec_name} ({s_sign}{sec_sent}, {sec_count}건)''')
            if sec_summary:
                parts.append(f'''  └ {sec_summary}''')
                continue
                n = min(TOP_N, len(top_tweets))
                parts.append('')
                parts.append('─ ─ ─ ─ ─ ─ ─ ─')
                parts.append(f'''*TOP {n} 인기 트윗*''')
                for i, t in enumerate(top_tweets[:TOP_N], 1):
                    handle = t.get('author_handle', '')
                    title = _first_line(_clean_tweet_text(t.get('text', '')))
                    likes = _format_count(t.get('likes', 0))
                    rt = t.get('retweets', 0)
                    url = t.get('url', '')
                    entry = f'''{i}. @{handle} — {title}'''
                    metrics = f'''   {likes} likes'''
                    if rt > 0:
                        metrics += f''' · {rt} RT'''
                    if url:
                        metrics += f'''\n   {url}'''
                    parts.append(entry)
                    parts.append(metrics)
                summary = analysis.get('summary', '')
                if summary:
                    parts.append('')
                    parts.append('─ ─ ─ ─ ─ ─ ─ ─')
                    parts.append('*종합 요약*')
                    parts.append(summary)
    return '\n'.join(parts)


def format_dm_summary(analysis = None, total_accounts = None, total_tweets = None):
    '''Short DM summary (under 500 chars).'''
    now = datetime.now(KST).strftime('%m/%d %H:%M')
    sentiment = analysis.get('sentiment', 0)
    sign = '+' if sentiment > 0 else ''
    label = analysis.get('sentiment_label', '')
    parts = [
        f'''X 리포트 {now}''',
        f'''{total_accounts}명 | {total_tweets}건 | 감성 {sign}{sentiment} ({label})''']
    kws = analysis.get('keywords', [])[:5]
    if kws:
        kw_str = ' · '.join(k.get('word', k) if isinstance(k, dict) else str(k) for k in kws)
        parts.append(f'''키워드: {kw_str}''')
    stocks = analysis.get('stocks', [])[:5]
    if stocks:
        stock_str = ' · '.join(f'''{s.get('name', '')} {'+' if isinstance(s, dict) or s.get('score', 0) > 0 else ''}{s.get('score', 0)}''' for s in stocks)
        parts.append(f'''종목: {stock_str}''')
    sectors = analysis.get('sectors', [])[:5]
    if sectors:
        sec_str = ' · '.join(f'''{s.get('name', '')}({'+' if isinstance(s, dict) or s.get('sentiment', 0) > 0 else ''}{s.get('sentiment', 0)})''' for s in sectors)
        parts.append(f'''섹터: {sec_str}''')
    return '\n'.join(parts)


def _send_telegram_text(text = None, chat_id = None, message_thread_id = None):
    '''Send text via Bot API directly.'''
    url = f'''https://api.telegram.org/bot{BOT_TOKEN}/sendMessage'''
    payload = {
        'chat_id': chat_id,
        'text': text,
        'parse_mode': 'Markdown',
        'disable_web_page_preview': True }
    if message_thread_id is not None:
        payload['message_thread_id'] = message_thread_id
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data, {
        'Content-Type': 'application/json' }, **('data', 'headers'))
# WARNING: Decompyle incomplete


def _split_message(text = None, max_len = None):
    '''Split message into chunks respecting line boundaries.'''
    if len(text) <= max_len:
        return [
            text]
    chunks = None
    current = ''
    for line in text.split('\n'):
        if len(line) > max_len:
            if current:
                chunks.append(current)
                current = ''
            if len(line) > max_len:
                chunks.append(line[:max_len])
                line = line[max_len:]
                continue
            if line:
                current = line
                continue
                if len(current) + len(line) + 1 > max_len:
                    if current:
                        chunks.append(current)
                    current = line
                    continue
        current = current + '\n' + line if current else line
    if current:
        chunks.append(current)
    return chunks


def notify_telegram(report_text = None):
    '''Send report to DM and group topic.'''
    chunks = _split_message(report_text)
    all_ok = True
    for chunk in chunks:
        if not _send_telegram_text(chunk, DM_CHAT_ID, None, **('chat_id', 'message_thread_id')):
            log('DM send failed', 'WARN', **('level',))
            all_ok = False
        time.sleep(0.5)
    for chunk in chunks:
        if not _send_telegram_text(chunk, GROUP_CHAT_ID, RON_TOPIC_ID, **('chat_id', 'message_thread_id')):
            log('Group send failed', 'WARN', **('level',))
            all_ok = False
        time.sleep(0.5)
    return all_ok


def save_report(report_text = None):
    '''Archive report to file.'''
    REPORTS_DIR.mkdir(True, True, **('parents', 'exist_ok'))
    filename = datetime.now(KST).strftime('report-%Y-%m-%d-%H%M.md')
    path = REPORTS_DIR / filename
    path.write_text(report_text, 'utf-8', **('encoding',))
    log(f'''Report saved: {path}''')


def cleanup_old_reports(days = None):
    '''Remove reports older than N days.'''
    if not REPORTS_DIR.exists():
        return None
    cutoff = None.now() - timedelta(days, **('days',))
# WARNING: Decompyle incomplete


def load_state():
    pass
# WARNING: Decompyle incomplete


def save_state(state = None):
    MEMORY_DIR.mkdir(True, True, **('parents', 'exist_ok'))
    tmp = STATE_FILE.with_suffix('.tmp')
    tmp.write_text(json.dumps(state, 2, False, **('indent', 'ensure_ascii')), 'utf-8', **('encoding',))
    tmp.replace(STATE_FILE)


def _maybe_sync_following(cookies = None):
    '''Sync following list if stale (>24h since last sync).

    Returns True if sync succeeded, False otherwise.
    '''
    state = load_state()
    last_sync = state.get('last_following_sync', '')
# WARNING: Decompyle incomplete


def run_pipeline(notify = None, dry_run = None, limit = None, sync_following = (False, False, 0, False)):
    '''Run the full pipeline: collect → score → analyze → report → send.'''
    log('==================================================')
    log('Starting Twitter collector pipeline')
    init_db()
    MEMORY_DIR.mkdir(True, True, **('parents', 'exist_ok'))
    REPORTS_DIR.mkdir(True, True, **('parents', 'exist_ok'))
# WARNING: Decompyle incomplete


def print_stats():
    '''Print account statistics.'''
    init_db()
    stats = get_account_stats()
    if not stats:
        print('No data yet. Run the pipeline first.')
        return None
    any(  # FIXME: check if any/all/sum
f'''\n{'Handle':<25} {'Name':<20} {'Tweets':>7} {'Avg Likes':>10} {'Max Likes':>10} {'Avg Score':>10}''')
    print('------------------------------------------------------------------------------------------')
    for s in stats:
        handle = f'''@{s.get('author_handle', '?')}'''
        if not s.get('author_name'):
            pass
        name = _truncate('', 19)
        print(f'''{handle:<25} {name:<20} {s['tweet_count']:>7} {s['avg_likes']:>10.0f} {s['max_likes']:>10} {s['avg_score']:>10.1f}''')


def main():
    ap = argparse.ArgumentParser('X/Twitter 트윗 수집 리포트 파이프라인', **('description',))
    ap.add_argument('--notify', 'store_true', '텔레그램 전송 (DM + 론 토픽)', **('action', 'help'))
    ap.add_argument('--dry-run', 'store_true', '수집+분석 후 stdout 출력 (전송 안 함)', **('action', 'help'))
    ap.add_argument('--stats', 'store_true', '계정별 통계 출력', **('action', 'help'))
    ap.add_argument('--limit', int, 0, '계정 수 제한 (0=전체)', **('type', 'default', 'help'))
    ap.add_argument('--fetch-following', 'store_true', 'X 팔로잉 목록을 accounts.json에 저장 (최초 1회)', **('action', 'help'))
    ap.add_argument('--sync-following', 'store_true', '크론 실행 시 팔로잉 목록 자동 갱신 (24h 간격)', **('action', 'help'))
    args = ap.parse_args()
# WARNING: Decompyle incomplete

if __name__ == '__main__':
    main()
