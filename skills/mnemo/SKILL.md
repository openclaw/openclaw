---
name: mnemo
description: Mnemo GraphRAG 지식그래프 검색. Obsidian 볼트 + MAIBOT memory를 그래프로 탐색하여 맥락적 답변을 제공. 지식 검색, 크로스 프로젝트 추론, 관련 노트 탐색에 사용.
---

# Mnemo — GraphRAG 지식그래프 검색

Obsidian 볼트(3,037+ 파일)와 MAIBOT memory를 NetworkX 지식그래프로 탐색하는 스킬.

## 언제 사용하나

- "~에 대해 볼트에서 찾아줘", "~와 관련된 프로젝트는?"
- 크로스 프로젝트 추론이 필요할 때
- memory_search보다 더 넓은 범위 검색이 필요할 때
- 노트 간 관계/연결을 탐색할 때

## 사용 방법

### 1. 그래프 빌드 (최초 또는 갱신 시)

```bash
cd C:\TEST\MAISECONDBRAIN
python -m mnemo.cli build "C:\Users\jini9\OneDrive\Documents\JINI_SYNC" --include-memory "C:\MAIBOT\memory" --cache-dir ".mnemo"
```

### 2. 질의 (CLI)

```bash
cd C:\TEST\MAISECONDBRAIN
python -m mnemo.cli query "질문 내용" --cache-dir ".mnemo"
```

### 3. 이웃 탐색

```bash
cd C:\TEST\MAISECONDBRAIN
python -m mnemo.cli neighbors "노드명" --hops 2 --cache-dir ".mnemo"
```

### 4. API 서버

```bash
cd C:\TEST\MAISECONDBRAIN
python -m mnemo.cli serve --cache-dir ".mnemo" --port 7890
```

API 엔드포인트:
- `POST /api/query` — GraphRAG 질의
- `GET /api/stats` — 그래프 통계
- `GET /api/neighbors/{node}` — 이웃 탐색
- `POST /api/suggest` — 관련 노트 추천

## 환경

- 프로젝트 경로: `C:\TEST\MAISECONDBRAIN`
- 볼트: `C:\Users\jini9\OneDrive\Documents\JINI_SYNC`
- Memory: `C:\MAIBOT\memory`
- 캐시: `C:\TEST\MAISECONDBRAIN\.mnemo/`
- Python 3.13+, pip dependencies installed

## 검색 성능 (실측)

| 쿼리 | 결과 | 확장 노드 |
|------|------|-----------|
| "MAIOSS 보안 관련 작업" | MAIOSS 5개 정확히 검색 | 97개 |
| "베트남 화장품 TikTok" | 베트남+TikTok 관련 5개 | 12개 |

- 하이브리드 검색: 키워드(50%) + 벡터(30%) + 그래프 PageRank(20%)
- 임베딩: Ollama nomic-embed-text (로컬, 768dim), 2,164개, 46초
- 그래프: 2,475 노드 + 16,576 엣지

## 주의사항

- 볼트 변경 후 `mnemo build`로 그래프 갱신 필요 (증분 빌드, ~5초)
- 임베딩 재생성: `python scripts/embed_vault.py` (~46초)
- `$env:PYTHONIOENCODING="utf-8"` 필요 (Windows 콘솔)
