#!/usr/bin/env python3
"""
Scrape LinkedIn full job descriptions from a source CSV and append results to output CSV.

Requirements satisfied:
- Python + Playwright browser automation
- Processes jobs in rank order
- Extracts visible JD text from article element (with safe fallbacks)
- Writes incrementally to CSV
- 3-second delay between requests
- Checkpoints every 20 jobs
- Marks login/captcha pages as "login_required"
"""

from __future__ import annotations

import csv
import json
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

SOURCE_CSV = Path(
    "~/Library/Mobile Documents/com~apple~CloudDocs/Job Applications/Combined Discovery/all-discovered-jobs.csv"
).expanduser()
OUTPUT_CSV = Path(
    "~/Library/Mobile Documents/com~apple~CloudDocs/Job Applications/Combined Discovery/discovery-with-jd.csv"
).expanduser()
PROGRESS_JSON = Path(
    "~/Library/Mobile Documents/com~apple~CloudDocs/Job Applications/Combined Discovery/jd-scrape-progress.json"
).expanduser()

SLEEP_SECONDS = 3
CHECKPOINT_EVERY = 20
NAV_TIMEOUT_MS = 35000


@dataclass
class JobRow:
    rank_key: Tuple[int, str]
    row: Dict[str, str]


def parse_rank_key(value: str | None) -> Tuple[int, str]:
    raw = (value or "").strip()
    try:
        return (int(raw), raw)
    except ValueError:
        return (10**9, raw)


def load_source_rows(path: Path) -> Tuple[List[str], List[Dict[str, str]]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        fieldnames = list(reader.fieldnames or [])
        rows = list(reader)
    return fieldnames, rows


def sorted_rows(rows: Iterable[Dict[str, str]]) -> List[Dict[str, str]]:
    wrapped = [JobRow(parse_rank_key(r.get("rank")), r) for r in rows]
    wrapped.sort(key=lambda x: x.rank_key)
    return [w.row for w in wrapped]


def load_existing_processed_ranks(output_path: Path) -> set[str]:
    if not output_path.exists():
        return set()
    with output_path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        return {str((r.get("rank") or "").strip()) for r in reader if (r.get("rank") or "").strip()}


def ensure_output_header(output_path: Path, fieldnames: List[str]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.exists() and output_path.stat().st_size > 0:
        return
    with output_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()


def rotate_if_incompatible_output(output_path: Path, expected_fieldnames: List[str], progress_path: Path) -> None:
    """If output CSV header doesn't match expected schema, archive and restart fresh."""
    if not output_path.exists() or output_path.stat().st_size == 0:
        return

    with output_path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        try:
            header = next(reader)
        except StopIteration:
            header = []

    if header == expected_fieldnames:
        return

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    bak_csv = output_path.with_suffix(output_path.suffix + f".bak-{stamp}")
    output_path.replace(bak_csv)

    bak_progress = None
    if progress_path.exists():
        bak_progress = progress_path.with_suffix(progress_path.suffix + f".bak-{stamp}")
        progress_path.replace(bak_progress)

    print("Detected incompatible existing output schema; archived old files:")
    print(f"- CSV: {bak_csv}")
    if bak_progress:
        print(f"- Progress: {bak_progress}")


def save_checkpoint(
    path: Path,
    *,
    total_rows: int,
    completed_rows: int,
    remaining_rows: int,
    last_rank: str,
    last_url: str,
    note: str,
) -> None:
    payload = {
        "updatedAt": datetime.now().isoformat(timespec="seconds"),
        "totalRows": total_rows,
        "completedRows": completed_rows,
        "remainingRows": remaining_rows,
        "lastCompletedRank": last_rank,
        "lastCompletedUrl": last_url,
        "note": note,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    tmp.replace(path)


def compact_text(text: str) -> str:
    text = text.replace("\xa0", " ")
    # Normalize repeated blank lines and excessive spaces.
    text = re.sub(r"\r\n?", "\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def is_login_required(page, url: str) -> bool:
    lowered_url = (url or "").lower()
    if any(k in lowered_url for k in ["/authwall", "/login", "captcha", "checkpoint"]):
        return True

    body = page.locator("body")
    body_text = body.inner_text(timeout=4000).lower() if body.count() else ""

    login_signals = [
        "sign in",
        "join now",
        "security verification",
        "are you human",
        "verify you are human",
        "captcha",
        "let's do a quick security check",
        "to view full job details",
        "login to view",
    ]
    if any(sig in body_text for sig in login_signals):
        # Avoid false positive on pages that mention sign in in nav only by ensuring no article text exists.
        has_article = page.locator("article").count() > 0
        if not has_article:
            return True
    return False


def click_show_more(page) -> None:
    selectors = [
        "button[aria-label*='see more' i]",
        "button[aria-label*='show more' i]",
        "button.show-more-less-html__button--more",
        "button:has-text('Show more')",
        "button:has-text('see more')",
        "button:has-text('Read more')",
    ]
    for sel in selectors:
        try:
            btn = page.locator(sel).first
            if btn.count() and btn.is_visible(timeout=1000):
                btn.click(timeout=2000)
                time.sleep(0.15)
        except Exception:
            continue


def extract_description(page) -> str:
    # Primary requirement: article element.
    primary_selectors = [
        "article",
        "article.jobs-description",
        "article.jobs-description__container",
    ]
    fallback_selectors = [
        "div.jobs-description-content__text",
        "div.show-more-less-html__markup",
        "section.show-more-less-html",
        "main",
    ]

    for sel in primary_selectors + fallback_selectors:
        try:
            loc = page.locator(sel).first
            if not loc.count():
                continue
            text = loc.inner_text(timeout=4000)
            text = compact_text(text)
            if len(text) >= 80:
                return text
        except Exception:
            continue

    return "description_not_found"


def scrape_one(page, url: str) -> str:
    if not url:
        return "missing_url"

    try:
        page.goto(url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        page.wait_for_timeout(900)

        final_url = page.url
        if is_login_required(page, final_url):
            return "login_required"

        click_show_more(page)
        text = extract_description(page)
        if text == "description_not_found" and is_login_required(page, final_url):
            return "login_required"
        return text

    except PlaywrightTimeoutError:
        # If timed out but page still partially rendered, try extraction.
        try:
            if is_login_required(page, page.url):
                return "login_required"
            click_show_more(page)
            text = extract_description(page)
            if text and text != "description_not_found":
                return text
        except Exception:
            pass
        return "timeout"
    except Exception as e:
        return f"error:{type(e).__name__}"


def main() -> int:
    if not SOURCE_CSV.exists():
        print(f"ERROR: source file not found: {SOURCE_CSV}", file=sys.stderr)
        return 1

    src_fieldnames, rows = load_source_rows(SOURCE_CSV)
    if not src_fieldnames:
        print("ERROR: source CSV has no headers", file=sys.stderr)
        return 1

    ordered = sorted_rows(rows)
    out_fields = list(src_fieldnames)
    if "full_job_description" not in out_fields:
        out_fields.append("full_job_description")

    rotate_if_incompatible_output(OUTPUT_CSV, out_fields, PROGRESS_JSON)
    ensure_output_header(OUTPUT_CSV, out_fields)
    already_done = load_existing_processed_ranks(OUTPUT_CSV)

    total = len(ordered)
    pending = [r for r in ordered if (r.get("rank") or "").strip() not in already_done]

    print(f"Total source rows: {total}")
    print(f"Already in output: {len(already_done)}")
    print(f"Pending scrape: {len(pending)}")

    if not pending:
        save_checkpoint(
            PROGRESS_JSON,
            total_rows=total,
            completed_rows=total,
            remaining_rows=0,
            last_rank="",
            last_url="",
            note="No pending rows. Output already complete.",
        )
        print("Nothing to do. Output already complete.")
        return 0

    completed_now = 0

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={"width": 1440, "height": 900},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            locale="en-US",
        )
        page = context.new_page()

        with OUTPUT_CSV.open("a", encoding="utf-8", newline="") as out_f:
            writer = csv.DictWriter(out_f, fieldnames=out_fields)

            for idx, row in enumerate(pending, start=1):
                rank = (row.get("rank") or "").strip()
                url = (row.get("linkedinJobUrl") or "").strip()

                desc = scrape_one(page, url)

                out_row = dict(row)
                out_row["full_job_description"] = desc
                writer.writerow(out_row)
                out_f.flush()

                completed_now += 1
                completed_total = len(already_done) + completed_now
                remaining = total - completed_total

                print(
                    f"[{completed_total}/{total}] rank={rank} "
                    f"status={'OK' if desc not in {'login_required','timeout','description_not_found'} and not desc.startswith('error:') else desc}"
                )

                if completed_total % CHECKPOINT_EVERY == 0:
                    save_checkpoint(
                        PROGRESS_JSON,
                        total_rows=total,
                        completed_rows=completed_total,
                        remaining_rows=remaining,
                        last_rank=rank,
                        last_url=url,
                        note="Periodic checkpoint",
                    )

                time.sleep(SLEEP_SECONDS)

        context.close()
        browser.close()

    save_checkpoint(
        PROGRESS_JSON,
        total_rows=total,
        completed_rows=total,
        remaining_rows=0,
        last_rank=(ordered[-1].get("rank") or "").strip() if ordered else "",
        last_url=(ordered[-1].get("linkedinJobUrl") or "").strip() if ordered else "",
        note="Scrape finished",
    )

    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
