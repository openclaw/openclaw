#!/usr/bin/env python3
"""
note_tag_cleanup.py - 태그 정리 (4단계)

기능:
1. 중복 태그 병합 (AI, ai, Ai → ai)
2. 오타/유사 태그 통합
3. 태그 사용 현황 리포트

Usage:
  python3 note_tag_cleanup.py --dry-run
  python3 note_tag_cleanup.py
"""

import os
import re
import json
import argparse
from pathlib import Path
from collections import defaultdict, Counter
from datetime import datetime

from shared.vault_paths import VAULT

def log(msg, level="INFO"):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] [{level}] {msg}")


def extract_frontmatter(filepath):
    """파일에서 frontmatter 추출"""
    try:
        content = filepath.read_text(encoding="utf-8")
        if not content.startswith("---"):
            return None, content
        
        parts = content.split("---", 2)
        if len(parts) < 3:
            return None, content
        
        fm_text = parts[1]
        body = parts[2]
        
        # 간단한 YAML 파싱
        fm = {}
        for line in fm_text.strip().split("\n"):
            if ":" in line:
                key, _, value = line.partition(":")
                key = key.strip()
                value = value.strip()
                
                # 태그 배열 처리
                if key == "tags":
                    if value.startswith("["):
                        try:
                            fm[key] = json.loads(value)
                        except:
                            # 수동 파싱
                            value = value.strip("[]")
                            fm[key] = [t.strip().strip('"').strip("'") for t in value.split(",") if t.strip()]
                    else:
                        fm[key] = [value.strip('"').strip("'")]
                else:
                    fm[key] = value.strip('"').strip("'")
        
        return fm, body
    except:
        return None, ""


def save_frontmatter(filepath, fm, body):
    """frontmatter 저장"""
    lines = ["---"]
    
    for key, value in fm.items():
        if key == "tags" and isinstance(value, list):
            # 태그 정렬 및 중복 제거
            unique_tags = sorted(set(value))
            lines.append(f'{key}: {json.dumps(unique_tags, ensure_ascii=False)}')
        elif isinstance(value, list):
            lines.append(f'{key}: {json.dumps(value, ensure_ascii=False)}')
        elif isinstance(value, bool):
            lines.append(f'{key}: {"true" if value else "false"}')
        else:
            lines.append(f'{key}: "{value}"')
    
    lines.append("---")
    
    content = "\n".join(lines) + "\n" + body
    filepath.write_text(content, encoding="utf-8")


def normalize_tag(tag):
    """태그 정규화"""
    tag = tag.lower().strip()
    
    # 매핑 규칙
    mappings = {
        # AI 관련
        "ai": "ai",
        "인공지능": "ai",
        "machine-learning": "ml",
        "ml": "ml",
        "llm": "llm",
        "gpt": "gpt",
        
        # 금융 관련
        "finance": "finance",
        "금융": "finance",
        "증권": "securities",
        "주식": "stock",
        "stock": "stock",
        
        # 반도체
        "반도체": "semiconductor",
        "semiconductor": "semiconductor",
        "chip": "semiconductor",
        "memory": "memory",
        "hbm": "hbm",
        
        # 기타
        "knowledge": "knowledge",
        "지식": "knowledge",
        "agent": "agent",
        "에이전트": "agent",
        "macro": "macro",
        "매크로": "macro",
    }
    
    return mappings.get(tag, tag)


def analyze_tags(vault_path):
    """모든 태그 분석"""
    tag_files = defaultdict(list)
    tag_counts = Counter()
    
    for md_file in vault_path.rglob("*.md"):
        fm, _ = extract_frontmatter(md_file)
        if fm and "tags" in fm:
            tags = fm["tags"]
            if isinstance(tags, list):
                for tag in tags:
                    tag_files[tag].append(md_file)
                    tag_counts[tag] += 1
            elif isinstance(tags, str):
                tag_files[tags].append(md_file)
                tag_counts[tags] += 1
    
    return tag_files, tag_counts


def find_tag_issues(tag_files, tag_counts):
    """태그 문제점 찾기"""
    issues = {
        "duplicates": [],  # 대소문자 중복
        "similar": [],     # 유사 태그
        "empty": [],       # 빈 태그
    }
    
    tags_lower = {}
    for tag in tag_counts:
        # 빈 태그
        if not tag or not tag.strip():
            issues["empty"].append(tag)
            continue
        
        # 대소문자 중복
        lower = tag.lower()
        if lower in tags_lower:
            issues["duplicates"].append((tag, tags_lower[lower]))
        else:
            tags_lower[lower] = tag
    
    return issues


def cleanup_tags(vault_path, dry_run=True):
    """태그 정리 실행"""
    log("[1/3] 태그 분석...")
    tag_files, tag_counts = analyze_tags(vault_path)
    log(f"  고유 태그: {len(tag_counts)}개")
    log(f"  총 사용: {sum(tag_counts.values())}회")
    
    # 상위 태그 출력
    log("\n  상위 10개 태그:")
    for tag, count in tag_counts.most_common(10):
        log(f"    - {tag}: {count}회")
    
    # 문제점 찾기
    log("\n[2/3] 태그 문제점 검사...")
    issues = find_tag_issues(tag_files, tag_counts)
    
    if issues["duplicates"]:
        log(f"  대소문자 중복: {len(issues['duplicates'])}쌍")
        for t1, t2 in issues["duplicates"][:5]:
            log(f"    - {t1} ↔ {t2}")
    
    if issues["empty"]:
        log(f"  빈 태그: {len(issues['empty'])}개")
    
    if not issues["duplicates"] and not issues["empty"]:
        log("  태그 정리 필요 없음")
        return {"analyzed": len(tag_counts), "cleaned": 0}
    
    # 정리 실행
    log("\n[3/3] 태그 정리...")
    cleaned = 0
    
    # 중복 태그 병합
    normalized_map = {}
    for tag in list(tag_counts.keys()):
        normalized = normalize_tag(tag)
        if normalized != tag:
            normalized_map[tag] = normalized
    
    log(f"  정규화 필요: {len(normalized_map)}개")
    
    if not dry_run:
        for old_tag, new_tag in list(normalized_map.items())[:20]:  # 상위 20개만
            files = tag_files.get(old_tag, [])
            for filepath in files:
                try:
                    fm, body = extract_frontmatter(filepath)
                    if fm and "tags" in fm:
                        tags = fm["tags"]
                        if isinstance(tags, list):
                            new_tags = [normalize_tag(t) for t in tags]
                            fm["tags"] = list(set(new_tags))  # 중복 제거
                            save_frontmatter(filepath, fm, body)
                            cleaned += 1
                except Exception as e:
                    log(f"    오류: {filepath.name} - {e}", "ERROR")
    
    return {"analyzed": len(tag_counts), "cleaned": cleaned, "normalized": len(normalized_map)}


def main():
    parser = argparse.ArgumentParser(description="태그 정리")
    parser.add_argument("--dry-run", action="store_true", help="미리보기")
    args = parser.parse_args()
    
    log("=" * 60)
    log("태그 정리 시작 (4단계)")
    log("=" * 60)
    log(f"모드: {'미리보기' if args.dry_run else '실행'}")
    
    stats = cleanup_tags(VAULT, args.dry_run)
    
    log("\n" + "=" * 60)
    log("태그 정리 완료")
    log("=" * 60)
    log(f"분석: {stats['analyzed']}개 태그")
    log(f"정리: {stats.get('cleaned', 0)}개 파일")
    log(f"정규화: {stats.get('normalized', 0)}개 태그")
    
    if args.dry_run:
        log("\n[미리보기 모드] 실제 변경은 없었습니다.")
        log("실행하려면: python3 note_tag_cleanup.py")


if __name__ == "__main__":
    main()
