"""Centralized vault path definitions — single source of truth.

All scripts should import paths from here instead of declaring their own.
v3 물리 경로 반영 완료 (2026-02-26).
일별 수신함 구조 도입 (2026-02-27).
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Iterator

VAULT = Path(os.path.expanduser("~/knowledge"))

# v3 논리 단계 = 물리 경로 (번호만 보면 성숙도 단계를 알 수 있음)
_V3_MAP = {
    "캡처":   VAULT / "100 캡처" / "110 수신함",
    "정리":   VAULT / "200 정리",
    "연결":   VAULT / "300 연결",
    "판단":   VAULT / "400 판단",
    "리소스": VAULT / "600 리소스",
    "활동":   VAULT / "700 활동",
    "운영":   VAULT / "800 운영",
    "시스템": VAULT / "900 시스템",
}

# 자주 쓰는 하위 경로 (파이프라인에서 직접 참조)
INBOX       = _V3_MAP["캡처"]
NOTES       = _V3_MAP["정리"]
STRUCTURE   = _V3_MAP["연결"]
INSIGHTS    = _V3_MAP["판단"]
RESOURCES   = _V3_MAP["리소스"]
ACTIVITY    = _V3_MAP["활동"]
OPS         = _V3_MAP["운영"]
SYSTEM      = _V3_MAP["시스템"]

# 600 리소스 하위 경로
RESOURCES_REF     = RESOURCES / "610 참조자료"
RESOURCES_TOOLKIT = RESOURCES / "620 도구킷"
RESOURCES_LEARNING = RESOURCES / "630 학습자료"

# Inbox 하위 경로
INBOX_RAW   = INBOX / "111_raw"
INBOX_HYPO  = INBOX / "112 가설"

# 하위호환: INBOX_SUMM/INBOX_DAILY는 폐지됨 (2026-02-27)
# 113_summarized, 114 일일 폴더 삭제 — 일별 폴더(YYYY-MM-DD/)로 대체
INBOX_SUMM  = INBOX  # 참조하는 레거시 스크립트용 fallback → INBOX 자체로 리다이렉트
INBOX_DAILY = INBOX  # 동일

# Activity 하위 경로
PROJECTS    = ACTIVITY / "710 프로젝트"
DAILY       = ACTIVITY / "730 일일"

# Ops 하위 경로
PLAYBOOK    = OPS / "820 플레이북"
REPORTS     = OPS / "840 리포트"
EXECUTION   = OPS / "850 실행"
REPORTS_ARCHIVE   = REPORTS / "841 아카이브"
REPORTS_HYPO      = REPORTS / "842 가설"
REPORTS_VIZ       = REPORTS / "843 시각화"
REPORTS_ANALYSIS  = REPORTS / "844 분석"

# System 하위 경로
ONTOLOGY    = SYSTEM / "910 온톨로지"
CLASSIFICATION_FILE = SYSTEM / "classification.json"

# v2 호환 심링크 경유 경로 (1개월 유지 후 삭제 예정)
# 100 지식 → 100 캡처 심링크가 존재하므로 아래 경로는 여전히 유효
LEGACY_NOTES = VAULT / "100 지식" / "120 노트"
LEGACY_MOC   = VAULT / "100 지식" / "150 구조노트"
LEGACY_AREAS = VAULT / "100 지식" / "120 영역"

# Areas (MOC 디렉터리) — system_dashboard 등 파이프라인 참조용
AREAS = VAULT / "100 지식" / "125 영역"

# 200 정리 하위 경로
ATOMIC_NOTES  = NOTES / "210 원자노트"
CAT_COMPANY   = NOTES / "220 기업"
CAT_MARKET    = NOTES / "225 시장"
CAT_INDUSTRY  = NOTES / "230 산업분석"
CAT_PROG      = NOTES / "235 프로그래밍"
CAT_INSIGHT   = NOTES / "240 인사이트"

# classify.py 전용 — v3 분류 카테고리 → 폴더
VAULT_CATEGORY_DIRS = {
    "기업":     VAULT / "200 정리" / "220 기업",
    "시장":     VAULT / "200 정리" / "225 시장",
    "산업분석": VAULT / "200 정리" / "230 산업분석",
    "프로그래밍": VAULT / "200 정리" / "235 프로그래밍",
    "인사이트": VAULT / "200 정리" / "240 인사이트",
}


def get(stage: str) -> Path:
    """v3 단계명으로 경로 반환. KeyError if invalid."""
    return _V3_MAP[stage]


def get_all_stages() -> dict[str, Path]:
    """전체 v3 매핑 복사본 반환."""
    return dict(_V3_MAP)


# ── 일별 수신함 헬퍼 ─────────────────────────────────────────────────────

_DATE_DIR_RE = re.compile(r"\d{4}-\d{2}-\d{2}$")


def iter_inbox_notes(inbox_dir: Path | None = None) -> Iterator[Path]:
    """110 수신함의 모든 .md 노트 반환 (루트 + YYYY-MM-DD/ 하위).

    111_raw, 112 가설 등 비-날짜 하위폴더는 제외.
    """
    d = inbox_dir or INBOX
    if not d.exists():
        return
    # 루트 레벨 (하위호환)
    yield from sorted(d.glob("*.md"))
    # 일별 폴더
    for sub in sorted(d.iterdir()):
        if sub.is_dir() and _DATE_DIR_RE.match(sub.name):
            yield from sorted(sub.glob("*.md"))


def get_daily_inbox_dir(date_str: str | None = None) -> Path:
    """오늘(또는 지정일) 일별 수신함 폴더 반환. 없으면 생성."""
    from datetime import date as dt_date
    d = date_str or dt_date.today().isoformat()
    daily = INBOX / d
    daily.mkdir(parents=True, exist_ok=True)
    return daily
