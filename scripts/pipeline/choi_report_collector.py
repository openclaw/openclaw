#!/usr/bin/env python3
"""choi_report_collector.py — 최광식(다올투자증권) 텔레그램 리포트 수집 파이프라인

텔레그램 공개 아카이브(t.me/s/HI_GS)에서 리서치 노트 및 리포트 메타데이터를 수집하고,
bit.ly 링크를 확장하여 PDF를 다운로드. 방법론 키워드 자동 추출.

Usage:
    python3 pipeline/choi_report_collector.py --collect          # 신규 수집
    python3 pipeline/choi_report_collector.py --collect --full   # 전체 아카이브
    python3 pipeline/choi_report_collector.py --stats            # 수집 현황
    python3 pipeline/choi_report_collector.py --extract-methods  # 방법론 키워드 추출
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from html.parser import HTMLParser
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

# -- path setup --
SCRIPT_DIR = Path(__file__).resolve().parent
SCRIPTS_DIR = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPTS_DIR))

from shared.log import make_logger  # noqa: E402

# ── 상수 ──────────────────────────────────────────────────────────
WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))
OUTPUT_DIR = WORKSPACE / "memory" / "choi-reports"
PDF_DIR = OUTPUT_DIR / "pdfs"
INDEX_FILE = OUTPUT_DIR / "index.json"
STATE_FILE = OUTPUT_DIR / "state.json"
LOG_FILE = WORKSPACE / "logs" / "choi_report_collector.log"

CHANNEL_URL = "https://t.me/s/HI_GS"
BOT_TOKEN = "8554125313:AAGC5Zzb9nCbPYgmOVqs3pVn-qzIA2oOtkI"
DM_CHAT_ID = "492860021"

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

REQUEST_DELAY = 3  # seconds between requests
MAX_RETRIES = 3
MAX_PAGES = 200  # safety cap for --full

log = make_logger(log_file=str(LOG_FILE))

# ── 방법론 키워드 매핑 ──────────────────────────────────────────────
METHOD_KEYWORDS: dict[str, str] = {
    "수주잔고": "backlog_cycle",
    "신조선가": "newbuild_price",
    "피크아웃": "peakout",
    "슈퍼사이클": "supercycle",
    "선종 전환": "vessel_mix_shift",
    "선종전환": "vessel_mix_shift",
    "탱커 국면": "tanker_structural",
    "탱커국면": "tanker_structural",
    "이중 촉매": "dual_catalyst",
    "이중촉매": "dual_catalyst",
    "EEXI": "regulation_impact",
    "CII": "regulation_impact",
    "톤마일": "ton_mile",
    "MASGA": "defense_catalyst",
    "K-방산": "defense_catalyst",
    "선가": "newbuild_price",
    "LNG 메가오더": "lng_mega_order",
    "메가오더": "lng_mega_order",
    "선령": "vessel_age",
}

# ── 조선/기계/방산 관련 태그 키워드 ──────────────────────────────────
TAG_KEYWORDS: list[str] = [
    "HD현대중공업", "HD한국조선해양", "HD현대미포", "HD현대마린엔진",
    "한화오션", "삼성중공업", "현대중공업",
    "LNG", "VLCC", "컨테이너", "탱커", "벌크", "FPSO",
    "조선", "해양", "방산", "잠수함", "수주", "실적",
    "기계", "엔진", "터빈",
]


# ══════════════════════════════════════════════════════════════════
#  HTML Parser — 텔레그램 아카이브 메시지 파싱
# ══════════════════════════════════════════════════════════════════

class TelegramArchiveParser(HTMLParser):
    """Parse t.me/s/CHANNEL public archive HTML."""

    def __init__(self):
        super().__init__()
        self.messages: list[dict[str, Any]] = []
        self._current_msg: dict[str, Any] | None = None
        self._in_text = False
        self._text_parts: list[str] = []
        self._text_depth = 0
        self._wrap_depth = 0  # track message_wrap div nesting

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attr_dict = dict(attrs)
        cls = attr_dict.get("class", "")

        # Message wrapper — track div depth for proper close detection
        if tag == "div" and "tgme_widget_message_wrap" in cls:
            self._current_msg = {"msg_id": None, "date": None, "text": "", "links": []}
            self._wrap_depth = 1
        elif self._current_msg is not None and tag == "div":
            self._wrap_depth += 1

        if tag == "div" and "tgme_widget_message " in (cls + " "):
            data_post = attr_dict.get("data-post", "")
            if data_post and self._current_msg is not None:
                parts = data_post.split("/")
                if len(parts) == 2:
                    try:
                        self._current_msg["msg_id"] = int(parts[1])
                    except ValueError:
                        pass

        # Message text
        if tag == "div" and "tgme_widget_message_text" in cls:
            self._in_text = True
            self._text_parts = []
            self._text_depth = 0

        if self._in_text:
            self._text_depth += 1

        # Links inside message
        if tag == "a" and self._current_msg is not None:
            href = attr_dict.get("href", "")
            if href:
                self._current_msg["links"].append(href)

        # Date
        if tag == "time" and self._current_msg is not None:
            dt = attr_dict.get("datetime", "")
            if dt:
                self._current_msg["date"] = dt[:10]  # YYYY-MM-DD

    def handle_endtag(self, tag: str) -> None:
        if self._in_text:
            self._text_depth -= 1
            if tag == "div" and self._text_depth <= 0:
                self._in_text = False
                if self._current_msg is not None:
                    self._current_msg["text"] = " ".join(self._text_parts).strip()

        # Only consume message when the outermost wrap div closes
        if tag == "div" and self._current_msg is not None:
            self._wrap_depth -= 1
            if self._wrap_depth <= 0 and self._current_msg.get("msg_id"):
                if self._current_msg["text"] or self._current_msg["links"]:
                    self.messages.append(self._current_msg)
                self._current_msg = None

    def handle_data(self, data: str) -> None:
        if self._in_text:
            stripped = data.strip()
            if stripped:
                self._text_parts.append(stripped)


# ══════════════════════════════════════════════════════════════════
#  Core Functions
# ══════════════════════════════════════════════════════════════════

def _fetch_page(url: str) -> str:
    """Fetch a URL with retries and exponential backoff."""
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
    return ""  # unreachable


def _resolve_bitly(short_url: str) -> str | None:
    """Expand a bit.ly short URL by following redirects via HEAD request."""
    try:
        req = urllib.request.Request(short_url, method="HEAD", headers={"User-Agent": USER_AGENT})
        # Use custom opener that doesn't follow redirects
        class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, req, fp, code, msg, headers, newurl):
                return None

        opener = urllib.request.build_opener(NoRedirectHandler)
        try:
            opener.open(req, timeout=15)
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308):
                return e.headers.get("Location")
            return None
        return None
    except (urllib.error.URLError, OSError):
        return None


def _is_pdf_url(url: str) -> bool:
    """Check if a URL likely points to a PDF."""
    parsed = urlparse(url)
    path_lower = parsed.path.lower()
    return path_lower.endswith(".pdf") or "pdf" in parsed.query.lower()


def _download_pdf(url: str, filename: str) -> str | None:
    """Download PDF and save to PDF_DIR. Returns relative path or None."""
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    dest = PDF_DIR / filename
    if dest.exists():
        return f"pdfs/{filename}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read()
            if len(data) < 1000:  # too small for a real PDF
                return None
            dest.write_bytes(data)
            return f"pdfs/{filename}"
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
        log(f"PDF download failed: {e}", level="WARN")
        return None


def _extract_tags(text: str) -> list[str]:
    """Extract relevant tags from message text."""
    found = []
    for kw in TAG_KEYWORDS:
        if kw in text:
            found.append(kw)
    return found


def _extract_methods(text: str) -> list[str]:
    """Extract methodology keywords from message text."""
    found = []
    for kw, method_id in METHOD_KEYWORDS.items():
        if kw in text and method_id not in found:
            found.append(method_id)
    return found


def _make_pdf_filename(msg_id: int, bitly_url: str) -> str:
    """Generate a safe PDF filename from bitly URL or message ID."""
    parsed = urlparse(bitly_url)
    slug = parsed.path.strip("/").replace("/", "_")
    if slug:
        return f"{slug}.pdf"
    return f"msg_{msg_id}.pdf"


# ══════════════════════════════════════════════════════════════════
#  Index management
# ══════════════════════════════════════════════════════════════════

def _load_index() -> dict[str, Any]:
    """Load or create the report index."""
    if INDEX_FILE.exists():
        try:
            return json.loads(INDEX_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {"reports": [], "last_msg_id": 0, "total_reports": 0, "last_updated": None}


def _save_index(index: dict[str, Any]) -> None:
    """Save the report index atomically."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    index["last_updated"] = datetime.now().isoformat()
    index["total_reports"] = len(index["reports"])
    tmp = INDEX_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(index, ensure_ascii=False, indent=2))
    tmp.rename(INDEX_FILE)


def _load_state() -> dict[str, Any]:
    """Load crawler state for idempotency."""
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {"last_collected_msg_id": 0, "pages_fetched": 0}


def _save_state(state: dict[str, Any]) -> None:
    """Save crawler state."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    state["last_run"] = datetime.now().isoformat()
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2))
    tmp.rename(STATE_FILE)


# ══════════════════════════════════════════════════════════════════
#  Collection
# ══════════════════════════════════════════════════════════════════

def parse_archive_page(html: str) -> list[dict[str, Any]]:
    """Parse a telegram archive page and return messages."""
    parser = TelegramArchiveParser()
    parser.feed(html)
    return parser.messages


def collect_reports(full: bool = False) -> dict[str, Any]:
    """Collect reports from the Telegram public archive.

    Args:
        full: If True, scan the entire archive. Otherwise, only new messages.

    Returns:
        Summary dict with counts.
    """
    index = _load_index()
    state = _load_state()

    existing_ids = {r["msg_id"] for r in index["reports"]}
    last_known = state["last_collected_msg_id"] if not full else 0

    new_reports: list[dict[str, Any]] = []
    pages_fetched = 0
    earliest_id_seen = None
    url = CHANNEL_URL

    log(f"Starting collection (full={full}, last_known={last_known})")

    while pages_fetched < MAX_PAGES:
        try:
            html = _fetch_page(url)
        except (urllib.error.URLError, OSError) as e:
            log(f"Failed to fetch page: {e}", level="ERROR")
            break

        messages = parse_archive_page(html)
        pages_fetched += 1

        if not messages:
            log(f"No messages found on page {pages_fetched}, stopping.")
            break

        log(f"Page {pages_fetched}: {len(messages)} messages "
            f"(ids {messages[-1].get('msg_id', '?')}~{messages[0].get('msg_id', '?')})")

        stop_scan = False
        for msg in messages:
            msg_id = msg.get("msg_id")
            if not msg_id:
                continue

            if earliest_id_seen is None or msg_id < earliest_id_seen:
                earliest_id_seen = msg_id

            if msg_id in existing_ids:
                if not full:
                    stop_scan = True
                continue

            # Process bit.ly links
            bitly_links = [l for l in msg.get("links", [])
                           if "bit.ly" in l or "bitly" in l]
            resolved_url = None
            pdf_path = None

            if bitly_links:
                bitly_url = bitly_links[0]
                resolved_url = _resolve_bitly(bitly_url)
                if resolved_url and _is_pdf_url(resolved_url):
                    fname = _make_pdf_filename(msg_id, bitly_url)
                    pdf_path = _download_pdf(resolved_url, fname)
                time.sleep(0.5)  # gentle delay for bit.ly
            else:
                bitly_url = None

            text = msg.get("text", "")
            report = {
                "msg_id": msg_id,
                "date": msg.get("date"),
                "text": text[:500],  # cap text length
                "bitly_url": bitly_url,
                "resolved_url": resolved_url,
                "pdf_path": pdf_path,
                "tags": _extract_tags(text),
                "methods": _extract_methods(text),
                "methodology_extracted": bool(_extract_methods(text)),
            }
            new_reports.append(report)
            existing_ids.add(msg_id)

        if stop_scan:
            log("Reached last known message, stopping.")
            break

        # Pagination: find the earliest message ID and go before it
        if earliest_id_seen and earliest_id_seen > 1:
            url = f"{CHANNEL_URL}?before={earliest_id_seen}"
            time.sleep(REQUEST_DELAY)
        else:
            break

    # Merge new reports into index
    if new_reports:
        index["reports"].extend(new_reports)
        index["reports"].sort(key=lambda r: r["msg_id"], reverse=True)

    # Update state
    if index["reports"]:
        state["last_collected_msg_id"] = index["reports"][0]["msg_id"]
    state["pages_fetched"] = pages_fetched

    _save_index(index)
    _save_state(state)

    summary = {
        "new_reports": len(new_reports),
        "total_reports": len(index["reports"]),
        "pages_fetched": pages_fetched,
        "pdfs_downloaded": sum(1 for r in new_reports if r.get("pdf_path")),
        "methods_found": sum(1 for r in new_reports if r.get("methods")),
    }
    log(f"Collection done: {summary}")
    return summary


# ══════════════════════════════════════════════════════════════════
#  Stats & Method extraction
# ══════════════════════════════════════════════════════════════════

def show_stats() -> str:
    """Show collection statistics."""
    index = _load_index()
    state = _load_state()
    reports = index.get("reports", [])

    if not reports:
        return "No reports collected yet."

    dates = [r["date"] for r in reports if r.get("date")]
    date_range = f"{min(dates)} ~ {max(dates)}" if dates else "unknown"
    pdfs = sum(1 for r in reports if r.get("pdf_path"))
    with_methods = sum(1 for r in reports if r.get("methods"))

    # Method frequency
    method_counts: dict[str, int] = {}
    for r in reports:
        for m in r.get("methods", []):
            method_counts[m] = method_counts.get(m, 0) + 1

    lines = [
        f"=== 최광식 리포트 수집 현황 ===",
        f"총 메시지: {len(reports)}건",
        f"기간: {date_range}",
        f"PDF 다운로드: {pdfs}건",
        f"방법론 키워드 매칭: {with_methods}건",
        f"마지막 수집: {state.get('last_run', 'never')}",
        "",
        "=== 방법론 빈도 ===",
    ]
    for method, count in sorted(method_counts.items(), key=lambda x: -x[1]):
        lines.append(f"  {method}: {count}건")

    result = "\n".join(lines)
    log(result)
    return result


def extract_methods_summary() -> dict[str, list[dict[str, str]]]:
    """Extract methodology references grouped by method type."""
    index = _load_index()
    reports = index.get("reports", [])

    method_refs: dict[str, list[dict[str, str]]] = {}
    for r in reports:
        for m in r.get("methods", []):
            if m not in method_refs:
                method_refs[m] = []
            method_refs[m].append({
                "msg_id": r["msg_id"],
                "date": r.get("date", ""),
                "text_preview": r.get("text", "")[:100],
            })

    log(f"Method extraction: {len(method_refs)} methods from {len(reports)} reports")
    return method_refs


# ══════════════════════════════════════════════════════════════════
#  Telegram DM
# ══════════════════════════════════════════════════════════════════

def _send_dm(text: str) -> bool:
    """Send result to Telegram DM via Bot API."""
    try:
        payload = json.dumps({
            "chat_id": int(DM_CHAT_ID),
            "text": text,
            "parse_mode": "Markdown",
        }).encode()
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            data=payload,
            headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status == 200
    except (urllib.error.URLError, OSError) as e:
        log(f"DM send failed: {e}", level="WARN")
        return False


# ══════════════════════════════════════════════════════════════════
#  CLI
# ══════════════════════════════════════════════════════════════════

def main() -> None:
    parser = argparse.ArgumentParser(description="최광식 텔레그램 리포트 수집")
    parser.add_argument("--collect", action="store_true", help="신규 리포트 수집")
    parser.add_argument("--full", action="store_true", help="전체 아카이브 스캔 (--collect과 함께)")
    parser.add_argument("--stats", action="store_true", help="수집 현황 출력")
    parser.add_argument("--extract-methods", action="store_true", help="방법론 키워드 추출")
    parser.add_argument("--notify", action="store_true", help="텔레그램 DM으로 결과 전송")
    args = parser.parse_args()

    if args.stats:
        print(show_stats())
        return

    if args.extract_methods:
        refs = extract_methods_summary()
        for method, entries in sorted(refs.items()):
            print(f"\n=== {method} ({len(entries)}건) ===")
            for e in entries[:5]:
                print(f"  [{e['date']}] msg#{e['msg_id']}: {e['text_preview']}")
        return

    if args.collect:
        summary = collect_reports(full=args.full)
        msg = (
            f"*최광식 리포트 수집 완료*\n"
            f"신규: {summary['new_reports']}건\n"
            f"총계: {summary['total_reports']}건\n"
            f"PDF: {summary['pdfs_downloaded']}건\n"
            f"방법론: {summary['methods_found']}건\n"
            f"페이지: {summary['pages_fetched']}개"
        )
        print(msg)
        if args.notify:
            _send_dm(msg)
        return

    parser.print_help()


if __name__ == "__main__":
    main()
