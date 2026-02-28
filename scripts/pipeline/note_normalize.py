#!/usr/bin/env python3
"""
note_normalize.py - 파일명 정규화 (3단계)

기능:
1. 파일명 정규화 (공백 → _, 특수문자 제거)
2. 날짜 형식 통일 (YYYY-MM-DD)
3. 카테고리 접두사 추가

Usage:
  python3 note_normalize.py --dry-run
  python3 note_normalize.py
"""

import os
import re
import argparse
from pathlib import Path
from datetime import datetime

from shared.vault_paths import VAULT

def log(msg, level="INFO"):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] [{level}] {msg}")


def normalize_filename(filename):
    """파일명 정규화"""
    # 확장자 분리
    stem = filename.stem
    suffix = filename.suffix
    
    # 1. 공백 → 언더스코어
    normalized = stem.replace(" ", "_")
    
    # 2. 특수문자 제거 (한글, 영문, 숫자, _ , - 만 허용)
    normalized = re.sub(r'[^\w\-\uAC00-\uD7AF]', '', normalized)
    
    # 3. 연속된 언더스코어 제거
    normalized = re.sub(r'_+', '_', normalized)
    
    # 4. 앞뒤 언더스코어 제거
    normalized = normalized.strip('_')
    
    return normalized + suffix


def extract_date_from_filename(filename):
    """파일명에서 날짜 추출"""
    patterns = [
        r'(\d{4})-(\d{2})-(\d{2})',  # YYYY-MM-DD
        r'(\d{4})(\d{2})(\d{2})',      # YYYYMMDD
    ]
    
    for pattern in patterns:
        match = re.search(pattern, filename)
        if match:
            return f"{match.group(1)}-{match.group(2)}-{match.group(3)}"
    return None


def get_category_prefix(filepath):
    """파일 경로에서 카테고리 접두사 추출"""
    parts = filepath.parts
    
    # 카테고리 매핑
    category_map = {
        "기업": "기업",
        "시장": "시장",
        "산업분석": "산업",
        "프로그래밍": "프로그래밍",
        "인사이트": "인사이트",
        "110 수신함": "수신함",
        "100 캡처": "캡처",
        "200 정리": "정리",

        "300 연결": "연결",
        "400 판단": "판단",
        "120 노트": "노트",
        "150 구조노트": "구조",
    }
    
    for part in parts:
        for key, value in category_map.items():
            if key in part:
                return value
    
    return None


def analyze_filenames(vault_path):
    """정규화가 필요한 파일 분석"""
    to_normalize = []
    
    for md_file in vault_path.rglob("*.md"):
        # 숨김 파일 제외
        if md_file.name.startswith("."):
            continue
        
        current_name = md_file.name
        normalized_name = normalize_filename(md_file)
        
        # 변경 필요 여부 확인
        if current_name != normalized_name:
            to_normalize.append({
                "path": md_file,
                "current": current_name,
                "normalized": normalized_name,
                "date": extract_date_from_filename(current_name),
                "category": get_category_prefix(md_file)
            })
    
    return to_normalize


def rename_files(files_to_rename, dry_run=True):
    """파일명 변경 실행"""
    renamed = 0
    errors = 0
    
    for item in files_to_rename:
        old_path = item["path"]
        new_name = item["normalized"]
        new_path = old_path.parent / new_name
        
        # 중복 체크
        if new_path.exists() and new_path != old_path:
            log(f"  충돌: {new_name} (이미 존재)", "WARN")
            new_name = f"{item['normalized'].replace('.md', '')}_1.md"
            new_path = old_path.parent / new_name
        
        log(f"  {old_path.name}")
        log(f"    → {new_name}")
        
        if not dry_run:
            try:
                old_path.rename(new_path)
                renamed += 1
            except Exception as e:
                log(f"    오류: {e}", "ERROR")
                errors += 1
    
    return renamed, errors


def main():
    parser = argparse.ArgumentParser(description="파일명 정규화")
    parser.add_argument("--dry-run", action="store_true", help="미리보기")
    args = parser.parse_args()
    
    log("=" * 60)
    log("파일명 정규화 시작 (3단계)")
    log("=" * 60)
    log(f"모드: {'미리보기' if args.dry_run else '실행'}")
    
    # 분석
    log("\n[1/2] 파일명 분석...")
    to_rename = analyze_filenames(VAULT)
    log(f"  정규화 필요: {len(to_rename)}개 파일")
    
    if not to_rename:
        log("  모든 파일명이 정규화되어 있습니다.")
        return
    
    # 샘플 출력
    for item in to_rename[:10]:
        log(f"  - {item['current'][:50]}...")
        log(f"    → {item['normalized'][:50]}...")
    if len(to_rename) > 10:
        log(f"  ... 외 {len(to_rename)-10}개")
    
    # 실행
    log("\n[2/2] 파일명 변경...")
    renamed, errors = rename_files(to_rename, args.dry_run)
    
    # 결과
    log("\n" + "=" * 60)
    log("정규화 완료")
    log("=" * 60)
    log(f"분석: {len(to_rename)}개 파일")
    log(f"변경: {renamed}개 파일")
    if errors:
        log(f"오류: {errors}개")
    
    if args.dry_run:
        log("\n[미리보기 모드] 실제 변경은 없었습니다.")
        log("실행하려면: python3 note_normalize.py")


if __name__ == "__main__":
    main()
