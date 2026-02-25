#!/usr/bin/env python3
"""
note_cleanup.py - 노트 정리 스크립트 (2단계)

기능:
1. 중복 노트 찾기 및 병합
2. 빈/짧은 노트 아카이브
3. 파일명 정규화

Usage:
  python3 note_cleanup.py --dry-run    # 미리보기
  python3 note_cleanup.py              # 실제 실행
"""

import os
import sys
import hashlib
import argparse
from pathlib import Path
from collections import defaultdict
from datetime import datetime

from shared.vault_paths import VAULT

def log(msg, level="INFO"):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] [{level}] {msg}")


def find_duplicate_notes(vault_path):
    """내용 기반 중복 노트 찾기"""
    content_hashes = defaultdict(list)
    
    for md_file in vault_path.rglob("*.md"):
        try:
            content = md_file.read_text(encoding="utf-8")
            if content.startswith("---"):
                parts = content.split("---", 2)
                body = parts[2] if len(parts) >= 3 else content
            else:
                body = content
            
            normalized = " ".join(body.split()).lower()
            if len(normalized) > 50:
                h = hashlib.md5(normalized.encode()).hexdigest()[:16]
                content_hashes[h].append(md_file)
        except:
            pass
    
    return {h: files for h, files in content_hashes.items() if len(files) > 1}


def merge_duplicate_notes(duplicate_groups, dry_run=True):
    """중복 노트 병합"""
    merged_count = 0
    archived_count = 0
    
    for content_hash, files in duplicate_groups.items():
        if len(files) < 2:
            continue
        
        files_sorted = sorted(files, key=lambda f: f.stat().st_mtime, reverse=True)
        primary = files_sorted[0]
        duplicates = files_sorted[1:]
        
        log(f"  병합 그룹: {primary.name}")
        
        for dup in duplicates:
            log(f"    병합 대상: {dup.name}")
            
            if not dry_run:
                archive_dir = VAULT / "300 운영" / "310 아카이브" / "duplicates"
                archive_dir.mkdir(parents=True, exist_ok=True)
                
                try:
                    primary_content = primary.read_text(encoding="utf-8")
                    
                    if "## 병합된 노트" not in primary_content:
                        primary_content += "\n\n## 병합된 노트\n"
                    
                    primary_content += f"\n- 중복 병합: [[{dup.stem}]] → 아카이브됨"
                    primary.write_text(primary_content, encoding="utf-8")
                    
                    archive_path = archive_dir / f"{dup.stem}_dup_{content_hash[:6]}.md"
                    dup.rename(archive_path)
                    archived_count += 1
                except Exception as e:
                    log(f"    오류: {e}", "ERROR")
        
        merged_count += 1
    
    return merged_count, archived_count


def find_empty_notes(vault_path, min_length=50):
    """짧은/빈 노트 찾기"""
    empty_notes = []
    
    for md_file in vault_path.rglob("*.md"):
        try:
            content = md_file.read_text(encoding="utf-8")
            if content.startswith("---"):
                parts = content.split("---", 2)
                body = parts[2] if len(parts) >= 3 else ""
            else:
                body = content
            
            text_only = "".join(c for c in body if c.isalnum() or c.isspace())
            if len(text_only.strip()) < min_length:
                empty_notes.append((md_file, len(text_only.strip())))
        except:
            pass
    
    return sorted(empty_notes, key=lambda x: x[1])


def archive_empty_notes(empty_notes, dry_run=True, max_archive=30):
    """빈 노트 아카이브"""
    archived = 0
    
    archive_dir = VAULT / "300 운영" / "310 아카이브" / "empty"
    if not dry_run:
        archive_dir.mkdir(parents=True, exist_ok=True)
    
    for note_path, length in empty_notes[:max_archive]:
        log(f"  아카이브 대상: {note_path.name} (길이: {length})")
        
        if not dry_run:
            try:
                archive_path = archive_dir / note_path.name
                note_path.rename(archive_path)
                archived += 1
            except Exception as e:
                log(f"    오류: {e}", "ERROR")
    
    return archived


def main():
    parser = argparse.ArgumentParser(description="노트 정리 스크립트")
    parser.add_argument("--dry-run", action="store_true", help="미리보기 모드")
    parser.add_argument("--min-length", type=int, default=50, help="빈 노트 기준 (기본 50자)")
    args = parser.parse_args()
    
    log("=" * 60)
    log("노트 정리 시작")
    log("=" * 60)
    log(f"모드: {'미리보기' if args.dry_run else '실행'}")
    log(f"Vault: {VAULT}")
    
    stats = {
        "duplicates_found": 0,
        "duplicates_merged": 0,
        "duplicates_archived": 0,
        "empty_found": 0,
        "empty_archived": 0
    }
    
    # 1. 중복 노트 처리
    log("\n[1/2] 중복 노트 검사...")
    duplicates = find_duplicate_notes(VAULT)
    stats["duplicates_found"] = sum(len(f) for f in duplicates.values())
    
    if duplicates:
        log(f"  발견: {len(duplicates)}개 그룹, {stats['duplicates_found']}개 파일")
        for h, files in list(duplicates.items())[:5]:
            log(f"    그룹: {files[0].name} 외 {len(files)-1}개")
        
        merged, archived = merge_duplicate_notes(duplicates, args.dry_run)
        stats["duplicates_merged"] = merged
        stats["duplicates_archived"] = archived
    else:
        log("  중복 노트 없음")
    
    # 2. 빈 노트 처리
    log(f"\n[2/2] 빈 노트 검사 (기준: {args.min_length}자 미만)...")
    empty_notes = find_empty_notes(VAULT, args.min_length)
    stats["empty_found"] = len(empty_notes)
    
    if empty_notes:
        log(f"  발견: {len(empty_notes)}개")
        for path, length in empty_notes[:10]:
            log(f"    - {path.name} ({length}자)")
        if len(empty_notes) > 10:
            log(f"    ... 외 {len(empty_notes)-10}개")
        
        archived = archive_empty_notes(empty_notes, args.dry_run)
        stats["empty_archived"] = archived
    else:
        log("  빈 노트 없음")
    
    # 결과 출력
    log("\n" + "=" * 60)
    log("정리 완료")
    log("=" * 60)
    log(f"중복 노트:")
    log(f"  - 발견: {stats['duplicates_found']}개 파일")
    log(f"  - 병합: {stats['duplicates_merged']}개 그룹")
    log(f"  - 아카이브: {stats['duplicates_archived']}개 파일")
    log(f"빈 노트:")
    log(f"  - 발견: {stats['empty_found']}개")
    log(f"  - 아카이브: {stats['empty_archived']}개")
    
    if args.dry_run:
        log("\n[미리보기 모드] 실제 변경은 없었습니다.")
        log("실행하려면: python3 note_cleanup.py")


if __name__ == "__main__":
    main()
