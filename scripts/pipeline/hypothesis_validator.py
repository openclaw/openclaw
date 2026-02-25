#!/usr/bin/env python3
"""
hypothesis_validator.py - 가설 검증 자동화

기능:
1. 생성된 가설과 주가 데이터 비교
2. 뉴스/공시 데이터와 가설 일치도 확인
3. 검증 결과 리포트 생성

Usage:
  python3 hypothesis_validator.py --dry-run
  python3 hypothesis_validator.py
"""

import os
import re
import json
import argparse
from pathlib import Path
from datetime import datetime, timedelta
from collections import defaultdict

from shared.vault_paths import VAULT

WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))

def log(msg, level="INFO"):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] [{level}] {msg}")


def load_hypotheses():
    """생성된 가설 파일 로드"""
    hypothesis_dir = VAULT / "100 지식" / "110 수신함" / "hypotheses"
    hypotheses = []
    
    if not hypothesis_dir.exists():
        return hypotheses
    
    for hyp_file in hypothesis_dir.glob("hypotheses-*.md"):
        try:
            content = hyp_file.read_text(encoding="utf-8")
            
            # 가설 추출 (간단한 파싱)
            current_category = None
            for line in content.split("\n"):
                if line.startswith("### "):
                    current_category = line.replace("### ", "").strip()
                elif re.match(r'^\d+\.\s+\*\*', line) and "H" in line:
                    # 가설 라인 (1. **H1: ...** 형태)
                    match = re.search(r'\*\*(H\d+:[^*]+)\*\*', line)
                    if match:
                        hypotheses.append({
                            "file": hyp_file.name,
                            "category": current_category,
                            "hypothesis": match.group(1).strip(),
                            "status": "pending"
                        })
        except Exception as e:
            log(f"파일 로드 오류: {hyp_file.name} - {e}", "ERROR")
    
    return hypotheses


def extract_keywords_from_hypothesis(hypothesis_text):
    """가설에서 키워드 추출"""
    keywords = []
    
    # 기업/종목 키워드
    stock_patterns = [
        r'([가-힣A-Za-z]+)(?:증권|화학|전자|반도체|바이오)',
        r'삼성\w+',
        r'SK\w+',
        r'현대\w+',
        r'LG\w+',
    ]
    
    for pattern in stock_patterns:
        matches = re.findall(pattern, hypothesis_text)
        keywords.extend(matches)
    
    # 섹터 키워드
    sector_keywords = [
        "반도체", "금융", "바이오", "자동차", "에너지", "디스플레이",
        "semiconductor", "finance", "biotech", "automotive", "energy"
    ]
    
    for kw in sector_keywords:
        if kw.lower() in hypothesis_text.lower():
            keywords.append(kw)
    
    return list(set(keywords))


def search_evidence_in_vault(keywords, days_back=30):
    """Vault에서 근거 검색"""
    evidence = []
    cutoff_date = datetime.now() - timedelta(days=days_back)
    
    for md_file in VAULT.rglob("*.md"):
        try:
            # 파일 수정일 체크
            mtime = datetime.fromtimestamp(md_file.stat().st_mtime)
            if mtime < cutoff_date:
                continue
            
            content = md_file.read_text(encoding="utf-8")
            
            # 키워드 매칭
            matched_keywords = []
            for kw in keywords:
                if kw.lower() in content.lower():
                    matched_keywords.append(kw)
            
            if matched_keywords:
                evidence.append({
                    "file": md_file.name,
                    "path": str(md_file.relative_to(VAULT)),
                    "keywords": matched_keywords,
                    "date": mtime.strftime("%Y-%m-%d")
                })
        except:
            pass
    
    return evidence[:10]  # 상위 10개만


def validate_hypothesis(hypothesis, dry_run=True):
    """단일 가설 검증"""
    log(f"  검증: {hypothesis['hypothesis'][:60]}...")
    
    # 키워드 추출
    keywords = extract_keywords_from_hypothesis(hypothesis['hypothesis'])
    log(f"    키워드: {', '.join(keywords[:5])}")
    
    if not keywords:
        return {"status": "no_keywords", "evidence": []}
    
    # 근거 검색
    evidence = search_evidence_in_vault(keywords)
    
    if evidence:
        log(f"    근거 발견: {len(evidence)}개 파일")
        for ev in evidence[:3]:
            log(f"      - {ev['file']} ({', '.join(ev['keywords'])})")
        return {"status": "supported", "evidence": evidence}
    else:
        log(f"    근거 없음")
        return {"status": "pending", "evidence": []}


def generate_validation_report(results, dry_run=True):
    """검증 리포트 생성"""
    timestamp = datetime.now().strftime("%Y-%m-%d")
    report_dir = VAULT / "300 운영" / "340 리포트"
    report_dir.mkdir(parents=True, exist_ok=True)
    
    report_file = report_dir / f"hypothesis-validation-{timestamp}.md"
    
    # 통계
    supported = sum(1 for r in results if r['validation']['status'] == 'supported')
    pending = sum(1 for r in results if r['validation']['status'] == 'pending')
    no_keywords = sum(1 for r in results if r['validation']['status'] == 'no_keywords')
    
    lines = [
        "---",
        f"date: {timestamp}",
        "tags: [hypothesis, validation, report]",
        "category: validation",
        "---",
        "",
        f"# 가설 검증 리포트 ({timestamp})",
        "",
        "## 개요",
        f"- 총 가설: {len(results)}개",
        f"- 근거 발견: {supported}개",
        f"- 검증 대기: {pending}개",
        f"- 키워드 없음: {no_keywords}개",
        "",
        "## 검증 결과",
        "",
    ]
    
    # 지지되는 가설
    if supported > 0:
        lines.append("### ✅ 근거 발견된 가설")
        lines.append("")
        for r in results:
            if r['validation']['status'] == 'supported':
                lines.append(f"**{r['category']}**")
                lines.append(f"- {r['hypothesis']}")
                lines.append(f"  - 키워드: {', '.join(r['keywords'][:5])}")
                lines.append(f"  - 근거: {len(r['validation']['evidence'])}개 파일")
                for ev in r['validation']['evidence'][:3]:
                    lines.append(f"    - [[{ev['path']}]]")
                lines.append("")
    
    # 대기 중인 가설
    if pending > 0:
        lines.append("### ⏳ 검증 대기 중인 가설")
        lines.append("")
        for r in results:
            if r['validation']['status'] == 'pending':
                lines.append(f"- **{r['category']}**: {r['hypothesis']}")
        lines.append("")
    
    # 다음 단계
    lines.extend([
        "## 다음 단계",
        "- [ ] 주가 데이터와 상관관계 분석",
        "- [ ] 뉴스 감성 분석 연동",
        "- [ ] 가설 업데이트 (주간)",
        "",
        "## 관련 파일",
        "- [[hypotheses-2026-02-24]]",
    ])
    
    if not dry_run:
        report_file.write_text("\n".join(lines), encoding="utf-8")
        log(f"리포트 저장: {report_file}")
    
    return report_file


def main():
    parser = argparse.ArgumentParser(description="가설 검증 자동화")
    parser.add_argument("--dry-run", action="store_true", help="미리보기")
    args = parser.parse_args()
    
    log("=" * 60)
    log("가설 검증 자동화 시작")
    log("=" * 60)
    log(f"모드: {'미리보기' if args.dry_run else '실행'}")
    
    # 가설 로드
    log("\n[1/3] 가설 로드...")
    hypotheses = load_hypotheses()
    log(f"  로드된 가설: {len(hypotheses)}개")
    
    if not hypotheses:
        log("  검증할 가설이 없습니다.")
        return
    
    # 가설 검증
    log("\n[2/3] 가설 검증...")
    results = []
    for hyp in hypotheses[:20]:  # 상위 20개만
        validation = validate_hypothesis(hyp, args.dry_run)
        results.append({
            **hyp,
            "keywords": extract_keywords_from_hypothesis(hyp['hypothesis']),
            "validation": validation
        })
    
    # 리포트 생성
    log("\n[3/3] 리포트 생성...")
    report_path = generate_validation_report(results, args.dry_run)
    
    # 결과 요약
    log("\n" + "=" * 60)
    log("검증 완료")
    log("=" * 60)
    supported = sum(1 for r in results if r['validation']['status'] == 'supported')
    log(f"검증된 가설: {len(results)}개")
    log(f"  - 근거 발견: {supported}개")
    log(f"  - 검증 대기: {len(results) - supported}개")
    
    if not args.dry_run:
        log(f"\n리포트: {report_path}")
    else:
        log("\n[미리보기 모드] 실제 변경은 없었습니다.")
        log("실행하려면: python3 hypothesis_validator.py")


if __name__ == "__main__":
    main()
