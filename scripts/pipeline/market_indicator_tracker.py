#!/usr/bin/env python3
"""
market_indicator_tracker.py — 핵심 시장 지표 일일 수집 + 이상치 감지

Usage:
  python3 market_indicator_tracker.py --notify   # 수집 + 이상치 DM
  python3 market_indicator_tracker.py --dry-run  # 수집만 (저장/DM 없음)

추적 지표: VIX, 금리(US10Y/US2Y/SOFR/KR3Y), 환율(DXY/KRW/JPY/EUR),
           커머디티(금/은/구리/금은비/WTI/천연가스/B-W/BDI/SOXX),
           미국(S&P500/나스닥), 아시아(닛케이/항셍/상하이),
           한국(코스피/코스닥/신용비율),
           리스크(GPR지정학리스크/EPU경제정책불확실성)
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.log import make_logger
from shared.telegram import (
    send_dm, send_group, send_photo,
    GROUP_CHAT_ID, RON_TOPIC_ID,
)

WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))
OUTPUT_DIR = WORKSPACE / "memory" / "market-indicators"
CHART_DIR = OUTPUT_DIR / "charts"
LOGS_DIR = WORKSPACE / "logs"
LOG_FILE = LOGS_DIR / "market_indicator_tracker.log"
DM_SENT_FILE = OUTPUT_DIR / ".dm_sent_today.json"

log = make_logger(log_file=LOG_FILE)

# ── 추적 지표 정의 ──────────────────────────────────────────────────

INDICATORS = {
    # 변동성
    "VIX":    {"ticker": "^VIX",      "name": "VIX 공포지수",  "category": "변동성",  "region": "global"},
    # 금리
    "US10Y":  {"ticker": "^TNX",      "name": "미국 10년물",   "category": "금리",    "region": "global"},
    "US2Y":   {"ticker": "2YY=F",     "name": "미국 2년물",    "category": "금리",    "region": "global"},
    "SOFR":   {"ticker": "^IRX",      "name": "SOFR 3M",      "category": "금리",    "region": "global"},
    # 환율
    "DXY":    {"ticker": "DX-Y.NYB",  "name": "달러인덱스",    "category": "환율",    "region": "global"},
    "USDKRW": {"ticker": "USDKRW=X",  "name": "원/달러",      "category": "환율",    "region": "korea"},
    "USDJPY": {"ticker": "USDJPY=X",  "name": "엔/달러",      "category": "환율",    "region": "global"},
    "EURUSD": {"ticker": "EURUSD=X",  "name": "유로/달러",    "category": "환율",    "region": "global"},
    # 커머디티 (원자재 + 에너지 + 해운 + 반도체)
    "GOLD":   {"ticker": "GC=F",      "name": "금",           "category": "커머디티", "region": "global"},
    "SILVER": {"ticker": "SI=F",      "name": "은",           "category": "커머디티", "region": "global"},
    "COPPER": {"ticker": "HG=F",      "name": "구리",          "category": "커머디티", "region": "global"},
    "WTI":    {"ticker": "CL=F",      "name": "WTI유",        "category": "커머디티", "region": "global"},
    "NATGAS": {"ticker": "NG=F",      "name": "천연가스",      "category": "커머디티", "region": "global"},
    "BDI":    {"ticker": "BDRY",      "name": "BDI(발틱운임)", "category": "커머디티", "region": "global"},
    "SOXX":   {"ticker": "SOXX",      "name": "반도체(SOXX)",  "category": "커머디티", "region": "global"},
    # 주가지수
    "SPX":    {"ticker": "^GSPC",     "name": "S&P500",       "category": "주가지수", "region": "global"},
    "NDX":    {"ticker": "^IXIC",     "name": "나스닥",        "category": "주가지수", "region": "global"},
    "NIKKEI": {"ticker": "^N225",     "name": "닛케이225",     "category": "주가지수", "region": "asia"},
    "HSI":    {"ticker": "^HSI",      "name": "항셍지수",      "category": "주가지수", "region": "asia"},
    "SSEC":   {"ticker": "000001.SS", "name": "상하이종합",    "category": "주가지수", "region": "asia"},
    # 한국
    "KOSPI":  {"ticker": "^KS11",     "name": "코스피",        "category": "한국",    "region": "korea"},
    "KOSDAQ": {"ticker": "^KQ11",     "name": "코스닥",        "category": "한국",    "region": "korea"},
}

# ── 비-yfinance / 파생 지표 설정 ─────────────────────────────────

KR3Y_CONFIG = {"name": "한국 국채3년", "category": "금리", "region": "korea"}
ECOS_API_KEY = os.getenv("ECOS_API_KEY", "4GXR28BEVCS7PZE3G3MS")

# 한경 데이터센터 금리 지표 (KR3Y 외) + ECOS item code (817Y002 테이블)
HANKYUNG_RATE_CONFIGS = {
    "CD91":   {"name": "CD 91일",   "category": "금리", "region": "korea", "hk_name": "CD91일물",  "ecos_item": "010502000"},
    "CP91":   {"name": "CP 91일",   "category": "금리", "region": "korea", "hk_name": "CP91일물"},
    "KRC3Y":  {"name": "회사채3년",  "category": "금리", "region": "korea", "hk_name": "회사채3년", "ecos_item": "010300000"},
}
HANKYUNG_URL = "https://datacenter.hankyung.com/rates-bonds"

DDR5_CONFIG = {"name": "DDR5 현물", "category": "커머디티", "region": "global"}
TRENDFORCE_URL = "https://www.trendforce.com/price/dram/dram_spot"

# GPR (Geopolitical Risk) & EPU (Economic Policy Uncertainty)
GPR_CONFIG = {"name": "GPR지수", "category": "리스크", "region": "global"}
EPU_US_CONFIG = {"name": "EPU(미국)", "category": "리스크", "region": "global"}
EPU_GLOBAL_CONFIG = {"name": "EPU(글로벌)", "category": "리스크", "region": "global"}
GPR_XLS_URL = "https://www.matteoiacoviello.com/gpr_files/data_gpr_daily_recent.xls"
EPU_US_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=USEPUINDXD"
EPU_GLOBAL_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=GEPUCURRENT"

# 파생 지표 (다른 지표로부터 계산)
DERIVED_CONFIGS = {
    "GSRATIO":  {"name": "금은비",            "category": "커머디티", "region": "global",
                 "sources": ("GC=F", "SI=F"), "calc": "divide"},
    "BWSPREAD": {"name": "B-W스프레드",       "category": "커머디티",  "region": "global",
                 "sources": ("BZ=F", "CL=F"), "calc": "subtract"},
}

CREDIT_CSV = WORKSPACE / "memory" / "backup" / "vps-brain" / "skills" / "credit-monitor" / "data" / "historical_daily.csv"
CREDIT_SIGNAL_ZONES = [
    (0, 30, "매수 고려"),
    (30, 35, "중립"),
    (35, 40, "주의"),
    (40, 100, "매도 경고"),
]

# 이상치 기준
ZSCORE_THRESHOLD = 2.0
DAILY_CHANGE_THRESHOLD = 2.0  # percent
# 지표별 일일 변동 임계값 오버라이드 (변동성 큰 지표)
CHANGE_THRESHOLD_OVERRIDES = {
    "NATGAS": 5.0,  # 천연가스: 변동성 커서 5% 이상만
}

# 차트 그룹 (이상치 발생 시 같은 카테고리끼리 묶어서 차트 생성)
CHART_GROUPS = {
    "금리": ["US10Y", "US2Y", "SOFR", "KR3Y", "CD91", "CP91", "KRC3Y", "CRSPRD"],
    "환율": ["DXY", "USDKRW", "USDJPY", "EURUSD"],
    "주가지수": ["SPX", "NDX", "NIKKEI", "HSI", "SSEC"],
    "한국": ["KOSPI", "KOSDAQ"],
    "커머디티": ["GOLD", "GSRATIO", "SILVER", "COPPER", "WTI", "NATGAS", "BWSPREAD", "BDI", "SOXX", "DDR5"],
    "변동성": ["VIX"],
    "리스크": ["GPR", "EPU_US", "EPU_GLOBAL"],
}

# DM 섹터별 구성 — 이모지 + 코드블록 밖 텍스트 헤더
DM_SECTIONS = [
    ("💹 금리",   ["US10Y", "US2Y", "SOFR", "KR3Y", "CD91", "CP91", "KRC3Y", "CRSPRD"]),
    ("💱 환율",   ["DXY", "USDKRW", "USDJPY", "EURUSD"]),
    ("📈 주가지수", ["SPX", "NDX", "NIKKEI", "HSI", "SSEC"]),
    ("🇰🇷 한국",   ["KOSPI", "KOSDAQ"]),
    ("🛢 커머디티", ["GOLD", "GSRATIO", "SILVER", "COPPER", "WTI", "NATGAS", "BWSPREAD", "BDI", "SOXX", "DDR5"]),
    ("⚡ 변동성", ["VIX"]),
    ("🌐 리스크", ["GPR", "EPU_US", "EPU_GLOBAL"]),
]


# ── yfinance 데이터 수집 ─────────────────────────────────────────

def fetch_indicators():
    """yfinance로 지표 데이터 수집 (1년 히스토리 — DoD/MoM/YoY 계산)."""
    try:
        import yfinance as yf
    except ImportError:
        log("yfinance not installed", level="ERROR")
        return {}

    results = {}
    tickers = {key: cfg["ticker"] for key, cfg in INDICATORS.items()}

    for key, ticker_symbol in tickers.items():
        try:
            ticker = yf.Ticker(ticker_symbol)
            hist = ticker.history(period="1y")

            if hist.empty or len(hist) < 2:
                log(f"{key} ({ticker_symbol}): insufficient data ({len(hist)} rows)")
                continue

            closes = hist["Close"].dropna()
            if len(closes) < 2:
                continue

            current = float(closes.iloc[-1])
            prev = float(closes.iloc[-2])
            change_pct = ((current - prev) / prev * 100) if prev != 0 else 0

            # MoM (~20 거래일 전)
            mom_pct = 0.0
            if len(closes) > 20:
                m_prev = float(closes.iloc[-21])
                mom_pct = ((current - m_prev) / m_prev * 100) if m_prev != 0 else 0

            # YoY (~250 거래일 전, 또는 가용 최초)
            yoy_pct = 0.0
            if len(closes) > 200:
                y_idx = min(250, len(closes) - 1)
                y_prev = float(closes.iloc[-y_idx - 1])
                yoy_pct = ((current - y_prev) / y_prev * 100) if y_prev != 0 else 0

            # 20일 이동평균 & 표준편차
            ma20_data = closes.tail(20)
            ma20 = float(ma20_data.mean())
            std20 = float(ma20_data.std())
            zscore = ((current - ma20) / std20) if std20 > 0 else 0

            # 데이터 날짜 (마지막 종가 기준)
            data_date = closes.index[-1].strftime("%Y-%m-%d")

            results[key] = {
                "close": round(current, 2),
                "prev": round(prev, 2),
                "change_pct": round(change_pct, 2),
                "mom_pct": round(mom_pct, 2),
                "yoy_pct": round(yoy_pct, 2),
                "ma20": round(ma20, 2),
                "std20": round(std20, 2),
                "zscore": round(zscore, 2),
                "data_points": len(closes),
                "data_date": data_date,
            }
        except Exception as e:
            log(f"{key} ({ticker_symbol}): fetch error — {e}", level="WARN")
            continue

    return results


# ── ECOS 한국 국채3년 ────────────────────────────────────────────

def _fetch_hankyung_rates(targets=None):
    """한경 데이터센터에서 금리 지표 스크래핑 (T+1).

    Args:
        targets: 찾을 종목명→키 매핑. None이면 국고3년만.
                 예: {"국고3년": "KR3Y", "CD91일물": "CD91", ...}
    Returns:
        dict[key, {close, prev, change, change_pct, data_date}]
    """
    import re
    if targets is None:
        targets = {"국고3년": "KR3Y"}
    try:
        import requests as req
    except ImportError:
        return {}
    try:
        r = req.get(
            HANKYUNG_URL,
            headers={"User-Agent": "Mozilla/5.0 (compatible; market-tracker/1.0)"},
            timeout=15,
        )
        if r.status_code != 200:
            return {}
        html = r.text
        results = {}
        for hk_name, key in targets.items():
            idx = html.find(f">{hk_name}<")
            if idx < 0:
                continue
            end = html.find("</tr>", idx)
            row = html[idx:end + 5]
            values = re.findall(r'data-value="([^"]+)"', row)
            date = re.findall(r'txt-date">([^<]+)', row)
            if len(values) < 3 or not date:
                continue
            close = float(values[0])
            change = float(values[1])
            change_pct = float(values[2])
            prev = close - change
            data_date = date[0].replace(".", "-")
            results[key] = {
                "close": close, "prev": round(prev, 3),
                "change": change, "change_pct": change_pct,
                "data_date": data_date,
            }
        return results
    except Exception as e:
        log(f"Hankyung rates error: {e}", level="WARN")
        return {}


def _fetch_ecos_rate_history(item_code="010200000", days=400):
    """ECOS API에서 금리 히스토리 조회 (817Y002 시장금리 일별).

    Args:
        item_code: ECOS 항목코드 (010200000=국고3년, 010300000=회사채AA-,
                   010502000=CD91일)
        days: 조회 기간 (일). 400이면 YoY 계산 가능.
    Returns:
        list[float] | None: 일별 금리값 리스트 (오래된순)
    """
    import time as _time
    try:
        import requests
    except ImportError:
        return None
    end = datetime.now().strftime("%Y%m%d")
    start = (datetime.now() - timedelta(days=days)).strftime("%Y%m%d")
    limit = 10 if ECOS_API_KEY == "sample" else 300
    url = (
        f"https://ecos.bok.or.kr/api/StatisticSearch/"
        f"{ECOS_API_KEY}/json/kr/1/{limit}/817Y002/D/{start}/{end}/{item_code}"
    )
    for attempt in range(2):
        try:
            r = requests.get(url, timeout=20)
            data = r.json()
            if "StatisticSearch" not in data:
                if attempt == 0:
                    _time.sleep(1)
                    continue
                return None
            rows = data["StatisticSearch"]["row"]
            if not rows:
                return None
            return [float(r["DATA_VALUE"]) for r in rows]
        except Exception:
            if attempt == 0:
                _time.sleep(1)
                continue
            return None
    return None


def _fetch_kr3y_ecos():
    """후방호환 래퍼."""
    return _fetch_ecos_rate_history("010200000", days=400)


def fetch_kr3y_bond():
    """한국 국채 3년물 금리 조회. 한경(T+1) 1차 + ECOS(히스토리) 보조."""
    # 1) 한경에서 최신값
    hk_all = _fetch_hankyung_rates({"국고3년": "KR3Y"})
    hk = hk_all.get("KR3Y")
    # 2) ECOS에서 히스토리 (MA/zscore 계산용)
    ecos_values = _fetch_kr3y_ecos()

    if hk:
        close = hk["close"]
        prev = hk["prev"]
        change_pct = hk["change_pct"]
        data_date = hk["data_date"]
        source = "한경"
    elif ecos_values:
        close = ecos_values[-1]
        prev = ecos_values[-2] if len(ecos_values) > 1 else close
        change_pct = ((close - prev) / prev * 100) if prev != 0 else 0
        data_date = datetime.now().strftime("%Y-%m-%d")
        source = "ECOS"
    else:
        log("KR3Y: both Hankyung and ECOS failed", level="WARN")
        return None

    # 통계: ECOS 히스토리 + 한경 최신값 병합
    hist = ecos_values or []
    if hk and hist and abs(hist[-1] - close) > 0.001:
        hist.append(close)
    if not hist:
        hist = [close]

    ma = sum(hist) / len(hist)
    std = (sum((v - ma) ** 2 for v in hist) / len(hist)) ** 0.5
    zscore = ((close - ma) / std) if std > 0 else 0

    mom_pct = 0.0
    if len(hist) > 20:
        m_prev = hist[-21]
        mom_pct = ((close - m_prev) / m_prev * 100) if m_prev != 0 else 0

    yoy_pct = 0.0
    if len(hist) > 240:  # ~영업일 1년
        y_prev = hist[-241]
        yoy_pct = ((close - y_prev) / y_prev * 100) if y_prev != 0 else 0

    log(f"KR3Y: {close}% ({source}, {len(hist)} data points)")
    return {
        "close": round(close, 2),
        "prev": round(prev, 2),
        "change_pct": round(change_pct, 2),
        "mom_pct": round(mom_pct, 2),
        "yoy_pct": round(yoy_pct, 2),
        "ma20": round(ma, 2),
        "std20": round(std, 4),
        "zscore": round(zscore, 2),
        "data_points": len(hist),
        "data_date": data_date,
    }


def _calc_rate_stats(close, hist):
    """금리 히스토리에서 MA20/std/zscore/MoM/YoY 계산."""
    if not hist:
        hist = [close]
    ma = sum(hist) / len(hist)
    std = (sum((v - ma) ** 2 for v in hist) / len(hist)) ** 0.5
    zscore = ((close - ma) / std) if std > 0 else 0
    mom_pct = 0.0
    if len(hist) > 20:
        m_prev = hist[-21]
        mom_pct = ((close - m_prev) / m_prev * 100) if m_prev != 0 else 0
    yoy_pct = 0.0
    if len(hist) > 240:
        y_prev = hist[-241]
        yoy_pct = ((close - y_prev) / y_prev * 100) if y_prev != 0 else 0
    return {
        "mom_pct": round(mom_pct, 2),
        "yoy_pct": round(yoy_pct, 2),
        "ma20": round(ma, 2),
        "std20": round(std, 4),
        "zscore": round(zscore, 2),
        "data_points": len(hist),
    }


# ── DDR5 현물가격 (TrendForce 스크래핑) ─────────────────────────

def fetch_dram_price():
    """TrendForce에서 DDR5 16Gb 현물가격 스크래핑."""
    import re
    try:
        import requests as req
    except ImportError:
        log("requests not installed", level="ERROR")
        return None

    try:
        r = req.get(TRENDFORCE_URL, timeout=15,
                    headers={"User-Agent": "Mozilla/5.0 (compatible; market-tracker/1.0)"})
        if r.status_code != 200:
            log(f"DDR5 fetch failed: HTTP {r.status_code}", level="WARN")
            return None

        html = r.text
        marker = "DDR5 16Gb (2Gx8) 4800/5600"
        idx = html.find(marker)
        if idx < 0:
            log("DDR5 price not found in HTML", level="WARN")
            return None

        segment = html[idx:idx + 1000]
        nums = re.findall(r'class="lcd-num-l"[^>]*>([0-9.]+)</td>', segment)
        if len(nums) < 5:
            log(f"DDR5 insufficient data fields: {len(nums)}", level="WARN")
            return None

        session_avg = float(nums[4])

        # 변동률 추출
        change_match = re.search(r'(rise|fall)-trend.*?([0-9.]+)\s*%', segment)
        change_pct = 0.0
        if change_match:
            change_pct = float(change_match.group(2))
            if change_match.group(1) == "fall":
                change_pct = -change_pct

        # 데이터 날짜 (dateModified from schema)
        date_match = re.search(r'"dateModified":\s*"(\d{4}-\d{2}-\d{2})', html)
        data_date = date_match.group(1) if date_match else datetime.now().strftime("%Y-%m-%d")

        prev = session_avg / (1 + change_pct / 100) if change_pct != 0 else session_avg

        log(f"DDR5: ${session_avg:.3f} ({change_pct:+.2f}%) as of {data_date}")
        return {
            "close": round(session_avg, 3),
            "prev": round(prev, 3),
            "change_pct": round(change_pct, 2),
            "mom_pct": 0.0,
            "yoy_pct": 0.0,
            "ma20": round(session_avg, 3),
            "std20": 0,
            "zscore": 0,
            "data_points": 1,
            "data_date": data_date,
        }
    except Exception as e:
        log(f"DDR5 fetch error: {e}", level="WARN")
        return None


# ── GPR (Geopolitical Risk Index) ──────────────────────────────────

def fetch_gpr_index():
    """GPR 일일 지수 다운로드 (Matteo Iacoviello XLS).

    Returns dict with close/prev/change_pct/data_date or {} on error.
    GPR 데이터는 월 1회 갱신 — 며칠 stale 정상.
    """
    try:
        import pandas as pd
    except ImportError:
        log("pandas not installed, skip GPR", level="WARN")
        return {}

    import urllib.request
    try:
        req = urllib.request.Request(
            GPR_XLS_URL,
            headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            xls_data = resp.read()

        import io
        df = pd.read_excel(io.BytesIO(xls_data))

        # 컬럼명 정규화 (대소문자 혼용 방어)
        df.columns = [c.strip() for c in df.columns]
        col_map = {c.upper(): c for c in df.columns}

        date_col = col_map.get("DATE", None)
        gprd_col = col_map.get("GPRD", None)
        if date_col is None or gprd_col is None:
            log(f"GPR: unexpected columns: {list(df.columns)}", level="WARN")
            return {}

        df = df[[date_col, gprd_col]].dropna()
        if len(df) < 2:
            log("GPR: insufficient data", level="WARN")
            return {}

        current = float(df[gprd_col].iloc[-1])
        prev = float(df[gprd_col].iloc[-2])
        change_pct = ((current - prev) / prev * 100) if prev != 0 else 0

        # 20일 통계
        tail = df[gprd_col].tail(20).astype(float)
        ma20 = float(tail.mean())
        std20 = float(tail.std())
        zscore = ((current - ma20) / std20) if std20 > 0 else 0

        # MoM (~20 거래일)
        mom_pct = 0.0
        if len(df) > 20:
            m_prev = float(df[gprd_col].iloc[-21])
            mom_pct = ((current - m_prev) / m_prev * 100) if m_prev != 0 else 0

        data_date = pd.to_datetime(df[date_col].iloc[-1]).strftime("%Y-%m-%d")

        log(f"GPR: {current:.1f} (data_date={data_date}, {len(df)} pts)")
        return {
            "close": round(current, 2),
            "prev": round(prev, 2),
            "change_pct": round(change_pct, 2),
            "mom_pct": round(mom_pct, 2),
            "yoy_pct": 0.0,
            "ma20": round(ma20, 2),
            "std20": round(std20, 4),
            "zscore": round(zscore, 2),
            "data_points": len(df),
            "data_date": data_date,
        }
    except Exception as e:
        log(f"GPR fetch error: {e}", level="WARN")
        return {}


# ── EPU (Economic Policy Uncertainty Index) ───────────────────────

def fetch_epu_index():
    """FRED CSV에서 EPU 지수 다운로드 (US Daily + Global Monthly).

    Returns dict {"EPU_US": {...}, "EPU_GLOBAL": {...}} or {} on error.
    """
    import csv
    import urllib.request
    results = {}

    for key, url, config in [
        ("EPU_US", EPU_US_CSV_URL, EPU_US_CONFIG),
        ("EPU_GLOBAL", EPU_GLOBAL_CSV_URL, EPU_GLOBAL_CONFIG),
    ]:
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"},
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                text = resp.read().decode("utf-8")

            reader = csv.reader(text.strip().split("\n"))
            header = next(reader)  # DATE, value column

            rows = []
            for row in reader:
                if len(row) < 2 or row[1] in ("", "."):
                    continue
                try:
                    rows.append((row[0], float(row[1])))
                except (ValueError, IndexError):
                    continue

            if len(rows) < 2:
                log(f"{key}: insufficient data ({len(rows)} rows)", level="WARN")
                continue

            current = rows[-1][1]
            prev = rows[-2][1]
            change_pct = ((current - prev) / prev * 100) if prev != 0 else 0
            data_date = rows[-1][0]

            # 20일/20기간 통계
            tail = [r[1] for r in rows[-20:]]
            ma20 = sum(tail) / len(tail)
            std20 = (sum((v - ma20) ** 2 for v in tail) / len(tail)) ** 0.5
            zscore = ((current - ma20) / std20) if std20 > 0 else 0

            mom_pct = 0.0
            if len(rows) > 20:
                m_prev = rows[-21][1]
                mom_pct = ((current - m_prev) / m_prev * 100) if m_prev != 0 else 0

            log(f"{key}: {current:.1f} (data_date={data_date}, {len(rows)} pts)")
            results[key] = {
                "close": round(current, 2),
                "prev": round(prev, 2),
                "change_pct": round(change_pct, 2),
                "mom_pct": round(mom_pct, 2),
                "yoy_pct": 0.0,
                "ma20": round(ma20, 2),
                "std20": round(std20, 4),
                "zscore": round(zscore, 2),
                "data_points": len(rows),
                "data_date": data_date,
            }
        except Exception as e:
            log(f"{key} fetch error: {e}", level="WARN")
            continue

    return results


# ── 파생 지표 계산 ────────────────────────────────────────────────

def calculate_derived(indicators):
    """파생 지표 계산: 금은비(GSRATIO), 브렌트-WTI 스프레드(BWSPREAD)."""
    try:
        import yfinance as yf
    except ImportError:
        return {}

    derived = {}
    for key, cfg in DERIVED_CONFIGS.items():
        try:
            ticker_a, ticker_b = cfg["sources"]
            hist_a = yf.Ticker(ticker_a).history(period="1y")["Close"].dropna()
            hist_b = yf.Ticker(ticker_b).history(period="1y")["Close"].dropna()
            if hist_a.empty or hist_b.empty:
                continue

            # 날짜 정렬 (공통 인덱스)
            common = hist_a.index.intersection(hist_b.index)
            if len(common) < 2:
                continue
            a, b = hist_a[common], hist_b[common]

            if cfg["calc"] == "divide":
                series = a / b
            else:  # subtract
                series = a - b
            series = series.dropna()
            if len(series) < 2:
                continue

            current = float(series.iloc[-1])
            prev = float(series.iloc[-2])
            change_pct = ((current - prev) / prev * 100) if prev != 0 else 0

            mom_pct = 0.0
            if len(series) > 20:
                m_prev = float(series.iloc[-21])
                mom_pct = ((current - m_prev) / m_prev * 100) if m_prev != 0 else 0
            yoy_pct = 0.0
            if len(series) > 200:
                y_idx = min(250, len(series) - 1)
                y_prev = float(series.iloc[-y_idx - 1])
                yoy_pct = ((current - y_prev) / y_prev * 100) if y_prev != 0 else 0

            ma = float(series.tail(20).mean())
            std = float(series.tail(20).std())
            zscore = ((current - ma) / std) if std > 0 else 0

            derived[key] = {
                "close": round(current, 2),
                "prev": round(prev, 2),
                "change_pct": round(change_pct, 2),
                "mom_pct": round(mom_pct, 2),
                "yoy_pct": round(yoy_pct, 2),
                "ma20": round(ma, 2),
                "std20": round(std, 4),
                "zscore": round(zscore, 2),
                "data_points": len(series),
            }
            log(f"{key}: {current:.2f} ({len(series)} pts)")
        except Exception as e:
            log(f"Derived {key} error: {e}", level="WARN")

    return derived


# ── 신용잔고 CSV 자동 갱신 (네이버 금융) ──────────────────────────

NAVER_DEPOSIT_URL = "https://finance.naver.com/sise/sise_deposit.naver"


def update_credit_csv():
    """네이버 금융 증시자금동향에서 신용잔고/예탁금 데이터를 수집하여 CSV 갱신.

    네이버 금융 데이터: 억원 단위 → CSV: 조원 단위 (÷10000)
    네이버 '고객예탁금' = CSV 'deposit', 네이버 '신용잔고' = CSV 'credit_balance'
    ratio = credit_balance / deposit * 100
    """
    try:
        import requests as req
    except ImportError:
        log("requests not installed", level="ERROR")
        return 0

    if not CREDIT_CSV.exists():
        log("Credit CSV not found, skip update")
        return 0

    # 기존 CSV의 마지막 날짜 확인
    lines = CREDIT_CSV.read_text(encoding="utf-8").strip().split("\n")
    if len(lines) < 2:
        return 0
    last_date_str = lines[-1].split(",")[0]  # e.g. "2026/02/05"
    try:
        last_date = datetime.strptime(last_date_str, "%Y/%m/%d")
    except ValueError:
        log(f"Cannot parse last CSV date: {last_date_str}", level="WARN")
        return 0

    # 네이버 금융 페이지 가져오기 (EUC-KR 인코딩)
    try:
        r = req.get(NAVER_DEPOSIT_URL,
                    headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"},
                    timeout=15)
        r.raise_for_status()
        html = r.content.decode("euc-kr", errors="replace")
    except Exception as e:
        log(f"Naver fetch error: {e}", level="WARN")
        return 0

    # HTML 파싱: <td class="date">YY.MM.DD</td> 패턴으로 행 추출
    import re
    rows = re.findall(
        r'<td class="date">([\d.]+)</td>\s*'
        r'<td class="rate_(?:up|down)">([\d,]+)</td>\s*'
        r'<td class="rate_(?:up|down)">([\d,]+)</td>\s*'
        r'<td class="rate_(?:up|down)">([\d,]+)</td>\s*'
        r'<td class="rate_(?:up|down)">([\d,]+)</td>',
        html,
    )
    if not rows:
        log("No data rows parsed from Naver Finance")
        return 0

    # 새로운 행만 필터링 (CSV 마지막 날짜 이후)
    new_rows = []
    for date_short, deposit_str, _dep_chg, credit_str, _cred_chg in rows:
        # 날짜: "26.02.13" → "2026/02/13"
        parts = date_short.split(".")
        if len(parts) != 3:
            continue
        yy, mm, dd = parts
        full_date_str = f"20{yy}/{mm}/{dd}"
        try:
            row_date = datetime.strptime(full_date_str, "%Y/%m/%d")
        except ValueError:
            continue

        if row_date <= last_date:
            continue

        # 억원 → 조원
        deposit_eok = float(deposit_str.replace(",", ""))
        credit_eok = float(credit_str.replace(",", ""))
        deposit_jo = deposit_eok / 10000
        credit_jo = credit_eok / 10000
        ratio = (credit_jo / deposit_jo * 100) if deposit_jo > 0 else 0

        new_rows.append((row_date, full_date_str, credit_jo, deposit_jo, ratio))

    if not new_rows:
        log("Credit CSV already up to date")
        return 0

    # 날짜순 정렬 후 CSV에 append
    new_rows.sort(key=lambda x: x[0])
    existing = CREDIT_CSV.read_text(encoding="utf-8")
    needs_newline = existing and not existing.endswith("\n")
    with open(CREDIT_CSV, "a", encoding="utf-8") as f:
        for _, date_str, credit, deposit, ratio in new_rows:
            if needs_newline:
                f.write("\n")
                needs_newline = False
            f.write(f"{date_str},{credit:.6f},{deposit:.6f},{ratio:.6f}\n")

    log(f"Credit CSV updated: {len(new_rows)} new rows "
        f"({new_rows[0][1]} ~ {new_rows[-1][1]})")
    return len(new_rows)


# ── 신용잔고/예수금 CSV ──────────────────────────────────────────

def fetch_credit_data():
    """CSV에서 최신 신용잔고/예수금 데이터 읽기."""
    if not CREDIT_CSV.exists():
        log("Credit CSV not found")
        return None

    try:
        lines = CREDIT_CSV.read_text(encoding="utf-8").strip().split("\n")
        if len(lines) < 2:
            return None

        last = lines[-1].split(",")
        prev = lines[-2].split(",") if len(lines) > 2 else None

        date_str = last[0]
        credit_balance = float(last[1])
        deposit = float(last[2])
        ratio = float(last[3])

        signal = "중립"
        for low, high, zone in CREDIT_SIGNAL_ZONES:
            if low <= ratio < high:
                signal = zone
                break

        prev_ratio = float(prev[3]) if prev else ratio
        ratio_change = ratio - prev_ratio

        log(f"Credit: ratio={ratio:.1f}% ({signal}), balance={credit_balance:.1f}조원")
        return {
            "date": date_str,
            "credit_balance": round(credit_balance, 2),
            "deposit": round(deposit, 2),
            "ratio": round(ratio, 2),
            "ratio_change": round(ratio_change, 2),
            "signal": signal,
        }
    except Exception as e:
        log(f"Credit data error: {e}", level="WARN")
        return None


# ── 이상치 감지 ────────────────────────────────────────────────────

def _get_indicator_name(key):
    """지표 키에서 표시 이름 반환."""
    if key in INDICATORS:
        return INDICATORS[key]["name"]
    if key == "KR3Y":
        return KR3Y_CONFIG["name"]
    if key == "DDR5":
        return DDR5_CONFIG["name"]
    if key in HANKYUNG_RATE_CONFIGS:
        return HANKYUNG_RATE_CONFIGS[key]["name"]
    if key == "CRSPRD":
        return "신용스프레드"
    if key in DERIVED_CONFIGS:
        return DERIVED_CONFIGS[key]["name"]
    if key == "GPR":
        return GPR_CONFIG["name"]
    if key == "EPU_US":
        return EPU_US_CONFIG["name"]
    if key == "EPU_GLOBAL":
        return EPU_GLOBAL_CONFIG["name"]
    return key


def _zscore_dot(zscore):
    """z-score에 따른 상태 아이콘 (텔레그램에서 작게 렌더링되는 유니코드)."""
    az = abs(zscore)
    if az >= ZSCORE_THRESHOLD:
        return "◆"   # alert — 작은 검정 다이아몬드
    if az >= 1.5:
        return "◇"   # watch — 빈 다이아몬드
    return "·"        # normal — 가운데점


def detect_anomalies(indicators, credit_data=None):
    """20일 MA 대비 z-score 이탈 또는 일일 변동 감지. 동일 지표 중복 방지."""
    anomalies = []
    for key, data in indicators.items():
        name = _get_indicator_name(key)

        zscore_hit = abs(data["zscore"]) >= ZSCORE_THRESHOLD
        threshold = CHANGE_THRESHOLD_OVERRIDES.get(key, DAILY_CHANGE_THRESHOLD)
        change_hit = abs(data["change_pct"]) >= threshold

        if zscore_hit and change_hit:
            # 둘 다 해당: 1건으로 합침 (더 심각한 severity 사용)
            direction = "급등" if data["change_pct"] > 0 else "급락"
            sev_z = "high" if abs(data["zscore"]) >= 3.0 else "medium"
            sev_c = "high" if abs(data["change_pct"]) >= 5.0 else "medium"
            severity = "high" if "high" in (sev_z, sev_c) else "medium"
            anomalies.append({
                "ticker": key,
                "type": "combined",
                "detail": f"{name} {data['prev']}→{data['close']} ({data['change_pct']:+.2f}%) {direction}, z={data['zscore']:.1f}",
                "severity": severity,
            })
        elif zscore_hit:
            direction = "상승" if data["zscore"] > 0 else "하락"
            anomalies.append({
                "ticker": key,
                "type": "zscore_breach",
                "detail": f"{name} z={data['zscore']}, 20일 MA({data['ma20']}) 대비 {direction} 이탈",
                "severity": "high" if abs(data["zscore"]) >= 3.0 else "medium",
            })
        elif change_hit:
            direction = "급등" if data["change_pct"] > 0 else "급락"
            anomalies.append({
                "ticker": key,
                "type": "high_change",
                "detail": f"{name} {data['prev']}→{data['close']} ({data['change_pct']:+.2f}%) {direction}",
                "severity": "high" if abs(data["change_pct"]) >= 5.0 else "medium",
            })

    # 신용잔고 비중 시그널 존 이탈
    if credit_data:
        ratio = credit_data["ratio"]
        if ratio >= 35:
            severity = "high" if ratio >= 40 else "medium"
            zone = credit_data["signal"]
            anomalies.append({
                "ticker": "CREDIT",
                "type": "credit_signal",
                "detail": f"신용비율 {ratio:.1f}% ({zone})",
                "severity": severity,
            })

    return anomalies


# ── 요약 생성 ────────────────────────────────────────────────────

def generate_summary(indicators, anomalies, credit_data=None):
    """간단한 지표 요약 문자열 생성."""
    parts = []
    key_order = ["US10Y", "US2Y", "SOFR", "KR3Y", "CD91", "CP91", "KRC3Y", "CRSPRD",
                 "DXY", "USDKRW", "USDJPY", "EURUSD",
                 "SPX", "NDX", "NIKKEI", "HSI", "SSEC", "KOSPI", "KOSDAQ",
                 "GOLD", "GSRATIO", "WTI", "NATGAS", "BWSPREAD", "BDI", "SOXX", "DDR5",
                 "VIX", "GPR", "EPU_US", "EPU_GLOBAL"]
    for key in key_order:
        if key not in indicators:
            continue
        d = indicators[key]
        name = _get_indicator_name(key)
        arrow = "▲" if d["change_pct"] > 0 else "▼" if d["change_pct"] < 0 else "─"
        parts.append(f"{name} {d['close']} ({arrow}{abs(d['change_pct']):.1f}%)")

    if credit_data:
        parts.append(f"신용비율 {credit_data['ratio']:.1f}%({credit_data['signal']})")

    if anomalies:
        anomaly_note = f" | 이상치 {len(anomalies)}건 감지"
    else:
        anomaly_note = " | 이상치 없음"

    return ", ".join(parts) + anomaly_note


# ── 저장 ─────────────────────────────────────────────────────────

def save_indicators(indicators, anomalies, summary, credit_data=None):
    """Save daily indicator data as JSON."""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    date_str = datetime.now().strftime("%Y-%m-%d")
    filepath = OUTPUT_DIR / f"{date_str}.json"

    data = {
        "date": date_str,
        "collected_at": datetime.now().isoformat(),
        "indicators": indicators,
        "anomalies": anomalies,
        "credit_data": credit_data,
        "summary": summary,
    }

    filepath.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"Saved: {filepath.name}")
    return filepath


# ── 텔레그램 DM ──────────────────────────────────────────────────

def _format_value(key, val):
    """지표별 값 포맷팅."""
    if key in ("US10Y", "US2Y", "SOFR", "KR3Y", "CD91", "CP91", "KRC3Y"):
        return f"{val:.2f}%"
    if key == "CRSPRD":
        return f"{val:.3f}%p"
    if key in ("GOLD", "SILVER", "WTI", "NATGAS", "BWSPREAD", "DDR5"):
        return f"${val:,.1f}" if val >= 10 else f"${val:.2f}"
    if key in ("SPX", "NDX", "NIKKEI", "HSI", "SSEC", "KOSPI", "KOSDAQ"):
        return f"{val:,.0f}"
    if key == "USDKRW":
        return f"{val:,.0f}"
    if key in ("USDJPY", "EURUSD", "DXY"):
        return f"{val:.2f}"
    if key == "GSRATIO":
        return f"{val:.1f}"
    if key in ("GPR", "EPU_US", "EPU_GLOBAL"):
        return f"{val:.1f}"
    return f"{val:,.2f}"


# DM 코드블록용 영문 축약명 (모노스페이스 정렬 보장)
_DM_NAMES = {
    "VIX": "VIX",       "US10Y": "US10Y",   "US2Y": "US2Y",
    "SOFR": "SOFR",     "KR3Y": "KR3Y",     "DXY": "DXY",
    "CD91": "CD91",     "CP91": "CP91",     "KRC3Y": "Corp3Y",
    "CRSPRD": "CrSprd",
    "USDKRW": "KRW",    "USDJPY": "JPY",    "EURUSD": "EUR",
    "GOLD": "Gold",     "SILVER": "Silver",  "COPPER": "Copper",
    "GSRATIO": "Au/Ag", "WTI": "WTI",       "NATGAS": "NatGas",
    "BWSPREAD": "B-W",  "BDI": "BDI",       "SOXX": "SOXX",    "DDR5": "DDR5",
    "SPX": "S&P500",    "NDX": "Nasdaq",
    "NIKKEI": "N225",   "HSI": "HSI",       "SSEC": "SSEC",
    "KOSPI": "KOSPI",   "KOSDAQ": "KOSDAQ",
    "GPR": "GPR",       "EPU_US": "EPU-US", "EPU_GLOBAL": "EPU-GL",
}


def _pct_str(val):
    """변동률을 부호+소수1자리 문자열로."""
    if val > 0:
        return f"+{val:.1f}"
    if val < 0:
        return f"{val:.1f}"
    return " 0.0"


def _dm_row(key, d, anomaly_tickers):
    """DM 테이블 한 행 생성 (영문 축약명, DoD/MoM/YoY)."""
    name = _DM_NAMES.get(key, key)
    val = _format_value(key, d["close"])
    dod = _pct_str(d["change_pct"])
    mom = _pct_str(d.get("mom_pct", 0))
    yoy = _pct_str(d.get("yoy_pct", 0))
    # 이상치이면 ◆, 아니면 z-score 기반
    dot = "◆" if key in anomaly_tickers else _zscore_dot(d["zscore"])
    return f"{dot}{name:<7} {val:>9} {dod:>5} {mom:>5} {yoy:>5}"


def send_anomaly_dm(anomalies, summary, indicators, credit_data=None,
                    chat_id=None, topic_id=None):
    """Send market report via Telegram (HTML, shared.telegram 경유)."""

    now = datetime.now()
    date_str = now.strftime("%m/%d %H:%M")
    anomaly_tickers = {a["ticker"] for a in anomalies}
    today = now.strftime("%Y-%m-%d")

    lines = [f"<b>📊 시장지표 {date_str}</b>"]

    # ── 이상치 요약 (이유 포함) ──
    if anomalies:
        for a in anomalies[:5]:
            name = _DM_NAMES.get(a["ticker"], a["ticker"])
            d = indicators.get(a["ticker"], {})
            if a["type"] == "combined":
                reason = f"{d.get('change_pct', 0):+.1f}% z={d.get('zscore', 0):.1f}"
            elif a["type"] == "high_change":
                reason = f"{d.get('change_pct', 0):+.1f}%"
            elif a["type"] == "zscore_breach":
                reason = f"z={d.get('zscore', 0):.1f}"
            elif a["type"] == "credit_signal":
                reason = a["detail"]
            else:
                reason = ""
            lines.append(f"⚠ {name} {reason}")

    # ── 섹터별 데이터 (하나의 pre 블록) ──
    hdr = f"{'':8} {'':>9} {'DoD':>5} {'MoM':>5} {'YoY':>5}"
    data = []
    first = True
    stale_keys = []
    for title, keys in DM_SECTIONS:
        available = [k for k in keys if k in indicators]
        if not available:
            continue
        if data:
            data.append("")
        data.append(f"[{title}]")
        if first:
            data.append(hdr)
            first = False
        for key in available:
            data.append(_dm_row(key, indicators[key], anomaly_tickers))
            dd = indicators[key].get("data_date", today)
            if dd != today:
                stale_keys.append((key, dd))
    lines.append("<pre>" + "\n".join(data) + "</pre>")

    # ── D-1 footnote + 출처 ──
    if stale_keys:
        grouped = {}
        for key, dd in stale_keys:
            short_date = dd[5:]
            grouped.setdefault(short_date, []).append(_DM_NAMES.get(key, key))
        for dt, names in grouped.items():
            lines.append(f"{dt}: {', '.join(names)}")

    # 출처 표기
    src_parts = ["yfinance", "한경", "ECOS"]
    if "DDR5" in indicators:
        src_parts.append("TrendForce")
    if any(k in indicators for k in ("GPR", "EPU_US", "EPU_GLOBAL")):
        src_parts.append("GPR/FRED")
    if credit_data:
        src_parts.append("금투협")
    lines.append(f"출처: {' · '.join(src_parts)}")

    text = "\n".join(lines)
    return _send_telegram_text(text, chat_id, topic_id)


def _send_telegram_text(text, chat_id=None, topic_id=None):
    """Telegram 전송 — shared.telegram 모듈 경유."""
    if chat_id is not None and int(chat_id) == GROUP_CHAT_ID:
        return send_group(text, topic_id=topic_id)
    return send_dm(text)


# ── 차트 생성 ────────────────────────────────────────────────────

def _setup_matplotlib():
    """matplotlib 한글 폰트 + Agg 백엔드 설정."""
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    for font in ["AppleGothic", "Apple SD Gothic Neo", "NanumGothic", "DejaVu Sans"]:
        try:
            plt.rcParams["font.family"] = font
            break
        except Exception:
            continue
    plt.rcParams["axes.unicode_minus"] = False
    return plt


def fetch_chart_histories(keys):
    """이상치 차트용 히스토리 데이터 수집."""
    import pandas as pd
    histories = {}

    # yfinance 지표
    yf_keys = {k: INDICATORS[k]["ticker"] for k in keys if k in INDICATORS}
    if yf_keys:
        try:
            import yfinance as yf
            for key, ticker in yf_keys.items():
                try:
                    t = yf.Ticker(ticker)
                    hist = t.history(period="1mo")
                    if not hist.empty:
                        histories[key] = hist["Close"].dropna()
                except Exception:
                    pass
        except ImportError:
            pass

    # KR3Y (ECOS)
    if "KR3Y" in keys:
        try:
            import requests as req
            end = datetime.now().strftime("%Y%m%d")
            start = (datetime.now() - timedelta(days=60)).strftime("%Y%m%d")
            limit = 10 if ECOS_API_KEY == "sample" else 30
            url = (
                f"https://ecos.bok.or.kr/api/StatisticSearch/"
                f"{ECOS_API_KEY}/json/kr/1/{limit}/817Y002/D/{start}/{end}/010200000"
            )
            r = req.get(url, timeout=15)
            data = r.json()
            if "StatisticSearch" in data:
                rows = data["StatisticSearch"]["row"]
                dates = [datetime.strptime(row["TIME"], "%Y%m%d") for row in rows]
                values = [float(row["DATA_VALUE"]) for row in rows]
                histories["KR3Y"] = pd.Series(values, index=dates, name="KR3Y")
        except Exception as e:
            log(f"KR3Y chart history error: {e}", level="WARN")

    # 파생 지표 (GSRATIO, BWSPREAD)
    derived_keys = {k for k in keys if k in DERIVED_CONFIGS}
    if derived_keys:
        try:
            import yfinance as yf_d
            for dk in derived_keys:
                cfg = DERIVED_CONFIGS[dk]
                ta, tb = cfg["sources"]
                ha = yf_d.Ticker(ta).history(period="1mo")["Close"].dropna()
                hb = yf_d.Ticker(tb).history(period="1mo")["Close"].dropna()
                common = ha.index.intersection(hb.index)
                if len(common) < 2:
                    continue
                if cfg["calc"] == "divide":
                    s = ha[common] / hb[common]
                else:
                    s = ha[common] - hb[common]
                histories[dk] = s.dropna()
        except Exception as e:
            log(f"Derived chart history error: {e}", level="WARN")

    # 신용비율 (CSV — 3컬럼: ratio, credit_balance, deposit)
    if "CREDIT" in keys and CREDIT_CSV.exists():
        try:
            lines = CREDIT_CSV.read_text(encoding="utf-8").strip().split("\n")
            data_lines = lines[1:][-30:]
            dates, creds, deps, ratios = [], [], [], []
            for l in data_lines:
                p = l.split(",")
                dates.append(datetime.strptime(p[0], "%Y/%m/%d"))
                creds.append(float(p[1]))
                deps.append(float(p[2]))
                ratios.append(float(p[3]))
            histories["CREDIT"] = pd.DataFrame(
                {"ratio": ratios, "credit_balance": creds, "deposit": deps},
                index=dates,
            )
        except Exception as e:
            log(f"Credit chart history error: {e}", level="WARN")

    return histories


def _get_anomaly_desc(key, anomalies, indicators):
    """해당 지표의 이상치 설명 텍스트 생성."""
    descs = []
    for a in anomalies:
        if a["ticker"] != key:
            continue
        if a["type"] == "combined" and key in indicators:
            d = indicators[key]
            direction = "급등" if d["change_pct"] > 0 else "급락"
            descs.append(f"전일 대비 {d['change_pct']:+.1f}% {direction}, z={d['zscore']:+.1f}σ")
        elif a["type"] == "zscore_breach" and key in indicators:
            d = indicators[key]
            direction = "상방" if d["zscore"] > 0 else "하방"
            descs.append(f"MA20({d['ma20']}) 기준 {d['zscore']:+.1f}σ {direction} 이탈")
        elif a["type"] == "high_change" and key in indicators:
            d = indicators[key]
            direction = "급등" if d["change_pct"] > 0 else "급락"
            descs.append(f"전일 대비 {d['change_pct']:+.1f}% {direction}")
        elif a["type"] == "credit_signal":
            descs.append(a["detail"])
    return " / ".join(descs) if descs else ""


def generate_anomaly_charts(anomalies, indicators, credit_data=None):
    """이상치 통합 차트 1장 + 신용비율 현황 차트 1장 (항상) 생성."""
    plt = _setup_matplotlib()
    import matplotlib.dates as mdates
    import pandas as pd

    CHART_DIR.mkdir(parents=True, exist_ok=True)
    name_map = {**{k: v["name"] for k, v in INDICATORS.items()},
                **{k: v["name"] for k, v in DERIVED_CONFIGS.items()},
                "KR3Y": KR3Y_CONFIG["name"]}
    date_str = datetime.now().strftime("%Y-%m-%d")
    chart_results = []  # (path, caption)

    # ── 1. 이상치 통합 차트 (CREDIT 제외, 전부 한 이미지) ──
    anomaly_keys = [a["ticker"] for a in anomalies if a["ticker"] != "CREDIT"]
    if anomaly_keys:
        histories = fetch_chart_histories(set(anomaly_keys))
        available = [t for t in anomaly_keys if t in histories]
        if available:
            descs = []
            for t in available:
                desc = _get_anomaly_desc(t, anomalies, indicators)
                if desc:
                    descs.append(f"{name_map.get(t, t)}: {desc}")

            n = len(available)
            fig, axes = plt.subplots(n, 1, figsize=(10, 3.2 * n), squeeze=False)
            fig.suptitle(f"시장 이상치 ({date_str})",
                         fontsize=13, fontweight="bold", y=0.98)

            for i, key in enumerate(available):
                ax = axes[i][0]
                name = name_map.get(key, key)
                series = histories[key]
                ax.plot(series.index, series.values, color="#2196F3",
                        linewidth=1.8, label=name, zorder=4)

                window = min(20, len(series))
                if len(series) >= 3:
                    ma = series.rolling(window, min_periods=1).mean()
                    std = series.rolling(window, min_periods=1).std()
                    ax.plot(series.index, ma.values, color="#FF9800", linewidth=1,
                            linestyle="--", label="MA20", alpha=0.7)
                    upper = (ma + 2 * std).values
                    lower = (ma - 2 * std).values
                    ax.fill_between(series.index, lower, upper,
                                    alpha=0.1, color="red", label="±2σ 범위")
                    last_ma = ma.iloc[-1]
                    last_std = std.iloc[-1] if std.iloc[-1] == std.iloc[-1] else 0
                    if last_std > 0:
                        ax.axhline(y=last_ma + 2 * last_std, color="red",
                                   linestyle=":", alpha=0.3, linewidth=0.8)
                        ax.axhline(y=last_ma - 2 * last_std, color="red",
                                   linestyle=":", alpha=0.3, linewidth=0.8)
                        ax.axhline(y=last_ma, color="#FF9800",
                                   linestyle=":", alpha=0.3, linewidth=0.8)

                last_val = series.values[-1]
                ax.scatter([series.index[-1]], [last_val],
                           color="red", s=80, zorder=5,
                           edgecolors="white", linewidths=1)

                desc = _get_anomaly_desc(key, anomalies, indicators)
                unit = "%" if key == "KR3Y" else ""
                val_text = f"{last_val:.2f}{unit}"
                if desc:
                    val_text += f"\n{desc}"
                ax.annotate(
                    val_text,
                    xy=(series.index[-1], last_val),
                    xytext=(-15, 15), textcoords="offset points",
                    fontsize=9, color="red", fontweight="bold", ha="right",
                    arrowprops=dict(arrowstyle="->", color="red", lw=1),
                    bbox=dict(boxstyle="round,pad=0.3", facecolor="white",
                              edgecolor="red", alpha=0.9))

                ax.legend(loc="upper left", fontsize=7, framealpha=0.6)
                subtitle = f"{name}: {desc}" if desc else name
                ax.set_title(subtitle, fontsize=10, loc="left", fontweight="bold")
                ax.grid(True, alpha=0.2)
                ax.xaxis.set_major_formatter(mdates.DateFormatter("%m/%d"))

            plt.tight_layout(rect=[0, 0, 1, 0.95])
            chart_path = CHART_DIR / f"{date_str}_anomalies.png"
            fig.savefig(str(chart_path), dpi=140, bbox_inches="tight")
            plt.close(fig)

            caption = "시장 이상치\n" + "\n".join(descs)
            chart_results.append((chart_path, caption))
            log(f"Chart: {chart_path.name} ({n} subplots)")

    # ── 2. 신용비율 현황 차트 — 2패널 (위: ratio+시그널존, 아래: 잔고/예수금 분리) ──
    credit_histories = fetch_chart_histories({"CREDIT"})
    if "CREDIT" in credit_histories and isinstance(credit_histories["CREDIT"], pd.DataFrame):
        cdf = credit_histories["CREDIT"]
        fig, (ax_top, ax_bot) = plt.subplots(2, 1, figsize=(10, 6.5),
                                              height_ratios=[3, 2], sharex=True)
        fig.suptitle(f"신용비율 현황 ({date_str})",
                     fontsize=13, fontweight="bold")

        # ── 상단: 신용비율 + 시그널존 ──
        ax_top.plot(cdf.index, cdf["ratio"], color="#d62728", linewidth=2,
                    marker="o", markersize=3, label="신용비율(%)", zorder=5)
        ax_top.set_ylabel("비중 (%)", color="#d62728", fontsize=10)
        ax_top.tick_params(axis="y", labelcolor="#d62728")

        ax_top.axhline(y=30, color="green", linestyle="--", alpha=0.4, linewidth=0.8)
        ax_top.axhline(y=35, color="orange", linestyle="--", alpha=0.4, linewidth=0.8)
        ax_top.axhline(y=40, color="red", linestyle="--", alpha=0.4, linewidth=0.8)
        ax_top.axhspan(0, 30, alpha=0.03, color="green")
        ax_top.axhspan(30, 35, alpha=0.03, color="yellow")
        ax_top.axhspan(35, 40, alpha=0.03, color="orange")
        ax_top.axhspan(40, 55, alpha=0.03, color="red")

        x_right = cdf.index[-1] + timedelta(days=1)
        ax_top.text(x_right, 28, "매수 고려", fontsize=7, color="green", va="center")
        ax_top.text(x_right, 32.5, "중립", fontsize=7, color="#b8860b", va="center")
        ax_top.text(x_right, 37.5, "주의", fontsize=7, color="orange", va="center")
        ax_top.text(x_right, 42, "매도 경고", fontsize=7, color="red", va="center")

        last_ratio = cdf["ratio"].iloc[-1]
        signal = credit_data["signal"] if credit_data else ""
        ax_top.annotate(
            f"현재 {last_ratio:.1f}% [{signal}]",
            xy=(cdf.index[-1], last_ratio),
            xytext=(0, 15), textcoords="offset points", ha="center",
            fontsize=10, fontweight="bold", color="#d62728",
            bbox=dict(boxstyle="round,pad=0.3", facecolor="white",
                      edgecolor="#d62728", alpha=0.9))

        r_min = min(cdf["ratio"].min(), 25)
        r_max = max(cdf["ratio"].max(), 42)
        margin = max((r_max - r_min) * 0.1, 1)
        ax_top.set_ylim(r_min - margin, r_max + margin)
        ax_top.legend(loc="upper left", fontsize=7, framealpha=0.8)
        ax_top.grid(True, alpha=0.2)

        # ── 하단: 신용잔고 + 예수금 (각각 독립 Y축) ──
        color_credit = "#1f77b4"
        color_deposit = "#ff7f0e"

        ax_bot.plot(cdf.index, cdf["credit_balance"], color=color_credit,
                    linewidth=1.8, marker="s", markersize=2, label="신용잔고(조원)")
        ax_bot.set_ylabel("신용잔고 (조원)", color=color_credit, fontsize=9)
        ax_bot.tick_params(axis="y", labelcolor=color_credit)

        # 최신값 표기
        last_credit = cdf["credit_balance"].iloc[-1]
        ax_bot.annotate(f"{last_credit:.1f}조",
                        xy=(cdf.index[-1], last_credit),
                        xytext=(5, 8), textcoords="offset points",
                        fontsize=8, color=color_credit, fontweight="bold")

        # 예수금: 우축 (독립 스케일)
        ax_dep = ax_bot.twinx()
        ax_dep.plot(cdf.index, cdf["deposit"], color=color_deposit,
                    linewidth=1.8, marker="^", markersize=2, label="예수금(조원)")
        ax_dep.set_ylabel("예수금 (조원)", color=color_deposit, fontsize=9)
        ax_dep.tick_params(axis="y", labelcolor=color_deposit)

        last_dep = cdf["deposit"].iloc[-1]
        ax_dep.annotate(f"{last_dep:.1f}조",
                        xy=(cdf.index[-1], last_dep),
                        xytext=(5, -12), textcoords="offset points",
                        fontsize=8, color=color_deposit, fontweight="bold")

        # 범례 합치기
        l1, lb1 = ax_bot.get_legend_handles_labels()
        l2, lb2 = ax_dep.get_legend_handles_labels()
        ax_bot.legend(l1 + l2, lb1 + lb2, loc="upper left", fontsize=7, framealpha=0.8)
        ax_bot.grid(True, alpha=0.2)
        ax_bot.xaxis.set_major_formatter(mdates.DateFormatter("%m/%d"))

        plt.tight_layout()
        chart_path = CHART_DIR / f"{date_str}_credit.png"
        fig.savefig(str(chart_path), dpi=140, bbox_inches="tight")
        plt.close(fig)

        caption = "신용비율 현황"
        if credit_data:
            c = credit_data
            arrow = "▲" if c["ratio_change"] > 0 else "▼"
            caption += f"\n{c['ratio']:.1f}% ({arrow}{abs(c['ratio_change']):.1f}%p) {c['signal']}"
            caption += f"\n신용잔고 {c['credit_balance']:.1f}조 / 예수금 {c['deposit']:.1f}조"
        chart_results.append((chart_path, caption))
        log(f"Chart: {chart_path.name} (credit)")

    return chart_results


def send_telegram_images(chart_results, chat_id=None, topic_id=None):
    """텔레그램 Bot API로 차트 이미지 + 캡션 전송 (shared.telegram 경유)."""
    target_chat = int(chat_id) if chat_id is not None else None
    sent = 0
    for path, caption in chart_results:
        try:
            if target_chat is not None and target_chat == GROUP_CHAT_ID:
                ok = send_photo(GROUP_CHAT_ID, str(path), caption=caption[:1024],
                                topic_id=topic_id)
            else:
                ok = send_photo(GROUP_CHAT_ID, str(path), caption=caption[:1024],
                                topic_id=topic_id)
            if ok:
                sent += 1
            else:
                log(f"Chart send failed for {path}", level="WARN")
        except Exception as e:
            log(f"Chart send error: {e}", level="WARN")
    log(f"Charts sent: {sent}/{len(chart_results)}")
    return sent


# ── main ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Market Indicator Tracker — 시장 지표 일일 수집")
    parser.add_argument("--notify", action="store_true", help="이상치 감지 시 텔레그램 DM")
    parser.add_argument("--dry-run", action="store_true", help="수집만, 저장/DM 없음")
    args = parser.parse_args()

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    LOGS_DIR.mkdir(parents=True, exist_ok=True)

    log("Fetching market indicators...")
    indicators = fetch_indicators()
    if not indicators:
        log("No indicators collected", level="ERROR")
        result = {"source": "market_indicator_tracker",
                  "collected_at": datetime.now().isoformat(),
                  "status": "error", "indicators_count": 0}
        print(json.dumps(result, ensure_ascii=False))
        return result

    log(f"Collected {len(indicators)}/{len(INDICATORS)} yfinance indicators")

    # 한국 국채3년 (한경+ECOS)
    kr3y = fetch_kr3y_bond()
    if kr3y:
        indicators["KR3Y"] = kr3y

    # 한경 금리 지표 (CD91, CP91, 회사채3년) + ECOS 히스토리로 MoM/YoY 계산
    hk_targets = {cfg["hk_name"]: key for key, cfg in HANKYUNG_RATE_CONFIGS.items()}
    hk_rates = _fetch_hankyung_rates(hk_targets)
    for key, hk in hk_rates.items():
        close = hk["close"]
        ecos_item = HANKYUNG_RATE_CONFIGS.get(key, {}).get("ecos_item")
        hist = _fetch_ecos_rate_history(ecos_item, days=400) if ecos_item else None
        if hist and abs(hist[-1] - close) > 0.001:
            hist.append(close)
        stats = _calc_rate_stats(close, hist) if hist else {
            "mom_pct": 0.0, "yoy_pct": 0.0,
            "ma20": close, "std20": 0, "zscore": 0, "data_points": 1,
        }
        indicators[key] = {
            "close": close, "prev": hk["prev"],
            "change_pct": hk["change_pct"],
            "data_date": hk["data_date"],
            **stats,
        }
    if hk_rates:
        rate_strs = [f"{k}={v['close']}%" for k, v in hk_rates.items()]
        log(f"Hankyung rates: {', '.join(rate_strs)}")

    # 신용스프레드 (회사채3년 AA- - 국고3년)
    if "KRC3Y" in indicators and "KR3Y" in indicators:
        spread = indicators["KRC3Y"]["close"] - indicators["KR3Y"]["close"]
        prev_spread = indicators["KRC3Y"]["prev"] - indicators["KR3Y"]["prev"]
        chg = ((spread - prev_spread) / prev_spread * 100) if prev_spread != 0 else 0
        # CRSPRD MoM/YoY: 구성요소에서 파생
        krc3y_d = indicators["KRC3Y"]
        kr3y_d = indicators["KR3Y"]
        cr_mom = krc3y_d["mom_pct"] - kr3y_d["mom_pct"]
        cr_yoy = krc3y_d["yoy_pct"] - kr3y_d["yoy_pct"]
        indicators["CRSPRD"] = {
            "close": round(spread, 3), "prev": round(prev_spread, 3),
            "change_pct": round(chg, 2),
            "mom_pct": round(cr_mom, 2), "yoy_pct": round(cr_yoy, 2),
            "ma20": round(spread, 3), "std20": 0, "zscore": 0,
            "data_points": min(krc3y_d["data_points"], kr3y_d["data_points"]),
            "data_date": indicators["KRC3Y"].get("data_date", ""),
        }
        log(f"Credit spread: {spread:.3f}%p")

    # 파생 지표 (금은비, B-W스프레드)
    derived = calculate_derived(indicators)
    indicators.update(derived)
    if derived:
        log(f"Derived indicators: {', '.join(derived.keys())}")

    # DDR5 현물가격 (TrendForce)
    ddr5 = fetch_dram_price()
    if ddr5:
        indicators["DDR5"] = ddr5

    # GPR 지정학 리스크 지수
    gpr = fetch_gpr_index()
    if gpr:
        indicators["GPR"] = gpr

    # EPU 경제정책 불확실성 지수 (US Daily + Global Monthly)
    epu = fetch_epu_index()
    for epu_key, epu_data in epu.items():
        indicators[epu_key] = epu_data
    if epu:
        epu_strs = [f"{k}={v['close']:.1f}" for k, v in epu.items()]
        log(f"EPU: {', '.join(epu_strs)}")

    # 신용잔고/예수금 (CSV 자동 갱신 후 읽기)
    update_credit_csv()
    credit_data = fetch_credit_data()

    # 이상치 감지
    anomalies = detect_anomalies(indicators, credit_data)
    if anomalies:
        log(f"Anomalies detected: {len(anomalies)}")
        for a in anomalies:
            log(f"  [{a['severity']}] {a['detail']}")

    # 요약 생성
    summary = generate_summary(indicators, anomalies, credit_data)
    log(f"Summary: {summary}")

    if args.dry_run:
        print(json.dumps({
            "source": "market_indicator_tracker",
            "collected_at": datetime.now().isoformat(),
            "status": "dry_run",
            "indicators_count": len(indicators),
            "anomalies_count": len(anomalies),
            "summary": summary,
            "indicators": indicators,
            "credit_data": credit_data,
            "anomalies": anomalies,
        }, ensure_ascii=False, indent=2))
        return

    # 저장
    save_indicators(indicators, anomalies, summary, credit_data)

    # 이상치 DM + 차트 (같은 날 중복 전송 방지)
    dm_sent = False
    charts_sent = 0
    if args.notify:
        today = datetime.now().strftime("%Y-%m-%d")
        already_sent = False
        if DM_SENT_FILE.exists():
            try:
                state = json.loads(DM_SENT_FILE.read_text(encoding="utf-8"))
                already_sent = state.get("date") == today
            except (json.JSONDecodeError, OSError):
                pass
        if already_sent:
            log("DM already sent today, skipping")
        else:
            # 지식사랑방 론채널에 리포트 전송 (항상)
            send_anomaly_dm(anomalies, summary, indicators, credit_data,
                            chat_id=GROUP_CHAT_ID, topic_id=RON_TOPIC_ID)
            # 이상치 있으면 DM 알림도 추가
            if anomalies:
                dm_sent = send_anomaly_dm(anomalies, summary, indicators, credit_data)
            # 차트: 이상치 통합 + 신용비율 현황 → 그룹 전송
            chart_results = generate_anomaly_charts(anomalies, indicators, credit_data)
            if chart_results:
                charts_sent = send_telegram_images(
                    chart_results, chat_id=GROUP_CHAT_ID, topic_id=RON_TOPIC_ID)
            if dm_sent or charts_sent or True:  # 그룹 전송은 항상 기록
                DM_SENT_FILE.write_text(
                    json.dumps({"date": today, "anomalies": len(anomalies),
                                "charts": charts_sent}),
                    encoding="utf-8",
                )

    result = {"source": "market_indicator_tracker",
              "collected_at": datetime.now().isoformat(),
              "status": "ok",
              "indicators_count": len(indicators),
              "anomalies_count": len(anomalies),
              "dm_sent": dm_sent,
              "charts_sent": charts_sent,
              "summary": summary}
    print(json.dumps(result, ensure_ascii=False))
    return result


if __name__ == "__main__":
    main()
