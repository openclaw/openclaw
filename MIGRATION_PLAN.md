# OpenClaw 메모리 시스템 마이그레이션 기획서

## Local SQLite+sqlite-vec → Google Gemini File Search API

**기획일:** 2026-02-03
**대상:** OpenClaw 메모리 검색 파이프라인 전면 교체
**런타임:** Gemini 3 Pro (1M context) / 8GB RAM 서버
**목표:** 로컬 벡터 DB 제거, Google 관리형 RAG로 전환

---

## 0. 현황 진단

### 0.1 제거 대상 (로컬 스택)

```
src/memory/
├── sqlite-vec.ts          ← vec0 확장 로딩 (제거)
├── sqlite.ts              ← Node SQLite 초기화 (제거)
├── memory-schema.ts       ← chunks/chunks_vec/chunks_fts DDL (제거)
├── embeddings.ts          ← 임베딩 프로바이더 추상화 (제거)
├── embeddings-openai.ts   ← OpenAI 임베딩 (제거)
├── embeddings-gemini.ts   ← Gemini 임베딩 (제거)
├── node-llama.ts          ← 로컬 임베딩 (제거)
├── batch-openai.ts        ← OpenAI 배치 (제거)
├── batch-gemini.ts        ← Gemini 배치 (제거)
├── internal.ts            ← chunkMarkdown() (제거 — 청킹을 API에 위임)
├── hybrid.ts              ← BM25+벡터 병합 (제거)
├── manager-search.ts      ← searchVector()/searchKeyword() (제거)
├── manager-cache-key.ts   ← 임베딩 캐시 키 (제거)
├── headers-fingerprint.ts ← 파일 해시 중복 제거 (제거)
├── status-format.ts       ← 상태 포매팅 (수정)
└── openai-batch.ts        ← 배치 폴링 (제거)

package.json:
├── "sqlite-vec": "0.1.7-alpha.2"       ← 의존성 제거
└── "node-llama-cpp" (peerDep)           ← 의존성 제거
```

### 0.2 보존 대상

```
src/memory/
├── manager.ts             ← MemoryIndexManager (재작성 — 인터페이스 유지)
├── search-manager.ts      ← getMemorySearchManager() 팩토리 (수정)
├── index.ts               ← 공개 API 엔트리포인트 (수정)
├── sync-memory-files.ts   ← 파일 변경 감지 (수정 — 업로드 트리거로)
├── sync-session-files.ts  ← 세션 변경 감지 (수정 — 업로드 트리거로)
├── session-files.ts       ← 세션 파일 파싱 (유지)

소비자 레이어 (인터페이스만 유지, 내부 변경 없음):
├── src/agents/tools/memory-tool.ts       ← memory_search/memory_get 도구
├── src/cli/memory-cli.ts                 ← CLI commands
├── src/commands/status.scan.ts           ← 상태 보고
├── src/auto-reply/reply/agent-runner-memory.ts  ← memoryFlush 트리거
├── src/auto-reply/reply/memory-flush.ts  ← memoryFlush 설정
├── src/agents/workspace.ts               ← MEMORY.md bootstrap
├── extensions/memory-core/index.ts       ← 플러그인 등록
```

### 0.3 현재 데이터 플로우 vs 목표 데이터 플로우

```
[현재 - Write Path]
파일 변경 → listMemoryFiles() → buildFileEntry()
  → chunkMarkdown(400tok/80overlap) → embedChunksInBatches()
  → INSERT chunks + chunks_vec + chunks_fts (SQLite)

[목표 - Write Path]
파일 변경 → listMemoryFiles() → buildFileEntry()
  → uploadToFileSearchStore() (Google API가 청킹+임베딩 자동 처리)

[현재 - Read Path]
memory_search 호출 → embedQuery() → vec_distance_cosine() + FTS5 MATCH
  → mergeHybridResults(0.7/0.3) → filter(minScore) → 결과 반환

[목표 - Read Path]
memory_search 호출 → generateContent(file_search tool)
  → grounding_metadata 파싱 → 결과 반환
```

---

## 1. 아키텍처 정렬

### 1.1 추상화 경계: MemoryBackend 인터페이스

현재 `MemoryIndexManager`가 SQLite에 직접 결합되어 있으므로, **Backend 추상화 레이어**를 도입:

```typescript
// src/memory/backend.ts (신규)
interface MemoryBackend {
  // Store 관리
  init(config: MemoryBackendConfig): Promise<void>
  close(): Promise<void>

  // Write
  upsertDocument(doc: MemoryDocument): Promise<void>
  deleteDocument(path: string): Promise<void>

  // Read
  search(query: string, opts: SearchOptions): Promise<MemorySearchResult[]>
  readFile(path: string, range?: LineRange): Promise<string | null>

  // Status
  getStats(): Promise<BackendStats>
}

interface MemoryDocument {
  path: string           // 상대 경로 (MEMORY.md, memory/2026-02-03.md 등)
  source: "memory" | "sessions"
  content: string        // 전체 파일 텍스트
  hash: string           // SHA256
  metadata?: Record<string, string>
}

interface SearchOptions {
  maxResults: number     // default 6
  minScore: number       // default 0.35
}

interface MemorySearchResult {
  path: string
  startLine: number
  endLine: number
  score: number
  snippet: string
  source: "memory" | "sessions"
}
```

### 1.2 Backend 구현체

```
MemoryBackend (인터페이스)
├── GeminiFileSearchBackend (신규 — 1순위)
├── SqliteVecBackend (기존 코드 래핑 — 폴백/레거시)
└── LanceDbBackend (기존 extensions/memory-lancedb — 참고)
```

### 1.3 Provider 선택 로직

```typescript
// src/agents/memory-search.ts 수정
interface MemorySearchConfig {
  // 기존 필드 유지...

  // 신규 필드
  backend: "gemini-file-search" | "sqlite" | "lancedb"  // default: "gemini-file-search"
  geminiFileSearch?: {
    apiKey?: string          // 별도 키 또는 기존 Gemini 키 공유
    storeId?: string         // 미지정 시 agentId 기반 자동 생성
    storeName?: string       // 표시 이름
    topK?: number            // 검색 시 반환 청크 수 (default 10)
    chunkingConfig?: {
      maxTokensPerChunk?: number   // default 500
      chunkOverlapTokens?: number  // default 50
    }
    metadataFilter?: string  // 메타데이터 필터 표현식
  }
}
```

---

## 2. 마이그레이션 페이즈

### Phase 0: 기반 정비 (비파괴적)

**목표:** 기존 코드를 건드리지 않고 새 인터페이스와 Gemini 클라이언트만 추가

**작업:**

| # | 태스크 | 파일 | 변경 타입 |
|---|--------|------|-----------|
| 0-1 | `MemoryBackend` 인터페이스 정의 | `src/memory/backend.ts` (신규) | 신규 |
| 0-2 | Gemini File Search API 클라이언트 | `src/memory/gemini-file-search-client.ts` (신규) | 신규 |
| 0-3 | `GeminiFileSearchBackend` 구현 | `src/memory/gemini-file-search-backend.ts` (신규) | 신규 |
| 0-4 | 기존 SQLite 코드를 `SqliteVecBackend`로 래핑 | `src/memory/sqlite-backend.ts` (신규) | 신규 (기존 코드 참조만) |
| 0-5 | 단위 테스트 작성 | `src/memory/gemini-file-search-backend.test.ts` (신규) | 신규 |

**검증 기준:**
- `pnpm build` 통과 (기존 코드 무변경)
- 새 파일의 단위 테스트 통과
- 기존 테스트 전부 통과 (회귀 없음)

---

### Phase 1: Backend 추상화 도입

**목표:** `MemoryIndexManager`가 Backend 인터페이스를 통해 동작하도록 리팩토링

**작업:**

| # | 태스크 | 파일 | 변경 타입 |
|---|--------|------|-----------|
| 1-1 | `MemoryIndexManager` 생성자에 Backend 주입 | `src/memory/manager.ts` | 수정 |
| 1-2 | `search()` 메서드가 Backend.search() 위임 | `src/memory/manager.ts` | 수정 |
| 1-3 | `indexFile()` → Backend.upsertDocument() 위임 | `src/memory/manager.ts` | 수정 |
| 1-4 | `getMemorySearchManager()` 팩토리에 backend 선택 로직 | `src/memory/search-manager.ts` | 수정 |
| 1-5 | Config에 `backend` 필드 추가 | `src/agents/memory-search.ts` | 수정 |
| 1-6 | Config Zod 스키마 업데이트 | `src/config/zod-schema.agent-defaults.ts` | 수정 |
| 1-7 | Config 타입 업데이트 | `src/config/types.tools.ts` | 수정 |

**핵심 설계:**
```
config.backend = "sqlite"       → SqliteVecBackend (기존 동작 100% 유지)
config.backend = "gemini-file-search" → GeminiFileSearchBackend (신규)
```

**검증 기준:**
- `backend: "sqlite"` 로 기존 전체 테스트 통과 (무회귀)
- `backend: "gemini-file-search"`로 신규 통합 테스트 통과
- `pnpm build && pnpm lint && pnpm test` 전부 통과

---

### Phase 2: Gemini File Search 동기화 파이프라인

**목표:** 파일 변경 시 로컬 청킹 대신 Google API로 업로드

**작업:**

| # | 태스크 | 파일 | 변경 타입 |
|---|--------|------|-----------|
| 2-1 | Store 생명주기 관리 (생성/조회/삭제) | `src/memory/gemini-file-search-client.ts` | 수정 |
| 2-2 | 파일 업로드 + 청킹 설정 전달 | `src/memory/gemini-file-search-backend.ts` | 수정 |
| 2-3 | 파일 변경 감지 → 업로드 트리거 | `src/memory/sync-memory-files.ts` | 수정 |
| 2-4 | 세션 파일 변경 → 업로드 트리거 | `src/memory/sync-session-files.ts` | 수정 |
| 2-5 | 해시 기반 변경 감지 (중복 업로드 방지) | `src/memory/gemini-file-search-backend.ts` | 수정 |
| 2-6 | 삭제된 파일 정리 (Store에서 제거) | `src/memory/gemini-file-search-backend.ts` | 수정 |

**Gemini File Search API 호출 매핑:**

```
현재: chunkMarkdown() + embedChunksInBatches() + INSERT
교체: POST /upload/v1beta/{storeName}:uploadToFileSearchStore
      Body: { file: <content>, config: { chunkingConfig: {...} } }
```

**동기화 전략:**

```
파일 변경 감지 (chokidar watcher)
     ↓
해시 비교 (로컬 JSON 매니페스트)
     ↓ (변경 있음)
기존 문서 삭제 (DELETE /{storeName}/documents/{docId})
     ↓
신규 업로드 (POST /upload/.../uploadToFileSearchStore)
     ↓
매니페스트 업데이트 (path → docId, hash 매핑)
```

**매니페스트 파일** (로컬 상태 추적):
```json
// ~/.openclaw/state/memory/{agentId}.file-search-manifest.json
{
  "storeId": "fileSearchStores/abc123",
  "documents": {
    "MEMORY.md": { "docId": "documents/xyz", "hash": "sha256...", "uploadedAt": 1706... },
    "memory/2026-02-03.md": { "docId": "documents/uvw", "hash": "sha256...", "uploadedAt": 1706... }
  }
}
```

**검증 기준:**
- 파일 생성/수정/삭제 시 Store가 올바르게 동기화
- 동일 파일 재업로드 방지 (해시 변경 없으면 스킵)
- 네트워크 에러 시 재시도 (3회, 지수 백오프)

---

### Phase 3: 검색 파이프라인 교체

**목표:** 로컬 벡터/BM25 검색을 Gemini File Search 쿼리로 교체

**작업:**

| # | 태스크 | 파일 | 변경 타입 |
|---|--------|------|-----------|
| 3-1 | search() → generateContent(file_search) 호출 | `src/memory/gemini-file-search-backend.ts` | 수정 |
| 3-2 | grounding_metadata 파싱 → MemorySearchResult 변환 | `src/memory/gemini-file-search-backend.ts` | 수정 |
| 3-3 | memory_get 도구 (파일 읽기는 로컬 유지) | 변경 없음 | — |
| 3-4 | 검색 결과에 출처 인용 포함 | `src/memory/gemini-file-search-backend.ts` | 수정 |

**검색 API 호출:**

```typescript
// memory_search("프로젝트 설정 방법") 호출 시
const response = await fetch(
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-preview:generateContent?key=${apiKey}`,
  {
    method: "POST",
    body: JSON.stringify({
      contents: [{ parts: [{ text: query }] }],
      tools: [{
        file_search: {
          file_search_store_names: [storeId],
          top_k: maxResults
        }
      }],
      // 검색만 수행, 답변 생성 최소화
      generationConfig: {
        maxOutputTokens: 256,
        temperature: 0
      }
    })
  }
);

// grounding_metadata에서 결과 추출
const grounding = response.candidates[0].grounding_metadata;
const results: MemorySearchResult[] = grounding.grounding_chunks.map(chunk => ({
  path: chunk.retrieved_context.title,
  snippet: chunk.retrieved_context.text,
  score: chunk.retrieved_context.relevance_score ?? 0.5,
  // startLine/endLine: 청크 텍스트에서 역추적 또는 메타데이터 활용
}));
```

**중요 설계 결정: 검색 전용 vs 통합 생성**

두 가지 옵션:

| 옵션 | 방식 | 장점 | 단점 |
|---|---|---|---|
| **A. 검색 전용** | file_search로 관련 청크만 가져오고, 에이전트에 반환 | 기존 도구 인터페이스 유지, 에이전트가 결과 해석 | API 호출 2번 (검색 + 본 응답) |
| **B. 통합 생성** | 에이전트의 generateContent에 file_search 도구 직접 포함 | API 호출 1번, 가장 효율적 | memory_search 도구 제거 필요, 아키텍처 대변경 |

**추천: 옵션 A (검색 전용)**
- 기존 도구 인터페이스 (`memory_search` → 결과 반환 → 에이전트가 활용) 유지
- 마이그레이션 범위 최소화
- 나중에 옵션 B로 진화 가능

**검증 기준:**
- `memory_search` 도구 호출 시 관련 메모리 반환
- 결과 형식이 기존 `MemorySearchResult`와 호환
- 검색 레이턴시 측정 (로컬 대비 증가분 확인)

---

### Phase 4: CLI 및 상태 업데이트

**목표:** CLI 명령어와 상태 보고가 새 백엔드를 반영

**작업:**

| # | 태스크 | 파일 | 변경 타입 |
|---|--------|------|-----------|
| 4-1 | `memory status` — Store 정보 표시 | `src/cli/memory-cli.ts` | 수정 |
| 4-2 | `memory index` — 강제 재업로드 | `src/cli/memory-cli.ts` | 수정 |
| 4-3 | `memory search` — 검색 결과 표시 | `src/cli/memory-cli.ts` | 수정 (최소) |
| 4-4 | `status --deep` — 메모리 프로브 | `src/commands/status.scan.ts` | 수정 |
| 4-5 | Store 사용량/문서 수 보고 | `src/memory/status-format.ts` | 수정 |

**CLI 출력 변경 예시:**

```
# 현재
Memory: indexed (sqlite-vec, 42 chunks, gemini-embedding-001)

# 변경 후
Memory: synced (gemini-file-search, 12 documents, store: fileSearchStores/abc123)
```

---

### Phase 5: memoryFlush 통합

**목표:** memoryFlush가 생성한 파일이 자동으로 Store에 반영

**작업:**

| # | 태스크 | 파일 | 변경 타입 |
|---|--------|------|-----------|
| 5-1 | memoryFlush 후 파일 감지 → 자동 업로드 | 기존 watcher로 커버 | 변경 없음 |
| 5-2 | /new 세션 메모리 생성 → 자동 업로드 | 기존 watcher로 커버 | 변경 없음 |

**참고:** 파일 watcher가 `memory/` 디렉토리를 감시하므로, memoryFlush가 `memory/2026-02-03.md`를 생성하면 자동으로 sync 트리거됨. 별도 코드 변경 불필요할 수 있음. 단, watcher → 업로드 지연 시간 확인 필요.

---

### Phase 6: 레거시 코드 정리

**목표:** 사용하지 않는 로컬 벡터 DB 코드 제거

**작업:**

| # | 태스크 | 제거 대상 |
|---|--------|-----------|
| 6-1 | SQLite 벡터 관련 파일 삭제 | `sqlite-vec.ts`, `sqlite.ts`, `memory-schema.ts` |
| 6-2 | 임베딩 프로바이더 삭제 | `embeddings.ts`, `embeddings-openai.ts`, `embeddings-gemini.ts`, `node-llama.ts` |
| 6-3 | 배치 처리 삭제 | `batch-openai.ts`, `batch-gemini.ts`, `openai-batch.ts` |
| 6-4 | 검색/하이브리드 삭제 | `manager-search.ts`, `hybrid.ts`, `manager-cache-key.ts` |
| 6-5 | 청킹 로직 삭제 | `internal.ts`의 chunkMarkdown(), cosineSimilarity() |
| 6-6 | 의존성 제거 | `package.json`: `sqlite-vec`, `node-llama-cpp` |
| 6-7 | 관련 테스트 삭제/재작성 | 14개 테스트 파일 |
| 6-8 | LanceDB 확장 상태 결정 | `extensions/memory-lancedb/` (유지 or 제거) |

**위험:** 이 단계는 되돌리기 어려움. Phase 5까지 완전히 검증된 후에만 실행.

---

### Phase 7: 문서 및 설정 업데이트

**작업:**

| # | 태스크 | 파일 |
|---|--------|------|
| 7-1 | 메모리 개념 문서 업데이트 | `docs/concepts/memory.md` |
| 7-2 | CLI 레퍼런스 업데이트 | `docs/cli/memory.md` |
| 7-3 | 설정 가이드 추가 (API 키, Store 관리) | `docs/configuration.md` (섹션 추가) |
| 7-4 | 마이그레이션 가이드 작성 | `docs/migration/memory-file-search.md` (신규) |

---

## 3. 위험 요소 및 완화 방안

### 3.1 기술적 위험

| 위험 | 심각도 | 확률 | 완화 방안 |
|---|---|---|---|
| **BM25 키워드 검색 손실** | 중 | 확정 | Gemini File Search는 시맨틱 only. 정확한 키워드 매칭이 필요한 경우 `memory_get`(파일 직접 읽기)으로 보완. 또는 쿼리를 자연어로 변환하여 시맨틱 검색 품질 확보 |
| **네트워크 의존성** | 고 | 중 | 오프라인 폴백: 캐시된 최근 검색 결과 반환 or `SqliteVecBackend` 자동 전환 |
| **API 레이턴시** | 중 | 중 | 로컬 검색(~5ms) → API 검색(~200-500ms). 에이전트 응답에 체감 영향은 미미(LLM 호출 자체가 수초). 검색 프리페치로 보완 가능 |
| **Store 10개 제한** | 중 | 중 | 에이전트당 Store 매핑 전략 필요. 다중 에이전트 시 Store 풀링 or 단일 Store에 메타데이터 필터로 분리 |
| **파일 크기 100MB 제한** | 낮 | 낮 | 메모리 파일은 일반적으로 수KB~수MB. 세션 트랜스크립트만 주의 |
| **API 장애/변경** | 중 | 낮 | Backend 추상화로 `SqliteVecBackend` 즉시 전환 가능 |
| **임베딩 모델 고정** | 낮 | 확정 | `gemini-embedding-001` 변경 불가. 현재도 Gemini 사용 시 동일 모델이므로 영향 없음 |

### 3.2 운영 위험

| 위험 | 심각도 | 완화 방안 |
|---|---|---|
| **API 키 관리** | 중 | 기존 Gemini API 키 공유 가능. 별도 키 불필요 |
| **비용 예측 불가** | 중 | 메모리 파일 총량 기준 산정: 1MB 메모리 ≈ 250K 토큰 ≈ 인덱싱 $0.04. 일반 사용 시 월 $1 미만 |
| **데이터 주권** | 중 | 메모리 파일이 Google 서버에 저장됨. 민감 데이터 포함 시 별도 고려 필요 |
| **기존 사용자 마이그레이션** | 중 | `backend: "sqlite"` 폴백으로 기존 동작 유지 옵션 제공 |

---

## 4. 의존성 그래프 (변경 영향 범위)

```
[변경 없음 — 인터페이스만 소비]
├── src/agents/tools/memory-tool.ts     (memory_search, memory_get)
├── src/agents/workspace.ts             (MEMORY.md bootstrap — 파일 시스템 직접 읽기, 변경 없음)
├── src/auto-reply/reply/memory-flush.ts (설정만, 변경 없음)
├── src/agents/tool-policy.ts           (도구 이름만, 변경 없음)
├── src/agents/system-prompt.ts         (도구 존재 여부만, 변경 없음)
├── src/agents/pi-tools.policy.ts       (도구 이름만, 변경 없음)
├── src/gateway/tools-invoke-http.ts    (도구 이름만, 변경 없음)

[최소 수정 — 팩토리/설정]
├── src/memory/search-manager.ts        (Backend 선택 로직 추가)
├── src/memory/index.ts                 (export 업데이트)
├── src/agents/memory-search.ts         (config에 backend 필드 추가)
├── src/config/types.tools.ts           (타입 추가)
├── src/config/zod-schema.agent-defaults.ts (스키마 추가)

[중간 수정 — 동작 변경]
├── src/memory/manager.ts               (Backend 위임으로 재작성)
├── src/memory/sync-memory-files.ts     (업로드 트리거로)
├── src/memory/sync-session-files.ts    (업로드 트리거로)
├── src/cli/memory-cli.ts               (상태/인덱스 출력 변경)
├── src/commands/status.scan.ts         (프로브 변경)

[신규 추가]
├── src/memory/backend.ts               (인터페이스)
├── src/memory/gemini-file-search-client.ts  (API 클라이언트)
├── src/memory/gemini-file-search-backend.ts (Backend 구현)
├── src/memory/sqlite-backend.ts        (기존 코드 래핑)

[제거 (Phase 6)]
└── 15개 파일 + 2개 의존성
```

---

## 5. 검증 게이트

각 Phase 완료 시 반드시 통과해야 하는 게이트:

### Gate 0 (기반 정비 후)
- [ ] `pnpm build` 성공
- [ ] `pnpm test` 전체 통과 (기존 테스트 100% 유지)
- [ ] 신규 파일 단위 테스트 통과
- [ ] Gemini File Search API 연결 검증 (실제 API 키로 Store CRUD)

### Gate 1 (Backend 추상화 후)
- [ ] `backend: "sqlite"` 설정 시 기존 동작 100% 동일
- [ ] `backend: "gemini-file-search"` 설정 시 기본 검색 동작
- [ ] `pnpm build && pnpm lint && pnpm test` 전체 통과

### Gate 2 (동기화 파이프라인 후)
- [ ] 파일 생성 → Store 업로드 확인
- [ ] 파일 수정 → Store 문서 갱신 확인
- [ ] 파일 삭제 → Store 문서 제거 확인
- [ ] 해시 미변경 시 업로드 스킵 확인
- [ ] 네트워크 에러 재시도 확인

### Gate 3 (검색 파이프라인 후)
- [ ] `memory_search` 호출 → 관련 결과 반환
- [ ] 결과 형식이 기존 `MemorySearchResult` 호환
- [ ] 레이턴시 < 2초 (API 응답 시간 포함)
- [ ] 결과 없을 시 빈 배열 반환 (크래시 없음)

### Gate 4 (CLI 업데이트 후)
- [ ] `openclaw memory status` — Store 정보 표시
- [ ] `openclaw memory index` — 전체 재업로드
- [ ] `openclaw memory search "query"` — 검색 결과 표시

### Gate 5 (memoryFlush 통합 후)
- [ ] memoryFlush 실행 → 파일 생성 → Store 자동 반영
- [ ] `/new` 명령 → 메모리 파일 생성 → Store 자동 반영

### Gate 6 (레거시 정리 후)
- [ ] 삭제된 파일에 대한 import 에러 없음
- [ ] `pnpm build && pnpm lint && pnpm test` 전체 통과
- [ ] `package.json`에서 `sqlite-vec`, `node-llama-cpp` 제거 확인
- [ ] 번들 크기 감소 확인

---

## 6. 타임라인 정렬

```
Phase 0: 기반 정비 ─────────────────── 신규 파일 추가만, 기존 코드 무변경
     ↓ Gate 0 통과
Phase 1: Backend 추상화 ─────────────── MemoryIndexManager 리팩토링
     ↓ Gate 1 통과
Phase 2: 동기화 파이프라인 ──────────── 파일 → Store 업로드
     ↓ Gate 2 통과
Phase 3: 검색 파이프라인 ───────────── generateContent(file_search)
     ↓ Gate 3 통과
Phase 4: CLI/상태 ──────────────────── 표시 업데이트
     ↓ Gate 4 통과
Phase 5: memoryFlush 통합 ─────────── E2E 검증
     ↓ Gate 5 통과
     ↓
     ↓ ═══ 여기서 backend="gemini-file-search"를 default로 전환 ═══
     ↓
Phase 6: 레거시 정리 ──────────────── 코드/의존성 제거
     ↓ Gate 6 통과
Phase 7: 문서화 ────────────────────── 완료
```

---

## 7. 대안 검토

### 7.1 Vertex AI RAG Engine

| 항목 | Gemini File Search | Vertex AI RAG Engine |
|---|---|---|
| 설정 복잡도 | API 키만 | GCP 프로젝트 + IAM + 서비스 계정 |
| 하이브리드 검색 | 불가 | **가능** (dense + sparse) |
| 임베딩 모델 선택 | 고정 | 선택 가능 |
| 비용 | $0.15/1M 인덱싱 + 토큰 | $2.50/1K 쿼리 + 인덱싱 + Spanner |
| 8GB 서버 적합성 | API만 호출 → 적합 | API만 호출 → 적합 |

**결론:** 하이브리드 검색이 필수가 아니라면 Gemini File Search가 압도적으로 간단. BM25 손실이 치명적으로 판명되면 Phase 3에서 Vertex AI RAG Engine으로 전환 가능 (Backend 추상화가 이를 지원).

### 7.2 하이브리드 접근: File Search + 로컬 FTS5

File Search(시맨틱)와 로컬 FTS5(키워드)를 병행하는 절충안:

```
memory_search 호출
  ├→ Gemini File Search (시맨틱) → 결과 A
  └→ 로컬 FTS5 (BM25) → 결과 B
  → 기존 hybrid.ts로 병합 → 최종 결과
```

**장점:** BM25 유지, **단점:** SQLite 의존성 잔존 (sqlite-vec만 제거, FTS5는 유지)

이 접근은 Phase 3에서 A/B 테스트 후 결정 가능.

---

## 8. 미결정 사항 (의사결정 필요)

| # | 질문 | 옵션 | 추천 |
|---|------|------|------|
| D-1 | Store 매핑 전략 | (a) 에이전트당 1 Store (b) 전체 1 Store + 메타데이터 필터 | **(b)** — Store 10개 제한 고려 |
| D-2 | 세션 트랜스크립트 포함 여부 | (a) 메모리 파일만 (b) 세션도 포함 | **(a)** 우선 — 세션은 크기 무제한 증가 |
| D-3 | 검색 시 LLM 응답 생성 | (a) 검색 결과만 반환 (b) LLM이 요약해서 반환 | **(a)** — 기존 인터페이스 유지 |
| D-4 | SqliteVecBackend 유지 기간 | (a) Phase 6에서 즉시 제거 (b) 설정 옵션으로 장기 유지 | **(a)** — 복잡도 제거 |
| D-5 | API 키 설정 위치 | (a) 기존 Gemini 키 공유 (b) 별도 `fileSearchApiKey` | **(a)** — 중복 설정 방지 |
| D-6 | memory_get 도구 유지 | (a) 로컬 파일 읽기 유지 (b) Store에서 가져오기 | **(a)** — 로컬 파일이 더 빠르고 정확 |

---

## 9. 소스 파일 전체 목록 (영향받는 파일)

### 신규 생성 (4개)
```
src/memory/backend.ts
src/memory/gemini-file-search-client.ts
src/memory/gemini-file-search-backend.ts
src/memory/sqlite-backend.ts
```

### 수정 (11개)
```
src/memory/manager.ts
src/memory/search-manager.ts
src/memory/index.ts
src/memory/sync-memory-files.ts
src/memory/sync-session-files.ts
src/memory/status-format.ts
src/agents/memory-search.ts
src/config/types.tools.ts
src/config/zod-schema.agent-defaults.ts
src/cli/memory-cli.ts
src/commands/status.scan.ts
```

### 삭제 (15개)
```
src/memory/sqlite-vec.ts
src/memory/sqlite.ts
src/memory/memory-schema.ts
src/memory/embeddings.ts
src/memory/embeddings-openai.ts
src/memory/embeddings-gemini.ts
src/memory/node-llama.ts
src/memory/batch-openai.ts
src/memory/batch-gemini.ts
src/memory/openai-batch.ts
src/memory/hybrid.ts
src/memory/manager-search.ts
src/memory/manager-cache-key.ts
src/memory/headers-fingerprint.ts
src/memory/internal.ts (chunkMarkdown 등 — 일부 유틸은 보존 가능)
```

### 변경 없음 (12개 — 소비자)
```
src/agents/tools/memory-tool.ts
src/agents/workspace.ts
src/auto-reply/reply/memory-flush.ts
src/auto-reply/reply/agent-runner-memory.ts
src/agents/tool-policy.ts
src/agents/system-prompt.ts
src/agents/pi-tools.policy.ts
src/gateway/tools-invoke-http.ts
src/hooks/bundled/session-memory/handler.ts
src/plugins/runtime/index.ts
src/plugins/runtime/types.ts
extensions/memory-core/index.ts
```
