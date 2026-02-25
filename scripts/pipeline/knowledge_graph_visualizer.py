#!/usr/bin/env python3
"""
knowledge_graph_visualizer.py - 지식 그래프 시각화

기능:
1. MOC 간 관계 그래프 생성 (Mermaid)
2. 노트 연결맵 시각화
3. HTML 리포트 생성

Usage:
  python3 knowledge_graph_visualizer.py
"""

import os
import re
import json
from pathlib import Path
from datetime import datetime
from collections import defaultdict, Counter

from shared.vault_paths import VAULT

def log(msg, level="INFO"):
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] [{level}] {msg}")


def analyze_moc_relationships():
    """MOC 간 관계 분석"""
    moc_dir = VAULT / "100 지식" / "150 구조노트"
    
    moc_data = {}
    relationships = []
    
    for moc_file in moc_dir.glob("MOC-*.md"):
        try:
            content = moc_file.read_text(encoding="utf-8")
            moc_name = moc_file.stem.replace("MOC-", "")
            
            # 노트 링크 추출
            note_links = re.findall(r'\[\[([^\]]+)\]\]', content)
            
            # 키워드 추출
            keywords = []
            keyword_patterns = {
                "반도체": ["반도체", "semiconductor", "chip", "HBM", "메모리"],
                "AI": ["AI", "인공지능", "LLM", "GPT", "에이전트"],
                "금융": ["금융", "finance", "증권", "은행"],
                "바이오": ["바이오", "biotech", "제약"],
                "자동차": ["자동차", "automotive", "EV", "전기차"],
            }
            
            for category, words in keyword_patterns.items():
                for word in words:
                    if word in content:
                        keywords.append(category)
                        break
            
            moc_data[moc_name] = {
                "note_count": len(note_links),
                "keywords": list(set(keywords)),
                "notes": note_links[:10]
            }
        except:
            pass
    
    # 관계 분석 (공통 키워드 기반)
    moc_names = list(moc_data.keys())
    for i, moc1 in enumerate(moc_names):
        for moc2 in moc_names[i+1:]:
            shared_keywords = set(moc_data[moc1]["keywords"]) & set(moc_data[moc2]["keywords"])
            if shared_keywords:
                relationships.append({
                    "from": moc1,
                    "to": moc2,
                    "shared": list(shared_keywords),
                    "strength": len(shared_keywords)
                })
    
    return moc_data, relationships


def generate_mermaid_graph(moc_data, relationships):
    """Mermaid 그래프 생성"""
    lines = ["graph TD"]
    
    # 노드 정의
    for moc_name, data in sorted(moc_data.items()):
        size = min(data["note_count"] / 10, 5) + 1  # 크기 1-6
        keywords_str = ", ".join(data["keywords"][:2])
        label = f"{moc_name}({moc_name}<br/>{data['note_count']} notes)"
        
        # 크기별 스타일
        if size >= 5:
            lines.append(f"    {moc_name}{label}:::large")
        elif size >= 3:
            lines.append(f"    {moc_name}{label}:::medium")
        else:
            lines.append(f"    {moc_name}{label}:::small")
    
    # 관계 정의
    for rel in sorted(relationships, key=lambda x: x["strength"], reverse=True)[:15]:
        shared = ", ".join(rel["shared"])
        lines.append(f"    {rel['from']} -->|{shared}| {rel['to']}")
    
    # 스타일 정의
    lines.extend([
        "",
        "    classDef large fill:#f96,stroke:#333,stroke-width:4px;",
        "    classDef medium fill:#69f,stroke:#333,stroke-width:2px;",
        "    classDef small fill:#9f9,stroke:#333,stroke-width:1px;",
    ])
    
    return "\n".join(lines)


def generate_html_report(moc_data, relationships, mermaid_graph):
    """HTML 리포트 생성"""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    report_dir = VAULT / "300 운영" / "340 리포트"
    report_dir.mkdir(parents=True, exist_ok=True)
    
    report_file = report_dir / f"knowledge-graph-{datetime.now().strftime('%Y-%m-%d')}.html"
    
    # 통계
    total_mocs = len(moc_data)
    total_notes = sum(d["note_count"] for d in moc_data.values())
    total_relationships = len(relationships)
    
    html = f"""<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>지식 그래프 - {timestamp}</title>
    <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 40px; background: #f5f5f5; }}
        .container {{ max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }}
        h1 {{ color: #333; border-bottom: 2px solid #4CAF50; padding-bottom: 10px; }}
        h2 {{ color: #555; margin-top: 30px; }}
        .stats {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin: 20px 0; }}
        .stat-card {{ background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; border-radius: 8px; text-align: center; }}
        .stat-number {{ font-size: 2em; font-weight: bold; }}
        .stat-label {{ font-size: 0.9em; opacity: 0.9; }}
        .mermaid {{ background: #fafafa; padding: 20px; border-radius: 8px; margin: 20px 0; }}
        table {{ width: 100%; border-collapse: collapse; margin: 20px 0; }}
        th, td {{ padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }}
        th {{ background: #4CAF50; color: white; }}
        tr:hover {{ background: #f5f5f5; }}
        .keyword-tag {{ display: inline-block; background: #e3f2fd; color: #1976d2; padding: 2px 8px; border-radius: 12px; font-size: 0.85em; margin: 2px; }}
    </style>
</head>
<body>
    <div class="container">
        <h1>🧠 지식 그래프 시각화</h1>
        <p>생성일: {timestamp}</p>
        
        <div class="stats">
            <div class="stat-card">
                <div class="stat-number">{total_mocs}</div>
                <div class="stat-label">MOC 카테고리</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">{total_notes}</div>
                <div class="stat-label">총 노트 수</div>
            </div>
            <div class="stat-card">
                <div class="stat-number">{total_relationships}</div>
                <div class="stat-label">관계 연결</div>
            </div>
        </div>
        
        <h2>🕸️ MOC 관계맵</h2>
        <div class="mermaid">
{mermaid_graph}
        </div>
        
        <h2>📊 MOC 상세 정보</h2>
        <table>
            <tr>
                <th>MOC 이름</th>
                <th>노트 수</th>
                <th>핵심 키워드</th>
                <th>크기 등급</th>
            </tr>
"""
    
    # MOC 테이블
    for moc_name, data in sorted(moc_data.items(), key=lambda x: x[1]["note_count"], reverse=True):
        size_class = "대" if data["note_count"] >= 100 else "중" if data["note_count"] >= 50 else "소"
        keywords_html = " ".join([f'<span class="keyword-tag">{k}</span>' for k in data["keywords"]])
        
        html += f"""
            <tr>
                <td><strong>{moc_name}</strong></td>
                <td>{data['note_count']}</td>
                <td>{keywords_html}</td>
                <td>{size_class}</td>
            </tr>"""
    
    html += f"""
        </table>
        
        <h2>🔗 주요 관계</h2>
        <table>
            <tr>
                <th>From</th>
                <th>To</th>
                <th>공통 키워드</th>
                <th>연결 강도</th>
            </tr>
"""
    
    # 관계 테이블
    for rel in sorted(relationships, key=lambda x: x["strength"], reverse=True)[:20]:
        html += f"""
            <tr>
                <td>{rel['from']}</td>
                <td>{rel['to']}</td>
                <td>{', '.join(rel['shared'])}</td>
                <td>{'🟢' * rel['strength']}</td>
            </tr>"""
    
    html += """
        </table>
        
        <h2>📈 인사이트</h2>
        <ul>
            <li>노드 크기는 해당 MOC의 노트 수를 나타냅니다</li>
            <li>선으로 연결된 MOC는 공통 키워드를 가지고 있습니다</li>
            <li>큰 노드(주황색)는 핵심 카테고리입니다</li>
            <li>클러스터 형태로 그룹화된 영역을 확인하세요</li>
        </ul>
    </div>
    
    <script>
        mermaid.initialize({ startOnLoad: true });
    </script>
</body>
</html>
"""
    
    report_file.write_text(html, encoding="utf-8")
    log(f"HTML 리포트 저장: {report_file}")
    return report_file


def main():
    log("=" * 60)
    log("지식 그래프 시각화 시작")
    log("=" * 60)
    
    # MOC 관계 분석
    log("\n[1/3] MOC 관계 분석...")
    moc_data, relationships = analyze_moc_relationships()
    log(f"  MOC 수: {len(moc_data)}")
    log(f"  관계 수: {len(relationships)}")
    
    # Mermaid 그래프 생성
    log("\n[2/3] Mermaid 그래프 생성...")
    mermaid_graph = generate_mermaid_graph(moc_data, relationships)
    
    # HTML 리포트 생성
    log("\n[3/3] HTML 리포트 생성...")
    report_path = generate_html_report(moc_data, relationships, mermaid_graph)
    
    # 결과
    log("\n" + "=" * 60)
    log("시각화 완료")
    log("=" * 60)
    log(f"MOC 카테고리: {len(moc_data)}개")
    log(f"총 노트: {sum(d['note_count'] for d in moc_data.values())}개")
    log(f"관계 연결: {len(relationships)}개")
    log(f"\n리포트: {report_path}")
    log(f"\n브라우저에서 열어보세요:")
    log(f"  open {report_path}")


if __name__ == "__main__":
    main()
