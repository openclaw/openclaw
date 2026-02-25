#!/usr/bin/env python3
"""
Action Extractor - Vin's 5번째 패턴
인사이트 → 실행 항목 변환
"""

import re
from pathlib import Path
from datetime import datetime

class ActionExtractor:
    def __init__(self, vault_path: str):
        self.vault = Path(vault_path)
        self.actions_dir = self.vault / "300 운영" / "350 실행"
        
    def extract_actions(self, note_path: str) -> list:
        path = Path(note_path)
        
        if not path.exists():
            path = self.vault / note_path
            
        if not path.exists():
            path = self.vault / "100 지식/110 수신함/113_summarized" / note_path
            if not path.exists():
                return []
        
        content = path.read_text(encoding='utf-8')
        
        keywords = []
        if content.startswith("---"):
            parts = content.split("---", 2)
            if len(parts) >= 3:
                for line in parts[1].split(chr(10)):
                    if line.startswith("keywords:"):
                        kw_str = line.split(":", 1)[1].strip()
                        kw_str = kw_str.replace("[", "").replace("]", "")
                        kw_str = kw_str.replace('"', "").replace("'", "")
                        keywords = [k.strip().lower() for k in kw_str.split(",")]
                        break
        
        action_map = {
            "skill-graph": "[ ] Skill Graph 아키텍처 설계",
            "knowledge-base": "[ ] Knowledge Base 구축",
            "context-engineering": "[ ] Context Engineering 적용",
            "obsidian": "[ ] Obsidian 사용법 학습",
            "claude-code": "[ ] Claude Code Vault 분석 테스트",
            "automation": "[ ] 자동화 스크립트 작성",
            "moc": "[ ] MOC 자동 업데이트 설정",
            "knowledge-management": "[ ] 지식 관리 시스템 최적화",
            "action-insight": "[ ] 인사이트 → 실행 항목 변환 파이프라인",
            "agent": "[ ] 에이전트 워크플로우 구축"
        }
        
        actions = []
        for kw in keywords:
            if kw in action_map:
                actions.append(action_map[kw])
        
        return list(set(actions))
    
    def create_action_file(self, note_name: str, actions: list):
        if not actions:
            return None
            
        action_file = self.actions_dir / f"todo_{note_name}_{datetime.now().strftime('%Y%m%d%H%M%S')}.md"
        
        content = f"""---
source: auto-generated
date: {datetime.now().strftime('%Y-%m-%d')}
generated_by: action_extractor
---

# 실행 항목 - {note_name}

"""
        
        for action in actions:
            content += f"{action}\n"
        
        action_file.write_text(content, encoding='utf-8')
        return str(action_file.relative_to(self.vault))

if __name__ == "__main__":
    import sys
    from shared.vault_paths import VAULT

    vault_path = VAULT
    extractor = ActionExtractor(str(vault_path))
    
    inbox = vault_path / "100 지식" / "110 수신함" / "113_summarized"
    
    total = 0
    for md in list(inbox.glob("*.md")):
        actions = extractor.extract_actions(md.name)
        if actions:
            result = extractor.create_action_file(md.stem, actions)
            print(f"✅ {md.stem}: {len(actions)}개 -> {result}")
            total += len(actions)
    
    print(f"\n총 {total}개 실행 항목 생성")
