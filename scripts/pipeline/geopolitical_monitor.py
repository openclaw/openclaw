#!/usr/bin/env python3
"""
geopolitical_monitor.py -- 지정학 모니터: 항공기/선박/뉴스/피자지수 지역 감시 파이프라인

Usage:
  python3 geopolitical_monitor.py --dry-run       # 수집만, 저장 없음
  python3 geopolitical_monitor.py --notify        # 수집 + 저장 + 텔레그램
  python3 geopolitical_monitor.py --list          # 워치리스트 출력
  python3 geopolitical_monitor.py --region hormuz # 특정 지역만
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import time
import signal
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path


# ── 타임아웃 핸들러 ──────────────────────────────────────────────────
class TimeoutError(Exception):
    """작업 타임아웃 초과 예외"""
    pass


def timeout_handler(signum, frame):
    raise TimeoutError(f"Operation timed out after {TARGET_TIMEOUT_SECS} seconds")


TARGET_TIMEOUT_SECS = 480  # 8분 (cron 600초보다 짧게)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.log import make_logger

WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))
OUTPUT_DIR = WORKSPACE / "memory" / "geopolitical"
CHARTS_DIR = OUTPUT_DIR / "charts"
WATCHLIST_FILE = OUTPUT_DIR / "watchlist.json"
LOGS_DIR = WORKSPACE / "logs"
LOG_FILE = LOGS_DIR / "geopolitical_monitor.log"
from shared.telegram import send_photo, send_album, send_group_chunked, GROUP_CHAT_ID, RON_TOPIC_ID

log = make_logger(log_file=LOG_FILE)

# ── 기본 워치리스트 ──────────────────────────────────────────────────

DEFAULT_WATCHLIST = {
    "hormuz": {
        "name": "호르무즈 해협", "bbox": [25.5, 55.5, 27.5, 57.5],
        "types": ["aircraft", "vessel", "news"],
        "keywords": ["Hormuz", "Strait of Hormuz", "Persian Gulf"],
        "source": "preset",
    },
    "taiwan": {
        "name": "대만 해협", "bbox": [23, 117, 26, 121],
        "types": ["aircraft", "vessel", "news"],
        "keywords": ["Taiwan Strait", "Taiwan", "Cross-strait"],
        "source": "preset",
    },
    "scs": {
        "name": "남중국해", "bbox": [5, 109, 18, 121],
        "types": ["aircraft", "vessel", "news"],
        "keywords": ["South China Sea", "Spratly", "Paracel"],
        "source": "preset",
    },
    "suez": {
        "name": "수에즈 운하", "bbox": [29.5, 32, 31.5, 33.5],
        "types": ["vessel", "news"],
        "keywords": ["Suez Canal", "Suez"],
        "source": "preset",
    },
    "malacca": {
        "name": "말라카 해협", "bbox": [1, 100, 4, 105],
        "types": ["vessel", "news"],
        "keywords": ["Malacca Strait", "Malacca"],
        "source": "preset",
    },
    "black_sea": {
        "name": "흑해", "bbox": [41, 28, 46, 41],
        "types": ["aircraft", "vessel", "news"],
        "keywords": ["Black Sea", "Crimea", "Ukraine naval"],
        "source": "preset",
    },
    "baltic": {
        "name": "발트해", "bbox": [54, 12, 60, 30],
        "types": ["vessel", "news"],
        "keywords": ["Baltic Sea", "Baltic"],
        "source": "preset",
    },
    "korea_dmz": {
        "name": "한반도 DMZ", "bbox": [37, 125, 39, 129],
        "types": ["aircraft", "news"],
        "keywords": ["Korean DMZ", "North Korea military", "Korean Peninsula"],
        "source": "preset",
    },
    "pentagon": {
        "name": "Pentagon", "bbox": [38.8, -77.1, 38.95, -76.95],
        "types": ["pizza"],
        "keywords": ["Pentagon"],
        "source": "preset",
    },
}

# ── 긴장도 키워드 사전 (LLM 없이 결정적 매칭) ─────────────────────────

TENSION_HIGH = [
    "war", "attack", "missile", "blockade", "invasion", "strike", "bomb",
    "전쟁", "공격", "미사일", "봉쇄", "침공", "폭격",
]
TENSION_MEDIUM = [
    "military", "deploy", "sanctions", "tension", "conflict", "navy", "troops",
    "군사", "배치", "제재", "긴장", "충돌", "해군", "병력",
]

# ── 지역-시장 매핑 (참고 표시 전용, 자동 승격 안 함) ───────────────────

REGION_MARKET_MAP = {
    "hormuz": ["WTI", "GOLD"],
    "taiwan": ["VIX"],
    "scs": ["BDI"],
    "suez": ["BDI", "WTI"],
    "malacca": ["BDI"],
    "black_sea": ["NATGAS", "WTI"],
    "baltic": ["BDI", "NATGAS"],
    "korea_dmz": ["USDKRW", "VIX"],
}

MARKET_INDICATORS_DIR = WORKSPACE / "memory" / "market-indicators"

# ── 지역-초크포인트 매핑 (IMF PortWatch) ──────────────────────────────

REGION_CHOKEPOINT_MAP = {
    "hormuz": "chokepoint6",
    "suez": "chokepoint1",
    "malacca": "chokepoint5",
    "taiwan": "chokepoint11",
    "scs": "chokepoint14",       # Luzon Strait proxy
    "black_sea": "chokepoint3",  # Bosporus
    "baltic": "chokepoint10",    # Oresund
}

# ── 지역 Tier 분류 ────────────────────────────────────────────────────
# Active: 매 실행마다 수집 (항공기+뉴스+선박 전부) — 능동적 위협 지역
# Baseline: 하루 1회 수집 (뉴스+선박만, 항공기 생략) — 잠재적 위협 지역

REGION_TIERS = {
    "hormuz": "active",
    "suez": "active",
    "black_sea": "active",
    "korea_dmz": "active",
    "pentagon": "active",
    "taiwan": "baseline",
    "scs": "baseline",
    "malacca": "baseline",
    "baltic": "baseline",
}
BASELINE_SKIP_TYPES = {"aircraft"}

# ── 국가 약어 매핑 ──────────────────────────────────────────────────

COUNTRY_SHORT = {
    "United Arab Emirates": "UAE", "United States": "US", "United Kingdom": "UK",
    "Republic of Korea": "KOR", "Russian Federation": "RUS",
    "Islamic Republic of Iran": "IRN", "Viet Nam": "VNM",
    "China": "CHN", "Japan": "JPN", "Taiwan": "TWN", "Singapore": "SGP",
    "Malaysia": "MYS", "Philippines": "PHL", "Pakistan": "PAK",
    "Turkey": "TUR", "Hungary": "HUN", "Lithuania": "LTU",
    "Georgia": "GEO", "Qatar": "QAT", "Thailand": "THA",
    "Bangladesh": "BGD", "Malta": "MLT", "Uzbekistan": "UZB",
}


def _country_abbr(name: str) -> str:
    """Country name → short code (3-letter)."""
    return COUNTRY_SHORT.get(name, name[:3].upper())


def _trend_arrow(current: float, avg: float | None) -> str:
    """Compare current to 7-day average → trend arrow."""
    if avg is None or avg == 0:
        return ""
    pct = (current - avg) / avg * 100
    if pct <= -15:
        return "↓"
    elif pct >= 15:
        return "↑"
    return "→"


def _format_countries_short(countries: dict, top_n: int = 3) -> str:
    """Top N countries abbreviated: 'KOR 23, CHN 7, 외 3'."""
    sorted_c = sorted(countries.items(), key=lambda x: -x[1])
    top = sorted_c[:top_n]
    parts = [f"{_country_abbr(c)} {n}" for c, n in top]
    rest = sum(n for _, n in sorted_c[top_n:])
    if rest > 0:
        parts.append(f"외 {rest}")
    return ", ".join(parts)


def _format_region_lines(rid: str, rdata: dict, watchlist: dict) -> list[str]:
    """Format a region's data into 1-3 lines for Telegram.

    Multi-line if aircraft countries exist, single-line otherwise.
    """
    name = watchlist.get(rid, {}).get("name", rid)
    aircraft = rdata.get("aircraft", {})
    vessels = rdata.get("vessels", {})
    news = rdata.get("news", {})

    ac = aircraft.get("count")
    vc = vessels.get("count")
    nc = news.get("count")
    countries = aircraft.get("countries", {})
    avg_ac = rdata.get("avg7_aircraft")
    avg_vc = rdata.get("avg7_vessels")

    metrics = []
    if ac is not None:
        arrow = _trend_arrow(ac, avg_ac)
        avg_str = f" (7일avg {avg_ac}{arrow})" if avg_ac is not None else ""
        metrics.append(f"✈️항공기 {ac}대{avg_str}")
    if nc is not None and nc > 0:
        metrics.append(f"📰뉴스 {nc}건")
    if vc is not None and vc > 0:
        pw = rdata.get("portwatch", {})
        extra = ""
        if pw.get("latest_total"):
            bd = pw.get("breakdown", {})
            top_type = max(bd.items(), key=lambda x: x[1], default=("", 0))
            type_kr = {"tanker": "탱커", "container": "컨테이너", "dry_bulk": "건화물",
                        "cargo": "화물", "roro": "로로"}.get(top_type[0], top_type[0])
            pw_date = pw.get("latest_date", "")
            date_tag = f" {pw_date}" if pw_date else ""
            extra = f" (추세:{date_tag} 공식통과 {pw['latest_total']}대, 최다선종: {type_kr} {top_type[1]}척)"
        elif avg_vc is not None:
            arrow_v = _trend_arrow(vc, avg_vc)
            extra = f" (avg ~{avg_vc}{arrow_v})"
        metrics.append(f"🚢선박 ~{vc}대{extra}")

    if not metrics:
        return [f"▸ {name}: 데이터 없음"]

    lines = []
    if countries:
        lines.append(f"▸ {name}")
        lines.append(f"  {' | '.join(metrics)}")
        lines.append(f"  → {_format_countries_short(countries)}")
    else:
        lines.append(f"▸ {name}: {' | '.join(metrics)}")
    return lines


# ── 워치리스트 관리 ──────────────────────────────────────────────────

def load_watchlist() -> dict:
    if WATCHLIST_FILE.exists():
        try:
            with open(WATCHLIST_FILE) as f:
                return json.load(f)
        except (json.JSONDecodeError, TypeError):
            log("Watchlist corrupted, using default", level="WARN")
    return dict(DEFAULT_WATCHLIST)


def save_watchlist(watchlist: dict):
    WATCHLIST_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(WATCHLIST_FILE, "w") as f:
        json.dump(watchlist, f, indent=2, ensure_ascii=False)


# ── OpenSky API (항공기) ─────────────────────────────────────────────

def fetch_opensky(bbox: list) -> dict:
    """바운딩박스 내 항공기 수 + 국가별 분류."""
    lat_min, lon_min, lat_max, lon_max = bbox
    url = (
        f"https://opensky-network.org/api/states/all"
        f"?lamin={lat_min}&lomin={lon_min}&lamax={lat_max}&lomax={lon_max}"
    )
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, OSError) as e:
        log(f"OpenSky error for bbox {bbox[:2]}: {e}", level="WARN")
        return {"count": 0, "countries": {}, "error": str(e)}

    states = data.get("states") or []
    countries: dict[str, int] = {}
    for s in states:
        country = s[2] if len(s) > 2 and s[2] else "Unknown"
        countries[country] = countries.get(country, 0) + 1
    return {"count": len(states), "countries": countries}


# ── Airplanes.live API (OpenSky fallback) ──────────────────────────

# ICAO 24-bit hex prefix → country (most relevant for monitored regions)
ICAO_COUNTRY_RANGES: list[tuple[int, int, str]] = [
    (0x010000, 0x017FFF, "Egypt"),
    (0x018000, 0x01FFFF, "Libya"),
    (0x060000, 0x067FFF, "Algeria"),
    (0x100000, 0x1FFFFF, "Russian Federation"),
    (0x200000, 0x27FFFF, "South Africa"),
    (0x300000, 0x33FFFF, "Italy"),
    (0x340000, 0x37FFFF, "Spain"),
    (0x380000, 0x3BFFFF, "France"),
    (0x3C0000, 0x3FFFFF, "Germany"),
    (0x400000, 0x43FFFF, "United Kingdom"),
    (0x440000, 0x447FFF, "Austria"),
    (0x448000, 0x44FFFF, "Belgium"),
    (0x458000, 0x45FFFF, "Denmark"),
    (0x460000, 0x467FFF, "Finland"),
    (0x478000, 0x47FFFF, "Norway"),
    (0x480000, 0x487FFF, "Netherlands"),
    (0x488000, 0x48FFFF, "Sweden"),
    (0x490000, 0x497FFF, "Switzerland"),
    (0x4A0000, 0x4A7FFF, "Czech Republic"),
    (0x4A8000, 0x4AFFFF, "Poland"),
    (0x4B0000, 0x4B7FFF, "Hungary"),
    (0x4B8000, 0x4BFFFF, "Turkey"),
    (0x4C0000, 0x4C7FFF, "Romania"),
    (0x4D0000, 0x4D03FF, "Lithuania"),
    (0x4D4000, 0x4D43FF, "Latvia"),
    (0x4D8000, 0x4D83FF, "Estonia"),
    (0x500000, 0x5003FF, "Ukraine"),
    (0x501C00, 0x501FFF, "Georgia"),
    (0x506000, 0x5063FF, "Malta"),
    (0x508000, 0x50FFFF, "Ukraine"),
    (0x510000, 0x5103FF, "Portugal"),
    (0x514000, 0x5143FF, "Singapore"),
    (0x600000, 0x6003FF, "Australia"),
    (0x680000, 0x6803FF, "New Zealand"),
    (0x706000, 0x706FFF, "Kuwait"),
    (0x710000, 0x717FFF, "Saudi Arabia"),
    (0x718000, 0x71FFFF, "Republic of Korea"),
    (0x720000, 0x727FFF, "North Korea"),
    (0x728000, 0x72FFFF, "Iraq"),
    (0x730000, 0x737FFF, "Islamic Republic of Iran"),
    (0x738000, 0x73FFFF, "Israel"),
    (0x740000, 0x747FFF, "Jordan"),
    (0x748000, 0x74FFFF, "Lebanon"),
    (0x760000, 0x767FFF, "Pakistan"),
    (0x770000, 0x777FFF, "Philippines"),
    (0x778000, 0x77FFFF, "Syria"),
    (0x780000, 0x7BFFFF, "China"),
    (0x7C0000, 0x7FFFFF, "Australia"),
    (0x800000, 0x83FFFF, "India"),
    (0x840000, 0x87FFFF, "Japan"),
    (0x880000, 0x887FFF, "Thailand"),
    (0x888000, 0x88FFFF, "Viet Nam"),
    (0x890000, 0x890FFF, "Yemen"),
    (0x894000, 0x894FFF, "Bahrain"),
    (0x895000, 0x8953FF, "Bangladesh"),
    (0x896000, 0x896FFF, "United Arab Emirates"),
    (0x898000, 0x898FFF, "Malaysia"),
    (0x899000, 0x8993FF, "Taiwan"),
    (0x89C000, 0x89CFFF, "Uzbekistan"),
    (0x8A0000, 0x8A7FFF, "Indonesia"),
    (0x8A8000, 0x8AFFFF, "Qatar"),
    (0xA00000, 0xAFFFFF, "United States"),
    (0xC00000, 0xC3FFFF, "Canada"),
    (0xE00000, 0xE3FFFF, "Argentina"),
    (0xE40000, 0xE7FFFF, "Brazil"),
]


def _icao_hex_to_country(hex_str: str) -> str:
    """ICAO 24-bit hex → country name. 'Unknown' if no match."""
    try:
        val = int(hex_str, 16)
    except (ValueError, TypeError):
        return "Unknown"
    for start, end, country in ICAO_COUNTRY_RANGES:
        if start <= val <= end:
            return country
    return "Unknown"


def _bbox_to_point_radius(bbox: list) -> tuple[float, float, float]:
    """Convert [lat_min, lon_min, lat_max, lon_max] → (center_lat, center_lon, radius_nm)."""
    lat_min, lon_min, lat_max, lon_max = bbox
    center_lat = (lat_min + lat_max) / 2
    center_lon = (lon_min + lon_max) / 2
    dlat = lat_max - lat_min
    dlon = (lon_max - lon_min) * math.cos(math.radians(center_lat))
    diagonal_deg = math.sqrt(dlat ** 2 + dlon ** 2)
    radius_nm = diagonal_deg * 60 / 2  # 1 degree ≈ 60 nm
    return center_lat, center_lon, min(radius_nm, 250)


def fetch_airplanes_live(bbox: list) -> dict:
    """Airplanes.live point/radius API — OpenSky fallback. No auth required."""
    center_lat, center_lon, radius_nm = _bbox_to_point_radius(bbox)
    url = f"https://api.airplanes.live/v2/point/{center_lat:.4f}/{center_lon:.4f}/{radius_nm:.0f}"
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, OSError) as e:
        log(f"Airplanes.live error for bbox {bbox[:2]}: {e}", level="WARN")
        return {"count": 0, "countries": {}, "error": str(e)}
    ac_list = data.get("ac") or []
    countries: dict[str, int] = {}
    for ac in ac_list:
        country = _icao_hex_to_country(ac.get("hex", ""))
        countries[country] = countries.get(country, 0) + 1
    return {"count": len(ac_list), "countries": countries}


def fetch_aircraft(bbox: list) -> dict:
    """Fetch aircraft: OpenSky → Airplanes.live fallback."""
    result = fetch_opensky(bbox)
    if result.get("error") or result.get("count", 0) == 0:
        log("OpenSky failed/empty, trying Airplanes.live fallback...")
        alt = fetch_airplanes_live(bbox)
        if not alt.get("error"):
            alt["source"] = "airplanes.live"
            return alt
        result["fallback_error"] = alt.get("error", "")
    else:
        result["source"] = "opensky"
    return result


# ── GDELT News API ──────────────────────────────────────────────────

def fetch_gdelt_news(keywords: list, timespan: str = "24h", _max_retries: int = 3) -> dict:
    """지역 키워드로 GDELT 뉴스 기사 수 조회. 429 시 지수 백오프 재시도."""
    query = " OR ".join(f'"{kw}"' for kw in keywords)
    encoded = urllib.request.quote(query)
    url = (
        f"https://api.gdeltproject.org/api/v2/doc/doc"
        f"?query={encoded}&mode=ArtList&format=json&maxrecords=100&timespan={timespan}"
    )
    last_err = ""
    for attempt in range(_max_retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"})
            with urllib.request.urlopen(req, timeout=45) as resp:
                raw = resp.read().decode("utf-8")
                if not raw.strip():
                    raise ValueError("empty response body")
                data = json.loads(raw)
            articles = data.get("articles") or []
            top_titles = [a.get("title", "")[:100] for a in articles[:5]]
            return {"count": len(articles), "top_titles": top_titles}
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < _max_retries - 1:
                wait = 15 * (attempt + 1)
                log(f"GDELT 429 for {keywords[0]}, retry in {wait}s ({attempt+1}/{_max_retries})")
                time.sleep(wait)
                continue
            last_err = str(e)
        except (urllib.error.URLError, json.JSONDecodeError, ValueError, OSError) as e:
            is_transient = (
                isinstance(e, json.JSONDecodeError)
                or "empty response" in str(e)
                or "timed out" in str(e)
            )
            if is_transient and attempt < _max_retries - 1:
                wait = 10 * (attempt + 1)
                log(f"GDELT transient error for {keywords[0]}, retry in {wait}s ({attempt+1}/{_max_retries})")
                time.sleep(wait)
                continue
            last_err = str(e)
            break
    log(f"GDELT failed for {keywords[0]}: {last_err}", level="WARN")
    return {"count": 0, "top_titles": [], "error": last_err}


# ── GPR/EPU 리스크 지수 ──────────────────────────────────────────────

GPR_XLS_URL = "https://www.matteoiacoviello.com/gpr_files/data_gpr_daily_recent.xls"
EPU_US_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=USEPUINDXD"


def fetch_gpr_epu() -> dict:
    """GPR 지정학 리스크 + EPU 경제정책 불확실성 지수. 실패 시 부분 반환."""
    result: dict = {}
    # GPR Index (XLS — requires pandas)
    try:
        import pandas as pd
        req = urllib.request.Request(GPR_XLS_URL, headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            import io
            df = pd.read_excel(io.BytesIO(resp.read()))
        if "GPRD" in df.columns:
            val = df["GPRD"].dropna().iloc[-1]
            vals = df["GPRD"].dropna().tail(20)
            avg20 = vals.mean()
            std20 = vals.std()
            zscore = (val - avg20) / std20 if std20 > 0 else 0
            result["gpr"] = float(val)
            result["gpr_avg"] = round(float(avg20), 1)
            result["gpr_zscore"] = round(float(zscore), 2)
            log(f"GPR: {val:.1f} (avg={avg20:.1f}, z={zscore:.2f})")
    except ImportError:
        log("pandas not installed, skipping GPR", level="WARN")
    except Exception as e:
        log(f"GPR fetch error: {e}", level="WARN")
    # EPU US Index (FRED CSV — no pandas needed)
    try:
        import csv as csv_mod
        req = urllib.request.Request(EPU_US_CSV_URL, headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            text = resp.read().decode("utf-8")
        rows = list(csv_mod.reader(text.strip().split("\n")))
        vals = [float(r[1]) for r in rows[1:] if len(r) >= 2 and r[1] != "."]
        if vals:
            val = vals[-1]
            recent = vals[-20:] if len(vals) >= 20 else vals
            avg20 = sum(recent) / len(recent)
            std20 = (sum((v - avg20) ** 2 for v in recent) / len(recent)) ** 0.5
            zscore = (val - avg20) / std20 if std20 > 0 else 0
            result["epu_us"] = float(val)
            result["epu_us_avg"] = round(float(avg20), 1)
            result["epu_us_zscore"] = round(float(zscore), 2)
            log(f"EPU_US: {val:.0f} (avg={avg20:.0f}, z={zscore:.2f})")
    except Exception as e:
        log(f"EPU fetch error: {e}", level="WARN")
    return result


# ── 피자지수 (pizzint.watch) ────────────────────────────────────────

def fetch_pizza_index() -> dict:
    """playwright로 pizzint.watch 스크래핑 -> DOUGHCON 레벨."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        log("playwright not installed, skipping pizza index", level="WARN")
        return {"doughcon": None, "error": "playwright not installed"}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.goto("https://pizzint.watch/", timeout=30000)
            page.wait_for_load_state("networkidle", timeout=15000)
            text = page.inner_text("body")
            browser.close()
    except Exception as e:
        log(f"Pizza index scrape error: {e}", level="WARN")
        return {"doughcon": None, "error": str(e)}
    return _parse_pizza_text(text)


def _parse_pizza_text(text: str) -> dict:
    """Parse DOUGHCON level from page text."""
    result: dict = {"doughcon": None, "label": "", "alerts": 0, "status": ""}
    m = re.search(r"DOUGHCON\s*(\d)", text, re.IGNORECASE)
    if m:
        result["doughcon"] = int(m.group(1))
    labels = {1: "COCKED PISTOL", 2: "FAST PACE", 3: "ROUND HOUSE",
              4: "DOUBLE TAKE", 5: "FADE OUT"}
    if result["doughcon"] in labels:
        result["label"] = labels[result["doughcon"]]
    m = re.search(r"(\d+)\s*alerts?", text, re.IGNORECASE)
    if m:
        result["alerts"] = int(m.group(1))
    if "OPERATIONAL" in text.upper():
        result["status"] = "OPERATIONAL"
    elif "DEGRADED" in text.upper():
        result["status"] = "DEGRADED"
    return result


# ── 선박 데이터 (myshiptracking.com API + 스크린샷) ──────────────────


def fetch_vessel_count(bbox: list, zoom: int = 10) -> int:
    """myshiptracking 내부 API로 bbox 내 선박 수 조회. 실패 시 0."""
    lat_min, lon_min, lat_max, lon_max = bbox
    url = (
        f"https://www.myshiptracking.com/requests/vesselsonmaptempTTT.php"
        f"?type=json&minlat={lat_min}&maxlat={lat_max}"
        f"&minlon={lon_min}&maxlon={lon_max}"
        f"&zoom={zoom}&selid=-1&seltype=0&timecode=-1"
    )
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0",
        "Referer": "https://www.myshiptracking.com/",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = resp.read().decode("utf-8", errors="replace")
        lines = [ln for ln in data.strip().split("\n") if ln.strip()]
        # 첫 2줄은 헤더(timestamp, hasDetails), 나머지가 선박 데이터
        vessel_lines = lines[2:] if len(lines) > 2 else []
        count = len(vessel_lines)
        log(f"Vessel API: {count} vessels in bbox (zoom={zoom})")
        return count
    except Exception as e:
        log(f"Vessel API error: {e}", level="WARN")
        return 0


def fetch_portwatch_transit(region_id: str, days: int = 7) -> dict:
    """IMF PortWatch: chokepoint daily transit data. Returns latest + 7-day avg."""
    cp = REGION_CHOKEPOINT_MAP.get(region_id)
    if not cp:
        return {}
    # ArcGIS FeatureServer doesn't support combined portid+date WHERE clause.
    # Fetch latest N records for the chokepoint and filter locally.
    where_clause = f"portid='{cp}'"
    url = (
        "https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/"
        "Daily_Chokepoints_Data/FeatureServer/0/query"
        f"?where={urllib.request.quote(where_clause)}"
        "&outFields=date,n_total,n_tanker,n_container,n_dry_bulk,n_cargo,n_roro"
        "&orderByFields=date+DESC"
        f"&resultRecordCount={days + 2}&f=json"
    )
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, OSError) as e:
        log(f"PortWatch error for {region_id}: {e}", level="WARN")
        return {}
    features = data.get("features") or []
    if not features:
        return {}
    rows = [f["attributes"] for f in features]
    latest = rows[0]
    date_ms = latest.get("date", 0)
    latest_date = datetime.utcfromtimestamp(date_ms / 1000).strftime("%Y-%m-%d") if date_ms else ""
    totals = [r["n_total"] for r in rows if r.get("n_total") is not None]
    avg_7d = round(sum(totals) / len(totals), 1) if totals else 0
    return {
        "latest_total": latest.get("n_total", 0),
        "latest_date": latest_date,
        "avg_7d": avg_7d,
        "breakdown": {
            "tanker": latest.get("n_tanker", 0),
            "container": latest.get("n_container", 0),
            "dry_bulk": latest.get("n_dry_bulk", 0),
            "cargo": latest.get("n_cargo", 0),
            "roro": latest.get("n_roro", 0),
        },
        "source": "imf_portwatch",
    }


def capture_vessel_map(region_id: str, bbox: list) -> Path | None:
    """playwright로 지역별 선박 지도 스크린샷 캡처. 카운트는 fetch_vessel_count() 사용."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        log("playwright not installed, skipping vessel screenshot", level="WARN")
        return None
    CHARTS_DIR.mkdir(parents=True, exist_ok=True)
    lat_min, lon_min, lat_max, lon_max = bbox
    center_lat = (lat_min + lat_max) / 2
    center_lon = (lon_min + lon_max) / 2
    max_span = max(lat_max - lat_min, lon_max - lon_min)
    zoom = max(4, min(8, round(8 - math.log2(max_span))))
    url = f"https://www.myshiptracking.com/?zoom={zoom}&lat={center_lat}&lng={center_lon}"
    today = datetime.now().strftime("%Y-%m-%d")
    screenshot_path = CHARTS_DIR / f"{today}_{region_id}_vessels.png"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1280, "height": 800})
            page.goto(url, timeout=30000)
            page.wait_for_timeout(5000)
            for btn_text in ["Accept", "Close", "OK", "Agree"]:
                try:
                    page.click(f"button:has-text('{btn_text}')", timeout=2000)
                except Exception:
                    pass
            # 팝업/배너 제거 + Leaflet 컨트롤 제거
            page.evaluate("""() => {
                document.querySelectorAll(
                    '.modal, .popup, .overlay, .banner, [class*="promo"], [class*="cookie"]'
                ).forEach(el => el.remove());
                document.querySelectorAll('div, aside, section').forEach(el => {
                    if (el.textContent && el.textContent.includes('Mobile Apps')
                        && el.offsetHeight < 300) el.remove();
                });
                document.querySelectorAll('.leaflet-control-container')
                    .forEach(el => el.remove());
            }""")
            page.wait_for_timeout(1000)
            # 지도 요소만 직접 캡처 (사이드바/헤더/푸터 완전 제외)
            captured = False
            for sel in ['.leaflet-container', '#map', '[id*="map"]', 'canvas']:
                try:
                    loc = page.locator(sel).first
                    if loc.is_visible(timeout=3000):
                        loc.screenshot(path=str(screenshot_path))
                        captured = True
                        break
                except Exception:
                    continue
            if not captured:
                page.screenshot(path=str(screenshot_path))
            browser.close()
        log(f"Vessel screenshot: {screenshot_path.name}")
        return screenshot_path
    except Exception as e:
        log(f"Vessel screenshot error for {region_id}: {e}", level="WARN")
        return None


def _annotate_screenshot(path: Path, region_name: str, vessel_count: int) -> Path:
    """Pillow로 스크린샷 크롭 + 지도 중앙 상단 라벨 오버레이. 실패 시 원본 반환."""
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        log("Pillow not installed, returning raw screenshot", level="WARN")
        return path
    try:
        img = Image.open(path)
        w, h = img.size
        # 동적 크롭: 사이트 배경색(~25,58,128) 영역 자동 감지+제거
        def _is_site_bg(px):
            return abs(px[0] - 25) < 30 and abs(px[1] - 58) < 30 and abs(px[2] - 128) < 30
        # 우측에서 왼쪽으로 스캔
        crop_right = 0
        for x in range(w - 1, w // 2, -1):
            if not _is_site_bg(img.getpixel((x, h // 2))):
                crop_right = w - x - 1
                break
        # 하단에서 위로 스캔
        crop_bottom = 0
        for y in range(h - 1, h // 2, -1):
            if not _is_site_bg(img.getpixel((w // 3, y))):
                crop_bottom = h - y - 1
                break
        # 최소 트림 (Leaflet 컨트롤 제거)
        crop_top = max(50, crop_top if 'crop_top' in dir() else 50)
        crop_left = max(55, 55)
        crop_right = max(crop_right + 5, 35)   # +5 여유
        crop_bottom = max(crop_bottom + 5, 20)  # +5 여유
        if h > crop_top + crop_bottom + 100 and w > crop_left + crop_right + 100:
            img = img.crop((crop_left, crop_top, w - crop_right, h - crop_bottom))
        draw = ImageDraw.Draw(img, "RGBA")
        time_str = datetime.now().strftime("%H:%M KST")
        if vessel_count > 0:
            label = f"{region_name} — ~{vessel_count}대 ({time_str})"
        else:
            label = f"{region_name} ({time_str})"
        # 폰트 로드 (macOS → fallback)
        font = None
        for font_path in ["/System/Library/Fonts/AppleSDGothicNeo.ttc",
                          "/System/Library/Fonts/Supplemental/Arial.ttf"]:
            try:
                font = ImageFont.truetype(font_path, 28)
                break
            except (IOError, OSError):
                continue
        if font is None:
            font = ImageFont.load_default()
        bbox_text = draw.textbbox((0, 0), label, font=font)
        tw, th = bbox_text[2] - bbox_text[0], bbox_text[3] - bbox_text[1]
        pad = 12
        # 중앙 상단 배치
        new_w = img.size[0]
        bx = (new_w - tw - pad * 2) // 2
        by = 10
        draw.rectangle([(bx, by), (bx + tw + pad * 2, by + th + pad * 2)],
                        fill=(0, 0, 0, 200))
        draw.text((bx + pad, by + pad), label, fill=(255, 255, 255, 255), font=font)
        img.save(path)
        return path
    except Exception as e:
        log(f"Screenshot annotation error: {e}", level="WARN")
        return path


# ── 이상치 감지 ──────────────────────────────────────────────────────

def load_history(days: int = 7) -> list[dict]:
    """Load last N days of geopolitical data."""
    history = []
    today = datetime.now().date()
    for i in range(1, days + 1):
        filepath = OUTPUT_DIR / f"{(today - timedelta(days=i)).isoformat()}.json"
        if filepath.exists():
            try:
                with open(filepath) as f:
                    history.append(json.load(f))
            except (json.JSONDecodeError, TypeError):
                continue
    return history


def compute_averages(history: list[dict]) -> dict:
    """Compute 7-day averages per region (aircraft, news, vessels)."""
    acc: dict[str, dict[str, list]] = {}
    for record in history:
        for rid, rdata in record.get("regions", {}).items():
            if rid not in acc:
                acc[rid] = {"aircraft": [], "news": [], "vessels": []}
            ac = rdata.get("aircraft", {}).get("count")
            if ac is not None:
                acc[rid]["aircraft"].append(ac)
            nc = rdata.get("news", {}).get("count")
            if nc is not None:
                acc[rid]["news"].append(nc)
            vc = rdata.get("vessels", {}).get("count")
            if vc is not None and vc > 0:  # 0 = JS 실패, 평균에서 제외
                acc[rid]["vessels"].append(vc)
    return {
        rid: {
            "avg_aircraft": sum(d["aircraft"]) / len(d["aircraft"]) if d["aircraft"] else None,
            "avg_news": sum(d["news"]) / len(d["news"]) if d["news"] else None,
            "avg_vessels": sum(d["vessels"]) / len(d["vessels"]) if d["vessels"] else None,
        }
        for rid, d in acc.items()
    }


def _compute_tension(titles: list[str]) -> tuple[str, list[str]]:
    """키워드 매칭으로 뉴스 긴장도 판정 (LLM 없음). 감지 키워드도 반환."""
    text = " ".join(titles).lower()
    matched: list[str] = []
    high_kw = 0
    for kw in TENSION_HIGH:
        if kw.lower() in text:
            high_kw += 1
            matched.append(kw)
    med_kw = 0
    for kw in TENSION_MEDIUM:
        if kw.lower() in text:
            med_kw += 1
            matched.append(kw)
    if high_kw >= 2:
        return "high", matched
    if high_kw >= 1 or med_kw >= 3:
        return "medium", matched
    return "low", matched


def detect_anomalies(today_data: dict, averages: dict) -> list[dict]:
    """Detect anomalies: aircraft decrease only, news volume+keywords, DOUGHCON."""
    anomalies = []
    for rid, rdata in today_data.get("regions", {}).items():
        avg = averages.get(rid, {})
        # Aircraft — 감소만 감지 (증가는 상업 노이즈)
        ac = rdata.get("aircraft", {}).get("count")
        avg_ac = avg.get("avg_aircraft")
        if ac is not None and avg_ac and avg_ac > 0:
            pct = (ac - avg_ac) / avg_ac * 100
            if pct <= -50:
                anomalies.append({"region": rid, "type": "aircraft_avoidance", "severity": "high",
                                  "value": ac, "avg": round(avg_ac, 1), "pct_change": round(pct)})
            elif pct <= -30:
                anomalies.append({"region": rid, "type": "aircraft_avoidance", "severity": "medium",
                                  "value": ac, "avg": round(avg_ac, 1), "pct_change": round(pct)})
        # Vessels — 감소만 감지 (항공기와 동일 로직, count=0은 JS 실패이므로 제외)
        vc = rdata.get("vessels", {}).get("count")
        avg_vc = avg.get("avg_vessels")
        if vc is not None and vc > 0 and avg_vc and avg_vc > 0:
            pct = (vc - avg_vc) / avg_vc * 100
            if pct <= -50:
                anomalies.append({"region": rid, "type": "vessel_avoidance", "severity": "high",
                                  "value": vc, "avg": round(avg_vc, 1), "pct_change": round(pct)})
            elif pct <= -30:
                anomalies.append({"region": rid, "type": "vessel_avoidance", "severity": "medium",
                                  "value": vc, "avg": round(avg_vc, 1), "pct_change": round(pct)})
        # News — 볼륨 + 키워드 결합
        nc = rdata.get("news", {}).get("count")
        avg_nc = avg.get("avg_news")
        if nc is not None and avg_nc and avg_nc > 0:
            pct = (nc - avg_nc) / avg_nc * 100
            titles = rdata.get("news", {}).get("top_titles", [])
            tension, matched_kw = _compute_tension(titles)
            # 볼륨만 높고 긴장도 낮으면 무시 (평화 회담 등)
            if pct >= 200 and tension in ("high", "medium"):
                anomalies.append({"region": rid, "type": "news", "severity": "high",
                                  "value": nc, "avg": round(avg_nc, 1), "pct_change": round(pct),
                                  "tension": tension, "matched_keywords": matched_kw})
            elif pct >= 100 and tension != "low":
                anomalies.append({"region": rid, "type": "news", "severity": "medium",
                                  "value": nc, "avg": round(avg_nc, 1), "pct_change": round(pct),
                                  "tension": tension, "matched_keywords": matched_kw})
    # DOUGHCON
    pi = today_data.get("pentagon_index", {})
    dc = pi.get("doughcon")
    if dc is not None and dc <= 3:
        anomalies.append({"region": "pentagon", "type": "doughcon", "severity": "high",
                          "value": dc, "label": pi.get("label", "")})
    return anomalies


# ── 시장 컨텍스트 & 판정 레벨 ──────────────────────────────────────────

def load_market_context() -> dict[str, float]:
    """오늘(또는 가장 최근) 시장 지표 로드 — 참고 표시용.

    memory/market-indicators/{date}.json에서 change_pct만 추출.
    오늘 → 어제 → 그저께 fallback (주말/공휴일 대비).
    실패 시 빈 dict 반환 — 시장 데이터 없어도 파이프라인 정상 동작.
    """
    today = datetime.now().date()
    for i in range(3):
        filepath = MARKET_INDICATORS_DIR / f"{(today - timedelta(days=i)).isoformat()}.json"
        if filepath.exists():
            try:
                with open(filepath) as f:
                    data = json.load(f)
                indicators = data.get("indicators", {})
                return {k: v.get("change_pct", 0) for k, v in indicators.items()
                        if isinstance(v, dict)}
            except (json.JSONDecodeError, TypeError, KeyError):
                continue
    return {}


def compute_alert_level(anomalies: list[dict]) -> tuple[str, str]:
    """3단계 판정: Normal / Watch / Alert.

    Alert: 물리적 행동(항공기 회피) + 정보(뉴스/DOUGHCON) 동시, OR DOUGHCON ≤2 단독.
    Watch: 단일 소스 이상.
    Normal: 이상 없음.
    """
    has_avoidance = any(a["type"] in ("aircraft_avoidance", "vessel_avoidance") for a in anomalies)
    has_news_high = any(a["type"] == "news" and a["severity"] == "high" for a in anomalies)
    has_doughcon = any(a["type"] == "doughcon" for a in anomalies)

    if has_avoidance and (has_news_high or has_doughcon):
        return "alert", "복수 독립 소스 확인"
    dc_val = next((a["value"] for a in anomalies if a["type"] == "doughcon"), None)
    if dc_val is not None and dc_val <= 2:
        return "alert", f"DOUGHCON {dc_val}"
    if anomalies:
        return "watch", "단일 소스 이상"
    return "normal", "전 지역 정상"


# ── 텔레그램 알림 ────────────────────────────────────────────────────

def format_telegram_message(today_data: dict, anomalies: list, watchlist: dict) -> str:
    """Format Telegram notification text (v4: detailed with averages, countries, tiers)."""
    regions = today_data.get("regions", {})
    pi = today_data.get("pentagon_index", {})
    market_ctx = today_data.get("market_context", {})
    alert_level = today_data.get("alert_level", "normal").capitalize()
    collected_at = today_data.get("collected_at", "")

    # Date header
    try:
        dt = datetime.fromisoformat(collected_at)
        date_str = dt.strftime("%Y-%m-%d %H:%M KST")
    except (ValueError, TypeError):
        date_str = datetime.now().strftime("%Y-%m-%d %H:%M KST")

    lines = [f"🌐 *지정학 모니터* [{alert_level}]", date_str, ""]

    if anomalies:
        # Anomaly highlight section
        by_region: dict[str, list] = {}
        for a in anomalies:
            by_region.setdefault(a["region"], []).append(a)
        for rid, ra in by_region.items():
            if rid == "pentagon":
                continue
            name = watchlist.get(rid, {}).get("name", rid)
            lines.append(f"⚠️ *{name}*")
            for a in ra:
                if a["type"] == "aircraft_avoidance":
                    lines.append(f"  ✈️ 항공기: {a['value']}대 (7일 평균 {a['avg']}대, {a['pct_change']}%) — 영공 회피")
                elif a["type"] == "vessel_avoidance":
                    lines.append(f"  🚢 선박: ~{a['value']}대 (7일 평균 ~{a['avg']}대, {a['pct_change']}%) — 해역 회피")
                elif a["type"] == "news":
                    kw_str = ", ".join(a.get("matched_keywords", [])[:5])
                    kw_part = f" — {kw_str}" if kw_str else ""
                    lines.append(f"  📰 뉴스: {a['value']}건 (+{a['pct_change']}%){kw_part}")
            lines.append("")

        # Remaining normal regions (compact with details)
        anomaly_rids = set(by_region.keys())
        normal_rids = [rid for rid in regions if rid not in anomaly_rids]
        if normal_rids:
            for rid in normal_rids:
                lines.extend(_format_region_lines(rid, regions[rid], watchlist))
            lines.append("")
    else:
        # Normal mode: group by tier, detailed
        active_rids = [rid for rid in regions if REGION_TIERS.get(rid) == "active"]
        baseline_rids = [rid for rid in regions if REGION_TIERS.get(rid) != "active"]

        if active_rids:
            lines.append("📍 *능동 감시* (항공·뉴스·선박 실시간)")
            for rid in active_rids:
                lines.extend(_format_region_lines(rid, regions[rid], watchlist))
            lines.append("")

        if baseline_rids:
            lines.append("📍 *기준 감시* (뉴스·선박 위주)")
            for rid in baseline_rids:
                lines.extend(_format_region_lines(rid, regions[rid], watchlist))
            lines.append("")

    if pi.get("doughcon") is not None:
        dc = pi["doughcon"]
        emoji = "🔴" if dc <= 2 else "🟡" if dc <= 3 else "🍕"
        # DOUGHCON 레벨 설명 (PizzINT 피자 배달 지수)
        dc_desc = {
            1: "미 정보기관 인근 피자 주문 폭증 — 최고 경계",
            2: "피자 주문 급증 — 고경계",
            3: "평소 대비 피자 주문 증가 — 주의",
            4: "피자 주문 소폭 증가 — 관심",
            5: "피자 주문 정상 — 평상시",
        }.get(dc, "")
        lines.append(f"{emoji} DOUGHCON {dc} — {pi.get('label', '')}")
        lines.append(f"  ({pi.get('alerts', 0)} alerts | {pi.get('status', '')})")
        if dc_desc:
            lines.append(f"  _{dc_desc}_")
        lines.append("")

    # 시장 데이터 참고 표시 (이상 발생 시에만)
    if market_ctx and anomalies:
        relevant_indicators = set()
        for a in anomalies:
            rid = a.get("region", "")
            relevant_indicators.update(REGION_MARKET_MAP.get(rid, []))
        market_parts = []
        for ind in sorted(relevant_indicators):
            if ind in market_ctx:
                val = market_ctx[ind]
                sign = "+" if val > 0 else ""
                market_parts.append(f"{ind} {sign}{val:.1f}%")
        if market_parts:
            lines.append(f"💹 참고 시장: {' | '.join(market_parts)}")
            lines.append("")

    # GPR/EPU 지정학·경제 리스크 지수 (항상 표시, 해석 포함)
    gpr_epu = today_data.get("gpr_epu", {})
    gpr_val = gpr_epu.get("gpr")
    epu_val = gpr_epu.get("epu_us")
    if gpr_val is not None or epu_val is not None:
        lines.append("📊 *리스크 지수* (전일 기준)")
        if gpr_val is not None:
            gpr_z = gpr_epu.get("gpr_zscore", 0)
            gpr_avg = gpr_epu.get("gpr_avg")
            gpr_level = ("🔴 극단" if gpr_z >= 3 else "🟠 높음" if gpr_z >= 2
                         else "🟡 관심" if gpr_z >= 1 else "🟢 정상"
                         if gpr_z > -1 else "🔵 낮음")
            avg_str = f", 20일평균 {gpr_avg:.0f}" if gpr_avg else ""
            lines.append(f"  GPR: {gpr_val:.0f}{avg_str} — {gpr_level}")
            lines.append("  _전세계 신문의 군사긴장·테러 보도 빈도_")
            lines.append("  _기준: 평시~100 | 이란위기~200 | 우크라전쟁~350_")
        if epu_val is not None:
            epu_z = gpr_epu.get("epu_us_zscore", 0)
            epu_avg = gpr_epu.get("epu_us_avg")
            epu_level = ("🔴 극단" if epu_z >= 3 else "🟠 높음" if epu_z >= 2
                         else "🟡 관심" if epu_z >= 1 else "🟢 정상"
                         if epu_z > -1 else "🔵 낮음")
            avg_str = f", 20일평균 {epu_avg:.0f}" if epu_avg else ""
            lines.append(f"  EPU: {epu_val:.0f}{avg_str} — {epu_level}")
            lines.append("  _미국 주요지 정책불확실성 보도 빈도_")
            lines.append("  _기준: 평시~110 | 관세전쟁~300 | 코로나~900_")
        lines.append("")

    sources = "OpenSky(항공) · GDELT(뉴스) · PizzINT(피자지수) · IMF PortWatch(추세)"
    lines.append(f"🔗 {sources}")
    return "\n".join(lines)


def notify_telegram(today_data: dict, anomalies: list, screenshots: dict):
    """Send geopolitical summary to 지식사랑방 Ron topic."""
    watchlist = load_watchlist()
    msg = format_telegram_message(today_data, anomalies, watchlist)

    # Text → shared telegram 모듈 경유
    if send_group_chunked(msg, topic_id=RON_TOPIC_ID):
        log("Telegram text sent (지식사랑방 론 토픽)")
    else:
        log("Telegram text send failed", level="WARN")

    # Vessel screenshots — 앨범 전송 (fallback: 개별 sendPhoto)
    regions = today_data.get("regions", {})
    album_photos = []
    date_str = datetime.now().strftime("%Y-%m-%d")
    for rid, path in screenshots.items():
        if path and Path(path).exists():
            name = watchlist.get(rid, {}).get("name", rid)
            vc = regions.get(rid, {}).get("vessels", {}).get("count", 0)
            count_str = f"~{vc}대" if vc > 0 else ""
            if not album_photos:
                caption = f"🚢 지정학 모니터 — 선박 현황 ({date_str})\n{name} {count_str}".strip()
            else:
                caption = f"🚢 {name} {count_str}".strip()
            album_photos.append({"path": path, "caption": caption})
    if album_photos:
        if not send_album(GROUP_CHAT_ID, album_photos, topic_id=RON_TOPIC_ID):
            log("Album failed, falling back to individual photos")
            for p in album_photos:
                send_photo(GROUP_CHAT_ID, str(p["path"]), caption=p["caption"],
                           topic_id=RON_TOPIC_ID)


# ── 차트 정리 ────────────────────────────────────────────────────────

def cleanup_old_charts(days: int = 7):
    """Remove screenshots older than N days."""
    if not CHARTS_DIR.exists():
        return
    cutoff = datetime.now() - timedelta(days=days)
    for f in CHARTS_DIR.iterdir():
        if f.suffix == ".png":
            try:
                if datetime.fromtimestamp(f.stat().st_mtime) < cutoff:
                    f.unlink()
            except Exception:
                pass


# ── 수집 메인 ────────────────────────────────────────────────────────

def collect_all(watchlist: dict, target_region: str | None = None,
                tier_filter: str | None = None) -> tuple[dict, dict]:
    """Collect data for all (or one) region.

    tier_filter: "active" or "baseline" — collect only that tier.
                 None — smart mode (active always, baseline only if not yet today).
    """
    today_data = {
        "date": datetime.now().strftime("%Y-%m-%d"),
        "collected_at": datetime.now().isoformat(),
        "regions": {},
        "pentagon_index": {},
        "anomalies": [],
        "summary": "",
    }
    screenshots: dict[str, Path | None] = {}

    # Load existing daily data for baseline carry-forward
    existing_data: dict = {}
    today_file = OUTPUT_DIR / f"{datetime.now().strftime('%Y-%m-%d')}.json"
    if today_file.exists():
        try:
            with open(today_file) as f:
                existing_data = json.load(f)
        except (json.JSONDecodeError, TypeError):
            pass
    existing_regions = set(existing_data.get("regions", {}).keys())

    targets = {}
    if target_region:
        if target_region in watchlist:
            targets[target_region] = watchlist[target_region]
        else:
            log(f"Region '{target_region}' not in watchlist", level="ERROR")
            return today_data, screenshots
    else:
        targets = watchlist

    for rid, rcfg in targets.items():
        types = list(rcfg.get("types", []))
        bbox = rcfg.get("bbox", [])
        keywords = rcfg.get("keywords", [])
        tier = REGION_TIERS.get(rid, "active")

        if "pizza" in types:
            if tier_filter and tier != tier_filter:
                if existing_data.get("pentagon_index"):
                    today_data["pentagon_index"] = existing_data["pentagon_index"]
                continue
            log("Fetching pizza index...")
            today_data["pentagon_index"] = fetch_pizza_index()
            continue

        # --tier flag: skip regions not in requested tier (carry forward existing)
        if tier_filter and tier != tier_filter:
            if rid in existing_regions:
                today_data["regions"][rid] = existing_data["regions"][rid]
            continue

        # Smart mode: baseline regions skip if already collected today
        if not target_region and not tier_filter and tier == "baseline" and rid in existing_regions:
            log(f"Skipping {rid} (baseline, already collected today)")
            today_data["regions"][rid] = existing_data["regions"][rid]
            continue

        # Baseline regions: skip aircraft (unless --region explicitly targets)
        if tier == "baseline" and not target_region:
            types = [t for t in types if t not in BASELINE_SKIP_TYPES]

        log(f"Collecting {rid} ({rcfg.get('name', rid)}) [tier={tier}]...")
        rdata: dict = {}

        if "aircraft" in types and bbox:
            rdata["aircraft"] = fetch_aircraft(bbox)
            time.sleep(1)

        if "news" in types and keywords:
            rdata["news"] = fetch_gdelt_news(keywords)
            time.sleep(8)  # GDELT rate limit courtesy

        today_data["regions"][rid] = rdata

        if "vessel" in types and bbox:
            vcount = fetch_vessel_count(bbox)
            vpath = capture_vessel_map(rid, bbox)
            screenshots[rid] = vpath
            rdata["vessels"] = {"count": vcount, "estimated": False}
            if vpath:
                _annotate_screenshot(vpath, rcfg.get("name", rid), vcount)
            # PortWatch transit data (complements vessel count)
            pw = fetch_portwatch_transit(rid)
            if pw.get("latest_total"):
                rdata["portwatch"] = pw

    # Anomaly detection
    history = load_history(7)
    averages = compute_averages(history)
    for rid, rdata in today_data["regions"].items():
        avg = averages.get(rid, {})
        if avg.get("avg_aircraft") is not None:
            rdata["avg7_aircraft"] = round(avg["avg_aircraft"], 1)
        if avg.get("avg_news") is not None:
            rdata["avg7_news"] = round(avg["avg_news"], 1)
        if avg.get("avg_vessels") is not None:
            rdata["avg7_vessels"] = round(avg["avg_vessels"], 1)

    anomalies = detect_anomalies(today_data, averages)
    today_data["anomalies"] = anomalies

    # 시장 컨텍스트 (참고 표시용)
    today_data["market_context"] = load_market_context()

    # GPR/EPU 리스크 지수 (실시간 fetch)
    today_data["gpr_epu"] = fetch_gpr_epu()

    # 3단계 판정
    alert_level, alert_reason = compute_alert_level(anomalies)
    today_data["alert_level"] = alert_level
    today_data["alert_reason"] = alert_reason

    pi = today_data.get("pentagon_index", {})
    dc_str = f"DOUGHCON {pi.get('doughcon', '?')}" if pi.get("doughcon") else ""
    today_data["summary"] = f"[{alert_level.upper()}] {alert_reason} | {dc_str}".strip(" |")

    return today_data, screenshots


# ── main ─────────────────────────────────────────────────────────────

def main():
    # 타임아웃 설정 (Unix/Linux/macOS only)
    if sys.platform != "win32":
        signal.signal(signal.SIGALRM, timeout_handler)
        signal.alarm(TARGET_TIMEOUT_SECS)

    parser = argparse.ArgumentParser(description="지정학 모니터: 항공기/선박/뉴스/피자지수 감시")
    parser.add_argument("--dry-run", action="store_true", help="수집만, 저장 없음")
    parser.add_argument("--notify", action="store_true", help="수집 + 저장 + 텔레그램")
    parser.add_argument("--list", action="store_true", help="워치리스트 출력")
    parser.add_argument("--region", help="특정 지역만 수집")
    parser.add_argument("--tier", choices=["active", "baseline"],
                        help="특정 tier만 수집 (active: 6h, baseline: 24h)")
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    CHARTS_DIR.mkdir(parents=True, exist_ok=True)
    LOGS_DIR.mkdir(parents=True, exist_ok=True)

    watchlist = load_watchlist()
    if not WATCHLIST_FILE.exists():
        save_watchlist(watchlist)
        log(f"Created default watchlist: {len(watchlist)} regions")

    if args.list:
        print(json.dumps(watchlist, indent=2, ensure_ascii=False))
        return {"status": "ok", "regions": len(watchlist)}

    tier_label = f", tier={args.tier}" if args.tier else ""
    log(f"Starting collection ({len(watchlist)} regions{tier_label})")
    today_data, screenshots = collect_all(watchlist, args.region, tier_filter=args.tier)

    if args.dry_run:
        print(json.dumps(today_data, indent=2, ensure_ascii=False, default=str))
        log(f"Dry run: {today_data['summary']}")
        return today_data

    # Save daily JSON
    output_file = OUTPUT_DIR / f"{datetime.now().strftime('%Y-%m-%d')}.json"
    with open(output_file, "w") as f:
        json.dump(today_data, f, indent=2, ensure_ascii=False, default=str)
    log(f"Saved: {output_file.name}")

    # Telegram — 항상 발송 (기본 데이터 + 이상 시 하이라이트)
    if args.notify:
        notify_telegram(today_data, today_data.get("anomalies", []), screenshots)

    cleanup_old_charts(7)
    log(f"Done: {today_data['summary']}")
    print(json.dumps(today_data, indent=2, ensure_ascii=False, default=str))

    # 타임아웃 alarm 취소
    if sys.platform != "win32":
        signal.alarm(0)

    return today_data


if __name__ == "__main__":
    main()
