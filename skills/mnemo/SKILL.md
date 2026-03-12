---
name: mnemo
description: "Mnemo GraphRAG knowledge graph search + Obsidian vault enrichment. Use when: (1) searching vault for context beyond memory_search, (2) cross-project reasoning, (3) exploring note relationships, (4) auto-enriching vault after adding notes. Triggers: '볼트에서 찾아줘', '관련 프로젝트는?', 'Mnemo 검색', 'vault search', 'knowledge graph', 'memory_search 부족할 때'. NOT for: simple MEMORY.md lookups (use memory_search instead)."
---

# Mnemo — GraphRAG 지식그래프 검색 + 볼트 보강

## 환경

| 항목     | 값                                            |
| -------- | --------------------------------------------- |
| 프로젝트 | `C:\TEST\MAISECONDBRAIN`                      |
| 볼트     | `C:\Users\jini9\OneDrive\Documents\JINI_SYNC` |
| Memory   | `C:\MAIBOT\memory`                            |
| 캐시     | `.mnemo/`                                     |
| Python   | 3.13+                                         |
| 임베딩   | Ollama qwen3-embedding:0.6b (로컬)            |

**모든 명령에 `$env:PYTHONIOENCODING="utf-8"` 필수** (Windows)

## 빠른 참조 — 핵심 명령어

```powershell
cd C:\TEST\MAISECONDBRAIN; $env:PYTHONIOENCODING="utf-8"
```

### 통합 검색 (가장 많이 사용)

```powershell
# JSON (memory 우선 + 볼트 보강)
python scripts/integrated_search.py "검색어" --top-k 7 --format json

# GraphRAG LLM 답변
python scripts/integrated_search.py "검색어" --graphrag --top-k 5 --format text

# 볼트만 검색
python scripts/search.py "검색어" --top-k 5 --format json
```

### 그래프 빌드 (볼트 변경 후)

```powershell
python -m mnemo.cli build "C:\Users\jini9\OneDrive\Documents\JINI_SYNC" --include-memory "C:\MAIBOT\memory" --cache-dir ".mnemo"
```

### 이웃 탐색 / 분석

```powershell
python -m mnemo.cli neighbors "노드명" --hops 2 --cache-dir ".mnemo"
python scripts/analyze_vault.py
```

## 볼트 보강 전체 순서 (새 노트 추가 후)

```powershell
cd C:\TEST\MAISECONDBRAIN; $env:PYTHONIOENCODING="utf-8"
python scripts/enrich_apply.py       # 1. type + project
python scripts/enrich_related.py     # 2. related 관계
python scripts/content_enrich.py     # 3. 태그 + 백링크
python -m mnemo.cli build "C:\Users\jini9\OneDrive\Documents\JINI_SYNC" --include-memory "C:\MAIBOT\memory" --cache-dir ".mnemo"  # 4. 그래프 재빌드
python scripts/embed_vault.py        # 5. 임베딩 갱신
```

**⚠️ 그래프 업데이트 후 반드시 대시보드 싱크 실행** → [dashboard-sync.md](references/dashboard-sync.md)

## 외부 지식 수집

```powershell
python scripts/collect_knowledge.py                    # 전체
python scripts/collect_knowledge.py MAIOSS MAITOK      # 특정 프로젝트만
```

## 그래프 현황 (2026-03-12)

| 지표     | 값     |
| -------- | ------ |
| 노드     | 3,289  |
| 엣지     | 36,176 |
| 컴포넌트 | 1      |
| 임베딩   | 3,842  |

## 주의사항

- 볼트 변경 후 `mnemo build`로 그래프 갱신 필요 (증분, ~6초)
- 보강 스크립트는 기존 값을 덮어쓰지 않음 (없는 필드만 추가)
- OneDrive 동기화로 아이패드 Obsidian에 자동 반영
- **그래프 업데이트 후 대시보드 싱크를 잊지 말 것!**

## References

- [commands.md](references/commands.md) — 전체 명령어 상세 + 검색 워크플로 + 그래프 통계
- [enrichment.md](references/enrichment.md) — 볼트 보강 상세 코드 + 모듈 구조 + 보강 이력
- [dashboard-sync.md](references/dashboard-sync.md) — 대시보드 싱크 코드 + 규칙
