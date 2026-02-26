#!/usr/bin/env python3
"""vault_wikilink_cleanup.py — 깨진 위키링크 일괄 정리 (일회성).

v3 볼트 물리 재배치 후 남은 깨진 위키링크를 정리한다.
- `000 설계/` 내 파일(템플릿/예시)은 건드리지 않음
- `129 비넘버 통합` 경로 참조 → stem만 남기도록 수정 (대상 파일이 실재할 때)
- 나머지 깨진 링크: 목록 아이템이면 라인 삭제, 인라인이면 plain text로 변환

Usage:
    python3 vault_wikilink_cleanup.py --dry-run   # 변경 없이 리포트
    python3 vault_wikilink_cleanup.py              # 실행
    python3 vault_wikilink_cleanup.py --backup     # 원본 백업 후 실행
"""
import argparse
import os
import re
import shutil
import sys
from pathlib import Path

VAULT = Path.home() / "knowledge"
ARCHIVES = VAULT / "archives"
DESIGN_DIR = VAULT / "000 설계"

WIKILINK_RE = re.compile(r"\[\[([^\]]+)\]\]")
# Unclosed wikilink: [[ with no matching ]] on the same line
UNCLOSED_WIKILINK_RE = re.compile(r"\[\[(?![^\[]*\]\])")
# List-only line: optional whitespace, -, optional whitespace, [[...]], optional whitespace, EOL
LIST_LINK_ONLY_RE = re.compile(r"^(\s*[-*]\s*)\[\[([^\]]+)\]\]\s*$")


def build_vault_stems() -> set[str]:
    """Collect all .md file stems in vault (excluding archives/)."""
    stems = set()
    for root, _dirs, files in os.walk(VAULT):
        if str(root).startswith(str(ARCHIVES)):
            continue
        for fn in files:
            if fn.endswith(".md"):
                stems.add(Path(fn).stem)
    return stems


def resolve_target(raw: str) -> str:
    """Extract the target stem from a wikilink target string."""
    # strip alias: [[target|alias]]
    target = raw.split("|")[0].strip()
    # strip heading: [[target#heading]]
    target = target.split("#")[0].strip()
    # strip path: use just the filename
    if "/" in target:
        target = os.path.basename(target)
    # strip .md extension if present
    if target.endswith(".md"):
        target = target[:-3]
    return target


def is_design_file(fpath: Path) -> bool:
    """Check if file is under 000 설계/ (template/example — skip)."""
    try:
        fpath.relative_to(DESIGN_DIR)
        return True
    except ValueError:
        return False


def process_file(
    fpath: Path, vault_stems: set[str], dry_run: bool
) -> tuple[int, int]:
    """Process a single .md file. Returns (links_fixed, lines_deleted)."""
    try:
        content = fpath.read_text(encoding="utf-8")
    except Exception:
        return 0, 0

    lines = content.split("\n")
    new_lines: list[str | None] = []  # None = deleted
    links_fixed = 0
    lines_deleted = 0

    for line in lines:
        # Handle unclosed wikilinks: [[ without ]] on the same line
        if UNCLOSED_WIKILINK_RE.search(line) and "]]" not in line:
            # This is a malformed wikilink — delete the line if it's a list item
            stripped = line.strip()
            if stripped.startswith(("-", "*", "+")):
                new_lines.append(None)
                lines_deleted += 1
                links_fixed += 1
            else:
                # Convert [[ to plain text
                modified = line.replace("[[", "")
                new_lines.append(modified)
                links_fixed += 1
            continue

        matches = list(WIKILINK_RE.finditer(line))
        if not matches:
            new_lines.append(line)
            continue

        # Check if any wikilink on this line is broken
        broken_targets = []
        for m in matches:
            stem = resolve_target(m.group(1))
            if stem and stem not in vault_stems:
                broken_targets.append(m)

        if not broken_targets:
            new_lines.append(line)
            continue

        # Check: is this a list item with ONLY a single broken link?
        list_match = LIST_LINK_ONLY_RE.match(line)
        if list_match and len(matches) == 1 and len(broken_targets) == 1:
            # Delete the entire line
            new_lines.append(None)
            lines_deleted += 1
            links_fixed += 1
            continue

        # Otherwise: replace broken [[links]] with plain text (remove brackets)
        modified = line
        for m in reversed(broken_targets):  # reverse to preserve positions
            raw = m.group(1)
            target_stem = resolve_target(raw)

            # Special case: 129 비넘버 통합 path reference
            if "129 비넘버" in raw and target_stem in vault_stems:
                # Target exists — just fix to [[stem]]
                alias_part = ""
                if "|" in raw:
                    alias_part = "|" + raw.split("|", 1)[1]
                replacement = f"[[{target_stem}{alias_part}]]"
            else:
                # Replace with plain text (remove brackets)
                # Preserve alias if present as display text
                if "|" in raw:
                    display = raw.split("|", 1)[1].strip()
                else:
                    display = target_stem
                replacement = display

            modified = modified[: m.start()] + replacement + modified[m.end() :]
            links_fixed += 1

        # If the modified line is now an empty list item, delete it
        stripped = modified.strip()
        if stripped in ("-", "*", "+") or re.match(r"^\s*[-*+]\s*$", modified):
            new_lines.append(None)
            lines_deleted += 1
        else:
            new_lines.append(modified)

    # Check if anything changed
    filtered = [l for l in new_lines if l is not None]
    new_content = "\n".join(filtered)

    if new_content != content and not dry_run:
        fpath.write_text(new_content, encoding="utf-8")

    return links_fixed, lines_deleted


def main():
    parser = argparse.ArgumentParser(description="Clean broken wikilinks in vault")
    parser.add_argument("--dry-run", action="store_true", help="Report only, no changes")
    parser.add_argument("--backup", action="store_true", help="Create .bak files before editing")
    args = parser.parse_args()

    vault_stems = build_vault_stems()
    print(f"Vault stems: {len(vault_stems)}")

    total_links_fixed = 0
    total_lines_deleted = 0
    files_modified = 0
    skipped_design = 0

    for root, _dirs, files in os.walk(VAULT):
        if str(root).startswith(str(ARCHIVES)):
            continue
        for fn in files:
            if not fn.endswith(".md"):
                continue
            fpath = Path(root) / fn

            if is_design_file(fpath):
                skipped_design += 1
                continue

            if args.backup and not args.dry_run:
                bak = fpath.with_suffix(".md.bak")
                if not bak.exists():
                    shutil.copy2(fpath, bak)

            lf, ld = process_file(fpath, vault_stems, dry_run=args.dry_run)
            if lf > 0:
                files_modified += 1
                total_links_fixed += lf
                total_lines_deleted += ld

    action = "Would fix" if args.dry_run else "Fixed"
    print(f"\n{'=== DRY RUN ===' if args.dry_run else '=== DONE ==='}")
    print(f"Skipped (design/template): {skipped_design} files")
    print(f"{action}: {total_links_fixed} broken wikilinks")
    print(f"Lines deleted: {total_lines_deleted}")
    print(f"Files modified: {files_modified}")


if __name__ == "__main__":
    main()
