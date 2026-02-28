#!/usr/bin/env python3
"""vault_funnel_fix.py — 400 판단 역류 정리 (1회성 마이그레이션).

400 판단에 capture 직행으로 쌓인 미성숙 노트를 200 정리/240 인사이트로 이동.
Obsidian wikilink는 파일명 기반이라 폴더 이동에 영향 없음.

Usage:
  python3 vault_funnel_fix.py --dry-run   # 이동 계획만 출력 (기본값)
  python3 vault_funnel_fix.py --execute   # 실제 이동 실행
"""
from __future__ import annotations

import argparse
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shared.frontmatter import parse_frontmatter, update_frontmatter

VAULT = Path.home() / "knowledge"
SRC_DIR = VAULT / "400 판단"
DST_DIR = VAULT / "200 정리" / "240 인사이트"

_WIKILINK_RE = re.compile(r"\[\[([^\]|]+)(?:\|[^\]]+)?\]\]")


def count_wikilinks(body: str) -> int:
    """본문 내 wikilink 수."""
    return len(_WIKILINK_RE.findall(body))


def should_migrate(meta: dict, body: str) -> tuple[bool, str]:
    """마이그레이션 대상 여부 판단.

    Returns:
        (should_move, reason)
    """
    source_type = meta.get("source_type", "")
    maturity = meta.get("maturity", "")
    links = count_wikilinks(body)

    if source_type != "capture":
        return False, f"non-capture (source_type={source_type!r})"

    if maturity == "seedling" and links <= 2:
        return True, f"capture+seedling, links={links} (≤2)"

    if maturity == "growing" and links <= 4:
        return True, f"capture+growing, links={links} (≤4)"

    if maturity == "seedling" and links > 2:
        return False, f"capture+seedling but links={links} (>2), keep"

    if maturity == "growing" and links > 4:
        return False, f"capture+growing but links={links} (>4), keep"

    return False, f"capture+{maturity}, links={links}, keep"


def scan_files() -> list[Path]:
    """400 판단 하위 전체 .md 스캔 (백업 파일 제외)."""
    files = []
    for f in SRC_DIR.rglob("*.md"):
        if f.name.endswith("_orig.md") or f.name.endswith("_reclass.md"):
            continue
        files.append(f)
    return sorted(files)


def plan_migration(files: list[Path]) -> tuple[list[tuple[Path, Path, str]], list[tuple[Path, str]], list[Path]]:
    """마이그레이션 계획 수립.

    Returns:
        (to_move, to_keep, backups)
        to_move: [(src, dst, reason), ...]
        to_keep: [(path, reason), ...]
        backups: [path, ...]
    """
    to_move: list[tuple[Path, Path, str]] = []
    to_keep: list[tuple[Path, str]] = []
    backups: list[Path] = []

    for f in files:
        meta, body = parse_frontmatter(f)

        if not meta:
            to_keep.append((f, "no frontmatter"))
            continue

        move, reason = should_migrate(meta, body)
        if move:
            dst = DST_DIR / f.name
            # 이름 충돌 처리
            if dst.exists():
                stem = f.stem
                suffix = f.suffix
                dst = DST_DIR / f"{stem}_from500{suffix}"
            to_move.append((f, dst, reason))
        else:
            to_keep.append((f, reason))

    # 백업 파일 집계
    for f in SRC_DIR.rglob("*.md"):
        if f.name.endswith("_orig.md") or f.name.endswith("_reclass.md"):
            backups.append(f)

    return to_move, to_keep, backups


def execute_migration(to_move: list[tuple[Path, Path, str]]) -> int:
    """실제 파일 이동 + frontmatter 업데이트."""
    moved = 0
    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")

    for src, dst, reason in to_move:
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
        update_frontmatter(dst, {
            "migrated_from": str(src.relative_to(VAULT)),
            "migrated_at": now,
        })
        moved += 1

    return moved


def main():
    parser = argparse.ArgumentParser(description="400 판단 역류 정리")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--dry-run", action="store_true", default=True,
                       help="이동 계획만 출력 (기본값)")
    group.add_argument("--execute", action="store_true",
                       help="실제 이동 실행")
    args = parser.parse_args()

    if not SRC_DIR.exists():
        print(f"[ERROR] {SRC_DIR} 없음")
        sys.exit(1)

    DST_DIR.mkdir(parents=True, exist_ok=True)

    files = scan_files()
    print(f"[SCAN] 400 판단 내 .md 파일: {len(files)}개 (백업 제외)")

    to_move, to_keep, backups = plan_migration(files)

    print(f"\n{'='*60}")
    print(f"  이동 대상: {len(to_move)}개 → 200 정리/240 인사이트")
    print(f"  유지:      {len(to_keep)}개 (500 잔류)")
    print(f"  백업 파일: {len(backups)}개 (_orig/_reclass)")
    print(f"{'='*60}\n")

    if to_move:
        print("[MOVE 대상]")
        for src, dst, reason in to_move:
            rel_src = src.relative_to(VAULT)
            print(f"  {rel_src}")
            print(f"    → {dst.relative_to(VAULT)}  ({reason})")
        print()

    if to_keep:
        print(f"[KEEP — 500 유지] ({len(to_keep)}개)")
        for path, reason in to_keep[:20]:
            print(f"  {path.relative_to(VAULT)}  ({reason})")
        if len(to_keep) > 20:
            print(f"  ... +{len(to_keep) - 20}개 더")
        print()

    if backups:
        print(f"[BACKUP 파일] ({len(backups)}개)")
        for b in backups[:10]:
            print(f"  {b.relative_to(VAULT)}")
        if len(backups) > 10:
            print(f"  ... +{len(backups) - 10}개 더")
        print()

    if args.execute:
        print("[EXECUTE] 마이그레이션 실행 중...")
        moved = execute_migration(to_move)
        print(f"[DONE] {moved}개 파일 이동 완료")
    else:
        print("[DRY-RUN] --execute 플래그로 실행하세요")


if __name__ == "__main__":
    main()
