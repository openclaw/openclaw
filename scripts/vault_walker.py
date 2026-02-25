#!/usr/bin/env python3
"""
Vault Walker - Ron이 Vault를 Wikilink로 탐색하는 로직
@arscontexta 원칙: the agent follows relevant paths and skips what doesn't matter
Vin 원칙: Vault-wide Pattern Recognition + Contextual Knowledge Retrieval
"""

import os
import json
from pathlib import Path
from datetime import datetime
from typing import List, Dict, Optional
import re

class VaultWalker:
    """Ron이 Vault를 탐색하는 클래스"""
    
    def __init__(self, vault_path: str):
        self.vault = Path(vault_path)
        self.cache = {}
        
    def get_index(self) -> Dict:
        """
        INDEX.md를 읽고 Vault 구조 파악
        Progressive Disclosure 1단계
        """
        index_path = self.vault / "100 지식" / "120 영역" / "INDEX.md"
        if not index_path.exists():
            return {"error": "INDEX.md not found"}
        
        content = index_path.read_text(encoding='utf-8')
        
        # YAML frontmatter 추출
        frontmatter = {}
        if content.startswith("---"):
            parts = content.split("---", 2)
            if len(parts) >= 3:
                fm_text = parts[1]
                for line in fm_text.split("\n"):
                    if ":" in line:
                        key, val = line.split(":", 1)
                        frontmatter[key.strip()] = val.strip()
        
        # MOC 링크 추출
        mocs = re.findall(r'\[\[([^\]|]+)\]\]', content)
        
        return {
            "description": frontmatter.get("description", ""),
            "type": frontmatter.get("type", ""),
            "mocs": mocs,
            "raw": content[:500]
        }
    
    def scan_moc(self, moc_name: str) -> Dict:
        """
        MOC 파일을 읽고 연결된 노트 파악
        Progressive Disclosure 2단계
        """
        # MOC 파일 찾기
        moc_path = None
        for pattern in [f"MOC-{moc_name}.md", f"{moc_name}.md"]:
            potential = self.vault / "100 지식" / "120 영역" / pattern
            if potential.exists():
                moc_path = potential
                break
            
            # 150 구조노트에서도 찾기
            potential = list((self.vault / "100 지식" / "150 구조노트").glob(f"*{moc_name}*.md"))
            if potential:
                moc_path = potential[0]
                break
        
        if not moc_path:
            return {"error": f"MOC not found: {moc_name}"}
        
        content = moc_path.read_text(encoding='utf-8')
        
        # YAML frontmatter에서 description 추출
        frontmatter = {}
        if content.startswith("---"):
            parts = content.split("---", 2)
            if len(parts) >= 3:
                fm_text = parts[1]
                for line in fm_text.split("\n"):
                    if ":" in line:
                        key, val = line.split(":", 1)
                        frontmatter[key.strip()] = val.strip()
        
        # Wikilink로 연결된 노트 추출
        linked_notes = re.findall(r'\[\[([^\]|]+)\]\|?([^\]]*)\]\]', content)
        
        return {
            "name": moc_path.stem,
            "description": frontmatter.get("description", ""),
            "tags": frontmatter.get("tags", "").split(","),
            "linked_notes": [{"name": n[0], "label": n[1]} for n in linked_notes],
            "path": str(moc_path.relative_to(self.vault))
        }
    
    def read_note(self, note_name: str) -> Dict:
        """
        개별 노트 읽기
        Progressive Disclosure 3단계
        """
        # 모든 곳에서 노트 찾기
        search_paths = [
            self.vault / "100 지식",
            self.vault / "300 운영" / "350 실행"
        ]
        
        for search_path in search_paths:
            if not search_path.exists():
                continue
                
            # 정확한 이름 또는 부분 일치
            matches = list(search_path.rglob(f"{note_name}.md"))
            matches += list(search_path.rglob(f"*{note_name}*.md"))
            
            if matches:
                note_path = matches[0]
                content = note_path.read_text(encoding='utf-8')
                
                # frontmatter 추출
                frontmatter = {}
                if content.startswith("---"):
                    parts = content.split("---", 2)
                    if len(parts) >= 3:
                        fm_text = parts[1]
                        for line in fm_text.split("\n"):
                            if ":" in line:
                                key, val = line.split(":", 1)
                                frontmatter[key.strip()] = val.strip()
                
                # outbound links 추출
                outbound = re.findall(r'\[\[([^\]|]+)\]\|?([^\]]*)\]\]', content)
                
                return {
                    "name": note_path.stem,
                    "description": frontmatter.get("description", ""),
                    "source": frontmatter.get("source", ""),
                    "keywords": frontmatter.get("keywords", ""),
                    "outbound_links": [{"name": n[0], "label": n[1]} for n in outbound],
                    "content": content[200:] if len(content) > 200 else content,
                    "path": str(note_path.relative_to(self.vault))
                }
        
        return {"error": f"Note not found: {note_name}"}
    
    def find_related(self, keyword: str) -> List[Dict]:
        """
        키워드로 관련 노트 찾기
        Contextual Knowledge Retrieval (Vin's 2번째 패턴)
        """
        results = []
        
        # 모든 마크다운 파일에서 키워드 검색
        for md_file in self.vault.rglob("*.md"):
            if "node_modules" in str(md_file) or ".git" in str(md_file):
                continue
                
            try:
                content = md_file.read_text(encoding='utf-8')
                if keyword.lower() in content.lower():
                    # frontmatter 추출
                    frontmatter = {}
                    if content.startswith("---"):
                        parts = content.split("---", 2)
                        if len(parts) >= 3:
                            fm_text = parts[1]
                            for line in fm_text.split("\n"):
                                if ":" in line:
                                    key, val = line.split(":", 1)
                                    frontmatter[key.strip()] = val.strip()
                    
                    results.append({
                        "name": md_file.stem,
                        "description": frontmatter.get("description", ""),
                        "path": str(md_file.relative_to(self.vault)),
                        "relevance": content.lower().count(keyword.lower())
                    })
            except:
                continue
        
        # 관련성 순으로 정렬
        results.sort(key=lambda x: x["relevance"], reverse=True)
        return results[:10]
    
    def get_vault_stats(self) -> Dict:
        """Vault 전체 통계 - Vault-wide Pattern Recognition"""
        stats = {
            "total_notes": 0,
            "total_mocs": 0,
            "folders": {},
            "sources": {}
        }
        
        for md_file in self.vault.rglob("*.md"):
            if "node_modules" in str(md_file) or ".git" in str(md_file):
                continue
            
            stats["total_notes"] += 1
            
            # 폴더별
            rel_path = md_file.relative_to(self.vault)
            folder = str(rel_path).split("/")[0]
            stats["folders"][folder] = stats["folders"].get(folder, 0) + 1
            
            # MOC 파일
            if "MOC-" in md_file.name:
                stats["total_mocs"] += 1
            
            # source별
            try:
                content = md_file.read_text(encoding='utf-8')
                if content.startswith("---"):
                    parts = content.split("---", 2)
                    if len(parts) >= 3:
                        for line in parts[1].split("\n"):
                            if line.startswith("source:"):
                                source = line.split(":", 1)[1].strip()
                                stats["sources"][source] = stats["sources"].get(source, 0) + 1
                                break
            except:
                continue
        
        return stats

# CLI interface
if __name__ == "__main__":
    import sys
    from shared.vault_paths import VAULT

    vault_path = VAULT
    walker = VaultWalker(str(vault_path))
    
    command = sys.argv[1] if len(sys.argv) > 1 else "stats"
    
    if command == "stats":
        print(json.dumps(walker.get_vault_stats(), indent=2, ensure_ascii=False))
    elif command == "index":
        print(json.dumps(walker.get_index(), indent=2, ensure_ascii=False))
    elif command == "moc" and len(sys.argv) > 2:
        print(json.dumps(walker.scan_moc(sys.argv[2]), indent=2, ensure_ascii=False))
    elif command == "note" and len(sys.argv) > 2:
        print(json.dumps(walker.read_note(sys.argv[2]), indent=2, ensure_ascii=False))
    elif command == "find" and len(sys.argv) > 2:
        results = walker.find_related(sys.argv[2])
        print(json.dumps(results, indent=2, ensure_ascii=False))
    else:
        print("Usage:")
        print("  python vault_walker.py stats      # 전체 통계")
        print("  python vault_walker.py index      # INDEX 확인")
        print("  python vault_walker.py moc <name> # MOC 스캔")
        print("  python vault_walker.py note <name> # 노트 읽기")
        print("  python vault_walker.py find <keyword> # 키워드로 검색")
