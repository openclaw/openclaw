#!/usr/bin/env python3
"""
Resumable LinkedIn JD scraper.

What it does:
1) Reads the shortlist input CSV.
2) Merges any already-scraped JD data from existing output CSV (if present).
3) Processes jobs in priority order: rank 1-20 first, then remaining ranks.
4) Scrapes up to N jobs per run (default: all remaining), with 3-5s delay between visits.
5) Writes progress JSON so interrupted runs can resume.
6) Writes output CSV with JD columns appended.
"""

from __future__ import annotations

import argparse
import csv
import json
import random
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Tuple

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

DEFAULT_INPUT = Path(
    "~/Library/Mobile Documents/com~apple~CloudDocs/Job Applications/Combined Discovery/all-discovered-jobs.csv"
).expanduser()
DEFAULT_OUTPUT = Path(
    "~/Library/Mobile Documents/com~apple~CloudDocs/Job Applications/Combined Discovery/all-discovered-with-jd.csv"
).expanduser()
DEFAULT_PROGRESS = Path(
    "~/Library/Mobile Documents/com~apple~CloudDocs/Job Applications/Combined Discovery/all-jd-scrape-progress.json"
).expanduser()

# Include legacy-compatible alias column too.
NEW_COLUMNS = ["jobDescriptionText", "full_job_description", "jdStatus", "jdError", "jdScrapedAt"]
DONE_STATUSES = {"ok", "login_required", "error", "no_url"}
EXISTING_JD_COLUMNS = ["jobDescriptionText", "full_job_description", "job_description", "jd_text"]
EXISTING_STATUS_COLUMNS = ["jdStatus", "jd_status", "status"]
EXISTING_ERROR_COLUMNS = ["jdError", "jd_error", "error"]
EXISTING_SCRAPED_AT_COLUMNS = ["jdScrapedAt", "jd_scraped_at", "scraped_at"]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_rank(row: Dict[str, str]) -> int:
    raw = (row.get("rank") or "").strip()
    try:
        return int(raw)
    except Exception:
        return 10**9


def read_csv_dict(path: Path) -> Tuple[List[Dict[str, str]], List[str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
        fieldnames = reader.fieldnames or []
    return rows, list(fieldnames)


def write_csv_dict(path: Path, rows: List[Dict[str, str]], fieldnames: List[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=fieldnames,
            extrasaction="ignore",
            quoting=csv.QUOTE_ALL,
            doublequote=True,
            lineterminator="\n",
        )
        writer.writeheader()
        writer.writerows(rows)


def first_non_empty(row: Dict[str, str], keys: List[str]) -> str:
    for k in keys:
        v = (row.get(k) or "").strip()
        if v:
            return v
    return ""


def normalize_url(url: str) -> str:
    if not url:
        return ""
    return url.strip().split("?", 1)[0].rstrip("/").lower()


def row_key(row: Dict[str, str]) -> Tuple[str, str, str, str]:
    rank = (row.get("rank") or "").strip()
    title = (row.get("jobTitle") or "").strip().lower()
    company = (row.get("company") or "").strip().lower()
    url = normalize_url((row.get("linkedinJobUrl") or "").strip())
    return rank, title, company, url


def ensure_columns(rows: List[Dict[str, str]], fieldnames: List[str]) -> List[str]:
    final_fields = list(fieldnames)
    for col in NEW_COLUMNS:
        if col not in final_fields:
            final_fields.append(col)

    for row in rows:
        for col in NEW_COLUMNS:
            row.setdefault(col, "")
    return final_fields


def canonicalize_jd_fields(row: Dict[str, str]) -> None:
    """Keep legacy/full_job_description and jobDescriptionText in sync."""
    jd = (row.get("jobDescriptionText") or "").strip()
    legacy = (row.get("full_job_description") or "").strip()

    if not jd and legacy:
        jd = legacy
    if jd and not legacy:
        legacy = jd

    row["jobDescriptionText"] = jd
    row["full_job_description"] = legacy

    status = (row.get("jdStatus") or "").strip().lower()
    if not status:
        if jd.lower() == "login_required":
            row["jdStatus"] = "login_required"
        elif jd:
            row["jdStatus"] = "ok"


def is_processed(row: Dict[str, str]) -> bool:
    status = (row.get("jdStatus") or "").strip().lower()
    jd = (row.get("jobDescriptionText") or row.get("full_job_description") or "").strip()
    if status in DONE_STATUSES:
        return True
    if jd:
        return True
    return False


def merge_existing_output(base_rows: List[Dict[str, str]], output_path: Path) -> int:
    """Merge prior scraped values from output CSV (if present)."""
    if not output_path.exists():
        return 0

    try:
        existing_rows, _ = read_csv_dict(output_path)
    except Exception:
        return 0

    if not existing_rows:
        return 0

    lookup: Dict[Tuple[str, str, str, str], Dict[str, str]] = {}
    for r in existing_rows:
        k = row_key(r)
        if k != ("", "", "", ""):
            lookup[k] = r

    merged = 0
    for row in base_rows:
        k = row_key(row)
        old = lookup.get(k)
        if not old:
            continue

        jd_old = first_non_empty(old, EXISTING_JD_COLUMNS)
        status_old = first_non_empty(old, EXISTING_STATUS_COLUMNS)
        err_old = first_non_empty(old, EXISTING_ERROR_COLUMNS)
        scraped_old = first_non_empty(old, EXISTING_SCRAPED_AT_COLUMNS)

        if jd_old and not (row.get("jobDescriptionText") or "").strip():
            row["jobDescriptionText"] = jd_old
            row["full_job_description"] = jd_old
            merged += 1
        if status_old and not (row.get("jdStatus") or "").strip():
            row["jdStatus"] = status_old
        if err_old and not (row.get("jdError") or "").strip():
            row["jdError"] = err_old
        if scraped_old and not (row.get("jdScrapedAt") or "").strip():
            row["jdScrapedAt"] = scraped_old

        canonicalize_jd_fields(row)

    return merged


def load_progress(progress_path: Path) -> Dict:
    if not progress_path.exists():
        return {}
    try:
        with progress_path.open("r", encoding="utf-8") as f:
            payload = json.load(f)
        if isinstance(payload, dict):
            return payload
    except Exception:
        pass
    return {}


def build_order(rows: List[Dict[str, str]]) -> List[int]:
    sortable = []
    for idx, row in enumerate(rows):
        rank = parse_rank(row)
        top20_bucket = 0 if 1 <= rank <= 20 else 1
        sortable.append((top20_bucket, rank, idx))
    sortable.sort(key=lambda t: (t[0], t[1], t[2]))
    return [idx for _, _, idx in sortable]


def first_unprocessed_position(order: List[int], rows: List[Dict[str, str]]) -> int:
    for pos, idx in enumerate(order):
        if not is_processed(rows[idx]):
            return pos
    return len(order)


def save_progress(
    progress_path: Path,
    order: List[int],
    rows: List[Dict[str, str]],
    last_completed_index: int,
    batch_attempted: int,
    batch_processed: int,
) -> None:
    progress_path.parent.mkdir(parents=True, exist_ok=True)

    next_pos = last_completed_index + 1
    next_rank = None
    next_company = None
    next_title = None
    if 0 <= next_pos < len(order):
        nxt = rows[order[next_pos]]
        next_rank = nxt.get("rank")
        next_company = nxt.get("company")
        next_title = nxt.get("jobTitle")

    payload = {
        "updatedAt": now_iso(),
        "last_completed_index": last_completed_index,
        "batch_attempted": batch_attempted,
        "batch_processed": batch_processed,
        "total_rows": len(rows),
        "total_done": sum(1 for r in rows if is_processed(r)),
        "next_index": next_pos if next_pos < len(order) else None,
        "next_rank": next_rank,
        "next_company": next_company,
        "next_jobTitle": next_title,
        "order_strategy": "rank_1_to_20_first_then_remaining",
    }

    with progress_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def detect_login_or_captcha(url: str, title: str, body_text: str) -> bool:
    hay = f"{url}\n{title}\n{body_text}".lower()
    markers = [
        "authwall",
        "checkpoint/challenge",
        "captcha",
        "verify you are human",
        "security verification",
        "let's do a quick security check",
        "to continue, sign in",
        "join linkedin",
        "sign in",
        "new to linkedin",
    ]
    return any(m in hay for m in markers)


def clean_text(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    return text.strip()


def extract_description(page) -> str:
    js = """
() => {
  const selectors = [
    'div.show-more-less-html__markup',
    '.show-more-less-html__markup',
    '.jobs-description-content__text',
    '.description__text',
    '[data-test-job-description]'
  ];

  const chunks = [];
  for (const sel of selectors) {
    const nodes = document.querySelectorAll(sel);
    for (const n of nodes) {
      const t = (n.innerText || '').trim();
      if (t.length > 0) chunks.push(t);
    }
  }

  if (chunks.length === 0) {
    const fallback = document.querySelectorAll('main, [role="main"], article, section');
    for (const n of fallback) {
      const t = (n.innerText || '').trim();
      if (t.length > 200) chunks.push(t);
    }
  }

  if (chunks.length === 0 && document.body) {
    chunks.push((document.body.innerText || '').trim());
  }

  chunks.sort((a, b) => b.length - a.length);
  return chunks[0] || '';
}
"""
    text = page.evaluate(js)
    return clean_text(text if isinstance(text, str) else "")


def scrape_job(page, url: str) -> Tuple[str, str, str]:
    """Return (status, jd_text, error)."""
    if not url:
        return "no_url", "", "missing linkedinJobUrl"

    try:
        page.goto(url, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_timeout(1500)
    except PlaywrightTimeoutError:
        return "error", "", "navigation_timeout"
    except Exception as e:
        return "error", "", f"navigation_error: {e}"

    try:
        title = page.title() or ""
    except Exception:
        title = ""

    try:
        body_text = page.evaluate("() => (document.body ? document.body.innerText : '')")
        if not isinstance(body_text, str):
            body_text = ""
    except Exception:
        body_text = ""

    current_url = page.url or url
    if detect_login_or_captcha(current_url, title, body_text):
        return "login_required", "login_required", ""

    try:
        jd = extract_description(page)
    except Exception as e:
        return "error", "", f"extract_error: {e}"

    if len(jd) < 120:
        if detect_login_or_captcha(current_url, title, body_text):
            return "login_required", "login_required", ""
        return "error", jd, "description_too_short"

    return "ok", jd, ""


def run(args: argparse.Namespace) -> int:
    input_path = args.input.expanduser()
    output_path = args.output.expanduser()
    progress_path = args.progress.expanduser()

    if not input_path.exists():
        raise FileNotFoundError(f"Input CSV not found: {input_path}")

    base_rows, base_fields = read_csv_dict(input_path)
    if not base_rows:
        raise RuntimeError(f"No rows in input CSV: {input_path}")

    fieldnames = ensure_columns(base_rows, base_fields)
    merged = merge_existing_output(base_rows, output_path)

    order = build_order(base_rows)
    progress = load_progress(progress_path)

    if isinstance(progress.get("last_completed_index"), int):
        start_pos = max(0, progress["last_completed_index"] + 1)
        while start_pos < len(order) and is_processed(base_rows[order[start_pos]]):
            start_pos += 1
    else:
        start_pos = first_unprocessed_position(order, base_rows)

    if start_pos >= len(order):
        write_csv_dict(output_path, base_rows, fieldnames)
        save_progress(progress_path, order, base_rows, len(order) - 1, 0, 0)
        print("All rows already processed. Nothing to do.")
        return 0

    remaining = len(order) - start_pos
    effective_batch_size = args.batch_size if args.batch_size > 0 else remaining

    print(f"Input rows: {len(base_rows)}")
    print(f"Merged existing JD rows from output: {merged}")
    print(
        f"Starting at order index: {start_pos} "
        f"(target this run: {effective_batch_size} of {remaining} remaining)"
    )

    last_completed_index = start_pos - 1
    batch_attempted = 0
    batch_processed = 0

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/123.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1366, "height": 900},
            locale="en-US",
        )
        page = context.new_page()

        pos = start_pos
        while pos < len(order) and batch_attempted < effective_batch_size:
            idx = order[pos]
            row = base_rows[idx]

            if is_processed(row):
                last_completed_index = pos
                save_progress(progress_path, order, base_rows, last_completed_index, batch_attempted, batch_processed)
                pos += 1
                continue

            rank = row.get("rank", "")
            company = row.get("company", "")
            title = row.get("jobTitle", "")
            url = (row.get("linkedinJobUrl") or "").strip()

            print(f"[{batch_attempted + 1}/{effective_batch_size}] rank={rank} | {company} | {title}")
            status, jd_text, err = scrape_job(page, url)

            row["jobDescriptionText"] = jd_text
            row["full_job_description"] = jd_text
            row["jdStatus"] = status
            row["jdError"] = err
            row["jdScrapedAt"] = now_iso()

            canonicalize_jd_fields(row)

            batch_attempted += 1
            if status in DONE_STATUSES:
                batch_processed += 1

            last_completed_index = pos
            write_csv_dict(output_path, base_rows, fieldnames)
            save_progress(progress_path, order, base_rows, last_completed_index, batch_attempted, batch_processed)

            if batch_attempted < effective_batch_size and pos + 1 < len(order):
                delay = random.uniform(args.min_delay, args.max_delay)
                print(f"  -> status={status}; sleeping {delay:.2f}s")
                time.sleep(delay)
            else:
                print(f"  -> status={status}")

            pos += 1

        context.close()
        browser.close()

    print("Done.")
    print(f"Output CSV: {output_path}")
    print(f"Progress JSON: {progress_path}")
    print(f"Batch attempted: {batch_attempted}")
    print(f"Batch processed: {batch_processed}")
    print(f"Last completed index: {last_completed_index}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scrape LinkedIn job descriptions in resumable batches")
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--progress", type=Path, default=DEFAULT_PROGRESS)
    parser.add_argument(
        "--batch-size",
        type=int,
        default=0,
        help="Number of jobs to process this run. Use 0 to process all remaining jobs (default).",
    )
    parser.add_argument("--min-delay", type=float, default=3.0)
    parser.add_argument("--max-delay", type=float, default=5.0)
    parser.add_argument("--headed", action="store_true", help="Run browser in headed mode")
    args = parser.parse_args()

    if args.batch_size < 0:
        parser.error("--batch-size must be >= 0")
    if args.min_delay < 0 or args.max_delay < 0:
        parser.error("--min-delay/--max-delay must be >= 0")
    if args.min_delay > args.max_delay:
        parser.error("--min-delay cannot be greater than --max-delay")
    return args


if __name__ == "__main__":
    try:
        raise SystemExit(run(parse_args()))
    except KeyboardInterrupt:
        print("Interrupted by user.")
        raise SystemExit(130)
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        raise SystemExit(1)
