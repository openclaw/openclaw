#!/usr/bin/env python3
"""
MOC Auto Updater - Living Documents (Vin's 4번째 패턴)
MOC 파일을 자동으로 업데이트하는 크론 스크립트
"""

import json
from pathlib import Path
from datetime import datetime

class MOCAutoUpdater:
    """MOC 자동 업데이트"""
    
    def __init__(self, vault_path: str):
        self.vault = Path(vault_path)
        self.area = self.vault / "100 지식" / "120 영역"
        self.inbox = self.vault / "100 지식" / "110 수신함" / "113_summarized"
        
    def get_recent_notes(self, hours: int = 24) -> list:
        """최근 생성된 노트 가져오기"""
        notes = []
        cutoff = datetime.now().timestamp() - (hours * 3600)
        
        for md in self.inbox.glob("*.md"):
            if md.stat().st_mtime > cutoff:
                content = md.read_text(encoding='utf-8')
                
                # frontmatter에서 키워드 추출
                keywords = []
                if content.startswith("---"):
                    parts = content.split("---", 2)
                    if len(parts) >= 3:
                        for line in parts[1].split("\n"):
                            if line.startswith("keywords:"):
                                kw_str = line.split(":", 1)[1].strip()
                                keywords = [k.strip() for k in kw_str.strip("[]").split(",")]
                                break
                
                notes.append({
                    "name": md.stem,
                    "keywords": keywords,
                    "path": str(md.relative_to(self.vault))
                })
        
        return notes
    
    def update_mocs(self):
        """MOC 파일 업데이트"""
        recent = self.get_recent_notes()
        
        updated = []
        for note in recent:
            for kw in note["keywords"]:
                moc_path = self.area / f"MOC-{kw}.md"
                
                if not moc_path.exists():
                    # 새 MOC 생성
                    moc_path.write_text(f"""---
title: "MOC-{kw}"
description: "자동 생성된 MOC - {kw}"
tags: [{kw}, MOC, auto-generated]
---

# MOC-{kw}

## 최근 업데이트
- [[{note["name"]}]] - {datetime.now().strftime("%Y-%m-%d")}
""", encoding='utf-8')
                else:
                    # 기존 MOC에 추가
                    content = moc_path.read_text(encoding='utf-8')
                    entry = f"- [[{note['name']}]] - {datetime.now().strftime('%Y-%m-%d')}"
                    
                    if entry not in content:
                        content = content.replace(
                            "## 최근 업데이트\n",
                            f"## 최근 업데이트\n{entry}\n"
                        )
                        moc_path.write_text(content, encoding='utf-8')
                
                updated.append(f"MOC-{kw}")
        
        return updated

if __name__ == "__main__":
    import sys
    from shared.vault_paths import VAULT

    vault_path = VAULT
    updater = MOCAutoUpdater(str(vault_path))
    
    updated = updater.update_mocs()
    
    print(f"✅ MOC 자동 업데이트 완료: {len(updated)}개 MOC 업데이트")
    for m in updated:
        print(f"   - {m}")
