#!/usr/bin/env python3
"""
Dual-source JD scraper for discovery-with-jd.csv.

Flow per row (for rows needing update):
1) Try externalApplyUrl (skip Workday URLs/ATS)
2) Fallback to LinkedIn job URL using an authenticated Chrome profile (Playwright)

Writes back to the same CSV in place.
"""

from __future__ import annotations

import asyncio
import csv
import os
import re
import ssl
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from lxml import html
from playwright.async_api import async_playwright, BrowserContext, Page


CSV_PATH = Path(
    os.path.expanduser(
        "~/Library/Mobile Documents/com~apple~CloudDocs/Job Applications/Combined Discovery/discovery-with-jd.csv"
    )
)
PROFILE_PATH = Path("/Users/raylim/Bespoke Software/LinkedInAutoApply/user_data")

REQUEST_DELAY_SECONDS = 2.0
BATCH_SIZE = 20
PROGRESS_EVERY = 40

SENTINELS = {"", "login_required", "description_not_found"}
MIN_DESC_LEN_EXTERNAL = 280
MIN_DESC_LEN_LINKEDIN = 220


@dataclass
class Stats:
    total_rows: int = 0
    rows_needing_update: int = 0
    rows_attempted: int = 0
    rows_updated: int = 0
    external_success: int = 0
    linkedin_success: int = 0
    still_not_found: int = 0
    login_required: int = 0
    workday_skipped: int = 0


class RateLimiter:
    def __init__(self, min_interval: float) -> None:
        self.min_interval = min_interval
        self._last_ts = 0.0

    async def wait(self) -> None:
        now = time.monotonic()
        elapsed = now - self._last_ts
        if elapsed < self.min_interval:
            await asyncio.sleep(self.min_interval - elapsed)
        self._last_ts = time.monotonic()


def normalize_text(text: str) -> str:
    text = text.replace("\r", "\n")
    text = re.sub(r"\u00a0", " ", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def is_workday(url: str, ats: str) -> bool:
    u = (url or "").lower()
    a = (ats or "").lower()
    return "workday" in a or "workdayjobs" in u or ".wd" in u


def needs_update(value: str) -> bool:
    v = (value or "").strip().lower()
    return v in SENTINELS


def read_csv_rows(path: Path) -> Tuple[List[str], List[Dict[str, str]]]:
    with path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames or []
        rows = list(reader)
    return fieldnames, rows


def write_csv_rows(path: Path, fieldnames: List[str], rows: List[Dict[str, str]]) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    tmp.replace(path)


def extract_external_description(html_text: str, source_url: str = "") -> Optional[str]:
    try:
        doc = html.fromstring(html_text)
    except Exception:
        return None

    for bad in doc.xpath("//script|//style|//noscript|//svg|//iframe|//header|//footer"):
        bad.drop_tree()

    candidates: List[str] = []

    xpaths = [
        "//*[contains(@class,'jobs-description') or contains(@class,'job-description') or contains(@id,'job-description')]",
        "//*[contains(@class,'description') and (contains(@class,'job') or contains(@id,'job'))]",
        "//*[contains(@class,'posting') and contains(@class,'content')]",
        "//*[contains(@class,'content') and contains(@class,'description')]",
        "//main",
        "//article",
    ]

    for xp in xpaths:
        nodes = doc.xpath(xp)
        for n in nodes[:4]:
            txt = normalize_text(n.text_content())
            if len(txt) >= 120:
                candidates.append(txt)

    # LinkedIn external pages often embed JSON with rich description
    for script in doc.xpath("//script[@type='application/ld+json']/text()")[:10]:
        if not script:
            continue
        m = re.search(r'"description"\s*:\s*"(.*?)"', script, flags=re.S)
        if m:
            t = m.group(1)
            t = t.encode("utf-8", "ignore").decode("unicode_escape", "ignore")
            t = re.sub(r"<[^>]+>", " ", t)
            t = normalize_text(t)
            if len(t) >= 120:
                candidates.append(t)

    # Site-specific heuristics
    host = urlparse(source_url).netloc.lower()
    if "greenhouse" in host:
        nodes = doc.xpath("//*[contains(@class,'content') or contains(@id,'content')]")
        for n in nodes[:4]:
            t = normalize_text(n.text_content())
            if len(t) >= 120:
                candidates.append(t)
    elif "smartrecruiters" in host:
        nodes = doc.xpath("//*[contains(@class,'job-description') or contains(@class,'opening-job-description')]")
        for n in nodes[:3]:
            t = normalize_text(n.text_content())
            if len(t) >= 120:
                candidates.append(t)
    elif "lever.co" in host:
        nodes = doc.xpath("//*[contains(@class,'posting-page') or contains(@class,'section-wrapper')]")
        for n in nodes[:5]:
            t = normalize_text(n.text_content())
            if len(t) >= 120:
                candidates.append(t)
    elif "ashby" in host:
        nodes = doc.xpath("//*[contains(@class,'job-posting') or contains(@class,'description')]")
        for n in nodes[:5]:
            t = normalize_text(n.text_content())
            if len(t) >= 120:
                candidates.append(t)

    if not candidates:
        full = normalize_text(doc.text_content())
        if len(full) >= MIN_DESC_LEN_EXTERNAL:
            return full
        return None

    best = max(candidates, key=len)

    # Cheap noise filter: reject pages that are clearly not job details
    bad_markers = ["enable javascript", "access denied", "cloudflare", "captcha", "sign in"]
    low = best.lower()
    if any(m in low for m in bad_markers) and len(best) < 900:
        return None

    return best if len(best) >= MIN_DESC_LEN_EXTERNAL else None


def fetch_external_url(url: str, timeout: int = 30) -> Optional[str]:
    req = Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
        },
    )
    ctx = ssl.create_default_context()
    with urlopen(req, timeout=timeout, context=ctx) as resp:
        content_type = resp.headers.get("Content-Type", "")
        charset = "utf-8"
        m = re.search(r"charset=([\w\-]+)", content_type, flags=re.I)
        if m:
            charset = m.group(1)
        data = resp.read()
        text = data.decode(charset, errors="ignore")
    return text


class LinkedInScraper:
    def __init__(self, profile_path: Path) -> None:
        self.profile_path = profile_path
        self._pw = None
        self.ctx: Optional[BrowserContext] = None
        self.page: Optional[Page] = None

    async def __aenter__(self) -> "LinkedInScraper":
        self._pw = await async_playwright().start()
        self.ctx = await self._pw.chromium.launch_persistent_context(
            user_data_dir=str(self.profile_path),
            channel="chrome",
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
            ],
        )
        pages = self.ctx.pages
        self.page = pages[0] if pages else await self.ctx.new_page()
        self.page.set_default_timeout(45000)
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self.ctx:
            await self.ctx.close()
        if self._pw:
            await self._pw.stop()

    async def extract_job_description(self, job_url: str) -> Tuple[Optional[str], str]:
        assert self.page is not None
        page = self.page

        try:
            await page.goto(job_url, wait_until="domcontentloaded", timeout=45000)
        except Exception as e:
            return None, f"linkedin_goto_error:{type(e).__name__}"

        await page.wait_for_timeout(2500)

        current = (page.url or "").lower()
        if "authwall" in current or "login" in current:
            return None, "login_required"

        # Try expanding collapsed description.
        expand_selectors = [
            "button.show-more-less-html__button",
            "button[aria-label*='more']",
            "button:has-text('See more')",
            "button.jobs-description__footer-button",
        ]
        for sel in expand_selectors:
            try:
                btn = page.locator(sel).first
                if await btn.count() > 0:
                    await btn.click(timeout=1500)
                    await page.wait_for_timeout(300)
            except Exception:
                pass

        selectors = [
            ".jobs-description-content__text",
            ".show-more-less-html__markup",
            ".jobs-box__html-content",
            ".jobs-description__container",
            "#job-details",
        ]

        best = ""
        for sel in selectors:
            try:
                loc = page.locator(sel)
                cnt = await loc.count()
                for i in range(min(cnt, 4)):
                    t = normalize_text(await loc.nth(i).inner_text())
                    if len(t) > len(best):
                        best = t
            except Exception:
                pass

        if len(best) >= MIN_DESC_LEN_LINKEDIN:
            return best, "ok"

        # Fallback: parse page text for job-description-ish chunks
        try:
            body_txt = normalize_text(await page.inner_text("body"))
            # keep from first "About the job" marker if present
            marker = "about the job"
            idx = body_txt.lower().find(marker)
            if idx >= 0:
                body_txt = body_txt[idx:]
            if len(body_txt) >= 500:
                return body_txt, "ok_body_fallback"
        except Exception:
            pass

        # Check if login wall appeared as content
        try:
            body = (await page.inner_text("body")).lower()
            if "join linkedin" in body or "sign in" in body and "jobs" not in body[:120]:
                return None, "login_required"
        except Exception:
            pass

        return None, "description_not_found"


async def scrape_all() -> int:
    if not CSV_PATH.exists():
        print(f"ERROR: CSV not found: {CSV_PATH}")
        return 2
    if not PROFILE_PATH.exists():
        print(f"ERROR: LinkedIn profile path not found: {PROFILE_PATH}")
        return 2

    fieldnames, rows = read_csv_rows(CSV_PATH)
    stats = Stats(total_rows=len(rows))

    if "full_job_description" not in fieldnames:
        print("ERROR: full_job_description column missing")
        return 2

    to_process_idx = [i for i, r in enumerate(rows) if needs_update(r.get("full_job_description", ""))]
    stats.rows_needing_update = len(to_process_idx)

    print(f"Loaded {stats.total_rows} rows. Need update: {stats.rows_needing_update}")
    if stats.rows_needing_update == 0:
        print("Nothing to do.")
        return 0

    limiter = RateLimiter(REQUEST_DELAY_SECONDS)
    dirty_since_write = 0

    async with LinkedInScraper(PROFILE_PATH) as li:
        for idx, row in enumerate(rows, start=1):
            # Progress over all 239 rows as requested
            if idx % PROGRESS_EVERY == 0:
                print(
                    f"Progress {idx}/{stats.total_rows} | "
                    f"attempted={stats.rows_attempted} updated={stats.rows_updated} "
                    f"ext_ok={stats.external_success} li_ok={stats.linkedin_success}"
                )

            if not needs_update(row.get("full_job_description", "")):
                continue

            stats.rows_attempted += 1
            rank = row.get("rank", str(idx))
            ext_url = (row.get("externalApplyUrl") or "").strip()
            li_url = (row.get("linkedinJobUrl") or "").strip()
            ats = (row.get("ats") or "").strip().lower()

            final_desc: Optional[str] = None
            final_state = "description_not_found"

            # Source 1: externalApplyUrl
            if ext_url:
                if is_workday(ext_url, ats):
                    stats.workday_skipped += 1
                else:
                    await limiter.wait()
                    try:
                        ext_html = await asyncio.to_thread(fetch_external_url, ext_url)
                        ext_desc = await asyncio.to_thread(extract_external_description, ext_html, ext_url)
                        if ext_desc:
                            final_desc = ext_desc
                            final_state = "ok_external"
                            stats.external_success += 1
                    except Exception:
                        pass

            # Source 2: LinkedIn fallback
            if final_desc is None and li_url:
                await limiter.wait()
                li_desc, li_state = await li.extract_job_description(li_url)
                if li_desc:
                    final_desc = li_desc
                    final_state = "ok_linkedin"
                    stats.linkedin_success += 1
                else:
                    final_state = li_state

            if final_desc:
                row["full_job_description"] = final_desc
                stats.rows_updated += 1
            else:
                row["full_job_description"] = (
                    "login_required" if final_state == "login_required" else "description_not_found"
                )
                if final_state == "login_required":
                    stats.login_required += 1
                else:
                    stats.still_not_found += 1

            dirty_since_write += 1
            print(
                f"[{stats.rows_attempted}/{stats.rows_needing_update}] rank={rank} "
                f"-> {final_state} len={len(row.get('full_job_description',''))}"
            )

            if dirty_since_write >= BATCH_SIZE:
                write_csv_rows(CSV_PATH, fieldnames, rows)
                dirty_since_write = 0
                print(f"Flushed batch of {BATCH_SIZE} updates to CSV")

    if dirty_since_write:
        write_csv_rows(CSV_PATH, fieldnames, rows)
        print(f"Flushed final batch of {dirty_since_write} updates to CSV")

    print("Done.")
    print(
        "Summary: "
        f"total={stats.total_rows}, need={stats.rows_needing_update}, "
        f"attempted={stats.rows_attempted}, updated={stats.rows_updated}, "
        f"ext_ok={stats.external_success}, li_ok={stats.linkedin_success}, "
        f"workday_skipped={stats.workday_skipped}, "
        f"still_not_found={stats.still_not_found}, login_required={stats.login_required}"
    )
    return 0


def main() -> None:
    try:
        code = asyncio.run(scrape_all())
    except KeyboardInterrupt:
        print("Interrupted.")
        code = 130
    sys.exit(code)


if __name__ == "__main__":
    main()
