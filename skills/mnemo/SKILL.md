---
name: mnemo
description: Mnemo GraphRAG 지식그래프 검색 + 볼트 보강. Obsidian 볼트 + MAIBOT memory를 그래프로 탐색하여 맥락적 답변을 제공. 지식 검색, 크로스 프로젝트 추론, 관련 노트 탐색, 볼트 구조 자동 보강에 사용.
---

# Mnemo — GraphRAG 지식그래프 검색 + 볼트 보강

Obsidian 볼트(3,090+ 파일)와 MAIBOT memory를 NetworkX 지식그래프로 탐색하는 스킬.

## 언제 사용하나

- "~에 대해 볼트에서 찾아줘", "~와 관련된 프로젝트는?"
- 크로스 프로젝트 추론이 필요할 때
- memory_search보다 더 넓은 범위 검색이 필요할 때
- 노트 간 관계/연결을 탐색할 때
- 새 노트 추가 후 태그/백링크 자동 보강이 필요할 때

## 환경

| 항목        | 값                                            |
| ----------- | --------------------------------------------- |
| 프로젝트    | `C:\TEST\MAISECONDBRAIN`                      |
| 볼트        | `C:\Users\jini9\OneDrive\Documents\JINI_SYNC` |
| Memory      | `C:\MAIBOT\memory`                            |
| 캐시        | `C:\TEST\MAISECONDBRAIN\.mnemo/`              |
| Python      | 3.13+, pip dependencies installed             |
| 임베딩 모델 | Ollama nomic-embed-text (로컬, 768dim)        |

**모든 명령에 `$env:PYTHONIOENCODING="utf-8"` 필수** (Windows 콘솔)

## 사용 방법

### 1. 그래프 빌드 (최초 또는 갱신 시)

```powershell
cd C:\TEST\MAISECONDBRAIN
$env:PYTHONIOENCODING="utf-8"
python -m mnemo.cli build "C:\Users\jini9\OneDrive\Documents\JINI_SYNC" --include-memory "C:\MAIBOT\memory" --cache-dir ".mnemo"
```

증분 빌드: 변경된 노트만 감지, 캐시 갱신 (~6초)

### 2. 질의 (하이브리드 검색)

```powershell
python -m mnemo.cli query "질문 내용" --cache-dir ".mnemo" --top-k 7
```

임베딩 캐시가 있으면 자동으로 벡터+키워드+그래프 하이브리드 검색.

### 3. 이웃 탐색

```powershell
python -m mnemo.cli neighbors "노드명" --hops 2 --cache-dir ".mnemo"
```

부분 매칭 지원 — 정확한 이름이 아니어도 후보를 보여줌.

### 4. API 서버

```powershell
python -m mnemo.cli serve --cache-dir ".mnemo" --port 7890
```

엔드포인트:

- `POST /api/query` — GraphRAG 질의
- `GET /api/stats` — 그래프 통계
- `GET /api/neighbors/{node}` — 이웃 탐색
- `POST /api/suggest` — 관련 노트 추천

### 5. 임베딩 생성/갱신

```powershell
python scripts/embed_vault.py
```

Ollama nomic-embed-text (로컬 GPU), ~46초 for 2,164개 노트.

### 6. 볼트 보강 (3단계)

#### 6a. 구조 보강 — type + project frontmatter

```powershell
python scripts/enrich_apply.py
```

- type이 없는 노트에 자동 추론 (파일명 패턴 + 폴더 + 내용)
- project가 없는 노트에 경로/태그/내용에서 프로젝트 추론
- 타입: event, task, analysis, design, implementation, test, report, guide, meeting, devlog, document, template

#### 6b. 관계 보강 — related 링크

```powershell
python scripts/enrich_related.py
```

- `related:` frontmatter 자동 추론 (태그 겹침 ≥2 + 같은 프로젝트 + 날짜 근접)
- 노트당 최대 5개 관련 노트

#### 6c. 콘텐츠 보강 — 태그 + 백링크

```powershell
python scripts/content_enrich.py
```

- 본문 키워드 분석으로 토픽 태그 자동 추가 (AI, RAG, LLM, 자동화, 보안, TikTok, 화장품, 베트남, GraphRAG 등 20+ 토픽)
- 다른 노트명이 본문에 언급되었지만 `[[링크]]`가 없는 경우 `## Related Notes` 섹션에 백링크 추가
- 내용에서 프로젝트 키워드 발견 시 project frontmatter 추가

#### 전체 보강 순서 (새 노트 추가 후)

```powershell
cd C:\TEST\MAISECONDBRAIN; $env:PYTHONIOENCODING="utf-8"
python scripts/enrich_apply.py       # type + project
python scripts/enrich_related.py     # related 관계
python scripts/content_enrich.py     # 태그 + 백링크
python -m mnemo.cli build "C:\Users\jini9\OneDrive\Documents\JINI_SYNC" --include-memory "C:\MAIBOT\memory" --cache-dir ".mnemo"
python scripts/embed_vault.py        # 임베딩 갱신
```

### 7. 볼트 분석

```powershell
python scripts/analyze_vault.py
```

현황 리포트: frontmatter 비율, 태그 분포, 폴더별 분포, 위키링크 현황, 본문 길이 분포.

## 그래프 현황 (2026-02-20 기준)

| 지표           | 값             |
| -------------- | -------------- |
| 노드           | 2,475          |
| 엣지           | **24,138**     |
| wiki_link 엣지 | 17,943         |
| related 엣지   | 6,195          |
| 연결 컴포넌트  | 337            |
| 밀도           | 0.0039         |
| 임베딩         | 2,164 (768dim) |

### 보강 이력

| 단계               | 변경 노트 | 추가 항목                  |
| ------------------ | --------- | -------------------------- |
| type + project     | 1,057개   | 948 type + 415 project     |
| related 관계       | 1,460개   | 6,752 관계 → 6,195 엣지    |
| 콘텐츠 태그+백링크 | 2,831개   | 14,612 태그 + 1,769 백링크 |

### 검색 성능 (실측)

| 쿼리                        | 결과                               | 확장 노드 |
| --------------------------- | ---------------------------------- | --------- |
| "MAIOSS 보안 관련 작업"     | MAIOSS 5개 정확 검색               | 97        |
| "베트남 화장품 TikTok"      | 베트남+TikTok 5개                  | 12        |
| "AI 수익화 비즈니스모델"    | CBS 수익화, AI Monetization 브리핑 | 96        |
| "MAIAX 삼성 엔지니어링 C&E" | C&E 자동화 시스템 5개              | 475       |

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

### 8. 외부 지식 수집

```powershell
python scripts/collect_knowledge.py                    # 전체 프로젝트
python scripts/collect_knowledge.py MAIOSS MAITOK      # 특정 프로젝트만
```

수집 소스: YouTube (기본), Brave Search (API 키 필요), GitHub trending
저장 위치: `03.RESOURCES/외부지식/` (Obsidian 볼트)
프로젝트별 관심 토픽 자동 검색 → 마크다운 노트로 변환 → 볼트에 저장

지원 프로젝트: MAIOSS, MAIBEAUTY, MAITOK, MAISECONDBRAIN, MAIAX, MAITUTOR, MAIBOTALKS, GENERAL_AI

`daily_enrich.py`에 통합되어 매일 크론으로 자동 실행.

## memory_search 보강 워크플로

Mnemo는 MAIBOT의 `memory_search`를 보강/확장하는 용도로 사용.

### 워크플로

1. **기본:** `memory_search`로 MEMORY.md + memory/\*.md 검색
2. **결과 부족 시:** Mnemo 볼트 검색으로 확장
3. **통합 검색:** 두 소스를 한번에 검색

### 검색 명령어

```powershell
# Mnemo 볼트만 검색 (JSON)
cd C:\TEST\MAISECONDBRAIN; $env:PYTHONIOENCODING="utf-8"
python scripts/search.py "검색어" --top-k 5 --format json

# 통합 검색 (memory 우선 + 볼트 보강)
python scripts/integrated_search.py "검색어" --top-k 5 --format json

# 텍스트 출력
python scripts/integrated_search.py "검색어" --format text
```

### JSON 출력 형식

```json
[
  {
    "name": "노트명",
    "score": 0.85,
    "entity_type": "project",
    "snippet": "첫 200자...",
    "path": "...",
    "source": "memory|vault"
  }
]
```

### 언제 Mnemo 확장을 쓰나

- `memory_search` 결과가 2개 이하이거나 관련성 낮을 때
- 프로젝트 간 연결/관계를 찾을 때
- 과거 작업 이력이나 브리핑 내용을 찾을 때
- "볼트에서 찾아줘" 등 명시적 요청 시

## 주의사항

- 볼트 변경 후 `mnemo build`로 그래프 갱신 필요 (증분, ~6초)
- 보강 스크립트는 기존 값을 덮어쓰지 않음 (없는 필드만 추가)
- `related:` 추론은 태그 겹침 기반이라 태그가 많을수록 정확
- 백링크는 `## Related Notes` 섹션에 추가 (기존 섹션 있으면 스킵)
- OneDrive 동기화로 아이패드 Obsidian에 자동 반영
