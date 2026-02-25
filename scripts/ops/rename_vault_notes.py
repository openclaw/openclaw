#!/usr/bin/env python3
"""rename_vault_notes.py — 볼트 네이밍 일괄 정리

파일명에서 프로세스 메타데이터(합성_/reg-) 제거, 날짜 접두사 부여,
frontmatter 제목 정리, 본문 LLM disclaimer 제거, 위키링크 업데이트.

Usage:
  python3 rename_vault_notes.py --dry-run          # 변경 사항만 출력
  python3 rename_vault_notes.py --apply             # 실적용
  python3 rename_vault_notes.py --apply --cap 100   # 최대 100건만

Safety:
  - dry-run 기본값
  - 변경 매핑을 JSON으로 저장 (롤백용)
  - 충돌 시 스킵 + 로그
  - 1회 최대 500건 cap (--cap으로 조정)
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

from shared.vault_paths import VAULT as VAULT_ROOT
MAPPING_FILE = Path.home() / ".openclaw" / "workspace" / "memory" / "rename_mapping.json"
LLM_DISCLAIMER = "**(추정) LLM 합성 콘텐츠**"


def parse_frontmatter(text):
    """Parse YAML frontmatter. Returns (meta_dict, body_str)."""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    fm_text = text[4:end]
    body = text[end + 4:].lstrip("\n")

    meta = {}
    for line in fm_text.split("\n"):
        line = line.strip()
        if not line or ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        val = val.strip()
        # Strip quotes
        if val.startswith('"') and val.endswith('"'):
            val = val[1:-1]
        elif val.startswith("'") and val.endswith("'"):
            val = val[1:-1]
        # Parse JSON arrays
        if val.startswith("["):
            try:
                val = json.loads(val)
            except json.JSONDecodeError:
                pass
        meta[key] = val
    return meta, body


def render_frontmatter(meta):
    """Render meta dict back to YAML frontmatter string."""
    lines = ["---"]
    for k, v in meta.items():
        if isinstance(v, list):
            lines.append(f"{k}: {json.dumps(v, ensure_ascii=False)}")
        elif isinstance(v, bool):
            lines.append(f"{k}: {str(v).lower()}")
        elif isinstance(v, (int, float)):
            lines.append(f"{k}: {v}")
        else:
            lines.append(f'{k}: "{v}"')
    lines.append("---")
    return "\n".join(lines)


def sanitize_slug(text):
    """Clean text into a safe filename slug."""
    slug = re.sub(r"[^\w가-힣\s-]", "", text)
    slug = re.sub(r"\s+", "_", slug.strip())
    slug = slug.strip("_")
    return slug[:60] if slug else ""


def derive_title_from_source(meta):
    """빈 제목일 때 source/tags에서 제목 추정."""
    source = meta.get("source", "")
    tags = meta.get("tags", [])
    if isinstance(tags, str):
        tags = [tags]

    # Try source field
    if source:
        # Extract meaningful part from source path
        source_name = Path(source).stem if "/" in source else source
        source_name = source_name.replace("_", " ").replace("-", " ")
        # Remove common prefixes
        for prefix in ("telegram-export", "memory/backup", "topic_"):
            source_name = source_name.replace(prefix, "").strip()
        if len(source_name) > 5:
            return source_name[:60]

    # Try meaningful tags
    meaningful_tags = [
        t for t in tags
        if not t.startswith(("#", "status/", "source/", "synthesis"))
        and t not in ("seed", "seedling", "synthesis")
    ]
    if meaningful_tags:
        return "_".join(meaningful_tags[:3])[:60]

    return ""


def compute_new_filename(old_path, meta):
    """Compute new filename for a note. Returns (new_filename, changes_list) or (None, [])."""
    old_name = old_path.stem
    changes = []

    # Get date from frontmatter
    date_str = meta.get("date", "")
    if isinstance(date_str, str) and re.match(r"\d{4}-\d{2}-\d{2}", date_str):
        date_str = date_str[:10]
    else:
        date_str = ""

    title = meta.get("title", "")

    # Only target 합성_ and reg- prefixed files for rename
    # Case 1: 합성_ prefix
    if old_name.startswith("합성_"):
        slug_part = old_name[3:]  # Remove "합성_"
        changes.append("remove 합성_ prefix")

        # Check if slug is pure numeric or empty
        if re.match(r"^\d+$", slug_part) or not slug_part.strip():
            # Need to derive a meaningful name
            clean_title = title.replace("[합성]", "").strip()
            if clean_title and len(clean_title) > 2:
                slug_part = sanitize_slug(clean_title)
            else:
                derived = derive_title_from_source(meta)
                if derived:
                    slug_part = sanitize_slug(derived)
                else:
                    slug_part = f"note_{slug_part}" if slug_part else "unnamed"
            changes.append(f"derive slug from {'title' if clean_title else 'source'}")

    # Case 2: reg- prefix
    elif old_name.startswith("reg-"):
        slug_part = old_name[4:]  # Remove "reg-"
        changes.append("remove reg- prefix")

    else:
        # No 합성_/reg- prefix — skip rename (title/body fixes handled separately)
        return None, []

    # Already has date prefix in slug? Strip it to avoid duplication
    if re.match(r"\d{4}-\d{2}-\d{2}_", slug_part):
        slug_part = slug_part[11:]

    # Build new filename with date prefix
    if date_str:
        new_name = f"{date_str}_{slug_part}"
    else:
        new_name = slug_part

    if new_name == old_name:
        return None, []

    return new_name, changes


def clean_title(title):
    """Remove [합성] prefix from title."""
    if title.startswith("[합성]"):
        cleaned = title[4:].strip()
        return cleaned if cleaned else ""
    return title


def clean_body(body, meta):
    """Remove LLM disclaimer from body, add llm_synthesized to meta."""
    changed = False

    # Remove LLM disclaimer line
    lines = body.split("\n")
    new_lines = []
    for line in lines:
        if LLM_DISCLAIMER in line:
            changed = True
            continue
        new_lines.append(line)

    if changed:
        meta["llm_synthesized"] = True
        body = "\n".join(new_lines)
        # Remove leading blank lines
        body = body.lstrip("\n")

    # Remove [합성] from headings
    body = re.sub(r"^(#+)\s*\[합성\]\s*", r"\1 ", body, flags=re.MULTILINE)

    return body, changed


def update_wikilinks(vault_root, rename_map):
    """Update [[old_name]] → [[new_name]] across all vault files."""
    if not rename_map:
        return 0

    # Build regex pattern for all old names
    # Escape for regex
    patterns = {}
    for old_stem, new_stem in rename_map.items():
        patterns[old_stem] = new_stem

    updated_files = 0
    for md_file in vault_root.rglob("*.md"):
        try:
            content = md_file.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue

        original = content
        for old_stem, new_stem in patterns.items():
            # [[old_name]] → [[new_name]]
            content = content.replace(f"[[{old_stem}]]", f"[[{new_stem}]]")
            # [[old_name|alias]] → [[new_name|alias]]
            content = re.sub(
                rf"\[\[{re.escape(old_stem)}\|",
                f"[[{new_stem}|",
                content,
            )

        if content != original:
            md_file.write_text(content, encoding="utf-8")
            updated_files += 1

    return updated_files


def run(dry_run=True, cap=500):
    """Main rename logic."""
    print(f"볼트 네이밍 정리 {'[DRY-RUN]' if dry_run else '[APPLY]'}")
    print(f"볼트: {VAULT_ROOT}")
    print(f"최대 처리: {cap}건")
    print("=" * 60)

    # Collect all markdown files
    all_files = list(VAULT_ROOT.rglob("*.md"))
    print(f"전체 마크다운: {len(all_files)}건")

    # Track changes
    rename_map = {}      # old_stem -> new_stem
    title_fixes = 0
    body_fixes = 0
    skipped_collision = 0
    skipped_error = 0

    # Phase 1: Compute renames + title/body fixes
    candidates = []
    for md_file in sorted(all_files):
        try:
            content = md_file.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            skipped_error += 1
            continue

        meta, body = parse_frontmatter(content)
        needs_work = False

        # Check filename
        new_stem, changes = compute_new_filename(md_file, meta)

        # Check title
        title = meta.get("title", "")
        title_needs_fix = title.startswith("[합성]")

        # Check body
        body_has_disclaimer = LLM_DISCLAIMER in body
        body_has_synth_heading = bool(re.search(r"^#+\s*\[합성\]", body, re.MULTILINE))

        if new_stem or title_needs_fix or body_has_disclaimer or body_has_synth_heading:
            candidates.append({
                "path": md_file,
                "content": content,
                "meta": meta,
                "body": body,
                "new_stem": new_stem,
                "filename_changes": changes,
                "title_needs_fix": title_needs_fix,
                "body_has_disclaimer": body_has_disclaimer,
                "body_has_synth_heading": body_has_synth_heading,
            })

    print(f"변경 대상: {len(candidates)}건")
    candidates = candidates[:cap]

    # Phase 2: Check collisions and apply
    # Build set of existing filenames for collision detection
    existing_stems = {f.stem for f in all_files}

    for item in candidates:
        md_file = item["path"]
        meta = item["meta"]
        body = item["body"]
        new_stem = item["new_stem"]
        modified = False

        # --- Filename rename ---
        if new_stem:
            if new_stem in existing_stems and new_stem != md_file.stem:
                # Collision — try adding counter
                for c in range(1, 100):
                    candidate_stem = f"{new_stem}_{c}"
                    if candidate_stem not in existing_stems:
                        new_stem = candidate_stem
                        break
                else:
                    print(f"  [SKIP] 충돌: {md_file.name} → {new_stem}.md (이미 존재)")
                    skipped_collision += 1
                    new_stem = None

        # --- Title fix ---
        if item["title_needs_fix"]:
            old_title = meta["title"]
            cleaned = clean_title(old_title)
            if not cleaned:
                # Empty title — derive from source or slug
                derived = derive_title_from_source(meta)
                if derived:
                    cleaned = derived
                elif new_stem:
                    cleaned = new_stem.replace("_", " ")
                else:
                    cleaned = md_file.stem.replace("합성_", "").replace("_", " ")
            meta["title"] = cleaned
            title_fixes += 1
            modified = True

        # --- Body fix ---
        if item["body_has_disclaimer"] or item["body_has_synth_heading"]:
            body, was_fixed = clean_body(body, meta)
            if was_fixed or item["body_has_synth_heading"]:
                body_fixes += 1
                modified = True

        # --- Apply changes ---
        if new_stem:
            new_path = md_file.parent / f"{new_stem}.md"

            if dry_run:
                print(f"  [RENAME] {md_file.name} → {new_stem}.md")
                for c in item["filename_changes"]:
                    print(f"           {c}")
            else:
                # Rewrite content with updated meta
                new_content = render_frontmatter(meta) + "\n" + body
                new_path.write_text(new_content, encoding="utf-8")
                if new_path != md_file:
                    md_file.unlink()

            rename_map[md_file.stem] = new_stem
            existing_stems.discard(md_file.stem)
            existing_stems.add(new_stem)

        elif modified:
            if dry_run:
                if item["title_needs_fix"]:
                    print(f"  [TITLE] {md_file.name}: {meta['title']}")
                if item["body_has_disclaimer"]:
                    print(f"  [BODY]  {md_file.name}: LLM disclaimer 제거")
            else:
                new_content = render_frontmatter(meta) + "\n" + body
                md_file.write_text(new_content, encoding="utf-8")

    # Phase 3: Wikilink update
    print()
    print(f"파일명 변경: {len(rename_map)}건")
    print(f"제목 수정: {title_fixes}건")
    print(f"본문 수정: {body_fixes}건")
    print(f"충돌 스킵: {skipped_collision}건")
    print(f"에러 스킵: {skipped_error}건")

    if rename_map:
        if dry_run:
            print(f"\n위키링크 업데이트 대상: {len(rename_map)}건 (dry-run 시 스킵)")
        else:
            print(f"\n위키링크 업데이트 중...")
            wikilink_count = update_wikilinks(VAULT_ROOT, rename_map)
            print(f"위키링크 업데이트: {wikilink_count}개 파일")

    # Save mapping
    mapping_data = {
        "timestamp": datetime.now().isoformat(),
        "dry_run": dry_run,
        "renames": rename_map,
        "stats": {
            "renamed": len(rename_map),
            "title_fixes": title_fixes,
            "body_fixes": body_fixes,
            "skipped_collision": skipped_collision,
            "skipped_error": skipped_error,
        },
    }
    MAPPING_FILE.parent.mkdir(parents=True, exist_ok=True)
    MAPPING_FILE.write_text(json.dumps(mapping_data, ensure_ascii=False, indent=2))
    print(f"\n매핑 저장: {MAPPING_FILE}")

    return mapping_data


def main():
    parser = argparse.ArgumentParser(description="볼트 네이밍 일괄 정리")
    parser.add_argument("--dry-run", action="store_true", default=True,
                        help="변경 사항만 출력 (기본값)")
    parser.add_argument("--apply", action="store_true",
                        help="실적용")
    parser.add_argument("--cap", type=int, default=500,
                        help="최대 처리 건수 (기본 500)")
    args = parser.parse_args()

    dry_run = not args.apply
    run(dry_run=dry_run, cap=args.cap)


if __name__ == "__main__":
    main()
