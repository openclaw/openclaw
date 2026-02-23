#!/usr/bin/env python3
"""External discovery collector for the intelligence engine.

Usage:
    python3 idea_collector.py --source x_accounts      # X.com accounts via RSS
    python3 idea_collector.py --source github           # GitHub search
    python3 idea_collector.py --source telegram_links   # Links from ZK notes
    python3 idea_collector.py --source arxiv            # arXiv papers
    python3 idea_collector.py --source hackernews       # HackerNews stories
    python3 idea_collector.py --all                     # All sources
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
CONFIG_PATH = Path.home() / ".openclaw" / "idea_sources.json"
OUTPUT_DIR = Path.home() / ".openclaw" / "workspace" / "reports" / "ideas"
ZK_NOTES_DIR = Path.home() / ".openclaw" / "workspace" / "knowledge" / "zk" / "notes"

KST = timezone(timedelta(hours=9))


def now_kst() -> datetime:
    return datetime.now(KST)


def today_str() -> str:
    return now_kst().strftime("%Y%m%d")


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
def load_config() -> dict:
    if not CONFIG_PATH.exists():
        print(f"[ERROR] Config not found: {CONFIG_PATH}")
        sys.exit(1)
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Dedup helpers
# ---------------------------------------------------------------------------
def load_recent_urls(output_dir: Path, days: int = 7) -> set[str]:
    """최근 N일간 discoveries에서 URL 세트 로드 (크로스데이 중복 방지)."""
    urls: set[str] = set()
    cutoff = now_kst() - timedelta(days=days)
    cutoff_str = cutoff.strftime("%Y%m%d")
    for jsonl in output_dir.glob("discoveries_*.jsonl"):
        # 파일명에서 날짜 추출
        m = re.search(r"discoveries_(\d{8})\.jsonl$", jsonl.name)
        if m and m.group(1) >= cutoff_str:
            try:
                for line in jsonl.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if not line:
                        continue
                    obj = json.loads(line)
                    if "url" in obj:
                        urls.add(obj["url"])
            except Exception:
                continue
    return urls


def append_discovery(output_path: Path, record: dict, existing_urls: set[str]) -> bool:
    url = record.get("url", "")
    if url in existing_urls:
        return False
    existing_urls.add(url)
    with output_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")
    return True


# ---------------------------------------------------------------------------
# Focus-area keyword matcher
# ---------------------------------------------------------------------------
def match_focus_area(text: str, focus_areas: dict) -> tuple[str, list[str]]:
    """Return (best_focus_area, matched_tags). Falls back to empty string."""
    text_lower = text.lower()
    best = ""
    best_count = 0
    best_tags: list[str] = []
    for area_name, area_cfg in focus_areas.items():
        keywords = area_cfg.get("keywords", [])
        matched = [k for k in keywords if k.lower() in text_lower]
        if len(matched) > best_count:
            best = area_name
            best_count = len(matched)
            best_tags = matched
    return best, best_tags


# ---------------------------------------------------------------------------
# fxtwitter helper
# ---------------------------------------------------------------------------
def _fetch_via_fxtwitter(account: str, base_url: str) -> list[dict]:
    """fxtwitter API로 최근 트윗 가져오기."""
    import urllib.request as _ur
    api_url = f"{base_url.rstrip('/')}/{account}"
    try:
        req = _ur.Request(api_url, headers={
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json",
        })
        with _ur.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        print(f"    fxtwitter failed for @{account}: {e}")
        return []

    tweets_data = data.get("tweets", [])
    if not tweets_data:
        # 일부 엔드포인트는 timeline 형태
        timeline = data.get("timeline", {})
        tweets_data = timeline.get("entries", []) if timeline else []

    entries = []
    for tw in tweets_data[:20]:
        text = tw.get("text", "")
        tweet_url = tw.get("url", "")
        if not tweet_url:
            tweet_id = tw.get("id", "")
            if tweet_id:
                tweet_url = f"https://x.com/{account}/status/{tweet_id}"
        if text:
            entries.append({"text": text, "url": tweet_url, "author": account})
    return entries


# ---------------------------------------------------------------------------
# Source 1: X.com accounts via Nitter RSS
# ---------------------------------------------------------------------------
def collect_x_accounts(config: dict, output_path: Path, existing_urls: set[str]) -> int:
    try:
        import feedparser  # noqa: F811
    except ImportError:
        print("[WARN] feedparser not installed. Run: pip3 install feedparser")
        return 0

    settings = config.get("collection_settings", {})
    nitter_instances = settings.get("x_nitter_instances", ["nitter.net"])
    focus_areas = config.get("focus_areas", {})
    count = 0

    for area_name, area_cfg in focus_areas.items():
        accounts = area_cfg.get("x_accounts", [])
        keywords = [k.lower() for k in area_cfg.get("keywords", [])]
        if not accounts:
            continue

        for account in accounts:
            feed = None
            for instance in nitter_instances:
                feed_url = f"https://{instance}/{account}/rss"
                print(f"  Fetching {feed_url} ...")
                try:
                    parsed = feedparser.parse(feed_url)
                    if parsed.entries:
                        feed = parsed
                        break
                except Exception as e:
                    print(f"    Failed ({instance}): {e}")
                    continue

            if not feed or not feed.entries:
                # fxtwitter 폴백
                fxtwitter_base = settings.get("x_fxtwitter_base", "https://api.fxtwitter.com")
                fx_entries = _fetch_via_fxtwitter(account, fxtwitter_base)
                if not fx_entries:
                    print(f"    No entries for @{account} (Nitter + fxtwitter 모두 실패)")
                    continue

                for fx in fx_entries:
                    combined = f"{fx.get('text', '')}".lower()
                    if not any(kw in combined for kw in keywords):
                        continue
                    # 트윗 텍스트에서 흥미로운 URL 추출
                    urls_in_text = re.findall(r'https?://[^\s<>"\']+', fx.get("text", ""))
                    interesting = [u for u in urls_in_text if any(d in u for d in ("github.com", "arxiv.org"))]
                    link = interesting[0] if interesting else fx.get("url", "")
                    if not link:
                        continue
                    matched_tags = [k for k in area_cfg.get("keywords", []) if k.lower() in combined]
                    record = {
                        "source": "x",
                        "url": link,
                        "title": fx.get("text", "")[:200],
                        "summary": fx.get("text", "")[:500],
                        "focus_area": area_name,
                        "tags": matched_tags[:5],
                        "discovered_at": now_kst().isoformat(),
                    }
                    if append_discovery(output_path, record, existing_urls):
                        count += 1
                        print(f"    + [fxtwitter] {link}")
                continue

            for entry in feed.entries:
                title = entry.get("title", "")
                summary_text = entry.get("summary", title)
                combined = f"{title} {summary_text}".lower()

                # Keyword filter
                if not any(kw in combined for kw in keywords):
                    continue

                # Extract URLs from text
                urls_in_text = re.findall(r'https?://[^\s<>"\']+', summary_text)
                # Prefer github/arxiv links; fallback to tweet link
                interesting = [u for u in urls_in_text if any(d in u for d in ("github.com", "arxiv.org"))]
                link = interesting[0] if interesting else entry.get("link", "")
                if not link:
                    continue

                matched_tags = [k for k in area_cfg.get("keywords", []) if k.lower() in combined]
                record = {
                    "source": "x",
                    "url": link,
                    "title": title[:200],
                    "summary": summary_text[:500],
                    "focus_area": area_name,
                    "tags": matched_tags[:5],
                    "discovered_at": now_kst().isoformat(),
                }
                if append_discovery(output_path, record, existing_urls):
                    count += 1
                    print(f"    + {link}")

    return count


# ---------------------------------------------------------------------------
# Source 2: GitHub search via gh CLI
# ---------------------------------------------------------------------------
def collect_github(config: dict, output_path: Path, existing_urls: set[str]) -> int:
    settings = config.get("collection_settings", {})
    limit = settings.get("github_search_limit", 20)
    focus_areas = config.get("focus_areas", {})
    max_total = settings.get("max_discoveries_per_run", 30)
    count = 0

    # 영역별 최대 수집 제한 — 단일 영역 독점 방지
    num_areas = max(len(focus_areas), 1)
    max_per_area = max(max_total // num_areas, 5)
    area_counts: dict[str, int] = {}

    for area_name, area_cfg in focus_areas.items():
        queries = area_cfg.get("github_queries", [])
        for query in queries:
            if area_counts.get(area_name, 0) >= max_per_area:
                print(f"  [skip] {area_name} 영역 {max_per_area}건 도달, 다음 영역으로")
                break

            print(f"  gh search repos: {query!r} ...")
            try:
                result = subprocess.run(
                    [
                        "gh", "search", "repos", query,
                        "--json", "name,url,description,stargazersCount",
                        "--limit", str(limit),
                    ],
                    capture_output=True, text=True, timeout=30,
                )
                if result.returncode != 0:
                    print(f"    gh error: {result.stderr.strip()[:200]}")
                    continue
                repos = json.loads(result.stdout) if result.stdout.strip() else []
            except FileNotFoundError:
                print("[WARN] gh CLI not found. Install: https://cli.github.com/")
                return count
            except subprocess.TimeoutExpired:
                print("    Timed out")
                continue
            except (json.JSONDecodeError, Exception) as e:
                print(f"    Parse error: {e}")
                continue

            for repo in repos:
                if area_counts.get(area_name, 0) >= max_per_area:
                    break
                url = repo.get("url", "")
                if not url:
                    continue
                desc = repo.get("description", "") or ""
                name = repo.get("name", "")
                stars = repo.get("stargazersCount", 0)
                record = {
                    "source": "github",
                    "url": url,
                    "title": f"{name} ({stars} stars)",
                    "summary": desc[:500],
                    "focus_area": area_name,
                    "tags": area_cfg.get("keywords", [])[:5],
                    "discovered_at": now_kst().isoformat(),
                }
                if append_discovery(output_path, record, existing_urls):
                    count += 1
                    area_counts[area_name] = area_counts.get(area_name, 0) + 1
                    print(f"    + {url}")

    # 영역별 수집 통계
    if area_counts:
        stats = ", ".join(f"{a}: {c}" for a, c in area_counts.items())
        print(f"  [diversity] GitHub 영역별: {stats}")

    return count


# ---------------------------------------------------------------------------
# Source 3: Telegram links from ZK notes
# ---------------------------------------------------------------------------
URL_PATTERN = re.compile(
    r'https?://(?:www\.)?(?:github\.com|arxiv\.org|x\.com|twitter\.com)/[^\s<>"\')}\]]+',
)


def collect_telegram_links(config: dict, output_path: Path, existing_urls: set[str]) -> int:
    focus_areas = config.get("focus_areas", {})
    cutoff = now_kst() - timedelta(days=7)
    cutoff_str = cutoff.strftime("%Y%m%d")
    count = 0

    # ZK notes are stored as YYYY/MM/zk-YYYYMMDD-HHMMSS-hash__title.md
    note_files: list[Path] = []
    for md_file in ZK_NOTES_DIR.rglob("zk-*.md"):
        # Extract date from filename: zk-YYYYMMDD-...
        m = re.match(r"zk-(\d{8})-", md_file.name)
        if m and m.group(1) >= cutoff_str:
            note_files.append(md_file)

    if not note_files:
        print(f"  No ZK notes found in last 7 days (cutoff: {cutoff_str})")
        return 0

    print(f"  Scanning {len(note_files)} ZK notes from last 7 days ...")

    for note_path in sorted(note_files):
        try:
            text = note_path.read_text(encoding="utf-8")
        except Exception:
            continue

        urls_found = URL_PATTERN.findall(text)
        if not urls_found:
            continue

        area, tags = match_focus_area(text, focus_areas)

        for url in urls_found:
            # Clean trailing punctuation
            url = url.rstrip(".,;:!?)")
            # 원본 소스 추적: x.com/github.com 등
            parsed_url = urlparse(url)
            original_source = parsed_url.netloc.replace("www.", "")
            record = {
                "source": "internal_archived",
                "original_source": original_source,
                "url": url,
                "title": note_path.stem[:200],
                "summary": text[:500],
                "focus_area": area,
                "tags": tags[:5],
                "discovered_at": now_kst().isoformat(),
            }
            if append_discovery(output_path, record, existing_urls):
                count += 1
                print(f"    + {url}")

    return count


# ---------------------------------------------------------------------------
# Source 4: arXiv papers
# ---------------------------------------------------------------------------
_ARXIV_DEFAULT_QUERIES: dict[str, list[str]] = {
    "agent_orchestration": ["multi-agent system", "agent orchestration LLM"],
    "knowledge_management": ["knowledge graph", "RAG retrieval"],
    "pipeline_efficiency": ["workflow optimization", "batch processing"],
    "self_improvement": ["meta-learning", "self-improving AI"],
}


def collect_arxiv(config: dict, output_path: Path, existing_urls: set[str]) -> int:
    try:
        import feedparser  # noqa: F811
    except ImportError:
        print("[WARN] feedparser not installed. Run: pip3 install feedparser")
        return 0

    import urllib.request as _ur

    settings = config.get("collection_settings", {})
    max_results = settings.get("arxiv_max_results", 10)
    focus_areas = config.get("focus_areas", {})
    count = 0

    for area_name, area_cfg in focus_areas.items():
        queries = area_cfg.get("arxiv_queries", _ARXIV_DEFAULT_QUERIES.get(area_name, []))
        if not queries:
            continue

        for q in queries:
            search_q = q.replace(" ", "+")
            # CS 카테고리 제한 (물리/화학/수학 노이즈 제거)
            cs_cats = "cat:cs.AI+OR+cat:cs.MA+OR+cat:cs.CL+OR+cat:cs.LG+OR+cat:cs.IR"
            api_url = (
                f"http://export.arxiv.org/api/query"
                f"?search_query=({cs_cats})+AND+all:{search_q}"
                f"&sortBy=lastUpdatedDate&sortOrder=descending"
                f"&max_results={max_results}"
            )
            print(f"  arXiv: {q!r} ...")
            try:
                req = _ur.Request(api_url, headers={"User-Agent": "Mozilla/5.0"})
                with _ur.urlopen(req, timeout=20) as resp:
                    feed_xml = resp.read()
                feed = feedparser.parse(feed_xml)
            except Exception as e:
                print(f"    arXiv error: {e}")
                continue

            cutoff = now_kst() - timedelta(days=7)

            for entry in feed.entries:
                # 날짜 필터
                updated = entry.get("updated_parsed")
                if updated:
                    from time import mktime
                    entry_dt = datetime.fromtimestamp(mktime(updated), tz=timezone.utc)
                    if entry_dt < cutoff:
                        continue

                link = entry.get("link", "")
                title = entry.get("title", "").replace("\n", " ").strip()
                summary = entry.get("summary", "").replace("\n", " ").strip()
                if not link:
                    continue

                combined = f"{title} {summary}"
                area, tags = match_focus_area(combined, focus_areas)
                if not area:
                    area = area_name
                    tags = []

                record = {
                    "source": "arxiv",
                    "url": link,
                    "title": title[:200],
                    "summary": summary[:500],
                    "focus_area": area,
                    "tags": tags[:5] if tags else [q],
                    "discovered_at": now_kst().isoformat(),
                }
                if append_discovery(output_path, record, existing_urls):
                    count += 1
                    print(f"    + {link}")

    return count


# ---------------------------------------------------------------------------
# Source 5: HackerNews via Algolia API
# ---------------------------------------------------------------------------
_HN_DEFAULT_QUERIES: dict[str, list[str]] = {
    "agent_orchestration": ["multi-agent", "LLM orchestration"],
    "knowledge_management": ["knowledge graph", "RAG"],
    "pipeline_efficiency": ["workflow automation", "data pipeline"],
    "self_improvement": ["meta-learning", "self-improving"],
}


def collect_hackernews(config: dict, output_path: Path, existing_urls: set[str]) -> int:
    import urllib.request as _ur

    settings = config.get("collection_settings", {})
    min_points = settings.get("hackernews_min_points", 50)
    focus_areas = config.get("focus_areas", {})
    count = 0

    seven_days_ago = int((now_kst() - timedelta(days=7)).timestamp())

    for area_name, area_cfg in focus_areas.items():
        queries = area_cfg.get("hackernews_queries", _HN_DEFAULT_QUERIES.get(area_name, []))
        if not queries:
            continue

        for q in queries:
            encoded_q = q.replace(" ", "%20")
            api_url = (
                f"https://hn.algolia.com/api/v1/search"
                f"?query={encoded_q}"
                f"&tags=story"
                f"&numericFilters=created_at_i>{seven_days_ago},points>{min_points}"
            )
            print(f"  HackerNews: {q!r} ...")
            try:
                req = _ur.Request(api_url, headers={"User-Agent": "Mozilla/5.0"})
                with _ur.urlopen(req, timeout=15) as resp:
                    data = json.loads(resp.read())
            except Exception as e:
                print(f"    HN error: {e}")
                continue

            hits = data.get("hits", [])
            for hit in hits:
                url = hit.get("url") or f"https://news.ycombinator.com/item?id={hit.get('objectID', '')}"
                title = hit.get("title", "")
                points = hit.get("points", 0)
                if not title:
                    continue

                combined = f"{title} {hit.get('story_text', '')}"
                area, tags = match_focus_area(combined, focus_areas)
                if not area:
                    area = area_name
                    tags = []

                record = {
                    "source": "hackernews",
                    "url": url,
                    "title": f"{title} ({points} pts)",
                    "summary": hit.get("story_text", "")[:500] if hit.get("story_text") else title,
                    "focus_area": area,
                    "tags": tags[:5] if tags else [q],
                    "discovered_at": now_kst().isoformat(),
                }
                if append_discovery(output_path, record, existing_urls):
                    count += 1
                    print(f"    + {url}")

    return count


# ---------------------------------------------------------------------------
# GitHub issue → markdown helpers (used by github_release_monitor)
# ---------------------------------------------------------------------------
def build_issue_md(issue: dict, comments: list = None) -> str:
    """Convert a GitHub issue dict to markdown text."""
    number = issue.get("number", "?")
    title = issue.get("title", "")
    url = issue.get("url", "")
    body = issue.get("body", "") or ""
    labels = issue.get("labels", [])
    closed_at = issue.get("closedAt", "")

    lines = [f"# [{number}] {title}", ""]
    if url:
        lines.append(f"URL: {url}")
    if labels:
        label_str = ", ".join(l["name"] if isinstance(l, dict) else str(l) for l in labels)
        lines.append(f"Labels: {label_str}")
    if closed_at:
        date_part = closed_at[:10] if "T" in closed_at else closed_at
        lines.append(f"Closed: {date_part}")
    lines.append("")
    lines.append("---")
    lines.append("")
    if body:
        lines.append(body)

    if comments:
        lines.append("")
        lines.append("## Comments")
        for c in comments:
            author = c.get("author", "unknown")
            c_body = c.get("body", "")
            lines.append(f"\n@{author}: {c_body}")

    return "\n".join(lines)


def build_summary(issues: list) -> str | None:
    """Build a one-line summary of collected issues. Returns None if empty."""
    if not issues:
        return None
    count = len(issues)
    titles = [f"#{i.get('number', '?')} {i.get('title', '')}" for i in issues[:5]]
    return f"수집 {count}건: " + ", ".join(titles)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(description="External discovery collector")
    parser.add_argument(
        "--source",
        choices=["x_accounts", "github", "telegram_links", "arxiv", "hackernews"],
        help="Collect from a specific source",
    )
    parser.add_argument("--all", action="store_true", help="Collect from all sources")
    args = parser.parse_args()

    if not args.source and not args.all:
        parser.print_help()
        sys.exit(1)

    config = load_config()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    output_path = OUTPUT_DIR / f"discoveries_{today_str()}.jsonl"
    dedup_days = config.get("collection_settings", {}).get("dedup_window_days", 7)
    existing_urls = load_recent_urls(OUTPUT_DIR, days=dedup_days)

    print(f"[idea_collector] {now_kst().strftime('%Y-%m-%d %H:%M KST')}")
    print(f"  Output: {output_path}")
    print(f"  Existing discoveries today: {len(existing_urls)}")

    sources = (
        ["x_accounts", "github", "arxiv", "hackernews", "telegram_links"]
        if args.all
        else [args.source]
    )

    total = 0
    max_per_run = config.get("collection_settings", {}).get("max_discoveries_per_run", 30)

    for source in sources:
        if total >= max_per_run:
            print(f"  Reached max discoveries per run ({max_per_run}), stopping.")
            break

        print(f"\n--- Source: {source} ---")
        if source == "x_accounts":
            n = collect_x_accounts(config, output_path, existing_urls)
        elif source == "github":
            n = collect_github(config, output_path, existing_urls)
        elif source == "arxiv":
            n = collect_arxiv(config, output_path, existing_urls)
        elif source == "hackernews":
            n = collect_hackernews(config, output_path, existing_urls)
        elif source == "telegram_links":
            n = collect_telegram_links(config, output_path, existing_urls)
        else:
            n = 0
        total += n
        print(f"  {source}: {n} new discoveries")

    print(f"\n[Done] Total new discoveries: {total}")


if __name__ == "__main__":
    main()
