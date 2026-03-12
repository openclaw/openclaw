# Mnemo 볼트 보강 상세

## 6a. 구조 보강 — type + project frontmatter

```powershell
python scripts/enrich_apply.py
```

- type이 없는 노트에 자동 추론 (파일명 패턴 + 폴더 + 내용)
- project가 없는 노트에 경로/태그/내용에서 프로젝트 추론
- 타입: event, task, analysis, design, implementation, test, report, guide, meeting, devlog, document, template

## 6b. 관계 보강 — related 링크

```powershell
python scripts/enrich_related.py
```

- `related:` frontmatter 자동 추론 (태그 겹침 ≥2 + 같은 프로젝트 + 날짜 근접)
- 노트당 최대 5개 관련 노트

## 6c. 콘텐츠 보강 — 태그 + 백링크

```powershell
python scripts/content_enrich.py
```

- 본문 키워드 분석으로 토픽 태그 자동 추가 (AI, RAG, LLM, 자동화, 보안, TikTok, 화장품, 베트남, GraphRAG 등 20+ 토픽)
- 다른 노트명이 본문에 언급되었지만 `[[링크]]`가 없는 경우 `## Related Notes` 섹션에 백링크 추가
- 내용에서 프로젝트 키워드 발견 시 project frontmatter 추가

## 외부 지식 수집 상세

```powershell
python scripts/collect_knowledge.py                    # 전체 프로젝트
python scripts/collect_knowledge.py MAIOSS MAITOK      # 특정 프로젝트만
```

수집 소스: YouTube (기본), Brave Search (API 키 필요), GitHub trending
저장 위치: `03.RESOURCES/외부지식/` (Obsidian 볼트)
프로젝트별 관심 토픽 자동 검색 → 마크다운 노트로 변환 → 볼트에 저장

지원 프로젝트: MAIOSS, MAIBEAUTY, MAITOK, MAISECONDBRAIN, MAIAX, MAITUTOR, MAIBOTALKS, GENERAL_AI

`daily_enrich.py`에 통합되어 매일 크론으로 자동 실행.

---

## 모듈 구조

```
src/mnemo/
├── parser.py          # Obsidian 마크다운 파서 (YAML, wiki links, tags)
├── ontology.py        # 엔티티 타입 자동 분류
├── graph_builder.py   # NetworkX DiGraph 빌더
├── cache.py           # 증분 빌드 캐시 (checksums + pickle)
├── embedder.py        # OpenAI/Ollama 임베딩 생성
├── vector_search.py   # 코사인 유사도 Top-K
├── graph_search.py    # BFS, PageRank, 경로 탐색
├── hybrid_search.py   # 키워드(50%) + 벡터(30%) + 그래프(20%) 통합
├── graphrag.py        # GraphRAG 쿼리 엔진
├── api.py             # FastAPI REST 서버 (localhost:7890)
├── enricher.py        # 구조 보강 (type, project, related)
├── content_linker.py  # 콘텐츠 기반 태그 + 백링크 발견
└── cli.py             # CLI: build, stats, neighbors, query, serve
```

---

## 보강 이력

### 2026-02-20 기준

| 단계               | 변경 노트 | 추가 항목                  |
| ------------------ | --------- | -------------------------- |
| type + project     | 1,057개   | 948 type + 415 project     |
| related 관계       | 1,460개   | 6,752 관계 → 6,195 엣지    |
| 콘텐츠 태그+백링크 | 2,831개   | 14,612 태그 + 1,769 백링크 |
