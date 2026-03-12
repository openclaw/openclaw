# Mnemo 전체 명령어 상세

**모든 명령에 `$env:PYTHONIOENCODING="utf-8"` 필수** (Windows)

```powershell
cd C:\TEST\MAISECONDBRAIN; $env:PYTHONIOENCODING="utf-8"
```

## 1. 그래프 빌드 (최초 또는 갱신 시)

```powershell
python -m mnemo.cli build "C:\Users\jini9\OneDrive\Documents\JINI_SYNC" --include-memory "C:\MAIBOT\memory" --cache-dir ".mnemo"
```

증분 빌드: 변경된 노트만 감지, 캐시 갱신 (~6초)

## 2. 질의 (하이브리드 검색)

```powershell
python -m mnemo.cli query "질문 내용" --cache-dir ".mnemo" --top-k 7
```

임베딩 캐시가 있으면 자동으로 벡터+키워드+그래프 하이브리드 검색.

## 3. 이웃 탐색

```powershell
python -m mnemo.cli neighbors "노드명" --hops 2 --cache-dir ".mnemo"
```

부분 매칭 지원 — 정확한 이름이 아니어도 후보를 보여줌.

## 4. API 서버

```powershell
python -m mnemo.cli serve --cache-dir ".mnemo" --port 7890
```

엔드포인트:

- `POST /api/query` — GraphRAG 질의
- `GET /api/stats` — 그래프 통계
- `GET /api/neighbors/{node}` — 이웃 탐색
- `POST /api/suggest` — 관련 노트 추천

## 5. 임베딩 생성/갱신

```powershell
python scripts/embed_vault.py
```

Ollama qwen3-embedding:0.6b (로컬 GPU), 전체 재빌드 시 수분 소요.

## 6. 볼트 보강 (3단계)

→ 상세 코드는 [enrichment.md](enrichment.md) 참조

```powershell
python scripts/enrich_apply.py       # 6a. type + project
python scripts/enrich_related.py     # 6b. related 관계
python scripts/content_enrich.py     # 6c. 태그 + 백링크
```

전체 보강 순서 (새 노트 추가 후):

```powershell
cd C:\TEST\MAISECONDBRAIN; $env:PYTHONIOENCODING="utf-8"
python scripts/enrich_apply.py       # type + project
python scripts/enrich_related.py     # related 관계
python scripts/content_enrich.py     # 태그 + 백링크
python -m mnemo.cli build "C:\Users\jini9\OneDrive\Documents\JINI_SYNC" --include-memory "C:\MAIBOT\memory" --cache-dir ".mnemo"
python scripts/embed_vault.py        # 임베딩 갱신
```

## 7. 볼트 분석

```powershell
python scripts/analyze_vault.py
```

현황 리포트: frontmatter 비율, 태그 분포, 폴더별 분포, 위키링크 현황, 본문 길이 분포.

## 8. 외부 지식 수집

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

---

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

### 검색 성능 (실측)

| 쿼리                        | 결과                               | 확장 노드 |
| --------------------------- | ---------------------------------- | --------- |
| "MAIOSS 보안 관련 작업"     | MAIOSS 5개 정확 검색               | 97        |
| "베트남 화장품 TikTok"      | 베트남+TikTok 5개                  | 12        |
| "AI 수익화 비즈니스모델"    | CBS 수익화, AI Monetization 브리핑 | 96        |
| "MAIAX 삼성 엔지니어링 C&E" | C&E 자동화 시스템 5개              | 475       |

## 그래프 현황 (2026-03-12 기준)

| 지표     | 값     |
| -------- | ------ |
| 노드     | 3,289  |
| 엣지     | 36,176 |
| 컴포넌트 | 1      |
| 댕글링   | 0 ✅   |
| unknown  | 0 ✅   |
| 임베딩   | 3,842  |
| 밀도     | 0.0033 |
