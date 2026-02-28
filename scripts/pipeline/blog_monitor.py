#!/usr/bin/env python3
"""
blog_monitor.py — 네이버 블로그 RSS 모니터 → 인사이트 추출 → 텔레그램 전달

Usage:
  python3 blog_monitor.py --notify        # RSS 파싱 + 저장 + 텔레그램 전달
  python3 blog_monitor.py --dry-run       # 파싱만 (저장/전달 없음)
"""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.log import make_logger
from shared.llm import llm_chat_direct, DIRECT_DEFAULT_CHAIN
from shared.frontmatter import render_frontmatter
from shared.telegram import send_dm

BLOG_ID = "ranto28"
RSS_URL = f"https://rss.blog.naver.com/{BLOG_ID}"
WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))
OUTPUT_DIR = WORKSPACE / "memory" / "blog-insights"
PROCESSED_FILE = OUTPUT_DIR / ".processed_blogs.json"
LOGS_DIR = WORKSPACE / "logs"
LOG_FILE = LOGS_DIR / "blog_monitor.log"

log = make_logger(log_file=LOG_FILE)

EXTRACT_MODELS = list(DIRECT_DEFAULT_CHAIN)

# 관심 카테고리 (맛집/일상/여행 제외)
INCLUDE_CATEGORIES = {"경제", "주식", "국제정세", "사회", "부동산", "금융", "투자", "정치"}
EXCLUDE_KEYWORDS = {"맛집", "일상", "여행", "카페", "음식", "레시피", "맛있"}


# ── RSS 파싱 ──────────────────────────────────────────────────────

def fetch_rss():
    """Fetch and parse RSS feed."""
    try:
        import feedparser
    except ImportError:
        log("feedparser not installed", level="ERROR")
        return []

    feed = feedparser.parse(RSS_URL)
    if feed.bozo and not feed.entries:
        log(f"RSS parse error: {feed.bozo_exception}", level="ERROR")
        return []

    log(f"RSS fetched: {len(feed.entries)} entries")
    return feed.entries


def filter_by_category(entries):
    """카테고리 기반 필터링 (관심 주제만 통과).

    Naver RSS 카테고리는 "경제/주식/국제정세/사회" 같은 슬래시 구분 문자열.
    각 서브카테고리를 분리하여 INCLUDE_CATEGORIES와 매칭한다.
    """
    passed = []
    for entry in entries:
        # Naver RSS에서 카테고리 추출 (슬래시 분리)
        raw_cats = [c.get("term", "") for c in getattr(entry, "tags", [])]
        categories = []
        for cat in raw_cats:
            categories.extend(sub.strip() for sub in cat.split("/") if sub.strip())
        title = getattr(entry, "title", "")

        # 제외 키워드 검사
        combined = title + " " + " ".join(categories)
        if any(kw in combined for kw in EXCLUDE_KEYWORDS):
            continue

        # 카테고리 매칭 (카테고리 없으면 제목으로 판단 — 통과시킴)
        if categories:
            if any(cat in INCLUDE_CATEGORIES for cat in categories):
                passed.append(entry)
        else:
            # 카테고리 미지정 글은 일단 통과 (LLM이 판단)
            passed.append(entry)

    return passed


def extract_log_no(link):
    """Extract logNo from Naver blog URL."""
    if not link:
        return ""
    # https://blog.naver.com/ranto28/224188992845
    parts = link.rstrip("/").split("/")
    for p in reversed(parts):
        if p.isdigit() and len(p) > 8:
            return p
    return parts[-1] if parts else ""


# ── 중복 방지 ───────────────────────────────────────────────────────

def load_processed():
    """Load set of processed blog entry guids."""
    if PROCESSED_FILE.exists():
        try:
            with open(PROCESSED_FILE) as f:
                return set(json.load(f))
        except (json.JSONDecodeError, TypeError):
            return set()
    return set()


def save_processed(guids):
    """Save processed guids (keep last 500)."""
    PROCESSED_FILE.parent.mkdir(parents=True, exist_ok=True)
    recent = sorted(guids)[-500:]
    with open(PROCESSED_FILE, "w") as f:
        json.dump(recent, f, indent=2)


# ── LLM 인사이트 추출 ─────────────────────────────────────────────

def extract_insight(title, summary_text, categories):
    """LLM을 사용하여 블로그 글에서 핵심 인사이트/지표/방법론 추출."""
    if not summary_text or len(summary_text.strip()) < 30:
        return None

    # RSS 요약은 보통 500-800자
    text = summary_text[:2000]
    cat_str = ", ".join(categories) if categories else "미분류"

    messages = [
        {"role": "system", "content": (
            "블로그 글에서 투자/경제 관련 핵심 정보를 추출하라.\n\n"
            "출력 형식 (JSON):\n"
            "{\n"
            '  "insight": "핵심 인사이트 2-3줄 요약",\n'
            '  "methodology": "시장 판단 방법론/지표 (있을 경우, 없으면 빈 문자열)",\n'
            '  "tags": ["태그1", "태그2", "태그3"],\n'
            '  "indicators": ["관련 시장 지표1", "관련 시장 지표2"],\n'
            '  "regions": ["글에서 언급된 지정학적 지역/해상루트 (없으면 빈 배열)"]\n'
            "}\n\n"
            "JSON만 출력. 설명 없이."
        )},
        {"role": "user", "content": f"제목: {title}\n카테고리: {cat_str}\n\n{text}"},
    ]
    content, model, err = llm_chat_direct(
        messages, EXTRACT_MODELS, temperature=0.2, max_tokens=800, timeout=45,
    )
    if not content:
        log(f"LLM extraction failed: {err}", level="WARN")
        return None

    # JSON 파싱 (코드블록 제거)
    clean = content.strip()
    if clean.startswith("```"):
        lines = clean.split("\n")
        clean = "\n".join(lines[1:-1]) if len(lines) > 2 else clean
    try:
        return json.loads(clean)
    except json.JSONDecodeError:
        log(f"JSON parse failed from {model}, raw={content[:100]}", level="WARN")
        return None


# ── 마크다운 저장 ───────────────────────────────────────────────────

def save_blog_insight(entry, extracted):
    """Save blog insight as markdown file with frontmatter."""
    title = getattr(entry, "title", "Untitled")
    link = getattr(entry, "link", "")
    log_no = extract_log_no(link)
    categories = [c.get("term", "") for c in getattr(entry, "tags", [])]
    published = getattr(entry, "published", "")

    # 날짜 파싱
    date_str = datetime.now().strftime("%Y-%m-%d")
    if published:
        for fmt in ("%a, %d %b %Y %H:%M:%S %z", "%Y-%m-%dT%H:%M:%S"):
            try:
                date_str = datetime.strptime(published[:25], fmt).strftime("%Y-%m-%d")
                break
            except ValueError:
                continue

    safe_id = log_no or title[:30].replace(" ", "_")
    filepath = OUTPUT_DIR / f"{date_str}_blog_{safe_id}.md"

    # frontmatter 구성
    meta = {
        "title": title,
        "date": date_str,
        "source": "blog_insights",
        "blog": BLOG_ID,
        "url": link,
        "category": "/".join(categories) if categories else "미분류",
    }
    if extracted:
        meta["tags"] = extracted.get("tags", [])
        meta["indicators"] = extracted.get("indicators", [])
        if extracted.get("regions"):
            meta["regions"] = extracted["regions"]

    # 본문 구성
    body_lines = [""]
    if extracted:
        insight = extracted.get("insight", "")
        methodology = extracted.get("methodology", "")
        if insight:
            body_lines.extend(["## 핵심 인사이트", insight, ""])
        if methodology:
            body_lines.extend(["## 방법론/지표", methodology, ""])

    # RSS 요약 추가
    summary = getattr(entry, "summary", "")
    if summary:
        body_lines.extend(["## 원문 요약", summary[:1500], ""])

    body_lines.append(f"[원문 보기]({link})")

    fm = render_frontmatter(meta)
    content = fm + "\n" + "\n".join(body_lines) + "\n"
    filepath.write_text(content, encoding="utf-8")
    log(f"Saved: {filepath.name}")
    return filepath


# ── 지정학 워치리스트 자동 업데이트 ─────────────────────────────────

def _update_geo_watchlist(regions):
    """블로그에서 감지된 새 지역을 지정학 워치리스트에 자동 추가."""
    wl_path = WORKSPACE / "memory" / "geopolitical" / "watchlist.json"
    if not wl_path.exists() or not regions:
        return
    try:
        with open(wl_path) as f:
            wl = json.load(f)
    except (json.JSONDecodeError, TypeError):
        return
    known = {n.lower() for cfg in wl.values()
             for n in [cfg.get("name", "")] + cfg.get("keywords", [])}
    new_regions = [r for r in regions if r.lower() not in known]
    if not new_regions:
        return
    for name in new_regions[:2]:
        content, _, _ = llm_chat_direct(
            [{"role": "system", "content":
              'Geographic region -> JSON: {"id":"snake_case","bbox":[lat_min,lon_min,lat_max,lon_max],'
              '"keywords":["kw1"],"types":["news"]}. JSON only.'},
             {"role": "user", "content": name}],
            ["gpt-5-mini", "qwen2.5:7b"], temperature=0.1, max_tokens=200, timeout=20)
        if not content:
            continue
        clean = content.strip().strip("`")
        if clean.startswith("json"):
            clean = clean[4:].strip()
        try:
            d = json.loads(clean)
        except json.JSONDecodeError:
            continue
        rid = d.get("id", "")
        if rid and rid not in wl:
            wl[rid] = {"name": name, "bbox": d.get("bbox", []), "types": d.get("types", ["news"]),
                        "keywords": d.get("keywords", [name]), "source": "blog_auto"}
            log(f"Auto-added geo region: {rid}")
    with open(wl_path, "w") as f:
        json.dump(wl, f, indent=2, ensure_ascii=False)


def generate_summary_text(entries, extracted_map=None):
    """Generate a summary text of processed blog entries for reporting.

    Args:
        entries: list of feedparser entries processed
        extracted_map: optional dict mapping entry id to extracted insight

    Returns:
        str: summary text with counts and titles
    """
    if not entries:
        return "처리된 블로그 글 없음"

    lines = [f"블로그 모니터 요약 ({len(entries)}건)"]
    for entry in entries[:10]:
        title = getattr(entry, "title", "Untitled")
        has_insight = ""
        if extracted_map:
            eid = getattr(entry, "id", getattr(entry, "link", ""))
            if eid in extracted_map and extracted_map[eid]:
                has_insight = " ✓"
        lines.append(f"  - {title[:60]}{has_insight}")
    if len(entries) > 10:
        lines.append(f"  ... 외 {len(entries) - 10}건")
    return "\n".join(lines)


# ── 텔레그램 전달 ───────────────────────────────────────────────────

def notify_telegram(entry, extracted):
    """Send blog insight to Telegram via Bot API."""
    title = getattr(entry, "title", "Untitled")
    link = getattr(entry, "link", "")
    insight = extracted.get("insight", "") if extracted else ""

    lines = [f"<b>{title}</b>", ""]
    if insight:
        lines.append(insight[:500])
        lines.append("")
    lines.append(f'<a href="{link}">원문</a>')
    text = "\n".join(lines)

    if send_dm(text):
        log(f"Telegram notification sent: {title[:40]}")
        return True
    return False


# ── main ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Blog RSS Monitor → 인사이트 추출")
    parser.add_argument("--notify", action="store_true", help="텔레그램으로 인사이트 전달")
    parser.add_argument("--dry-run", action="store_true", help="파싱만, 저장/전달 없음")
    parser.add_argument("--limit", type=int, default=10, help="신규 처리 최대 건수 (기본: 10)")
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    LOGS_DIR.mkdir(parents=True, exist_ok=True)

    log(f"Fetching RSS from {RSS_URL}")
    entries = fetch_rss()
    if not entries:
        log("No entries found")
        result = {"source": "blog_monitor", "blog": BLOG_ID,
                  "collected_at": datetime.now().isoformat(),
                  "status": "ok", "new_posts": 0}
        print(json.dumps(result, ensure_ascii=False))
        return result

    # 카테고리 필터
    filtered = filter_by_category(entries)
    log(f"Category filter: {len(entries)} → {len(filtered)} entries")

    # 중복 제거
    processed = load_processed()
    new_entries = []
    for entry in filtered:
        guid = getattr(entry, "id", "") or getattr(entry, "link", "")
        if guid and guid not in processed:
            new_entries.append((guid, entry))

    if not new_entries:
        log("No new entries")
        result = {"source": "blog_monitor", "blog": BLOG_ID,
                  "collected_at": datetime.now().isoformat(),
                  "status": "ok", "new_posts": 0,
                  "total_processed": len(processed)}
        print(json.dumps(result, ensure_ascii=False))
        return result

    log(f"New entries: {len(new_entries)}")

    # 오래된 것부터 처리, limit 적용
    new_entries = list(reversed(new_entries[:args.limit]))

    if args.dry_run:
        for guid, entry in new_entries:
            title = getattr(entry, "title", "?")
            cats = [c.get("term", "") for c in getattr(entry, "tags", [])]
            log(f"  [DRY-RUN] {title} [{'/'.join(cats)}]")
        result = {"source": "blog_monitor", "blog": BLOG_ID,
                  "collected_at": datetime.now().isoformat(),
                  "status": "dry_run", "new_posts": len(new_entries)}
        print(json.dumps(result, ensure_ascii=False))
        return result

    saved = 0
    notified = 0
    for guid, entry in new_entries:
        title = getattr(entry, "title", "Untitled")
        summary = getattr(entry, "summary", "")
        categories = [c.get("term", "") for c in getattr(entry, "tags", [])]

        # LLM 인사이트 추출
        extracted = extract_insight(title, summary, categories)

        # 지정학 워치리스트 업데이트
        if extracted and extracted.get("regions"):
            _update_geo_watchlist(extracted["regions"])

        # 저장
        save_blog_insight(entry, extracted)
        saved += 1

        # 텔레그램 전달
        if args.notify:
            if notify_telegram(entry, extracted):
                notified += 1

        processed.add(guid)

    save_processed(processed)
    log(f"Done: {saved} saved, {notified} notified")

    result = {"source": "blog_monitor", "blog": BLOG_ID,
              "collected_at": datetime.now().isoformat(),
              "status": "ok", "new_posts": saved,
              "notified": notified, "total_processed": len(processed)}
    print(json.dumps(result, ensure_ascii=False))
    return result


if __name__ == "__main__":
    main()
