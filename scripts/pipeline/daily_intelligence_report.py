#!/usr/bin/env python3
"""
daily_intelligence_report.py — 통합 데일리 인텔리전스 리포트

7+ 파이프라인 출력을 취합하여 단일 리포트로 생성.

Usage:
  python3 pipeline/daily_intelligence_report.py --daily              # 데일리 리포트 (매일 08:30)
  python3 pipeline/daily_intelligence_report.py --6h-summary         # 6시간 취합 요약
  python3 pipeline/daily_intelligence_report.py --daily --dry-run    # DM 없이 stdout 출력
  python3 pipeline/daily_intelligence_report.py --6h-summary --dry-run
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.db import db_connection, resolve_ops_db_path
from shared.llm import llm_chat_direct, check_gateway, DIRECT_PREMIUM_CHAIN
from shared.log import make_logger
from shared.vault_paths import VAULT, INBOX

# ── 상수 ──────────────────────────────────────────────────────────────

WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))
MEMORY = WORKSPACE / "memory"
MEMORY_DIR = MEMORY / "daily-report"
STATE_FILE = MEMORY_DIR / "state.json"
LOG_FILE = WORKSPACE / "logs" / "daily_intelligence_report.log"

from shared.telegram import send_dm_chunked, send_group_chunked, send_dm_photo, DM_CHAT_ID, GROUP_CHAT_ID, RON_TOPIC_ID

MODELS = list(DIRECT_PREMIUM_CHAIN)
MODELS_PREMIUM = list(DIRECT_PREMIUM_CHAIN)

# ── v2.0 섹터 맵 ──────────────────────────────────────────────────

SECTOR_MAP = {
    "글로벌":   {"indicators": ["GPR", "EPU_GLOBAL", "EURUSD"]},
    "미국":     {"indicators": ["SPX", "NDX", "US10Y", "US2Y", "VIX", "EPU_US", "DXY"]},
    "중국":     {"indicators": ["SSEC", "HSI"]},
    "일본":     {"indicators": ["NIKKEI", "USDJPY"]},
    "한국":     {"indicators": ["KOSPI", "KOSDAQ", "KR3Y", "USDKRW"], "credit": True},
    "채권":     {"indicators": ["US10Y", "US2Y", "KR3Y", "SOFR", "CD91", "CP91", "KRC3Y", "CRSPRD"]},
    "원자재":   {"indicators": ["GOLD", "SILVER", "COPPER", "WTI", "NATGAS", "BDI"]},
    "IT반도체": {"indicators": ["SOXX", "DDR5"], "company_subcategory": "반도체"},
}

_LABEL_MAP = {
    "EPU_GLOBAL": "EPU글", "EPU_US": "EPU", "US10Y": "US10Y", "US2Y": "US2Y",
    "USDKRW": "KRW", "USDJPY": "JPY", "NIKKEI": "N225", "SSEC": "SSEC",
    "HSI": "HSI", "KOSPI": "KOSPI", "KOSDAQ": "KOSDAQ",
    "CRSPRD": "CrSprd", "NATGAS": "NatGas", "KRC3Y": "Corp3Y",
}

# 6시간 윈도우 시작 시각 (KST)
WINDOW_HOURS = [1, 7, 13, 19]

log = make_logger(log_file=LOG_FILE)


CHART_DIR = MEMORY_DIR / "charts"


def _setup_matplotlib():
    """matplotlib 한글 폰트 + Agg 백엔드."""
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


def generate_daily_chart(mkt: dict) -> Path | None:
    """주요 지표 DoD 변동률 + 이상치 표시 차트 생성."""
    indicators = mkt.get("indicators", {})
    if not indicators:
        return None

    try:
        plt = _setup_matplotlib()
    except Exception as e:
        log(f"matplotlib setup error: {e}")
        return None

    # 차트에 표시할 주요 지표 (순서대로)
    chart_keys = [
        "VIX", "SPX", "NDX", "KOSPI", "KOSDAQ",
        "US10Y", "KR3Y", "DXY", "USDKRW",
        "GOLD", "WTI", "SOXX", "DDR5",
        "EPU_US", "GPR",
    ]
    chart_labels = {
        "VIX": "VIX", "SPX": "S&P500", "NDX": "Nasdaq",
        "KOSPI": "KOSPI", "KOSDAQ": "KOSDAQ",
        "US10Y": "US10Y", "KR3Y": "KR3Y",
        "DXY": "DXY", "USDKRW": "USD/KRW",
        "GOLD": "Gold", "WTI": "WTI",
        "SOXX": "SOXX", "DDR5": "DDR5",
        "EPU_US": "EPU", "GPR": "GPR",
    }

    names, dods, colors = [], [], []
    high_tickers = {
        a.get("ticker", "") for a in mkt.get("anomalies", [])
        if a.get("severity") == "high"
    }

    for key in chart_keys:
        entry = indicators.get(key)
        if not entry or not isinstance(entry, dict):
            continue
        try:
            change = float(entry.get("change_pct", 0) or 0)
        except (ValueError, TypeError):
            continue
        try:
            z = float(entry.get("zscore", 0) or 0)
        except (ValueError, TypeError):
            z = 0.0

        names.append(chart_labels.get(key, key))
        dods.append(change)
        # 색상: 빨강(z≥2 이상치), 초록(상승), 회색(하락)
        if abs(z) >= 2 or key in high_tickers:
            colors.append("#e74c3c")  # red — flagged
        elif change > 0:
            colors.append("#2ecc71")  # green
        else:
            colors.append("#95a5a6")  # grey

    if not names:
        return None

    try:
        fig, ax = plt.subplots(figsize=(10, max(4, len(names) * 0.35)))
        y_pos = range(len(names))
        bars = ax.barh(y_pos, dods, color=colors, height=0.6, edgecolor="white")

        ax.set_yticks(y_pos)
        ax.set_yticklabels(names, fontsize=10)
        ax.invert_yaxis()
        ax.set_xlabel("DoD (%)", fontsize=10)
        ax.set_title(
            f"Daily Market Change  ({datetime.now().strftime('%Y-%m-%d')})",
            fontsize=12, fontweight="bold", pad=10,
        )
        ax.axvline(x=0, color="black", linewidth=0.5)

        # 수치 라벨
        for bar_item, val in zip(bars, dods):
            x_pos = bar_item.get_width()
            offset = 0.15 if val >= 0 else -0.15
            ha = "left" if val >= 0 else "right"
            ax.text(x_pos + offset, bar_item.get_y() + bar_item.get_height() / 2,
                    f"{val:+.1f}%", va="center", ha=ha, fontsize=8)

        # 범례
        from matplotlib.patches import Patch
        legend_items = [
            Patch(facecolor="#e74c3c", label="Anomaly (|z|>=2)"),
            Patch(facecolor="#2ecc71", label="Up"),
            Patch(facecolor="#95a5a6", label="Down"),
        ]
        ax.legend(handles=legend_items, loc="lower right", fontsize=8)

        ax.grid(axis="x", alpha=0.3)
        fig.tight_layout()

        CHART_DIR.mkdir(parents=True, exist_ok=True)
        date_str = datetime.now().strftime("%Y-%m-%d")
        chart_path = CHART_DIR / f"{date_str}_daily_overview.png"
        fig.savefig(str(chart_path), dpi=140, bbox_inches="tight")
        plt.close(fig)
        log(f"Chart generated: {chart_path.name}")
        return chart_path
    except Exception as e:
        log(f"Chart generation error: {e}")
        return None


CREDIT_CSV = WORKSPACE / "memory" / "backup" / "vps-brain" / "skills" \
              / "credit-monitor" / "data" / "historical_daily.csv"


def generate_credit_chart(mkt: dict) -> Path | None:
    """신용비율 현황 차트 — 비율+5MA+KOSPI+시그널존."""
    if not CREDIT_CSV.exists():
        return None
    try:
        import pandas as pd
        plt = _setup_matplotlib()
        import matplotlib.dates as mdates
    except Exception as e:
        log(f"credit chart import error: {e}")
        return None

    try:
        df = pd.read_csv(str(CREDIT_CSV), parse_dates=["date"], index_col="date")
        df = df.dropna(subset=["ratio"])
        df = df.loc["2020-01-01":]  # 2020년 1월부터
        if len(df) < 5:
            return None

        df["ratio_5ma"] = df["ratio"].rolling(5).mean()

        # KOSPI 로드
        kospi_close = None
        try:
            import yfinance as yf
            kospi = yf.download("^KS11", start="2020-01-01", progress=False)
            kospi_close = kospi["Close"].squeeze()
            kospi_close.index = kospi_close.index.tz_localize(None)
        except Exception as e:
            log(f"KOSPI download for credit chart: {e}")

        date_str = datetime.now().strftime("%Y-%m-%d")
        credit = mkt.get("credit_data", {})

        fig, ax1 = plt.subplots(figsize=(13, 6))

        # 시그널존 배경
        ax1.axhspan(0, 30, alpha=0.05, color="green")
        ax1.axhspan(30, 35, alpha=0.05, color="yellow")
        ax1.axhspan(35, 40, alpha=0.05, color="orange")
        ax1.axhspan(40, 55, alpha=0.05, color="red")
        ax1.axhline(y=30, color="green", linestyle="--", alpha=0.5, linewidth=0.8)
        ax1.axhline(y=35, color="orange", linestyle="--", alpha=0.5, linewidth=0.8)
        ax1.axhline(y=40, color="red", linestyle="--", alpha=0.5, linewidth=0.8)

        # 시그널 라벨
        ax1.text(df.index[3], 27, "매수고려 (<30%)", fontsize=7, color="green", va="center")
        ax1.text(df.index[3], 32.5, "중립", fontsize=7, color="#b8860b", va="center")
        ax1.text(df.index[3], 37.5, "주의", fontsize=7, color="orange", va="center")
        ax1.text(df.index[3], 42.5, "매도경고 (>40%)", fontsize=7, color="red", va="center")

        # 신용비율 + 5MA
        ax1.plot(df.index, df["ratio"], color="#d62728", linewidth=1.0,
                 alpha=0.5, label="신용비율 (%)", zorder=4)
        ax1.plot(df.index, df["ratio_5ma"], color="#d62728", linewidth=2.0,
                 label="5MA", zorder=5)
        ax1.set_ylabel("신용비율 (%)", color="#d62728", fontsize=10)
        ax1.tick_params(axis="y", labelcolor="#d62728")

        # 현재값 어노테이션
        last_ratio = df["ratio"].iloc[-1]
        signal = credit.get("signal", "") if credit else ""
        ax1.annotate(
            f"{last_ratio:.1f}% [{signal}]",
            xy=(df.index[-1], last_ratio),
            xytext=(0, 15), textcoords="offset points", ha="center",
            fontsize=10, fontweight="bold", color="#d62728",
            bbox=dict(boxstyle="round,pad=0.3", facecolor="white",
                      edgecolor="#d62728", alpha=0.9))

        r_min, r_max = min(df["ratio"].min(), 25), max(df["ratio"].max(), 45)
        ax1.set_ylim(r_min - 2, r_max + 2)

        # KOSPI 오버레이
        if kospi_close is not None and len(kospi_close) > 0:
            ax2 = ax1.twinx()
            ax2.plot(kospi_close.index, kospi_close.values, color="#1f77b4",
                     linewidth=1.0, alpha=0.6, label="KOSPI")
            ax2.set_ylabel("KOSPI", color="#1f77b4", fontsize=10)
            ax2.tick_params(axis="y", labelcolor="#1f77b4")
            l1, lb1 = ax1.get_legend_handles_labels()
            l2, lb2 = ax2.get_legend_handles_labels()
            ax1.legend(l1 + l2, lb1 + lb2, loc="upper right", fontsize=8)
        else:
            ax1.legend(loc="upper right", fontsize=8)

        ax1.set_title(
            f"KOSPI 매수판단 신호 — 신용비율  {date_str}",
            fontsize=13, fontweight="bold",
        )
        ax1.grid(True, alpha=0.12)

        ax1.xaxis.set_major_locator(mdates.YearLocator())
        ax1.xaxis.set_minor_locator(mdates.MonthLocator(bymonth=[4, 7, 10]))
        ax1.xaxis.set_major_formatter(mdates.DateFormatter("%Y"))
        ax1.xaxis.set_minor_formatter(mdates.DateFormatter("%m"))
        ax1.tick_params(axis="x", which="minor", labelsize=7, pad=1)
        ax1.tick_params(axis="x", which="major", labelsize=9, pad=12)
        plt.tight_layout()

        CHART_DIR.mkdir(parents=True, exist_ok=True)
        chart_path = CHART_DIR / f"{date_str}_credit.png"
        fig.savefig(str(chart_path), dpi=140, bbox_inches="tight")
        plt.close(fig)
        log(f"Credit chart generated: {chart_path.name}")
        return chart_path
    except Exception as e:
        log(f"Credit chart error: {e}")
        return None


# ── 유틸리티 ──────────────────────────────────────────────────────────

def _find_latest_json(directory: Path, exclude: list[str] | None = None,
                      exclude_dirs: list[str] | None = None) -> dict | None:
    """디렉토리에서 가장 최근 .json 파일 로드. 실패 시 None."""
    if not directory.exists():
        return None
    exclude = exclude or []
    exclude_dirs = exclude_dirs or []
    candidates: list[Path] = []
    for f in directory.iterdir():
        if not f.is_file() or f.suffix != ".json":
            continue
        if f.name.startswith("."):
            continue
        if f.name in exclude:
            continue
        if any(d in f.parts for d in exclude_dirs):
            continue
        candidates.append(f)
    if not candidates:
        return None
    latest = max(candidates, key=lambda p: p.stat().st_mtime)
    try:
        with open(latest) as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError):
        return None


def _find_latest_report(directory: Path) -> str | None:
    """디렉토리에서 가장 최근 .md 리포트의 앞 500자 반환."""
    if not directory.exists():
        return None
    candidates = sorted(directory.glob("*.md"), key=lambda p: p.stat().st_mtime,
                        reverse=True)
    if not candidates:
        return None
    try:
        text = candidates[0].read_text(encoding="utf-8")[:500]
        return text
    except OSError:
        return None


def _count_recent_files(directory: Path, hours: int = 24,
                        suffix: str = ".md") -> int:
    """지정 시간 내 생성/수정된 파일 수."""
    if not directory.exists():
        return 0
    cutoff = time.time() - (hours * 3600)
    count = 0
    for f in directory.rglob(f"*{suffix}"):
        try:
            if f.stat().st_mtime >= cutoff:
                count += 1
        except OSError:
            continue
    return count


def _fmt_num(val, fmt: str = ".1f") -> str:
    """숫자 포맷. None이면 '-'."""
    if val is None:
        return "-"
    try:
        return f"{float(val):{fmt}}"
    except (ValueError, TypeError):
        return str(val)


def _get_6h_window() -> tuple[datetime, datetime]:
    """현재 시각 기준으로 가장 가까운 6시간 윈도우(과거)의 start, end 반환."""
    now = datetime.now()
    # 현재 시각 이하인 가장 큰 윈도우 시작점
    current_hour = now.hour
    start_hour = max((h for h in WINDOW_HOURS if h <= current_hour),
                     default=WINDOW_HOURS[-1])
    if start_hour > current_hour:
        # 전날 마지막 윈도우
        start = (now - timedelta(days=1)).replace(
            hour=start_hour, minute=0, second=0, microsecond=0)
    else:
        start = now.replace(hour=start_hour, minute=0, second=0, microsecond=0)
    end = start + timedelta(hours=6)
    return start, end


# ── 섹션 수집 함수 ───────────────────────────────────────────────────

def collect_ops_section(db_path: Path) -> str:
    """운영 섹션: 볼트 흐름 + 시스템 상태 + 할일."""
    lines: list[str] = []

    # 1) 볼트 흐름 — vault-flow-health state.json
    vault_line = "[볼트] 데이터 없음"
    try:
        vfh_state_file = MEMORY / "vault-flow-health" / "state.json"
        if vfh_state_file.exists():
            with open(vfh_state_file) as f:
                vfh = json.load(f)
            today = datetime.now().strftime("%Y-%m-%d")
            # 오늘 데이터 우선, 없으면 가장 최근
            entry = vfh.get(today)
            if not entry and vfh:
                latest_key = max(vfh.keys())
                entry = vfh[latest_key]
            if entry:
                parts = []
                stage_map = [
                    ("수신함", "캡처"), ("정리", "정리"),
                    ("지식화", "지식화"), ("연결", "연결"), ("판단", "판단"),
                ]
                for label, key in stage_map:
                    val = entry.get(key, 0)
                    parts.append(f"{label} {val}")
                vault_line = "[볼트] " + " | ".join(parts)
    except Exception as e:
        log(f"vault-flow-health read error: {e}")
    lines.append(vault_line)

    # 2) 시스템 상태 — Gateway + 워커
    gw_status = "\U0001f534"  # red circle
    try:
        if check_gateway(timeout=5):
            gw_status = "\U0001f7e2"  # green circle
    except Exception:
        pass

    worker_count = 0
    try:
        result = subprocess.run(
            ["pgrep", "-f", "agent_queue_worker"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            worker_count = len(result.stdout.strip().splitlines())
    except Exception:
        pass

    # 크론 실패 — bus_commands에서 최근 24h 실패 수
    cron_fail = 0
    try:
        with db_connection(db_path) as conn:
            row = conn.execute(
                "SELECT COUNT(*) FROM bus_commands "
                "WHERE status='failed' AND created_at >= datetime('now', '-1 day', 'localtime')"
            ).fetchone()
            if row:
                cron_fail = row[0]
    except Exception:
        pass

    lines.append(f"[시스템] Gateway {gw_status} | 워커 {worker_count}/5 | 크론실패 {cron_fail}건")

    # 3) 할일 — ops_todos
    urgent = high = normal = completed = 0
    try:
        with db_connection(db_path) as conn:
            for prio in ("urgent", "high", "normal"):
                row = conn.execute(
                    "SELECT COUNT(*) FROM ops_todos WHERE status IN ('todo','open') AND priority=?",
                    (prio,),
                ).fetchone()
                if row:
                    if prio == "urgent":
                        urgent = row[0]
                    elif prio == "high":
                        high = row[0]
                    else:
                        normal = row[0]
            row = conn.execute(
                "SELECT COUNT(*) FROM ops_todos "
                "WHERE status='completed' AND date(completed_at)=date('now','localtime')"
            ).fetchone()
            if row:
                completed = row[0]
    except Exception as e:
        log(f"ops_todos query error: {e}")

    lines.append(f"[할일] urgent {urgent} / high {high} / normal {normal} \u2014 완료 {completed}건")

    return "\n".join(lines)


def collect_market_section() -> str:
    """투자-시장: market-indicators 최신 JSON에서 핵심 지표 추출."""
    data = _find_latest_json(MEMORY / "market-indicators")
    if not data:
        return "[시장] 데이터 없음"

    # 주요 지표 추출 — 다양한 키 이름 시도
    key_indicators = {
        "VIX": ["VIX", "^VIX", "vix"],
        "10Y": ["US10Y", "^TNX", "us_10y", "10y_yield"],
        "DXY": ["DXY", "DX-Y.NYB", "dxy", "dollar_index"],
        "KOSPI": ["KOSPI", "^KS11", "kospi"],
    }

    parts: list[str] = []
    anomalies: list[str] = []

    for label, keys in key_indicators.items():
        found = False
        for k in keys:
            if k in data:
                entry = data[k]
                if isinstance(entry, dict):
                    val = entry.get("value", entry.get("close", entry.get("last")))
                    change = entry.get("change", entry.get("change_pct"))
                    z = entry.get("z_score", entry.get("zscore"))
                    val_str = _fmt_num(val)
                    if label == "10Y":
                        val_str += "%"
                    parts.append(f"{label} {val_str}")
                    if z is not None and abs(float(z)) > 2:
                        arrow = "\u25b2" if float(z) > 0 else "\u25bc"
                        anomalies.append(f"{label} z={_fmt_num(z)}{arrow}")
                elif isinstance(entry, (int, float)):
                    parts.append(f"{label} {_fmt_num(entry)}")
                found = True
                break
        if not found:
            parts.append(f"{label} -")

    line1 = "[시장] " + " | ".join(parts)

    # 추가로 data 전체를 순회하며 z_score 높은 것 찾기
    if not anomalies:
        for k, v in data.items():
            if isinstance(v, dict):
                z = v.get("z_score", v.get("zscore"))
                if z is not None:
                    try:
                        if abs(float(z)) > 2:
                            arrow = "\u25b2" if float(z) > 0 else "\u25bc"
                            anomalies.append(f"{k} z={_fmt_num(z)}{arrow}")
                    except (ValueError, TypeError):
                        pass

    if anomalies:
        line1 += "\n       이상치: " + ", ".join(anomalies[:5])

    return line1


def collect_geo_section() -> str:
    """투자-지정학: DOUGHCON, GPR/EPU, 주요 변동."""
    data = _find_latest_json(
        MEMORY / "geopolitical",
        exclude=["watchlist.json"],
        exclude_dirs=["charts", "screenshots"],
    )
    if not data:
        return "[지정학] 데이터 없음"

    parts: list[str] = []

    # DOUGHCON
    pent = data.get("pentagon_index", {})
    doughcon = pent.get("doughcon")
    if doughcon is not None:
        parts.append(f"DOUGHCON {doughcon}")
    else:
        parts.append("DOUGHCON -")

    # GPR / EPU
    gpr_epu = data.get("gpr_epu", {})
    gpr = gpr_epu.get("gpr")
    epu = gpr_epu.get("epu_us")
    if gpr is not None:
        parts.append(f"GPR {_fmt_num(gpr)}")
    if epu is not None:
        parts.append(f"EPU {_fmt_num(epu)}")

    line = "[지정학] " + " | ".join(parts)

    # 주요 변동 — anomalies 또는 alert
    alert = data.get("alert_level", "normal")
    alert_reason = data.get("alert_reason", "")
    anomalies = data.get("anomalies", [])

    extras: list[str] = []
    if alert != "normal" and alert_reason:
        extras.append(alert_reason)
    if anomalies:
        for a in anomalies[:3]:
            if isinstance(a, str):
                extras.append(a)
            elif isinstance(a, dict):
                extras.append(a.get("description", a.get("region", str(a))))

    if extras:
        line += "\n       주요: " + "; ".join(extras)

    return line


def collect_company_section(db_path: Path) -> str:
    """투자-기업 인사이트: 최근 24시간 내 새 인사이트 기업 TOP 5."""
    try:
        with db_connection(db_path) as conn:
            # 테이블 존재 확인
            tables = {row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()}
            needed = {"company_entities", "company_insights"}
            if not needed.issubset(tables):
                return "[기업 인사이트] 테이블 없음"

            has_ratings = "company_ratings" in tables

            if has_ratings:
                query = """
                    SELECT ce.canonical_name, ce.ticker, cr.overall_score,
                           COUNT(ci.id) as new_count
                    FROM company_entities ce
                    JOIN company_insights ci ON ci.company_id = ce.id
                    LEFT JOIN company_ratings cr ON cr.company_id = ce.id
                    WHERE ci.date >= date('now', '-1 day', 'localtime')
                    GROUP BY ce.id
                    ORDER BY new_count DESC
                    LIMIT 5
                """
            else:
                query = """
                    SELECT ce.canonical_name, ce.ticker, NULL as overall_score,
                           COUNT(ci.id) as new_count
                    FROM company_entities ce
                    JOIN company_insights ci ON ci.company_id = ce.id
                    WHERE ci.date >= date('now', '-1 day', 'localtime')
                    GROUP BY ce.id
                    ORDER BY new_count DESC
                    LIMIT 5
                """

            rows = conn.execute(query).fetchall()
            if not rows:
                return "[기업 인사이트] 최근 24h 신규 없음"

            lines = ["[기업 인사이트]"]
            for name, ticker, score, count in rows:
                display = ticker or name or "?"
                score_str = f"\u2605{_fmt_num(score)}" if score else ""
                # 최근 인사이트 요약 (첫 번째)
                summary_row = conn.execute(
                    "SELECT content FROM company_insights "
                    "WHERE company_id = (SELECT id FROM company_entities WHERE canonical_name=?) "
                    "ORDER BY date DESC LIMIT 1",
                    (name,),
                ).fetchone()
                summary = ""
                if summary_row and summary_row[0]:
                    summary = summary_row[0][:40].replace("\n", " ")
                    if len(summary_row[0]) > 40:
                        summary += "..."

                parts = [f"  \u00b7 {display}"]
                if score_str:
                    parts.append(score_str)
                if summary:
                    parts.append(f"\u2014 {summary}")
                parts.append(f"(+{count}건)")
                lines.append(" ".join(parts))

            return "\n".join(lines)
    except Exception as e:
        log(f"company section error: {e}")
        return "[기업 인사이트] 조회 실패"


def collect_popular_section() -> str:
    """투자-인기: popular-posts + twitter-collector 최근 리포트에서 TOP 3."""
    items: list[str] = []

    # popular-posts
    pp_report = _find_latest_report(MEMORY / "popular-posts" / "reports")
    if pp_report:
        # 리포트에서 제목 줄 추출 (번호. `채널명` 형식)
        for line in pp_report.splitlines():
            stripped = line.strip()
            if stripped and stripped[0].isdigit() and ". " in stripped:
                # 첫 80자만
                title = stripped.split(". ", 1)[1][:80]
                if len(stripped.split(". ", 1)[1]) > 80:
                    title += "..."
                items.append(title)
                if len(items) >= 3:
                    break

    # twitter-collector
    tw_report = _find_latest_report(MEMORY / "twitter-collector" / "reports")
    if tw_report and len(items) < 3:
        for line in tw_report.splitlines():
            stripped = line.strip()
            if stripped and stripped[0].isdigit() and ". " in stripped:
                title = stripped.split(". ", 1)[1][:80]
                if len(stripped.split(". ", 1)[1]) > 80:
                    title += "..."
                items.append(title)
                if len(items) >= 3:
                    break

    if not items:
        return "[인기] 데이터 없음"

    display = ", ".join(items[:3])
    # 너무 길면 줄바꿈
    if len(display) > 120:
        lines = ["[인기] TOP 3"]
        for i, item in enumerate(items[:3], 1):
            lines.append(f"  {i}. {item}")
        return "\n".join(lines)
    return f"[인기] TOP 3 \u2014 {display}"


def collect_reference_section() -> str:
    """참고 섹션: 블로그/가설/발견 카운트."""
    lines: list[str] = []

    # 블로그 인사이트 (최근 24h)
    blog_count = _count_recent_files(MEMORY / "blog-insights", hours=24)
    lines.append(f"[블로그] 새 인사이트 {blog_count}건")

    # 가설 (전체 진행 중)
    hypo_dir = MEMORY / "hypotheses"
    hypo_count = 0
    if hypo_dir.exists():
        hypo_count = sum(1 for f in hypo_dir.rglob("*.md") if f.is_file())
    lines.append(f"[가설] 진행 중 {hypo_count}건")

    # 발견 (최근 24h)
    disc_count = _count_recent_files(MEMORY / "filtered-ideas", hours=24)
    lines.append(f"[발견] score\u22677 {disc_count}건")

    return "\n".join(lines)


# ── v2.0 데이터 로더 ────────────────────────────────────────────────

def _clean_llm_text(text: str) -> str:
    """LLM 출력에서 비한국어 문자, 마크다운, 깨진 단어 제거."""
    # Remove markdown
    text = text.replace("**", "").replace("__", "").replace("*", "")
    # Remove CJK Unified Ideographs (Chinese), Hiragana, Katakana, Cyrillic
    text = re.sub(
        r'[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u309f\u30a0-\u30ff\uf900-\ufaff'
        r'\u0400-\u04ff]',
        '', text,
    )
    # Remove stray box-drawing/pipe/bullet characters
    text = text.replace("│", "").replace("┃", "").replace("▪", "")
    # Remove leftover direction markers in wrong places + trailing slashes
    text = re.sub(r'/[▲▼─]', '', text)
    text = re.sub(r'(?<=[^\d])/\s*$', '', text, flags=re.MULTILINE)  # trailing /
    # Underscores used as separator → space
    text = re.sub(r'(?<=[가-힣a-zA-Z])_(?=[가-힣a-zA-Z])', ' ', text)
    # Fix common LLM garbled mixed-script words
    _WORD_FIXES = {
        "Trump": "트럼프", "trump": "트럼프",
        "트럼프's": "트럼프의", "트럼프's": "트럼프의",
        "트rump": "트럼프", "트Rump": "트럼프",
        "dooCON": "DOUGHCON", "DOUGH CON": "DOUGHCON",
        "doughcon": "DOUGHCON", "DOUGH_CONTRACT": "DOUGHCON",
        " but ": " 그러나 ", " But ": " 그러나 ",
        " mixed": " 혼조", "Mixed": "혼조",
        "blogs": "블로그", "Blogs": "블로그",
        "stocks": "주식", "Stocks": "주식",
        "Dollar": "달러", "dollar": "달러",
        "policy": "정책", "Policy": "정책",
        "market": "시장", "Market": "시장",
        "supply chain": "공급망", "Supply Chain": "공급망",
        "tariff": "관세", "Tariff": "관세",
        "inflation": "인플레이션",
        "inúmer": "", "número": "",
    }
    for bad, good in _WORD_FIXES.items():
        text = text.replace(bad, good)
    # English possessive 's after Korean → 의
    text = re.sub(r"(?<=[가-힣])'s\b", "의", text)
    # Remove stray single Latin chars between Korean (garbled fragments)
    text = re.sub(r'(?<=[가-힣])[a-z](?=[가-힣])', '', text)
    # Collapse multiple spaces
    text = re.sub(r' {2,}', ' ', text)
    return text.strip()


def _fmt_ind(name: str, indicators: dict, high_tickers: set) -> str:
    """Format single indicator: LABEL VALUE(change!) for factcheck (legacy)."""
    label = _LABEL_MAP.get(name, name)
    entry = indicators.get(name)
    if not entry or not isinstance(entry, dict):
        return f"{label} -"

    val = entry.get("close", entry.get("value"))
    if val is None:
        return f"{label} -"

    try:
        change = float(entry.get("change_pct", 0) or 0)
    except (ValueError, TypeError):
        change = 0.0
    try:
        z = float(entry.get("zscore", 0) or 0)
    except (ValueError, TypeError):
        z = 0.0

    try:
        fval = float(val)
        if abs(fval) >= 1000:
            val_str = f"{fval:.0f}"
        elif abs(fval) >= 10:
            val_str = f"{fval:.1f}"
        else:
            val_str = f"{fval:.2f}"
    except (ValueError, TypeError):
        val_str = str(val)

    flagged = abs(z) >= 2 or name in high_tickers
    parts: list[str] = []
    if abs(change) >= 1.0:
        if change < 0:
            parts.append(f"\u25bc{abs(change):.1f}")
        else:
            parts.append(f"+{change:.1f}")
    if abs(z) >= 2:
        parts.append(f"z{z:.1f}")

    if parts:
        suffix = " ".join(parts)
        if flagged:
            return f"{label} {val_str}({suffix}!)"
        return f"{label} {val_str}({suffix})"
    if flagged:
        return f"{label} {val_str}(!)"
    return f"{label} {val_str}"


def _fmt_pct(v: float | None) -> str:
    """±N.N 형식. 0이면 0.0."""
    if v is None:
        return "  -"
    return f"{v:+.1f}"


_RATE_TICKERS = {"US10Y", "US2Y", "SOFR", "KR3Y", "CD91", "CP91", "KRC3Y"}
_SPREAD_TICKERS = {"CRSPRD"}
_USD_TICKERS = {"GOLD", "SILVER", "COPPER", "WTI", "NATGAS"}


def _fmt_table_row(name: str, indicators: dict, high_tickers: set) -> str:
    """테이블 행: ·LABEL  VALUE  DoD  MoM  YoY."""
    label = _LABEL_MAP.get(name, name)
    entry = indicators.get(name)
    if not entry or not isinstance(entry, dict):
        return f"·{label:<8s}  -"

    val = entry.get("close", entry.get("value"))
    if val is None:
        return f"·{label:<8s}  -"

    try:
        z = float(entry.get("zscore", 0) or 0)
    except (ValueError, TypeError):
        z = 0.0
    flagged = abs(z) >= 2 or name in high_tickers

    # 마커: ◆(z≥2 강조), ◇(|change|≥3 주목), ·(일반)
    try:
        change = float(entry.get("change_pct", 0) or 0)
    except (ValueError, TypeError):
        change = 0.0
    if flagged:
        marker = "◆"
    elif abs(change) >= 3:
        marker = "◇"
    else:
        marker = "·"

    # 값 포맷: 금리는 %, 원자재는 $, 나머지는 숫자
    try:
        fval = float(val)
        if name in _RATE_TICKERS:
            val_str = f"{fval:.2f}%"
        elif name in _SPREAD_TICKERS:
            val_str = f"{fval:.3f}%p"
        elif name in _USD_TICKERS:
            if fval >= 100:
                val_str = f"${fval:,.1f}"
            else:
                val_str = f"${fval:.2f}"
        elif fval >= 10000:
            val_str = f"{fval:,.0f}"
        elif fval >= 100:
            val_str = f"{fval:,.1f}"
        elif fval >= 1:
            val_str = f"{fval:.2f}"
        else:
            val_str = f"{fval:.3f}"
    except (ValueError, TypeError):
        val_str = str(val)

    mom = entry.get("mom_pct")
    yoy = entry.get("yoy_pct")
    try:
        mom_f = float(mom) if mom is not None else None
    except (ValueError, TypeError):
        mom_f = None
    try:
        yoy_f = float(yoy) if yoy is not None else None
    except (ValueError, TypeError):
        yoy_f = None

    dod = _fmt_pct(change if change != 0 else 0.0)
    mom_s = _fmt_pct(mom_f)
    yoy_s = _fmt_pct(yoy_f)

    return f"{marker}{label:<8s} {val_str:>9s}  {dod:>5s} {mom_s:>5s} {yoy_s:>5s}"


def _load_market_data() -> dict:
    """시장 JSON 로드. data['indicators'] 접근으로 기존 버그 수정."""
    data = _find_latest_json(MEMORY / "market-indicators")
    if not data:
        return {}
    indicators = data.get("indicators", data)
    return {
        "indicators": indicators,
        "anomalies": data.get("anomalies", []),
        "credit_data": data.get("credit_data", {}),
        "date": data.get("date", ""),
        "collected_at": data.get("collected_at", ""),
    }


def _load_geo_data() -> dict:
    """지정학 JSON 로드."""
    data = _find_latest_json(
        MEMORY / "geopolitical",
        exclude=["watchlist.json"],
        exclude_dirs=["charts", "screenshots"],
    )
    return data or {}


def _load_social_data() -> dict:
    """소셜(인기게시물+트위터+블로그) 데이터 로드."""
    result: dict = {
        "sentiment": 0,
        "keywords": [],
        "blog_count": 0,
        "blog_titles": [],
    }

    # popular-posts
    pp_report = _find_latest_report(MEMORY / "popular-posts" / "reports")
    if pp_report:
        pp_lines = pp_report.splitlines()
        for i, line in enumerate(pp_lines):
            stripped = line.strip()
            if "\uc885\ud569 \uac10\uc131:" in stripped:  # 종합 감성:
                m = re.search(r'[+-]\d+', stripped)
                if m:
                    result["sentiment"] += int(m.group())
            if "\uc8fc\uc694 \ud0a4\uc6cc\ub4dc" in stripped and i + 1 < len(pp_lines):  # 주요 키워드
                kw_line = pp_lines[i + 1].strip()
                if "\u00b7" in kw_line and not result["keywords"]:
                    kws = [k.strip().split("(")[0].strip()
                           for k in kw_line.split("\u00b7")]
                    result["keywords"] = [k for k in kws if k][:10]

    # twitter
    tw_report = _find_latest_report(MEMORY / "twitter-collector" / "reports")
    if tw_report:
        for line in tw_report.splitlines():
            if "\uc885\ud569 \uac10\uc131:" in line.strip():  # 종합 감성:
                m = re.search(r'[+-]\d+', line.strip())
                if m:
                    result["sentiment"] += int(m.group())

    # blog
    result["blog_count"] = _count_recent_files(MEMORY / "blog-insights", hours=24)
    blog_dir = MEMORY / "blog-insights"
    if blog_dir.exists():
        blog_files = sorted(
            blog_dir.glob("*.md"),
            key=lambda p: p.stat().st_mtime, reverse=True,
        )
        for bf in blog_files[:5]:
            try:
                text = bf.read_text(encoding="utf-8")[:300]
                for bline in text.splitlines():
                    if bline.startswith("title:"):
                        title = bline.split(":", 1)[1].strip().strip('"').strip("'")
                        if title:
                            result["blog_titles"].append(title)
                        break
            except OSError:
                pass

    return result


def _load_hypotheses() -> list[dict]:
    """활성 가설 로드."""
    hypo_dir = MEMORY / "hypotheses"
    if not hypo_dir.exists():
        return []
    hypotheses: list[dict] = []
    for f in sorted(hypo_dir.glob("*.json"),
                    key=lambda p: p.stat().st_mtime, reverse=True)[:10]:
        try:
            with open(f) as fh:
                data = json.load(fh)
            items = data if isinstance(data, list) else [data]
            for h in items:
                if isinstance(h, dict) and h.get("status") in (
                    "proposed", "active", "testing",
                ):
                    hypotheses.append(h)
        except (json.JSONDecodeError, OSError):
            continue
    return hypotheses


def _calc_market_temperature(mkt: dict, geo: dict, social: dict) -> tuple[float, str]:
    """시장 온도 0-100°C 계산. (temperature, label) 반환.

    구성: VIX 역수(30%), 소셜 감성(20%), 주가 모멘텀(30%), 지정학 역수(20%)
    50°C = 중립, >70 = 과열, <30 = 공포
    """
    indicators = mkt.get("indicators", {})
    score = 50.0  # 중립 기본값

    # VIX → 역수 기여 (VIX 12=뜨거움, VIX 35=차가움)
    vix = indicators.get("VIX", {})
    if isinstance(vix, dict) and vix.get("close") is not None:
        try:
            vix_val = float(vix["close"])
            # VIX 12→+15, VIX 20→0, VIX 35→-15
            vix_score = max(-15, min(15, (20 - vix_val) * 0.75))
            score += vix_score
        except (ValueError, TypeError):
            pass

    # 소셜 감성 (±20 범위를 ±10으로 매핑)
    sentiment = social.get("sentiment", 0)
    score += max(-10, min(10, sentiment * 0.5))

    # 주가 모멘텀 (SPX+KOSPI+NDX 변동률 합계)
    momentum = 0.0
    for key in ("SPX", "KOSPI", "NDX"):
        entry = indicators.get(key, {})
        if isinstance(entry, dict):
            try:
                momentum += float(entry.get("change_pct", 0) or 0)
            except (ValueError, TypeError):
                pass
    score += max(-15, min(15, momentum * 2.5))

    # 지정학 역수 (DOUGHCON 높을수록 안전 → 뜨거움)
    doughcon = geo.get("pentagon_index", {}).get("doughcon")
    if doughcon is not None:
        # DOUGHCON 5=+5, DOUGHCON 3=0, DOUGHCON 1=-10
        score += max(-10, min(5, (doughcon - 3) * 2.5))

    # EPU 역수 (높을수록 불확실 → 차가움)
    epu_us = indicators.get("EPU_US", {})
    if isinstance(epu_us, dict):
        try:
            epu_z = float(epu_us.get("zscore", 0) or 0)
            score -= max(0, min(10, epu_z * 3))
        except (ValueError, TypeError):
            pass

    temp = max(0, min(100, score))

    if temp >= 80:
        label = "과열"
    elif temp >= 65:
        label = "온기"
    elif temp >= 45:
        label = "미지근"
    elif temp >= 30:
        label = "냉기"
    else:
        label = "공포"

    return round(temp, 1), label


def _get_company_tickers(db_path: Path) -> list[str]:
    """최근 24h 활성 기업 티커 추출."""
    try:
        with db_connection(db_path) as conn:
            tables = {row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()}
            if "company_insights" not in tables or "company_entities" not in tables:
                return []
            rows = conn.execute(
                """SELECT DISTINCT ce.ticker FROM company_entities ce
                   JOIN company_insights ci ON ci.company_id = ce.id
                   WHERE ci.date >= date('now', '-1 day', 'localtime')
                     AND ce.ticker IS NOT NULL AND ce.ticker != ''
                   ORDER BY ci.date DESC
                   LIMIT 5""",
            ).fetchall()
            return [r[0] for r in rows if r[0]]
    except Exception:
        return []


# ── v2.0 빌드 함수 ────────────────────────────────────────────────

def build_sector_factcheck(mkt: dict, geo: dict, social: dict,
                           company_tickers: list[str]) -> str:
    """8섹터 팩트체크 — DoD/MoM/YoY 테이블. LLM 0회."""
    indicators = mkt.get("indicators", {})
    high_tickers = {
        a.get("ticker", "") for a in mkt.get("anomalies", [])
        if a.get("severity") == "high"
    }

    # 섹터별 표 그룹핑
    _TABLE_SECTIONS = [
        ("💹 금리", ["US10Y", "US2Y", "SOFR", "KR3Y", "CD91", "CP91", "KRC3Y", "CRSPRD"]),
        ("💱 환율", ["DXY", "USDKRW", "USDJPY", "EURUSD"]),
        ("📈 주가지수", ["SPX", "NDX", "NIKKEI", "HSI", "SSEC"]),
        ("🇰🇷 한국", ["KOSPI", "KOSDAQ"]),
        ("🛢 원자재", ["GOLD", "SILVER", "COPPER", "WTI", "NATGAS", "BDI"]),
        ("⚡ 변동성·반도체", ["VIX", "SOXX", "DDR5"]),
    ]

    # pre 블록 내부 (monospace 칸막이)
    pre_lines: list[str] = []
    header = f"{'':21s}DoD   MoM   YoY"
    pre_lines.append(header)

    for section_name, tickers in _TABLE_SECTIONS:
        pre_lines.append(f"\n[{section_name}]")
        for ticker in tickers:
            pre_lines.append(_fmt_table_row(ticker, indicators, high_tickers))

    lines: list[str] = []
    lines.append("<pre>" + "\n".join(pre_lines) + "</pre>")

    # 추가 지표: DOUGHCON, 신용, 기업, GPR/EPU (pre 바깥)
    extras: list[str] = []
    doughcon = geo.get("pentagon_index", {}).get("doughcon")
    if doughcon is not None:
        extras.append(f"DOUGHCON {doughcon}")

    gpr = indicators.get("GPR", {})
    if isinstance(gpr, dict) and gpr.get("close") is not None:
        gpr_change = float(gpr.get("change_pct", 0) or 0)
        extras.append(f"GPR {gpr['close']:.0f}({gpr_change:+.1f}%)")
    epu_us = indicators.get("EPU_US", {})
    if isinstance(epu_us, dict) and epu_us.get("close") is not None:
        epu_z = float(epu_us.get("zscore", 0) or 0)
        extras.append(f"EPU {epu_us['close']:.0f}(z={epu_z:.1f})")
    epu_gl = indicators.get("EPU_GLOBAL", {})
    if isinstance(epu_gl, dict) and epu_gl.get("close") is not None:
        epu_gl_change = float(epu_gl.get("change_pct", 0) or 0)
        extras.append(f"EPU글 {epu_gl['close']:.0f}({epu_gl_change:+.1f}%)")

    credit = mkt.get("credit_data", {})
    credit_date_str = ""
    if credit:
        ratio = credit.get("ratio")
        signal = credit.get("signal", "")
        # 기준일 파싱: "2026/02/24" or "2026-02-24"
        raw_cd = credit.get("date", "")
        if raw_cd:
            normalized = raw_cd.replace("/", "-")
            try:
                cm, cd = int(normalized[5:7]), int(normalized[8:10])
                credit_date_str = f"{cm}/{cd}"
            except (ValueError, IndexError):
                pass
        if ratio is not None:
            tag = f"{credit_date_str} " if credit_date_str else ""
            extras.append(f"신용{ratio}%({signal} {tag}기준)".rstrip()
                          if signal else f"신용{ratio}%({tag}기준)".rstrip())

    if company_tickers:
        extras.append(f"기업: {','.join(company_tickers[:5])}")

    if extras:
        lines.append("📌 " + " │ ".join(extras))

    # 기준일: 날짜별 지표 묶어서 표시 (종가/실시간 구분)
    today_str = datetime.now().strftime("%Y-%m-%d")
    all_tickers = [t for _, tks in _TABLE_SECTIONS for t in tks]
    realtime_labels: list[str] = []
    closing_groups: dict[str, list[str]] = {}  # date -> labels
    for ticker in all_tickers:
        entry = indicators.get(ticker, {})
        if not isinstance(entry, dict):
            continue
        dd = entry.get("data_date", "")
        if not dd:
            continue
        lbl = _LABEL_MAP.get(ticker, ticker)
        if dd == today_str:
            realtime_labels.append(lbl)
        else:
            closing_groups.setdefault(dd, []).append(lbl)

    date_parts: list[str] = []
    for dd in sorted(closing_groups):
        try:
            m, d = int(dd[5:7]), int(dd[8:10])
            names = ",".join(closing_groups[dd])
            date_parts.append(f"{m}/{d}종가({names})")
        except (ValueError, IndexError):
            pass
    if realtime_labels:
        date_parts.append(f"실시간({','.join(realtime_labels)})")
    if date_parts:
        lines.append("📅 " + " | ".join(date_parts))

    lines.append("출처: yfinance·한경·TrendForce·IMF·FRED")

    return "\n".join(lines)


def build_pest_analysis(mkt: dict, geo: dict, social: dict) -> str:
    """PEST 4축 분석. LLM 1회, 실패 시 규칙 기반 fallback."""
    indicators = mkt.get("indicators", {})

    # Build context for LLM
    ctx_parts: list[str] = []
    for key in ("SPX", "NDX", "VIX", "KOSPI", "DXY", "USDKRW", "GOLD", "WTI", "SOXX"):
        entry = indicators.get(key, {})
        if isinstance(entry, dict) and entry.get("close") is not None:
            ctx_parts.append(
                f"{key} {entry['close']} ({entry.get('change_pct', 0):+.1f}%)"
            )
    for key in ("EPU_US", "EPU_GLOBAL", "GPR"):
        entry = indicators.get(key, {})
        if isinstance(entry, dict) and entry.get("close") is not None:
            ctx_parts.append(
                f"{key} {entry['close']:.0f} (z={entry.get('zscore', 0):.1f})"
            )
    doughcon = geo.get("pentagon_index", {}).get("doughcon")
    if doughcon is not None:
        ctx_parts.append(f"DOUGHCON {doughcon}")
    if social.get("sentiment"):
        ctx_parts.append(f"\uc18c\uc15c\uac10\uc131 {social['sentiment']:+d}")  # 소셜감성
    if social.get("keywords"):
        ctx_parts.append(
            f"\ud0a4\uc6cc\ub4dc: {', '.join(social['keywords'][:5])}"  # 키워드:
        )
    if social.get("blog_titles"):
        ctx_parts.append(
            f"\ube14\ub85c\uadf8: {'; '.join(social['blog_titles'][:3])}"  # 블로그:
        )

    context = "\n".join(ctx_parts)
    if not context.strip():
        return _pest_fallback(mkt, geo, social)

    messages = [
        {"role": "system", "content": (
            "아래 시장 데이터를 PEST 프레임워크(정치/경제/사회/기술)로 해석하세요.\n\n"
            "형식 규칙 (반드시 준수):\n"
            "1. 정확히 4줄만 출력. 각 줄은 P: E: S: T: 로 시작.\n"
            "2. 각 축 3-4문장: 수치 인용 → 원인 해석 → 투자자 관점의 판단/액션 1문장. 마지막에 방향 기호(▲▼─) 1개.\n"
            "3. 100% 한국어. 지표 코드(SPX, VIX 등)만 영어 허용.\n"
            "4. 인명은 한국어(트럼프, 파월). 표/마크다운/볼드 금지.\n"
            "5. 반드시 각 축 마지막 문장에 '~해야 한다', '~가 유리하다', '~에 주의' 등 판단을 포함.\n\n"
            "예시 (이 수준의 깊이와 분량으로 작성):\n"
            "P: EPU 725(z=2.1)로 정책 불확실성 극대화. "
            "트럼프의 상호관세 정책이 3월 발효 예정이나 세부 조건 미확정으로 "
            "수출 의존 섹터의 실적 가시성이 크게 낮아졌다. "
            "관세 방향 확인 전까지 투자 판단 유보 불가피. ▼\n"
            "E: SPX +0.8%, NDX +1.3%로 기술주 주도 상승. "
            "VIX -8.3% 급락은 직전 과매도 되돌림이며 구조적 낙관은 아니다. "
            "DXY -0.3%, USDKRW -1.2%로 달러 약세 전환, "
            "원화 강세는 수출주에 부담이나 외국인 자금 유입 기대. ▲\n"
            "S: 소셜감성 +35로 긍정적, 반도체와 실적 키워드 집중. "
            "엔비디아 블랙웰 기대감이 투자심리를 주도하나, "
            "EPU 급등과의 괴리는 소셜 심리가 정책 리스크를 과소평가하고 있음을 시사. ▲\n"
            "T: SOXX +1.6%로 반도체 강세 지속, DDR5 +1.7% 상승. "
            "엔비디아 GPU 블랙웰 양산과 AI 인프라 투자 확대가 기술 섹터 모멘텀 유지. "
            "다만 공급망 리스크와 관세 영향은 하반기 변수. ▲"
        )},
        {"role": "user", "content": context},
    ]

    try:
        content, model, error = llm_chat_direct(
            messages, MODELS_PREMIUM, max_tokens=800, timeout=90,
        )
        log(f"PEST model: {model or 'FAILED'}{f' err={error}' if error else ''}")
        if content:
            cleaned = _clean_llm_text(content)
            # Merge multi-line per axis: join lines until next P:/E:/S:/T:
            merged: list[str] = []
            current = ""
            for raw_line in cleaned.split("\n"):
                s = raw_line.strip()
                if not s:
                    continue
                if s[:2] in ("P:", "E:", "S:", "T:"):
                    if current:
                        merged.append(current)
                    current = s
                elif current:
                    current += " " + s
            if current:
                merged.append(current)
            # Cap each axis to 250 chars
            pest_lines = [l[:350] for l in merged
                          if l[:2] in ("P:", "E:", "S:", "T:") and len(l) > 5]
            if len(pest_lines) >= 3:
                return "\n".join(pest_lines[:4])
    except Exception as e:
        log(f"PEST LLM error: {e}")

    return _pest_fallback(mkt, geo, social)


def _pest_fallback(mkt: dict, geo: dict, social: dict) -> str:
    """PEST 규칙 기반 fallback (LLM 실패 시). 해석적 서술."""
    indicators = mkt.get("indicators", {})
    lines: list[str] = []

    # P: EPU + DOUGHCON 기반
    epu_us = indicators.get("EPU_US", {})
    epu_gl = indicators.get("EPU_GLOBAL", {})
    epu_z = float(epu_us.get("zscore", 0) or 0) if isinstance(epu_us, dict) else 0
    epu_val = epu_us.get("close", "-") if isinstance(epu_us, dict) else "-"
    epu_gl_change = float(epu_gl.get("change_pct", 0) or 0) if isinstance(epu_gl, dict) else 0
    doughcon = geo.get("pentagon_index", {}).get("doughcon", "-")
    if epu_z > 2:
        p_text = (f"P: EPU {epu_val}(z={epu_z:.1f})로 정책 불확실성 극대. "
                  f"글로벌 EPU도 {epu_gl_change:+.0f}% 동반급등. DOUGHCON {doughcon}. "
                  "정책 방향 미확정 상황에서 수출·무역 의존 섹터 신규 진입을 자제하고, "
                  "관세·재정 정책 확정 시점까지 현금 비중 확대가 유리하다 ▼")
    elif epu_z > 1:
        p_text = (f"P: EPU {epu_val}(z={epu_z:.1f}), 정책 불확실성 높음. "
                  f"DOUGHCON {doughcon}. 정책 민감 업종(방산·에너지) 비중 점검이 필요하며, "
                  "변동성 확대에 대비한 포지션 축소를 고려해야 한다 ─")
    else:
        p_text = (f"P: EPU {epu_val}, 정책 환경 안정적. DOUGHCON {doughcon}. "
                  "정치 리스크가 낮아 매크로 변수보다 기업 펀더멘털에 집중 가능하다 ─")
    lines.append(p_text)

    # E: VIX+KOSPI+SPX 기반
    vix = indicators.get("VIX", {})
    kospi = indicators.get("KOSPI", {})
    spx = indicators.get("SPX", {})
    vix_change = float(vix.get("change_pct", 0) or 0) if isinstance(vix, dict) else 0
    kospi_change = float(kospi.get("change_pct", 0) or 0) if isinstance(kospi, dict) else 0
    spx_change = float(spx.get("change_pct", 0) or 0) if isinstance(spx, dict) else 0
    usdkrw = indicators.get("USDKRW", {})
    krw_change = float(usdkrw.get("change_pct", 0) or 0) if isinstance(usdkrw, dict) else 0
    if kospi_change > 1 and vix_change < -3:
        e_text = (f"E: VIX {vix_change:+.1f}% 급감+코스피 {kospi_change:+.1f}%+SPX {spx_change:+.1f}%, "
                  f"리스크온 전환 뚜렷. 원화 {krw_change:+.1f}%. "
                  "변동성 축소 구간에서 성장주·기술주 비중 확대가 유리하다 ▲")
    elif vix_change > 5:
        e_text = (f"E: VIX {vix_change:+.1f}% 급등, 공포 확산. "
                  f"코스피 {kospi_change:+.1f}%. "
                  "위험자산 노출을 줄이고 방어적 포지션(국채·현금) 전환을 고려해야 한다 ▼")
    else:
        e_text = (f"E: VIX {vix_change:+.1f}%, 코스피 {kospi_change:+.1f}%, "
                  f"SPX {spx_change:+.1f}%. 뚜렷한 방향성 부재로 "
                  "기존 포지션 유지하되 방향 확인 후 대응이 적절하다 ─")
    lines.append(e_text)

    # S: social sentiment + keywords
    sentiment = social.get("sentiment", 0)
    kw = ", ".join(social.get("keywords", [])[:4]) or "특이 키워드 없음"
    if sentiment > 5:
        s_text = (f"S: 소셜 감성 {sentiment:+d}, 강한 긍정. "
                  f"주요 키워드: {kw}. 낙관론이 우세하나, "
                  "극단적 낙관은 역추세 신호일 수 있으므로 추격 매수보다 분할 접근이 안전하다 ▲")
    elif sentiment < -5:
        s_text = (f"S: 소셜 감성 {sentiment:+d}, 비관 우세. "
                  f"키워드: {kw}. 공포 심리가 극에 달한 구간에서 "
                  "역발상 매수 기회를 탐색하되 추가 하락 여력도 열어둬야 한다 ▼")
    else:
        s_text = (f"S: 소셜 감성 {sentiment:+d}, 중립. 키워드: {kw}. "
                  "뚜렷한 심리 편향이 없어 펀더멘털과 수급에 집중할 시점이다 ─")
    lines.append(s_text)

    # T: SOXX+DDR5 기반
    soxx = indicators.get("SOXX", {})
    ddr5 = indicators.get("DDR5", {})
    soxx_change = float(soxx.get("change_pct", 0) or 0) if isinstance(soxx, dict) else 0
    ddr5_change = float(ddr5.get("change_pct", 0) or 0) if isinstance(ddr5, dict) else 0
    if soxx_change > 1:
        t_text = (f"T: SOXX {soxx_change:+.1f}%, DDR5 {ddr5_change:+.1f}%. "
                  "반도체·AI 업종 강세 지속. "
                  "HBM·GPU 밸류체인과 AI 인프라 관련주 비중 유지가 유리하다 ▲")
    elif soxx_change < -2:
        t_text = (f"T: SOXX {soxx_change:+.1f}%, DDR5 {ddr5_change:+.1f}%. "
                  "기술주 약세로 밸류에이션 부담 노출. "
                  "단기 기술주 비중 축소하고 실적 확인된 종목 위주로 선별해야 한다 ▼")
    else:
        t_text = (f"T: SOXX {soxx_change:+.1f}%, DDR5 {ddr5_change:+.1f}%. "
                  "기술 섹터 관망세. 방향성 확인 전까지 기존 비중 유지하며 "
                  "실적 시즌 결과에 따라 포지션을 조정하는 것이 적절하다 ─")
    lines.append(t_text)

    return "\n".join(lines)


def _brief_anomaly(a: dict) -> str:
    """이상치 1줄 요약."""
    detail = a.get("detail", "")
    if "\uae09\ub4f1" in detail:  # 급등
        return "\uae09\ub4f1"
    if "\uae09\ub77d" in detail:  # 급락
        return "\uae09\ub77d"
    if "\uc774\ud0c8" in detail:  # 이탈
        return "\uc774\ud0c8"
    return detail[-12:] if len(detail) > 12 else (detail or "anomaly")


def build_falsification(mkt: dict, geo: dict,
                        hypotheses: list[dict]) -> str:
    """반증 체크. 규칙 기반, LLM 0회. 복합 해석 플래그."""
    flags: list[str] = []
    indicators = mkt.get("indicators", {})
    anomalies = mkt.get("anomalies", [])

    # 데이터 추출
    vix = indicators.get("VIX", {})
    spx = indicators.get("SPX", {})
    kospi = indicators.get("KOSPI", {})
    epu_us = indicators.get("EPU_US", {})
    epu_gl = indicators.get("EPU_GLOBAL", {})

    vix_change = float(vix.get("change_pct", 0) or 0) if isinstance(vix, dict) else 0
    spx_change = float(spx.get("change_pct", 0) or 0) if isinstance(spx, dict) else 0
    kospi_change = float(kospi.get("change_pct", 0) or 0) if isinstance(kospi, dict) else 0
    epu_z = float(epu_us.get("zscore", 0) or 0) if isinstance(epu_us, dict) else 0
    epu_gl_change = float(epu_gl.get("change_pct", 0) or 0) if isinstance(epu_gl, dict) else 0

    # 1. VIX-EPU 다이버전스 (복합: 시장 낙관 vs 정책 불확실)
    if vix_change < -5 and epu_z > 1.5:
        flags.append(
            f"  ! VIX {vix_change:+.1f}% vs EPU z={epu_z:.1f} — "
            "시장 낙관과 정책 불확실의 극단적 괴리. "
            "VIX 급감은 과도한 안도, 정책 변수 무시 가능성"
        )
    elif vix_change < -5:
        flags.append(
            f"  ! VIX {vix_change:+.1f}% 급감 — "
            "과도한 낙관 경계. 평균회귀 압력"
        )

    # 2. EPU 동반급등 (미국+글로벌)
    if epu_z > 2 or epu_gl_change > 15:
        parts = []
        if epu_z > 2:
            parts.append(f"EPU_US z={epu_z:.1f}")
        if epu_gl_change > 15:
            parts.append(f"EPU글 +{epu_gl_change:.0f}%")
        flags.append(
            f"  ! {' + '.join(parts)} — "
            "정책 불확실성 극대. 무역·재정 정책 결과 확인 전까지 신규 진입 부적절"
        )

    # 3. 지정학 에스컬레이션 (DOUGHCON ≤ 2 또는 GPR z > 2)
    doughcon = geo.get("pentagon_index", {}).get("doughcon")
    gpr_epu = geo.get("gpr_epu", {})
    gpr_z = gpr_epu.get("gpr_zscore")
    geo_parts = []
    if doughcon is not None and doughcon <= 2:
        geo_parts.append(f"DOUGHCON {doughcon}")
    if gpr_z is not None:
        try:
            if float(gpr_z) > 2:
                geo_parts.append(f"GPR z={float(gpr_z):.1f}")
        except (ValueError, TypeError):
            pass
    if geo_parts:
        flags.append(
            f"  ! {' + '.join(geo_parts)} — "
            "지정학 리스크 고조. 에너지·방산 외 리스크자산 노출 축소 고려"
        )

    # 4. 신용-지수 괴리 (매도 신호 vs 지수 상승)
    credit = mkt.get("credit_data", {})
    if credit:
        signal = credit.get("signal", "")
        if "매도" in signal and kospi_change > 0:
            flags.append(
                f"  ! 신용 '{signal}' vs 코스피 +{kospi_change:.1f}% — "
                "스마트머니는 이탈 중이나 지수는 상승. 후행 조정 리스크"
            )

    # 5. 고위험 이상치 (복합되지 않은 것들) — 최대 2건
    seen = {"VIX", "EPU_US", "EPU_GLOBAL"}
    for a in anomalies:
        if len(flags) >= 4:
            break
        if a.get("severity") == "high":
            ticker = a.get("ticker", "")
            if ticker in seen:
                continue
            seen.add(ticker)
            entry = indicators.get(ticker, {})
            change = 0.0
            try:
                change = float(entry.get("change_pct", 0) or 0) if isinstance(entry, dict) else 0.0
            except (ValueError, TypeError):
                pass
            label = _LABEL_MAP.get(ticker, ticker)
            brief = _brief_anomaly(a)
            flags.append(f"  ! {label} {change:+.1f}% — {brief}")

    # 6. 활성 가설 교차검증 (investment domain)
    inv_hypos = [h for h in hypotheses if h.get("domain") == "investment"]
    if inv_hypos and len(flags) < 4:
        h = inv_hypos[0]
        hyp_text = (h.get("hypothesis", "") or h.get("area", ""))[:50]
        flags.append(f"  ! 가설검증: {hyp_text}")

    if not flags:
        return "  반증 플래그 없음. 무행동 유지."

    # 규칙 플래그를 LLM에 넘겨 해석 심화
    raw_flags = "\n".join(flags[:4])
    try:
        messages = [
            {"role": "system", "content": (
                "너는 투자 반증 분석가다. 아래 규칙 기반 플래그를 받아, "
                "각 플래그에 대해 1-2문장으로 투자자가 주의해야 할 핵심 맥락을 추가해라.\n"
                "규칙:\n"
                "- 반드시 한국어로만 작성\n"
                "- 각 플래그는 '⚠️'로 시작\n"
                "- 영어/일본어/중국어 단어 사용 금지, 지표명(VIX,EPU,KOSPI 등)만 예외\n"
                "- 플래그 수를 늘리지 말고, 받은 것만 심화\n"
                "- 쓸데없는 서론/결론 없이 바로 플래그만 출력"
            )},
            {"role": "user", "content": raw_flags},
        ]
        content, model, error = llm_chat_direct(
            messages, MODELS_PREMIUM, max_tokens=500, timeout=90,
        )
        log(f"Falsification model: {model or 'FAILED'}{f' err={error}' if error else ''}")
        if content:
            cleaned = _clean_llm_text(content)
            lines = [l.strip() for l in cleaned.split("\n") if l.strip()]
            if len(lines) >= 1:
                return "\n".join(lines[:4])
    except Exception as e:
        log(f"Falsification LLM error: {e}")

    # LLM 실패 시 규칙 기반 원문 반환
    return raw_flags


def build_executive_summary(factcheck: str, pest: str,
                            falsification: str, mkt: dict) -> str:
    """총괄 판단. LLM 1회. 원라이너+판단+무효화 트리거."""
    context = (
        f"== 팩트체크 ==\n{factcheck}\n\n"
        f"== PEST ==\n{pest}\n\n"
        f"== 반증 ==\n{falsification}"
    )

    messages = [
        {"role": "system", "content": (
            "당신은 냉정하고 날카로운 투자 전략가입니다.\n"
            "아래 분석을 종합하여 정확히 3줄로 답하세요:\n\n"
            "원라이너: (오늘의 시장을 한 문장으로 관통하는 핵심 테제. "
            "비유/은유 가능, 날카롭고 기억에 남는 문장)\n"
            "판단: {무행동|관망|소규모조정|적극대응} | 확신 {상|중|하} | "
            "유효 {오늘|1주일|1개월}\n"
            "무효화: (이 판단이 틀릴 조건 1가지. 구체적 수치 포함)\n\n"
            "규칙:\n"
            "- '무행동'이 기본 자세. 강한 근거 없이 행동 권하지 마세요.\n"
            "- 마크다운/볼드 금지. 순수 텍스트만. 한국어로만 작성.\n"
            "- 각 줄의 접두어(원라이너/판단/무효화)를 반드시 포함.\n"
            "- 원라이너는 비유적이고 날카로운 한 문장(80자 이내)."
        )},
        {"role": "user", "content": context},
    ]

    try:
        content, model, error = llm_chat_direct(
            messages, MODELS_PREMIUM, max_tokens=400, timeout=90,
        )
        log(f"Executive model: {model or 'FAILED'}{f' err={error}' if error else ''}")
        if content:
            cleaned = _clean_llm_text(content)
            # Merge broken lines per prefix
            merged: list[str] = []
            current = ""
            for raw_line in cleaned.split("\n"):
                s = raw_line.strip()
                if not s:
                    continue
                if any(s.startswith(p) for p in ("원라이너:", "판단:", "무효화:")):
                    if current:
                        merged.append(current)
                    current = s
                elif current:
                    current += " " + s
            if current:
                merged.append(current)

            result_lines: list[str] = []
            for l in merged:
                for prefix in ("원라이너:", "판단:", "무효화:"):
                    if l.startswith(prefix):
                        # Cap one-liner to 120 chars, others to 80
                        cap = 120 if prefix == "원라이너:" else 80
                        result_lines.append(l[:cap])
                        break
            if len(result_lines) >= 2:
                return "\n".join(result_lines[:3])
            # Fallback: take first 3 meaningful lines
            return "\n".join(merged[:3])
    except Exception as e:
        log(f"Executive summary LLM error: {e}")

    # 규칙 기반 fallback
    flag_count = falsification.count("!")
    indicators = mkt.get("indicators", {})
    vix = indicators.get("VIX", {})
    vix_change = float(vix.get("change_pct", 0) or 0) if isinstance(vix, dict) else 0

    if flag_count == 0:
        return (
            "원라이너: 잔잔한 수면 아래 변화 없음. 기다리는 것도 전략.\n"
            "판단: 무행동 | 확신 중 | 유효 오늘\n"
            "무효화: VIX 25 돌파 시 즉시 재평가"
        )
    elif flag_count <= 2:
        return (
            "원라이너: 시그널은 혼조, 확신 없이 움직이면 실수.\n"
            "판단: 관망 | 확신 중 | 유효 1주일\n"
            f"무효화: VIX {abs(vix_change):.0f}% 반전 시 낙관론 무효"
        )
    else:
        return (
            "원라이너: 복수의 경보등이 깜빡이고 있다. 포지션 점검 시급.\n"
            "판단: 소규모조정 | 확신 하 | 유효 오늘\n"
            "무효화: 반증 플래그 전부 해소 시 관망 복귀"
        )


def collect_ops_section_brief(db_path: Path) -> str:
    """운영+참고 축약 1-2줄."""
    # Gateway status
    gw = "\U0001f534"
    try:
        if check_gateway(timeout=5):
            gw = "\U0001f7e2"
    except Exception:
        pass

    # Worker count
    w_count = 0
    try:
        result = subprocess.run(
            ["pgrep", "-f", "agent_queue_worker"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0 and result.stdout.strip():
            w_count = len(result.stdout.strip().splitlines())
    except Exception:
        pass

    # Vault flow
    vault_parts: list[str] = []
    try:
        vfh_state_file = MEMORY / "vault-flow-health" / "state.json"
        if vfh_state_file.exists():
            with open(vfh_state_file) as f:
                vfh = json.load(f)
            today = datetime.now().strftime("%Y-%m-%d")
            entry = vfh.get(today)
            if not entry and vfh:
                entry = vfh[max(vfh.keys())]
            if entry:
                for key in ("\uce90\ucc98", "\uc815\ub9ac", "\uc9c0\uc2dd\ud654",
                            "\uc5f0\uacb0", "\ud310\ub2e8"):
                    vault_parts.append(str(entry.get(key, 0)))
    except Exception:
        pass
    vault_str = "/".join(vault_parts) if vault_parts else "-"

    # Blog + hypotheses count
    blog_count = _count_recent_files(MEMORY / "blog-insights", hours=24)
    hypo_dir = MEMORY / "hypotheses"
    hypo_count = (
        sum(1 for f in hypo_dir.rglob("*.json") if f.is_file())
        if hypo_dir.exists() else 0
    )

    return (
        f"GW {gw} W{w_count}/5 | "
        f"\ubcfc\ud2b8 {vault_str} | "
        f"\ube14\ub85c\uadf8 {blog_count}\uac74 "
        f"\uac00\uc124 {hypo_count}\uac74"
    )


# ── 리포트 조립 ───────────────────────────────────────────────────────

def build_daily_report(db_path: Path) -> str:
    """v2.0 데일리 리포트: 온도→팩트체크→PEST→반증→총괄→참고."""
    today = datetime.now().strftime("%Y-%m-%d")

    # 데이터 로드
    mkt = _load_market_data()
    geo = _load_geo_data()
    social = _load_social_data()
    hypotheses = _load_hypotheses()
    company_tickers = _get_company_tickers(db_path)

    # 시장 온도
    try:
        temp, temp_label = _calc_market_temperature(mkt, geo, social)
    except Exception as e:
        log(f"temperature error: {e}")
        temp, temp_label = 50.0, "미지근"

    # 섹션 빌드
    try:
        factcheck = build_sector_factcheck(mkt, geo, social, company_tickers)
    except Exception as e:
        log(f"factcheck error: {e}")
        factcheck = "(팩트체크 생성 실패)"

    try:
        pest = build_pest_analysis(mkt, geo, social)
    except Exception as e:
        log(f"pest error: {e}")
        pest = _pest_fallback(mkt, geo, social)

    try:
        falsification = build_falsification(mkt, geo, hypotheses)
    except Exception as e:
        log(f"falsification error: {e}")
        falsification = "  반증 플래그 없음. 무행동 유지."

    try:
        executive = build_executive_summary(factcheck, pest, falsification, mkt)
    except Exception as e:
        log(f"executive summary error: {e}")
        executive = (
            "원라이너: 분석 생성 실패. 데이터 직접 확인 필요.\n"
            "판단: 관망 | 확신 하 | 유효 오늘\n"
            "무효화: -"
        )

    try:
        ops = collect_ops_section_brief(db_path)
    except Exception as e:
        log(f"ops brief error: {e}")
        ops = "GW - W-/5"

    # 원라이너 추출 (총괄에서)
    one_liner = ""
    exec_rest: list[str] = []
    for line in executive.split("\n"):
        stripped = line.strip()
        if stripped.startswith("원라이너:"):
            one_liner = stripped[len("원라이너:"):].strip()
        else:
            exec_rest.append(stripped)

    # 온도 게이지 바 (10칸)
    filled = max(0, min(10, round(temp / 10)))
    bar = "█" * filled + "░" * (10 - filled)
    temp_emoji = "🔥" if temp >= 70 else ("🌡" if temp >= 40 else "🧊")

    # PEST 축명 확장 + 방향 아이콘 + 구조화
    _PEST_LABELS = {
        "P:": ("📌 P 정치/정책", "P:"),
        "E:": ("📈 E 경제/시장", "E:"),
        "S:": ("💬 S 사회/심리", "S:"),
        "T:": ("🔧 T 기술/산업", "T:"),
    }
    pest_lines = []
    for line in pest.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        prefix = stripped[:2]
        if prefix in _PEST_LABELS:
            label, old_prefix = _PEST_LABELS[prefix]
            body = stripped[2:].strip()
            # 방향 아이콘 치환
            direction = ""
            for arrow, icon in [("▲", "🟢"), ("▼", "🔴"), ("─", "🟡")]:
                if body.endswith(arrow):
                    direction = f" {icon}"
                    body = body[:-1].rstrip()
                    break
                # 방향이 문장 중간에 있을 수도 있음
                if f" {arrow}" in body:
                    direction = f" {icon}"
                    body = body.replace(f" {arrow}", "")
                    break
            pest_lines.append(f"<b>{label}</b>{direction}\n  {body}")
        else:
            pest_lines.append(stripped)
    pest_visual = "\n\n".join(pest_lines) if pest_lines else pest

    # 반증 아이콘 치환
    fals_visual = falsification.replace("  ! ", "  ⚠️ ")

    # 조립
    parts = [
        f"<b>📋 인텔리전스 리포트</b>  {today}",
        "",
        f"{temp_emoji} <b>{temp:.0f}°C</b> {bar} {temp_label}",
    ]
    if one_liner:
        parts.append(f"<i>    \"{one_liner}\"</i>")
    parts += [
        "",
        "━━━━━━━━━━━━━━━━━━━━━━",
        "<b>📊 1. 팩트체크</b>",
        factcheck,
        "",
        "<b>🔬 2. PEST 분석</b>",
        pest_visual,
        "",
        "<b>⚡ 3. 반증 체크</b>",
        fals_visual,
        "",
        "<b>🎯 4. 총괄 판단</b>",
    ]
    # 총괄: 판단/무효화를 구조화
    for el in exec_rest:
        if el.startswith("판단:"):
            parts.append(f"  <b>{el}</b>")
        elif el.startswith("무효화:"):
            parts.append(f"  🚫 {el}")
        elif el:
            parts.append(f"  {el}")
    parts += [
        "",
        "─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─",
        f"📎 {ops}",
    ]

    return "\n".join(parts)


# ── 6시간 취합 요약 ──────────────────────────────────────────────────

def _count_telegram_topics(start: datetime, end: datetime) -> dict[str, int]:
    """telegram-topics/ 하위 디렉토리별 파일 수 (시간 윈도우 내)."""
    topics_dir = MEMORY / "telegram-topics"
    if not topics_dir.exists():
        return {}
    counts: dict[str, int] = {}
    start_ts = start.timestamp()
    end_ts = end.timestamp()
    for topic_dir in topics_dir.iterdir():
        if not topic_dir.is_dir():
            continue
        topic = topic_dir.name
        count = 0
        for f in topic_dir.iterdir():
            if not f.is_file():
                continue
            try:
                mtime = f.stat().st_mtime
                if start_ts <= mtime <= end_ts:
                    count += 1
            except OSError:
                continue
        if count > 0:
            counts[topic] = count
    return counts


def _count_company_mentions(db_path: Path, start: datetime,
                            end: datetime) -> list[tuple[str, int]]:
    """시간 윈도우 내 기업 멘션 카운트."""
    try:
        with db_connection(db_path) as conn:
            tables = {row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()}
            if "company_insights" not in tables or "company_entities" not in tables:
                return []

            start_str = start.strftime("%Y-%m-%d %H:%M:%S")
            end_str = end.strftime("%Y-%m-%d %H:%M:%S")
            rows = conn.execute(
                """SELECT ce.canonical_name, COUNT(ci.id) as cnt
                   FROM company_entities ce
                   JOIN company_insights ci ON ci.company_id = ce.id
                   WHERE ci.created_at >= ? AND ci.created_at <= ?
                   GROUP BY ce.id
                   ORDER BY cnt DESC
                   LIMIT 5""",
                (start_str, end_str),
            ).fetchall()
            return [(r[0], r[1]) for r in rows]
    except Exception:
        return []


def _get_market_changes() -> str:
    """시장 변동 한줄 요약."""
    data = _find_latest_json(MEMORY / "market-indicators")
    if not data:
        return ""
    # bugfix: indicators nested under "indicators" key
    indicators = data.get("indicators", data)

    changes: list[str] = []
    for label, keys in [("VIX", ["VIX", "^VIX"]), ("DXY", ["DXY", "DX-Y.NYB"])]:
        for k in keys:
            if k in indicators and isinstance(indicators[k], dict):
                change = indicators[k].get("change", indicators[k].get("change_pct"))
                if change is not None:
                    try:
                        cv = float(change)
                        arrow = "\u25b2" if cv > 0 else "\u25bc"
                        changes.append(f"{label} {arrow}{abs(cv):.1f}")
                    except (ValueError, TypeError):
                        pass
                break
    return ", ".join(changes) if changes else ""


def _get_blog_summary() -> str:
    """최근 블로그 인사이트 한줄."""
    blog_count = _count_recent_files(MEMORY / "blog-insights", hours=6)
    if blog_count == 0:
        return ""
    return f"새 글 {blog_count}건"


def _llm_one_line_summary(context: str) -> str:
    """LLM으로 1줄 종합 요약 생성.

    Uses a short per-model timeout (10s) so that the full model-chain retry loop
    stays well under the 120s cron job budget.  With 4 fallback models the
    worst-case LLM cost is 4 × 10s = 40s; the remainder is plenty for startup
    and the Telegram send.
    """
    if not context.strip():
        return ""
    messages = [
        {"role": "system", "content": (
            "당신은 투자 인텔리전스 보조입니다. "
            "아래 요약 데이터를 보고 투자자에게 유용한 1줄 종합 코멘트를 한국어로 작성하세요. "
            "50자 이내, 핵심만."
        )},
        {"role": "user", "content": context},
    ]
    try:
        content, model, error = llm_chat_direct(
            messages, MODELS, max_tokens=100, timeout=10,
        )
        if content:
            return content.strip().split("\n")[0][:100]
    except Exception as e:
        log(f"LLM summary error: {e}")
    return ""


def collect_6h_summary() -> str:
    """6시간 윈도우 취합 요약 생성."""
    start, end = _get_6h_window()
    now = datetime.now()
    # end가 미래면 현재까지로 제한
    if end > now:
        end = now

    time_label = f"{start.strftime('%m/%d %H:%M')}-{end.strftime('%H:%M')}"
    header = f"\U0001f4dd <b>6시간 취합 요약</b> | {time_label}"

    lines: list[str] = [header, ""]
    context_parts: list[str] = []

    # 1) 수집 — 텔레그램 토픽별
    topic_counts = _count_telegram_topics(start, end)
    total_topics = sum(topic_counts.values())
    if topic_counts:
        breakdown = ", ".join(f"{t} {c}" for t, c in
                             sorted(topic_counts.items(), key=lambda x: -x[1]))
        lines.append(f"[수집] 지식사랑방 {total_topics}건 ({breakdown})")
        context_parts.append(f"수집 {total_topics}건: {breakdown}")
    else:
        lines.append("[수집] 지식사랑방 0건")

    # 2) 기업 멘션
    db_path = resolve_ops_db_path()
    mentions = _count_company_mentions(db_path, start, end)
    if mentions:
        m_str = ", ".join(f"{name} {cnt}건" for name, cnt in mentions)
        lines.append(f"[기업 멘션] {m_str}")
        context_parts.append(f"기업 멘션: {m_str}")
    else:
        lines.append("[기업 멘션] 없음")

    # 3) 시장 변동
    market_changes = _get_market_changes()
    if market_changes:
        lines.append(f"[시장 변동] {market_changes}")
        context_parts.append(f"시장: {market_changes}")
    else:
        lines.append("[시장 변동] 데이터 없음")

    # 4) 블로그
    blog = _get_blog_summary()
    if blog:
        lines.append(f"[블로그] {blog}")
        context_parts.append(f"블로그: {blog}")
    else:
        lines.append("[블로그] 새 글 없음")

    # 5) 인기 게시물 — 가장 최근 리포트 제목 1개
    pp_report = _find_latest_report(MEMORY / "popular-posts" / "reports")
    if pp_report:
        for rline in pp_report.splitlines():
            stripped = rline.strip()
            if stripped and stripped.startswith("1. "):
                title = stripped[3:][:80]
                lines.append(f"[인기] 주목 게시물 \u2014 {title}")
                context_parts.append(f"인기: {title}")
                break
        else:
            lines.append("[인기] 리포트 없음")
    else:
        lines.append("[인기] 리포트 없음")

    # 6) LLM 종합
    lines.append("")
    context_text = " | ".join(context_parts)
    if context_text:
        summary = _llm_one_line_summary(context_text)
        if summary:
            lines.append(f"종합: {summary}")
        else:
            lines.append("종합: (요약 생성 실패)")
    else:
        lines.append("종합: 특이사항 없음")

    return "\n".join(lines)


# ── 상태 관리 ─────────────────────────────────────────────────────────

def _load_state() -> dict:
    """state.json 로드."""
    if not STATE_FILE.exists():
        return {}
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def _save_state(state: dict) -> None:
    """state.json 저장."""
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def _record_run(mode: str) -> None:
    """실행 기록 저장."""
    state = _load_state()
    now = datetime.now().isoformat()
    runs = state.setdefault("runs", [])
    runs.append({"mode": mode, "at": now})
    # 최근 30일분만 보존
    cutoff = (datetime.now() - timedelta(days=30)).isoformat()
    state["runs"] = [r for r in runs if r.get("at", "") >= cutoff]
    state["last_run"] = now
    _save_state(state)


# ── 메인 ──────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(
        description="통합 데일리 인텔리전스 리포트",
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--daily", action="store_true",
                       help="데일리 리포트 (매일 08:30)")
    group.add_argument("--6h-summary", dest="six_h_summary", action="store_true",
                       help="6시간 취합 요약")
    parser.add_argument("--dry-run", action="store_true",
                        help="DM 없이 stdout 출력")
    args = parser.parse_args()

    db_path = resolve_ops_db_path()

    if args.daily:
        log("Building daily report...")
        report = build_daily_report(db_path)

        # 차트 생성 (신용비율만)
        mkt = _load_market_data()
        credit_path = generate_credit_chart(mkt)

        if args.dry_run:
            print(report)
            if credit_path:
                print(f"\n[신용차트: {credit_path}]")
            log("Dry-run: daily report generated, not sent")
            return 0

        if send_dm_chunked(report):
            log("Daily report sent to DM")
            if credit_path:
                if send_dm_photo(
                    str(credit_path),
                    "KOSPI 매수판단 신호 — 신용비율\n"
                    "신용비율 = 신용잔고 ÷ (신용잔고+예수금) × 100\n"
                    "개인투자자 레버리지 수준을 나타내며, 높을수록 과열·낮을수록 매수 기회\n"
                    "<30% 매수고려 | 30-35% 중립 | 35-40% 주의 | >40% 매도경고\n"
                    "연한선: 일별 | 굵은선: 5일이동평균 | 파란선: KOSPI",
                ):
                    log("Credit chart sent to DM")
                else:
                    log("Credit chart send failed", level="WARN")
            _record_run("daily")
            return 0
        else:
            log("Failed to send daily report", level="ERROR")
            return 1

    elif args.six_h_summary:
        log("Building 6h summary...")
        summary = collect_6h_summary()

        if args.dry_run:
            print(summary)
            log("Dry-run: 6h summary generated, not sent")
            return 0

        if send_group_chunked(summary, topic_id=RON_TOPIC_ID):
            log("6h summary sent to Ron topic")
            _record_run("6h-summary")
            return 0
        else:
            log("Failed to send 6h summary", level="ERROR")
            return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
