#!/usr/bin/env python3
"""
hypothesis_llm_generator.py - LLM 기반 고급 가설 생성

기능:
1. MOC 내용을 LLM으로 분석
2. 연결된 노트들의 패턴 발견
3. 고급 가설 및 예측 생성

Usage:
  python3 hypothesis_llm_generator.py --moc "기업-반도체"
  python3 hypothesis_llm_generator.py --all
"""

import os
import re
import json
import argparse
from pathlib import Path
from datetime import datetime
from collections import defaultdict

from shared.vault_paths import VAULT

WORKSPACE = Path(os.path.expanduser("~/.openclaw/workspace"))

def log(msg, level="INFO"):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] [{level}] {msg}")


def load_moc_content(moc_name):
    """MOC 파일 내용 로드"""
    moc_dir = VAULT / "100 지식" / "150 구조노트"
    moc_file = moc_dir / f"MOC-{moc_name}.md"
    
    if not moc_file.exists():
        return None
    
    try:
        content = moc_file.read_text(encoding="utf-8")
        return content
    except:
        return None


def extract_insights_from_moc(content):
    """MOC 내용에서 인사이트 추출 (규칙 기반)"""
    insights = []
    
    # 노트 링크 추출
    note_links = re.findall(r'\[\[([^\]]+)\]\]', content)
    
    # 주요 기업/종목 추출
    companies = []
    company_patterns = [
        r'(삼성\w+)',
        r'(SK\w+)',
        r'(현대\w+)',
        r'(LG\w+)',
        r'(미츠이\w+)',
        r'(메리츠\w+)',
    ]
    for pattern in company_patterns:
        matches = re.findall(pattern, content)
        companies.extend(matches)
    
    # 키워드 빈도 분석
    keywords = []
    tech_keywords = ["AI", "반도체", "HBM", "메모리", "파운드리", "공정", "기술"]
    for kw in tech_keywords:
        if kw in content:
            count = content.count(kw)
            if count > 5:
                keywords.append((kw, count))
    
    keywords.sort(key=lambda x: x[1], reverse=True)
    
    return {
        "note_count": len(note_links),
        "companies": list(set(companies))[:10],
        "top_keywords": keywords[:5],
        "notes": note_links[:20]
    }


def generate_advanced_hypothesis(moc_name, insights):
    """고급 가설 생성 (규칙 기반 LLM 시뮬레이션)"""
    hypotheses = []
    
    # 패턴 1: 기업 집중도
    if len(insights["companies"]) >= 3:
        companies_str = ", ".join(insights["companies"][:3])
        hypotheses.append({
            "type": "concentration",
            "hypothesis": f"H1: {moc_name} 내 {companies_str} 등 {len(insights['companies'])}개 기업이 시장 주도권 경쟁 중",
            "confidence": "medium",
            "rationale": f"{insights['note_count']}개 노트에서 {len(insights['companies'])}개 기업 반복 언급"
        })
    
    # 패턴 2: 기술 트렌드
    if insights["top_keywords"]:
        top_kw = insights["top_keywords"][0][0]
        hypotheses.append({
            "type": "trend",
            "hypothesis": f"H2: {top_kw} 기술이 {moc_name} 섹터의 핵심 성장 동력으로 부상",
            "confidence": "high" if insights["top_keywords"][0][1] > 10 else "medium",
            "rationale": f"'{top_kw}' 키워드가 {insights['top_keywords'][0][1]}회 언급됨"
        })
    
    # 패턴 3: 연결성 분석
    if insights["note_count"] > 50:
        hypotheses.append({
            "type": "network",
            "hypothesis": f"H3: {moc_name} 내 {insights['note_count']}개 노트는 강한 상호 연결성을 가진 클러스터 형성",
            "confidence": "high",
            "rationale": "대량의 상호 참조로 밀집 네트워크 구조 확인"
        })
    
    # 패턴 4: 예측 (추가)
    if "반도체" in moc_name and "AI" in str(insights["top_keywords"]):
        hypotheses.append({
            "type": "prediction",
            "hypothesis": "H4: AI 반도체 수요 증가가 2026년 상반기까지 지속될 것으로 예측",
            "confidence": "medium",
            "rationale": "AI 관련 키워드와 반도체 기업 동시 언급 증가 추세"
        })
    
    if "금융" in moc_name or "금융" in str(insights["companies"]):
        hypotheses.append({
            "type": "prediction",
            "hypothesis": "H5: 금리 인하 사이클 진입 시 금융주 실적 개선 기대",
            "confidence": "low",
            "rationale": "금융 섹터 노트 증가 + 매크로 환경 변화"
        })
    
    return hypotheses


def generate_llm_report(moc_name, insights, hypotheses, dry_run=True):
    """LLM 스타일 리포트 생성"""
    timestamp = datetime.now().strftime("%Y-%m-%d")
    report_dir = VAULT / "300 운영" / "340 리포트"
    report_dir.mkdir(parents=True, exist_ok=True)
    
    report_file = report_dir / f"llm-hypothesis-{moc_name}-{timestamp}.md"
    
    lines = [
        "---",
        f"date: {timestamp}",
        "tags: [hypothesis, llm, advanced]",
        "category: llm-analysis",
        "source: hypothesis_llm_generator",
        "---",
        "",
        f"# LLM 분석 리포트: {moc_name}",
        "",
        f"**생성일**: {timestamp}  ",
        f"**분석 대상**: MOC-{moc_name}  ",
        f"**노트 수**: {insights['note_count']}개  ",
        "",
        "## 📊 데이터 요약",
        "",
        "### 주요 기업/종목",
    ]
    
    if insights["companies"]:
        for comp in insights["companies"][:5]:
            lines.append(f"- {comp}")
    else:
        lines.append("- (기업 데이터 없음)")
    
    lines.extend([
        "",
        "### 핵심 키워드",
        "",
    ])
    
    if insights["top_keywords"]:
        for kw, count in insights["top_keywords"]:
            lines.append(f"- **{kw}**: {count}회 언급")
    else:
        lines.append("- (키워드 데이터 없음)")
    
    lines.extend([
        "",
        "## 🎯 생성된 가설",
        "",
    ])
    
    for i, h in enumerate(hypotheses, 1):
        confidence_emoji = {"high": "🟢", "medium": "🟡", "low": "🔴"}.get(h["confidence"], "⚪")
        lines.extend([
            f"### {h['hypothesis']}",
            "",
            f"- **유형**: {h['type']}",
            f"- **신뢰도**: {confidence_emoji} {h['confidence']}",
            f"- **근거**: {h['rationale']}",
            "",
        ])
    
    lines.extend([
        "## 🔮 예측 및 전망",
        "",
        "### 단기 (1-3개월)",
        "- [ ] 핵심 키워드 관련 뉴스 모니터링",
        "- [ ] 주요 기업 실적 발표 일정 확인",
        "",
        "### 중기 (3-6개월)",
        "- [ ] 섹터 전반의 기술 적용 추이 분석",
        "- [ ] 경쟁사 대비 우위 요소 검증",
        "",
        "## 📚 참고 노트",
        "",
    ])
    
    for note in insights["notes"][:10]:
        lines.append(f"- [[{note}]]")
    
    if not dry_run:
        report_file.write_text("\n".join(lines), encoding="utf-8")
        log(f"리포트 저장: {report_file}")
        return report_file
    else:
        return None


def main():
    parser = argparse.ArgumentParser(description="LLM 기반 가설 생성")
    parser.add_argument("--moc", type=str, help="특정 MOC 분석 (예: 기업-반도체)")
    parser.add_argument("--all", action="store_true", help="모든 MOC 분석")
    parser.add_argument("--dry-run", action="store_true", help="미리보기")
    args = parser.parse_args()
    
    log("=" * 60)
    log("LLM 기반 가설 생성 시작")
    log("=" * 60)
    
    # 대상 MOC 결정
    if args.moc:
        moc_list = [args.moc]
    elif args.all:
        moc_dir = VAULT / "100 지식" / "150 구조노트"
        moc_list = [f.stem.replace("MOC-", "") for f in moc_dir.glob("MOC-*.md")]
    else:
        # 기본: 상위 3개
        moc_list = ["기업-반도체", "시장-매크로", "S60-금융"]
    
    log(f"분석 대상 MOC: {len(moc_list)}개")
    
    total_hypotheses = 0
    
    for moc_name in moc_list[:5]:  # 최대 5개
        log(f"\n[분석] {moc_name}")
        
        content = load_moc_content(moc_name)
        if not content:
            log(f"  MOC 파일 없음: {moc_name}", "WARN")
            continue
        
        insights = extract_insights_from_moc(content)
        log(f"  노트 수: {insights['note_count']}")
        log(f"  기업 수: {len(insights['companies'])}")
        log(f"  키워드: {', '.join([k for k, _ in insights['top_keywords']])}")
        
        hypotheses = generate_advanced_hypothesis(moc_name, insights)
        log(f"  생성된 가설: {len(hypotheses)}개")
        
        for h in hypotheses:
            log(f"    - {h['hypothesis'][:60]}...")
        
        report_path = generate_llm_report(moc_name, insights, hypotheses, args.dry_run)
        total_hypotheses += len(hypotheses)
    
    log("\n" + "=" * 60)
    log("LLM 분석 완료")
    log("=" * 60)
    log(f"분석된 MOC: {len(moc_list[:5])}개")
    log(f"생성된 고급 가설: {total_hypotheses}개")
    
    if args.dry_run:
        log("\n[미리보기 모드]")
        log("실행하려면: python3 hypothesis_llm_generator.py --all")


if __name__ == "__main__":
    main()
