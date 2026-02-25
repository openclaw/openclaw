#!/usr/bin/env python3
"""
5단계 완전 파이프라인 - ron_workflow_complete.py
"""
import json
import asyncio
from datetime import datetime
from pathlib import Path
from dataclasses import dataclass, asdict
import logging

logging.basicConfig(level=logging.INFO, format='%(message)s')
logger = logging.getLogger(__name__)

from shared.vault_paths import VAULT, INBOX

@dataclass
class Event:
    id: str
    source: str
    content: dict
    timestamp: str
    status: str = "pending"

class Pipeline5:
    def run(self, text: str, source="test"):
        event = Event(
            id=f"{source}-{datetime.now().strftime('%H%M%S')}",
            source=source,
            content={"text": text},
            timestamp=datetime.now().isoformat()
        )
        
        # 5단계 실행
        event = self.stage1_ingest(event)
        event = self.stage2_enrich(event)
        event = self.stage3_transform(event)
        event = self.stage4_structure(event)
        event = self.stage5_output(event)
        
        return event
    
    def stage1_ingest(self, event: Event):
        """1. 수집"""
        logger.info("[1/5] INGEST: 원본 저장")
        filepath = INBOX / "111_raw" / f"{event.timestamp[:19].replace(':','-')}_{event.id}.json"
        filepath.write_text(json.dumps(asdict(event), ensure_ascii=False, indent=2))
        event.status = "ingested"
        return event
    
    def stage2_enrich(self, event: Event):
        """2. 보강: 키워드 추출"""
        logger.info("[2/5] ENRICH: 키워드 분석")
        text = event.content["text"]
        
        patterns = {
            "반도체": ["반도체", "하이닉스", "삼성", "HBM", "TSMC"],
            "금융": ["금융", "은행", "ETF"],
            "AI": ["AI", "인공지능", "ChatGPT"],
            "매크로": ["금리", "FOMC", "연준"]
        }
        
        keywords = []
        for cat, terms in patterns.items():
            if any(t in text for t in terms):
                keywords.append(cat)
        
        event.content["keywords"] = keywords
        event.content["summary"] = text[:60] + "..."
        event.status = "enriched"
        logger.info(f"    키워드: {keywords}")
        return event
    
    def stage3_transform(self, event: Event):
        """3. 변환: Markdown"""
        logger.info("[3/5] TRANSFORM: Markdown 생성")
        md = f"""---
id: {event.id}
keywords: {event.content.get('keywords', [])}
---
# {event.source} - {event.timestamp[:10]}
{event.content.get('summary')}
"""
        filepath = INBOX / "113_summarized" / f"{event.id}.md"
        filepath.write_text(md)
        event.status = "transformed"
        return event
    
    def stage4_structure(self, event: Event):
        """4. 구조화: MOC 연결"""
        logger.info("[4/5] STRUCTURE: MOC 업데이트")
        keywords = event.content.get("keywords", [])
        
        for kw in keywords:
            moc_path = VAULT / "100 지식" / "120 영역" / f"MOC-{kw}.md"
            moc_path.parent.mkdir(parents=True, exist_ok=True)
            
            entry = f"- [[{event.id}]] {event.content.get('summary')[:30]}\n"
            
            if not moc_path.exists():
                moc_path.write_text(f"# MOC-{kw}\n\n## 최근\n")
            
            content = moc_path.read_text()
            if entry not in content:
                moc_path.write_text(content + entry)
            
            logger.info(f"    → MOC-{kw}")
        
        event.status = "structured"
        return event
    
    def stage5_output(self, event: Event):
        """5. 출력: 실행 항목"""
        logger.info("[5/5] OUTPUT: 실행 항목 생성")
        
        actions = []
        if "반도체" in event.content.get("keywords", []):
            actions.append("[ ] 반도체 점검")
        if "금리" in event.content["text"]:
            actions.append("[ ] 금리 분석")
        
        if actions:
            action_path = VAULT / "300 운영" / "350 실행" / f"todo_{event.id}.md"
            action_path.write_text(f"# 할일\n{chr(10).join(actions)}\n")
            logger.info(f"    → {len(actions)}개 할일")
        
        event.status = "completed"
        return event

if __name__ == "__main__":
    print("="*60)
    print("🚀 5단계 완전 파이프라인 테스트")
    print("="*60)
    
    pipe = Pipeline5()
    test_text = "SK하이닉스 HBM 실적 발표. 금리 인하 기대로 반도체 수요 상승."
    
    result = pipe.run(test_text)
    
    print("="*60)
    print(f"✅ 완료: {result.id}")
    print(f"   키워드: {result.content.get('keywords')}")
    print(f"   상태: {result.status}")
