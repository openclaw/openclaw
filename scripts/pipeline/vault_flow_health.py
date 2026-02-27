#!/usr/bin/env python3
"""
vault_flow_health.py — 볼트 v3 흐름 헬스체크 + 텔레그램 DM 알림

Usage:
  python3 vault_flow_health.py            # 측정 + 텔레그램 DM
  python3 vault_flow_health.py --dry-run  # 측정만 (전송 없음)
  python3 vault_flow_health.py --json     # JSON 출력 (다른 스크립트용)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from shared.frontmatter import parse_frontmatter
from shared.log import make_logger
from shared.vault_paths import (
    VAULT, INBOX as DEFAULT_INBOX, NOTES, STRUCTURE, INSIGHTS, RESOURCES,
    ACTIVITY, OPS, SYSTEM, ATOMIC_NOTES, PLAYBOOK, REPORTS, REPORTS_ARCHIVE,
    RESOURCES_REF, RESOURCES_TOOLKIT, RESOURCES_LEARNING, PROJECTS,
    _V3_MAP as DEFAULT_V3_MAP,
)

WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))
STATE_DIR = WORKSPACE / "memory" / "vault-flow-health"
STATE_FILE = STATE_DIR / "state.json"
LOG_FILE = WORKSPACE / "logs" / "vault_flow_health.log"

BOT_TOKEN = "8554125313:AAGC5Zzb9nCbPYgmOVqs3pVn-qzIA2oOtkI"
DM_CHAT_ID = "492860021"

# 깔때기 검증 대상 (100 캡처는 수신함이므로 제외)
FUNNEL_STAGES = ["정리", "연결", "판단"]

# 측정 대상 전체
COUNT_STAGES = ["캡처", "정리", "연결", "판단", "리소스", "활동", "운영", "시스템"]

# 단계 번호 매핑 (출력용)
STAGE_NUMBERS = {
    "캡처": "100", "정리": "200", "연결": "400",
    "판단": "500", "리소스": "600", "활동": "700", "운영": "800", "시스템": "900",
}

# 단계별 품질 점수 한글 라벨
STAGE_QUALITY_LABELS = {
    "캡처": "캡처", "정리": "정리", "지식화": "지식화", "연결": "연결",
    "판단": "판단", "리소스": "리소스", "활동": "활동", "운영": "운영", "시스템": "시스템",
}

STATE_MAX_DAYS = 30

log = make_logger(log_file=LOG_FILE)


# ── 측정 함수 ──────────────────────────────────────────────────────

def _is_excluded(filepath: Path, root: Path) -> bool:
    """root 기준 상대 경로에 archives/ 또는 .obsidian/이 포함되면 True."""
    try:
        rel = filepath.relative_to(root)
    except ValueError:
        return False
    return "archives" in rel.parts or ".obsidian" in rel.parts


def count_stage_notes(v3_map: dict[str, Path] | None = None) -> dict[str, int]:
    """각 단계별 .md 파일 수 카운트 (archives/, .obsidian/ 제외)."""
    if v3_map is None:
        v3_map = DEFAULT_V3_MAP
    counts = {}
    for stage, path in v3_map.items():
        if not path.exists():
            counts[stage] = 0
            continue
        count = 0
        for f in path.rglob("*.md"):
            if _is_excluded(f, path):
                continue
            count += 1
        counts[stage] = count
    return counts


def detect_funnel_health(counts: dict[str, int]) -> tuple[bool, str]:
    """깔때기 건강 여부 판단: 200 >= 300 >= 400 >= 500 이면 정상."""
    funnel = [counts.get(s, 0) for s in FUNNEL_STAGES]
    is_healthy = all(funnel[i] >= funnel[i + 1] for i in range(len(funnel) - 1))
    if is_healthy:
        return True, "정상"
    inversions = []
    for i in range(len(FUNNEL_STAGES) - 1):
        if funnel[i] < funnel[i + 1]:
            a, b = FUNNEL_STAGES[i], FUNNEL_STAGES[i + 1]
            inversions.append(f"{STAGE_NUMBERS[b]} > {STAGE_NUMBERS[a]}")
    return False, "역전 (" + ", ".join(inversions) + ")"


def detect_bottleneck(
    counts: dict[str, int], v3_map: dict[str, Path] | None = None
) -> str | None:
    """병목 단계 감지. 500 판단 > 200 정리 이면 500 내부 최대 하위폴더 표시."""
    if v3_map is None:
        v3_map = DEFAULT_V3_MAP
    c_judge = counts.get("판단", 0)
    c_notes = counts.get("정리", 0)
    if c_judge <= c_notes:
        return None

    judge_path = v3_map.get("판단")
    if not judge_path or not judge_path.exists():
        return f"500 판단 비대 ({c_judge}건)"

    subdir_counts: dict[str, int] = {}
    for item in judge_path.iterdir():
        if not item.is_dir() or item.name.startswith(".") or item.name == "archives":
            continue
        md_count = sum(
            1 for f in item.rglob("*.md")
            if not _is_excluded(f, item)
        )
        if md_count > 0:
            subdir_counts[item.name] = md_count

    if subdir_counts:
        largest = max(subdir_counts, key=subdir_counts.get)  # type: ignore[arg-type]
        return f"500 판단 비대 ({largest} {subdir_counts[largest]}건)"
    return f"500 판단 비대 ({c_judge}건)"


def count_inbox_stale(days: int = 7, inbox: Path | None = None) -> int:
    """수신함에서 N일 이상 된 파일 수 카운트."""
    if inbox is None:
        inbox = DEFAULT_INBOX
    if not inbox.exists():
        return 0
    cutoff = time.time() - (days * 86400)
    count = 0
    for f in inbox.rglob("*.md"):
        if _is_excluded(f, inbox):
            continue
        try:
            if f.stat().st_mtime < cutoff:
                count += 1
        except OSError:
            continue
    return count


# ── 고아 노트 감지 ────────────────────────────────────────────────

_WIKILINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]")


def _parse_wikilinks(text: str) -> set[str]:
    """텍스트에서 모든 wikilink 타겟(stem)을 추출."""
    return {m.group(1).strip() for m in _WIKILINK_RE.finditer(text)}


def _is_orphan_excluded(filepath: Path, vault_root: Path) -> bool:
    """고아 감지에서 제외할 파일인지 판단."""
    name = filepath.stem
    try:
        rel = filepath.relative_to(vault_root)
    except ValueError:
        return True
    parts = rel.parts
    # archives/, .obsidian/ 제외
    if "archives" in parts or ".obsidian" in parts:
        return True
    # 900 시스템/ 제외
    if any(p.startswith("900") for p in parts):
        return True
    # INDEX 파일 제외
    if "INDEX" in name:
        return True
    # MOC 파일 제외
    if name.startswith("MOC-") or name.startswith("MOC "):
        return True
    return False


def detect_orphan_notes(
    vault_root: Path | None = None,
) -> tuple[int, int, list[str]]:
    """고아 노트 감지: 다른 어떤 파일에서도 wikilink 되지 않는 노트 탐색.

    Returns (orphan_count, total_notes, top_10_orphan_names).
    """
    if vault_root is None:
        vault_root = VAULT

    if not vault_root.exists():
        return 0, 0, []

    # 1) 모든 .md 파일 수집 (archives/, .obsidian/ 제외)
    all_files: list[Path] = []
    for f in vault_root.rglob("*.md"):
        if _is_excluded(f, vault_root):
            continue
        all_files.append(f)

    # 2) 전체 파일에서 wikilink 타겟 집합 구축
    all_targets: set[str] = set()
    for f in all_files:
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        all_targets.update(_parse_wikilinks(text))

    # 3) 제외 대상 필터링 후 고아 판별
    orphans: list[str] = []
    total = 0
    for f in all_files:
        if _is_orphan_excluded(f, vault_root):
            continue
        total += 1
        if f.stem not in all_targets:
            orphans.append(f.stem)

    orphans.sort()
    return len(orphans), total, orphans[:10]


# ── MOC 신선도 체크 ──────────────────────────────────────────────

def check_moc_freshness(
    vault_root: Path | None = None, days: int = 7,
) -> list[str]:
    """MOC 파일의 신선도 체크: 링크된 파일보다 오래된 MOC를 탐색.

    Returns list of stale MOC names.
    """
    if vault_root is None:
        vault_root = VAULT

    connect_dir = vault_root / "400 연결"
    if not connect_dir.exists():
        return []

    # MOC 파일 수집: 이름에 "MOC" 포함 또는 zk_type: "structure"
    moc_files: list[Path] = []
    for f in connect_dir.rglob("*.md"):
        if _is_excluded(f, connect_dir):
            continue
        name = f.stem
        if "MOC" in name:
            moc_files.append(f)
            continue
        # frontmatter 체크
        meta, _ = parse_frontmatter(f)
        if meta.get("zk_type") == "structure":
            moc_files.append(f)

    # 모든 .md 파일의 stem → mtime 매핑 (빠른 조회용)
    stem_mtime: dict[str, float] = {}
    for f in vault_root.rglob("*.md"):
        if _is_excluded(f, vault_root):
            continue
        try:
            stem_mtime[f.stem] = f.stat().st_mtime
        except OSError:
            continue

    stale: list[str] = []
    threshold = days * 86400

    for moc in moc_files:
        try:
            moc_mtime = moc.stat().st_mtime
        except OSError:
            continue

        # MOC에서 wikilink 파싱
        try:
            text = moc.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue

        targets = _parse_wikilinks(text)
        if not targets:
            continue

        # 링크된 파일 중 가장 최근 수정 시간
        newest_linked = 0.0
        for target in targets:
            mt = stem_mtime.get(target, 0.0)
            if mt > newest_linked:
                newest_linked = mt

        if newest_linked <= 0:
            continue

        # MOC가 링크된 파일보다 days일 이상 오래되었으면 stale
        if newest_linked - moc_mtime > threshold:
            stale.append(moc.stem)

    stale.sort()
    return stale


# ── 9단계 품질 점수 ──────────────────────────────────────────────

KNOWLEDGE_DIR = VAULT / "300 지식화"


def _count_dir_md(d: Path) -> int:
    if not d.exists():
        return 0
    return sum(
        1 for f in d.rglob("*.md")
        if "archives" not in f.parts and ".obsidian" not in f.parts
    )


def _stale_ratio(directory: Path, days: int) -> float:
    """directory 내 .md 파일 중 days일 이상 미갱신 비율."""
    if not directory.exists():
        return 0.0
    cutoff = time.time() - (days * 86400)
    total = 0
    stale = 0
    for f in directory.rglob("*.md"):
        if _is_excluded(f, directory):
            continue
        total += 1
        try:
            if f.stat().st_mtime < cutoff:
                stale += 1
        except OSError:
            continue
    return stale / total if total > 0 else 0.0


def _frontmatter_completeness(directory: Path) -> tuple[float, float]:
    """directory 내 노트의 (분류율, 완성률) 반환.

    분류율: category 필드가 있고 UNCLASSIFIED가 아닌 비율
    완성률: tags>=3 AND source 있음 비율
    """
    if not directory.exists():
        return 0.0, 0.0
    total = 0
    classified = 0
    complete = 0
    for f in directory.rglob("*.md"):
        if _is_excluded(f, directory):
            continue
        total += 1
        meta, _ = parse_frontmatter(f)
        cat = meta.get("category", "")
        if cat and cat != "UNCLASSIFIED":
            classified += 1
        tags = meta.get("tags", [])
        has_tags = isinstance(tags, list) and len(tags) >= 3
        has_source = bool(meta.get("source_url") or meta.get("source"))
        if has_tags and has_source:
            complete += 1
    if total == 0:
        return 0.0, 0.0
    return classified / total, complete / total


def _linked_ratio(resource_dir: Path, vault_root: Path) -> float:
    """resource_dir 내 노트 중 볼트의 다른 노트에서 wikilink로 참조되는 비율."""
    if not resource_dir.exists():
        return 0.0
    res_stems = set()
    for f in resource_dir.rglob("*.md"):
        if not _is_excluded(f, resource_dir):
            res_stems.add(f.stem)
    if not res_stems:
        return 0.0

    # 볼트 전체에서 wikilink 타겟 수집 (리소스 폴더 제외)
    linked: set[str] = set()
    for f in vault_root.rglob("*.md"):
        if _is_excluded(f, vault_root):
            continue
        try:
            rel = f.relative_to(vault_root)
        except ValueError:
            continue
        if any(p.startswith("600") for p in rel.parts):
            continue
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for target in _parse_wikilinks(text):
            if target in res_stems:
                linked.add(target)
    return len(linked) / len(res_stems)


def _seedling_ratio(directory: Path) -> float:
    """seedling + capture maturity 비율."""
    if not directory.exists():
        return 0.0
    total = 0
    seedling = 0
    for f in directory.rglob("*.md"):
        if _is_excluded(f, directory):
            continue
        total += 1
        meta, _ = parse_frontmatter(f)
        mat = meta.get("maturity", "")
        zk = meta.get("zk_type", "")
        if mat in ("seedling", "") or zk in ("fleeting", "capture"):
            seedling += 1
    return seedling / total if total > 0 else 0.0


def _evidence_ratio(directory: Path) -> float:
    """노트 중 wikilink 또는 source 근거가 있는 비율."""
    if not directory.exists():
        return 0.0
    total = 0
    with_evidence = 0
    for f in directory.rglob("*.md"):
        if _is_excluded(f, directory):
            continue
        total += 1
        meta, body = parse_frontmatter(f)
        has_source = bool(meta.get("source_url") or meta.get("source"))
        has_links = bool(_WIKILINK_RE.search(body))
        if has_source or has_links:
            with_evidence += 1
    return with_evidence / total if total > 0 else 0.0


def compute_stage_quality(
    counts: dict[str, int],
    vault_root: Path | None = None,
) -> dict[str, dict]:
    """9단계 품질 점수 계산. 각 단계 {score: 0~100, detail: {...}}."""
    if vault_root is None:
        vault_root = VAULT
    results: dict[str, dict] = {}

    # 100 캡처 — 흐름 속도 (stale 7일+ 비율)
    inbox = vault_root / "100 캡처" / "110 수신함"
    sr = _stale_ratio(inbox, 7)
    results["캡처"] = {"score": round(max(0, 100 - sr * 100)), "stale_ratio": round(sr, 2)}

    # 200 정리 — 분류 완성도
    notes_dir = vault_root / "200 정리"
    cls_ratio, comp_ratio = _frontmatter_completeness(notes_dir)
    score_200 = round(cls_ratio * 40 + comp_ratio * 60)
    results["정리"] = {
        "score": min(100, score_200),
        "classified_ratio": round(cls_ratio, 2),
        "completeness_ratio": round(comp_ratio, 2),
    }

    # 300 지식화 — 존재 자체
    k_dir = vault_root / "300 지식화"
    k_count = _count_dir_md(k_dir)
    active_subdirs = sum(
        1 for d in (k_dir.iterdir() if k_dir.exists() else [])
        if d.is_dir() and _count_dir_md(d) > 0
    )
    score_300 = min(100, k_count * 5 + active_subdirs * 10)
    results["지식화"] = {"score": score_300, "count": k_count, "active_subdirs": active_subdirs}

    # 400 연결 — MOC 건강
    connect_dir = vault_root / "400 연결"
    moc_count = 0
    if connect_dir.exists():
        for f in connect_dir.rglob("*.md"):
            if not _is_excluded(f, connect_dir) and ("MOC" in f.stem):
                moc_count += 1
    stale_mocs = check_moc_freshness(vault_root)
    freshness = max(0.0, 1.0 - len(stale_mocs) / max(moc_count, 1))
    score_400 = round(min(moc_count, 10) * 5 + freshness * 50)
    results["연결"] = {
        "score": min(100, score_400),
        "moc_count": moc_count,
        "stale_mocs": len(stale_mocs),
    }

    # 500 판단 — 순도
    judge_dir = vault_root / "500 판단"
    ev_ratio = _evidence_ratio(judge_dir)
    sd_ratio = _seedling_ratio(judge_dir)
    score_500 = round(ev_ratio * 50 + (1 - sd_ratio) * 30 + 20)
    results["판단"] = {
        "score": min(100, score_500),
        "evidence_ratio": round(ev_ratio, 2),
        "seedling_ratio": round(sd_ratio, 2),
    }

    # 600 리소스 — 참조 활용도
    res_dir = vault_root / "600 리소스"
    lr = _linked_ratio(res_dir, vault_root)
    sr_res = _stale_ratio(res_dir, 90)
    score_600 = round(lr * 60 + (1 - sr_res) * 40) if _count_dir_md(res_dir) > 0 else 0
    results["리소스"] = {
        "score": min(100, score_600),
        "linked_ratio": round(lr, 2),
        "stale_ratio": round(sr_res, 2),
    }

    # 700 활동 — 프로젝트 활성도
    act_dir = vault_root / "700 활동"
    proj_dir = vault_root / "700 활동" / "710 프로젝트"
    proj_count = _count_dir_md(proj_dir) if proj_dir.exists() else 0
    act_stale = _stale_ratio(act_dir, 30)
    has_projects = 40 if proj_count > 0 else 0
    active_bonus = min(30, proj_count * 10)
    score_700 = round(has_projects + active_bonus + (1 - act_stale) * 30)
    results["활동"] = {
        "score": min(100, score_700),
        "project_count": proj_count,
        "stale_ratio": round(act_stale, 2),
    }

    # 800 운영 — 운영 문서 최신성
    ops_dir = vault_root / "800 운영"
    playbook_dir = vault_root / "800 운영" / "820 플레이북"
    reports_dir = vault_root / "800 운영" / "840 리포트"
    pb_fresh = 1.0 - _stale_ratio(playbook_dir, 60)
    report_count = _count_dir_md(reports_dir)
    archive_dir = vault_root / "800 운영" / "840 리포트" / "841 아카이브"
    archive_count = _count_dir_md(archive_dir)
    non_archive = max(0, report_count - archive_count)
    report_backlog_ratio = min(1.0, non_archive / 100) if non_archive > 0 else 0.0
    exec_dir = vault_root / "800 운영" / "850 실행"
    exec_fresh = 1.0 - _stale_ratio(exec_dir, 30) if exec_dir.exists() else 0.0
    score_800 = round(pb_fresh * 40 + (1 - report_backlog_ratio) * 30 + exec_fresh * 30)
    results["운영"] = {
        "score": min(100, score_800),
        "playbook_freshness": round(pb_fresh, 2),
        "report_backlog": non_archive,
    }

    # 900 시스템 — 시스템 문서 동기화
    sys_dir = vault_root / "900 시스템"
    sr_sys = _stale_ratio(sys_dir, 60)
    results["시스템"] = {"score": round(max(0, 100 - sr_sys * 100)), "stale_60d_ratio": round(sr_sys, 2)}

    return results


# ── 교차 교정 감지 ──────────────────────────────────────────────

def detect_misplaced_notes(
    vault_root: Path | None = None, limit: int = 50,
) -> list[dict]:
    """각 단계에서 잘못 분류된 노트 감지.

    Returns list of {"note": stem, "current": "500", "suggested": "200", "reason": "..."}.
    """
    if vault_root is None:
        vault_root = VAULT
    misplaced: list[dict] = []

    # 500 판단 → seedling/capture → 200
    judge_dir = vault_root / "500 판단"
    if judge_dir.exists():
        for f in judge_dir.rglob("*.md"):
            if len(misplaced) >= limit:
                break
            if _is_excluded(f, judge_dir):
                continue
            meta, body = parse_frontmatter(f)
            mat = meta.get("maturity", "")
            zk = meta.get("zk_type", "")
            if mat == "seedling" or zk in ("fleeting", "capture"):
                misplaced.append({
                    "note": f.stem, "current": "500", "suggested": "200",
                    "reason": f"미성숙 혼입 (maturity={mat}, zk_type={zk})",
                })

    # 200 정리 → evergreen+links≥5 → 300
    notes_dir = vault_root / "200 정리"
    if notes_dir.exists():
        for f in notes_dir.rglob("*.md"):
            if len(misplaced) >= limit:
                break
            if _is_excluded(f, notes_dir):
                continue
            meta, body = parse_frontmatter(f)
            mat = meta.get("maturity", "")
            links = len(_WIKILINK_RE.findall(body))
            if mat == "evergreen" and links >= 5:
                misplaced.append({
                    "note": f.stem, "current": "200", "suggested": "300",
                    "reason": f"이미 성숙 (evergreen, links={links})",
                })

    # 300 지식화 → 미성숙(tags=0, body<3줄) → 200
    k_dir = vault_root / "300 지식화"
    if k_dir.exists():
        for f in k_dir.rglob("*.md"):
            if len(misplaced) >= limit:
                break
            if _is_excluded(f, k_dir):
                continue
            meta, body = parse_frontmatter(f)
            tags = meta.get("tags", [])
            tag_count = len(tags) if isinstance(tags, list) else 0
            body_lines = [l for l in body.strip().split("\n") if l.strip()]
            if tag_count == 0 and len(body_lines) < 3:
                misplaced.append({
                    "note": f.stem, "current": "300", "suggested": "200",
                    "reason": f"아직 미성숙 (tags={tag_count}, body={len(body_lines)}줄)",
                })

    # 400 연결 → MOC가 아닌데 들어와있음 → 300/200
    connect_dir = vault_root / "400 연결"
    if connect_dir.exists():
        for f in connect_dir.rglob("*.md"):
            if len(misplaced) >= limit:
                break
            if _is_excluded(f, connect_dir):
                continue
            if "MOC" in f.stem or "INDEX" in f.stem:
                continue
            meta, _ = parse_frontmatter(f)
            if meta.get("zk_type") == "structure":
                continue
            misplaced.append({
                "note": f.stem, "current": "400", "suggested": "200",
                "reason": "MOC/구조노트가 아닌데 400 연결에 위치",
            })

    # 800 운영 → 지식 노트 혼입 → 200/300
    ops_dir = vault_root / "800 운영"
    if ops_dir.exists():
        for f in ops_dir.rglob("*.md"):
            if len(misplaced) >= limit:
                break
            if _is_excluded(f, ops_dir):
                continue
            if "INDEX" in f.stem:
                continue
            meta, body = parse_frontmatter(f)
            zk = meta.get("zk_type", "")
            cat = meta.get("category", "")
            # 운영 문서가 아닌 지식 노트 패턴
            if zk in ("permanent", "literature") and cat in ("기업", "시장", "산업분석", "프로그래밍"):
                misplaced.append({
                    "note": f.stem, "current": "800", "suggested": "200",
                    "reason": f"지식 노트가 800 운영에 혼입 (zk_type={zk}, category={cat})",
                })

    return misplaced


# ── 3시스템 통합 건강도 ──────────────────────────────────────────

def check_integration_health(
    vault_root: Path | None = None,
) -> dict:
    """OpenClaw↔볼트↔Claude Code 연결 건강도 측정.

    Returns {"score": 0~100, "checks": [...], "issues": [...]}.
    """
    if vault_root is None:
        vault_root = VAULT
    workspace = Path(os.path.expanduser("~/.openclaw/workspace"))
    cron_file = Path(os.path.expanduser("~/.openclaw/cron/jobs.json"))

    checks: list[dict] = []
    issues: list[str] = []
    total_weight = 0
    earned = 0

    # 1. OpenClaw → 볼트: 최근 7일 수신함 신규 노트 수
    weight = 25
    total_weight += weight
    inbox = vault_root / "100 캡처" / "110 수신함"
    recent_inbox = 0
    cutoff_7d = time.time() - 7 * 86400
    if inbox.exists():
        for f in inbox.rglob("*.md"):
            if not _is_excluded(f, inbox):
                try:
                    if f.stat().st_mtime > cutoff_7d:
                        recent_inbox += 1
                except OSError:
                    pass
    ok = recent_inbox > 0
    checks.append({"name": "OpenClaw→볼트", "value": recent_inbox, "ok": ok})
    if ok:
        earned += weight
    else:
        issues.append("수신함에 7일간 신규 노트 없음")

    # 2. OpenClaw → memory/: 최근 7일 memory 파일 수
    weight = 20
    total_weight += weight
    memory_dir = workspace / "memory"
    recent_mem = 0
    if memory_dir.exists():
        for f in memory_dir.rglob("*.json"):
            try:
                if f.stat().st_mtime > cutoff_7d:
                    recent_mem += 1
            except OSError:
                pass
    ok = recent_mem > 10
    checks.append({"name": "OpenClaw→memory", "value": recent_mem, "ok": ok})
    if ok:
        earned += weight
    else:
        issues.append(f"최근 7일 memory 파일 {recent_mem}개 (<10)")

    # 3. 볼트 → 파이프라인: vault_paths.py 경로 존재 확인
    weight = 20
    total_weight += weight
    missing_paths = []
    for stage, path in DEFAULT_V3_MAP.items():
        if not path.exists():
            missing_paths.append(stage)
    ok = len(missing_paths) == 0
    checks.append({"name": "볼트→파이프라인", "missing": missing_paths, "ok": ok})
    if ok:
        earned += weight
    else:
        issues.append(f"경로 미존재: {', '.join(missing_paths)}")

    # 4. 크론 → 파이프라인: 활성 크론 중 에러 비율
    weight = 20
    total_weight += weight
    cron_error_ratio = 0.0
    if cron_file.exists():
        try:
            cron_data = json.loads(cron_file.read_text(encoding="utf-8"))
            enabled = [j for j in cron_data.get("jobs", []) if j.get("enabled")]
            if enabled:
                errored = sum(
                    1 for j in enabled
                    if j.get("state", {}).get("consecutiveErrors", 0) > 0
                )
                cron_error_ratio = errored / len(enabled)
        except (json.JSONDecodeError, OSError):
            pass
    ok = cron_error_ratio < 0.2
    checks.append({"name": "크론→파이프라인", "error_ratio": round(cron_error_ratio, 2), "ok": ok})
    if ok:
        earned += weight
    else:
        issues.append(f"크론 에러율 {cron_error_ratio:.0%}")

    # 5. 워커 → 게이트웨이: 워커 프로세스 수
    weight = 15
    total_weight += weight
    worker_count = 0
    try:
        import subprocess
        result = subprocess.run(
            ["pgrep", "-f", "agent_queue_worker"],
            capture_output=True, text=True, timeout=5,
        )
        worker_count = len(result.stdout.strip().split("\n")) if result.stdout.strip() else 0
    except Exception:
        pass
    ok = worker_count >= 1
    checks.append({"name": "워커→게이트웨이", "workers": worker_count, "ok": ok})
    if ok:
        earned += weight
    else:
        issues.append(f"워커 {worker_count}개 활성")

    score = round(earned / total_weight * 100) if total_weight > 0 else 0
    return {"score": score, "checks": checks, "issues": issues}


# ── 상태 관리 ──────────────────────────────────────────────────────

def load_state(state_file: Path | None = None) -> dict:
    """state.json 로드. 없으면 빈 딕셔너리."""
    if state_file is None:
        state_file = STATE_FILE
    if not state_file.exists():
        return {}
    try:
        with open(state_file) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def save_state(
    state: dict, current: dict[str, int],
    state_dir: Path | None = None, state_file: Path | None = None,
    quality: dict[str, dict] | None = None,
) -> None:
    """현재 카운트를 오늘 날짜로 저장. 30일 초과 항목 정리."""
    if state_dir is None:
        state_dir = STATE_DIR
    if state_file is None:
        state_file = STATE_FILE

    today = datetime.now().strftime("%Y-%m-%d")
    state[today] = current

    # 품질 점수 저장 (30일 롤링)
    if quality:
        quality_scores = {k: v["score"] for k, v in quality.items()}
        state.setdefault("_quality", {})[today] = quality_scores

    cutoff = (datetime.now() - timedelta(days=STATE_MAX_DAYS)).strftime("%Y-%m-%d")
    pruned = {}
    for k, v in state.items():
        if k.startswith("_"):
            # special keys: prune nested date keys
            if isinstance(v, dict):
                pruned[k] = {dk: dv for dk, dv in v.items() if dk >= cutoff}
            else:
                pruned[k] = v
        elif k >= cutoff:
            pruned[k] = v

    state_dir.mkdir(parents=True, exist_ok=True)
    with open(state_file, "w") as f:
        json.dump(pruned, f, ensure_ascii=False, indent=2)


def compute_delta(current: dict[str, int], state: dict) -> dict[str, int]:
    """어제 대비 변화량 계산. 어제 데이터 없으면 전부 0."""
    yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
    prev = state.get(yesterday)
    if not prev:
        return {s: 0 for s in current}
    return {s: current.get(s, 0) - prev.get(s, 0) for s in current}


def compute_quality_trend(state: dict) -> dict[str, int]:
    """7일 전 대비 품질 점수 변화. 데이터 없으면 0."""
    quality_history = state.get("_quality", {})
    today = datetime.now().strftime("%Y-%m-%d")
    week_ago = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
    current = quality_history.get(today, {})
    prev = quality_history.get(week_ago, {})
    if not current or not prev:
        return {}
    return {s: current.get(s, 0) - prev.get(s, 0) for s in current}


# ── 리포트 포맷 ──────────────────────────────────────────────────────

def _quality_bar(score: int, width: int = 10) -> str:
    """점수를 ASCII 바 형태로 변환."""
    filled = round(score / 100 * width)
    return "=" * filled + "-" * (width - filled)


def format_report(
    counts: dict[str, int],
    delta: dict[str, int],
    funnel_msg: str,
    bottleneck: str | None,
    stale_count: int,
    orphan_count: int = 0,
    orphan_total: int = 0,
    stale_mocs: list[str] | None = None,
    stage_quality: dict[str, dict] | None = None,
    misplaced: list[dict] | None = None,
    integration: dict | None = None,
) -> str:
    """텔레그램 DM용 HTML 리포트 생성."""
    today = datetime.now().strftime("%Y-%m-%d")
    lines = [f"\U0001f4ca <b>볼트 흐름 헬스체크</b> | {today}", ""]

    for stage in COUNT_STAGES:
        num = STAGE_NUMBERS[stage]
        cnt = counts.get(stage, 0)
        d = delta.get(stage, 0)
        sign = "+" if d >= 0 else ""
        lines.append(f"{num} {stage:4s} {cnt:>4d}  (\u25b3{sign}{d})")

    lines.append("")
    funnel_icon = "\u2705" if funnel_msg == "정상" else "\u26a0\ufe0f"
    lines.append(f"깔때기: {funnel_icon} {funnel_msg}")

    if bottleneck:
        lines.append(f"병목: {bottleneck}")
    if stale_count > 0:
        lines.append(f"수신함: {stale_count}건 미처리 (7일+)")

    # 고아 노트
    if orphan_total > 0:
        ratio = orphan_count / orphan_total
        warn = "\u26a0\ufe0f " if ratio > 0.20 else ""
        lines.append(f"{warn}고아 노트: {orphan_count}개 / {orphan_total} ({ratio:.0%})")

    # MOC 신선도
    if stale_mocs:
        names = ", ".join(stale_mocs[:5])
        suffix = f" 외 {len(stale_mocs) - 5}개" if len(stale_mocs) > 5 else ""
        lines.append(f"MOC 갱신 필요: {len(stale_mocs)}개 ({names}{suffix})")

    # 단계별 품질
    if stage_quality:
        lines.append("")
        lines.append("<b>단계별 품질:</b>")
        quality_stages = ["캡처", "정리", "지식화", "연결", "판단", "리소스", "활동", "운영", "시스템"]
        for qs in quality_stages:
            info = stage_quality.get(qs)
            if info is None:
                continue
            score = info["score"]
            bar = _quality_bar(score)
            detail = ""
            if qs == "정리" and info.get("classified_ratio", 1.0) < 0.5:
                uncls = round((1 - info["classified_ratio"]) * counts.get("정리", 0))
                detail = f" (미분류 {uncls}건)"
            elif qs == "지식화" and info.get("count", 0) == 0:
                detail = " (비어있음)"
            elif qs == "판단" and info.get("seedling_ratio", 0) > 0.2:
                detail = f" (seedling {info['seedling_ratio']:.0%})"
            elif qs == "리소스" and info.get("linked_ratio", 1.0) < 0.5:
                detail = " (참조율 낮음)"
            elif qs == "활동" and info.get("project_count", 0) == 0:
                detail = " (프로젝트 0개)"
            elif qs == "운영" and info.get("report_backlog", 0) > 50:
                detail = f" (리포트 적체 {info['report_backlog']}건)"
            lines.append(f"  {qs:4s} [{bar}] {score:3d}{detail}")

    # 교정 필요
    if misplaced:
        summary: dict[str, int] = {}
        for m in misplaced:
            key = f"{m['current']}→{m['suggested']}"
            summary[key] = summary.get(key, 0) + 1
        detail_str = ", ".join(f"{k}: {v}" for k, v in summary.items())
        lines.append(f"\n교정 필요: {len(misplaced)}건 ({detail_str})")

    # 통합 건강도
    if integration:
        iscore = integration["score"]
        icon = "\u2705" if iscore >= 70 else "\u26a0\ufe0f"
        lines.append(f"통합: {iscore}/100 {icon}")
        for issue in integration.get("issues", []):
            lines.append(f"  - {issue}")

    return "\n".join(lines)


# ── 텔레그램 전송 ──────────────────────────────────────────────────

def _send_telegram_text(text: str, chat_id: str = DM_CHAT_ID) -> bool:
    """텔레그램 Bot API로 메시지 전송."""
    import urllib.request

    try:
        payload = {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            data=data,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            if result.get("ok"):
                return True
        log(f"Telegram failed: {result}")
        return False
    except Exception as e:
        log(f"Telegram error: {e}")
        return False


# ── 메인 ──────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="볼트 v3 흐름 헬스체크")
    parser.add_argument("--dry-run", action="store_true", help="측정만 (전송 없음)")
    parser.add_argument("--json", action="store_true", help="JSON 출력")
    args = parser.parse_args()

    counts = count_stage_notes()
    state = load_state()
    delta = compute_delta(counts, state)
    is_healthy, funnel_msg = detect_funnel_health(counts)
    bottleneck = detect_bottleneck(counts)
    stale_count = count_inbox_stale()
    orphan_count, orphan_total, orphan_names = detect_orphan_notes()
    stale_mocs = check_moc_freshness()

    # 9단계 품질 점수
    stage_quality = compute_stage_quality(counts)
    # 교차 교정 감지
    misplaced = detect_misplaced_notes()
    # 3시스템 통합 건강도
    integration = check_integration_health()

    save_state(state, counts, quality=stage_quality)

    if args.json:
        output = {
            "date": datetime.now().strftime("%Y-%m-%d"),
            "counts": counts,
            "delta": delta,
            "funnel_healthy": is_healthy,
            "funnel_message": funnel_msg,
            "bottleneck": bottleneck,
            "inbox_stale": stale_count,
            "orphan_count": orphan_count,
            "orphan_total": orphan_total,
            "orphan_ratio": round(orphan_count / orphan_total, 3) if orphan_total > 0 else 0,
            "orphan_top10": orphan_names,
            "stale_mocs": stale_mocs,
            "stage_quality": stage_quality,
            "misplaced_count": len(misplaced),
            "misplaced": misplaced[:20],
            "integration": integration,
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return

    report = format_report(
        counts, delta, funnel_msg, bottleneck, stale_count,
        orphan_count=orphan_count, orphan_total=orphan_total,
        stale_mocs=stale_mocs,
        stage_quality=stage_quality,
        misplaced=misplaced,
        integration=integration,
    )

    if args.dry_run:
        print(report)
        log("Dry-run: report generated, not sent")
        return

    if _send_telegram_text(report):
        log("Report sent to Telegram DM")
    else:
        log("Failed to send report", level="ERROR")


if __name__ == "__main__":
    main()
