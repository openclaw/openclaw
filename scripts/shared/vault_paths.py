"""Centralized vault path definitions — single source of truth.

All scripts should import paths from here instead of declaring their own.
Phase 2 (folder rename) only requires updating this file.
"""
from pathlib import Path
import os

VAULT = Path(os.path.expanduser("~/knowledge"))

# v3 논리 단계 → 현재 물리 경로 매핑
# Phase 2(폴더 이동) 시 여기만 수정하면 됨
_V3_MAP = {
    "캡처":   VAULT / "100 지식" / "110 수신함",
    "정리":   VAULT / "100 지식" / "121 노트",
    "지식화": VAULT / "100 지식" / "125 영역",
    "연결":   VAULT / "100 지식" / "130 구조노트",
    "판단":   VAULT / "100 지식" / "140 인사이트",
    "활동":   VAULT / "200 활동",
    "운영":   VAULT / "300 운영",
    "시스템": VAULT / "900 시스템",
}

# 자주 쓰는 하위 경로 (파이프라인에서 직접 참조)
INBOX       = _V3_MAP["캡처"]
NOTES       = _V3_MAP["정리"]
AREAS       = _V3_MAP["지식화"]
STRUCTURE   = _V3_MAP["연결"]
INSIGHTS    = _V3_MAP["판단"]
ACTIVITY    = _V3_MAP["활동"]
OPS         = _V3_MAP["운영"]
SYSTEM      = _V3_MAP["시스템"]

PROJECTS    = ACTIVITY / "210 프로젝트"
DAILY       = ACTIVITY / "230 일일"
PLAYBOOK    = OPS / "320 플레이북"
REPORTS     = OPS / "340 리포트"
EXECUTION   = OPS / "350 실행"
ONTOLOGY    = SYSTEM / "910 온톨로지"
CLASSIFICATION_FILE = SYSTEM / "classification.json"

# classify.py 전용 — v3 분류 카테고리 → 폴더
VAULT_CATEGORY_DIRS = {
    "기업":     VAULT / "100 지식" / "120 기업",
    "시장":     VAULT / "100 지식" / "125 시장",
    "산업분석": VAULT / "100 지식" / "130 산업분석",
    "프로그래밍": VAULT / "100 지식" / "135 프로그래밍",
    "인사이트": VAULT / "100 지식" / "140 인사이트",
}


def get(stage: str) -> Path:
    """v3 단계명으로 경로 반환. KeyError if invalid."""
    return _V3_MAP[stage]


def get_all_stages() -> dict[str, Path]:
    """전체 v3 매핑 복사본 반환."""
    return dict(_V3_MAP)
