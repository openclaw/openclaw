# Claude Code 생태계 컨텍스트 관리 솔루션 비교 분석

**조사일:** 2026-02-02
**분석자:** Claude Opus 4.5
**목적:** OpenClaw의 컨텍스트 관리 확장을 위한 외부 솔루션 탐색

---

## 배경

Claude Code 생태계에서 활발히 논의 중인 3가지 컨텍스트 관리 해법을 조사:
1. **claude-mem** — Plugin + Vector DB 기반 세션 간 메모리 영속
2. **Ralph Loop** — 반복 루프 + 파일 기반 영속성
3. **RLM Skill** — MIT CSAIL 논문 기반 재귀적 LLM 컨텍스트 분해

---

## 1. claude-mem 계열 (Plugin + Vector DB)

### 1.1 thedotmack/claude-mem ★~18,100

- **URL:** https://github.com/thedotmack/claude-mem
- **라이선스:** AGPL-3.0 (ragtime 하위 디렉토리는 PolyForm Noncommercial 1.0.0)
- **기술스택:** TypeScript (83.6%), Bun 런타임, SQLite 3, ChromaDB

#### 아키텍처 (6 핵심 컴포넌트)

1. **Lifecycle Hooks** — 5개 훅 포인트 (`SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd`)로 세션 데이터 자동 캡처
2. **Smart Install** — Pre-hook 스크립트 + 의존성 캐싱으로 빠른 시작
3. **Worker Service** — HTTP API (port 37777, Bun 런타임), 웹 뷰어 UI + 검색 엔드포인트
4. **SQLite Database** — 세션 및 관찰 데이터 영속 저장
5. **mem-search Skill** — 3단계 검색: compact index → chronological context → selective detail (~10x 토큰 효율)
6. **ChromaDB** — 하이브리드 semantic + keyword 검색

#### 통합 방식
Claude Code Plugin + MCP (Model Context Protocol) 도구 + Lifecycle Hooks. 4개 MCP 도구 노출.

#### "Endless Mode" (베타)
생체모방 메모리 아키텍처로 확장 세션 지원.

#### 주요 문제점
- Windows 호환성 깨짐 (`wmic` 사용 중단, `bun:sqlite` 미지원 등)
- 고부하 시 deadlock (관찰 생성기 교착)
- DB 손상 가능성 (Gemini API 요약 실패 시)
- `CLAUDE.md` 동시수정 충돌
- macOS 좀비 프로세스 (서브프로세스 정리 실패)
- 176개 브랜치 (과도한 브랜치 스프롤)

### 1.2 기타 메모리 플러그인

| 레포 | Stars | 통합방식 | 저장소 | 차별점 |
|---|---|---|---|---|
| supermemoryai/claude-supermemory | ~1,900 | Plugin | Supermemory 클라우드 | 가장 간단한 설정; 유료 구독 필요 |
| doobidoo/mcp-memory-service | ~1,300 | MCP 서버 (Python) | SQLite + Cloudflare | 13개 이상 AI 도구 지원; 5ms 컨텍스트 주입 |
| GMaN1911/claude-cognitive | ~432 | Shell Hook | 파일 기반 | attention 기반 3티어 (HOT/WARM/COLD); 멀티 인스턴스 조율 |
| memvid/claude-brain | ~184 | Plugin | 단일 `.mv2` (Rust) | 가장 이식성 높음; git 커밋 가능; sub-ms 검색 |
| julep-ai/memory-store-plugin | 6 | MCP | 클라우드 | **아카이브됨** (2025.12.27) |

---

## 2. Ralph Loop 계열 (반복 루프 + 파일 기반 영속성)

### 2.1 두 가지 아키텍처

#### Architecture A: Stop Hook (동일 세션 내)

```
[/ralph-loop 시작]
       ↓
[Claude 작업 수행] ←──────┐
       ↓                   │
[Claude 종료 시도]          │
       ↓                   │
[Stop hook 가로채기] ──────┘
  (completion promise 검사)
  (미발견 시 프롬프트 재주입)
       ↓ (발견 시)
[세션 정상 종료]
```

- 컨텍스트 **누적** (같은 대화 히스토리)
- 위험: 장시간 작업 시 컨텍스트 오버플로 + 손실성 압축

#### Architecture B: 외부 Bash 루프 (매 반복 fresh context)

```
[while true 루프]
       ↓
[새 Claude 인스턴스 생성] ←──────┐
  - PROMPT.md 읽기               │
  - progress.md/tasks 읽기        │
  - git 히스토리/파일 읽기          │
       ↓                          │
[Claude 작업 → 커밋 → 종료]       │
       ↓                          │
[완료 신호 검사] ─────────────────┘
  (미완료 시 루프 반복)
```

- 매 반복 **완전히 새로운 컨텍스트 윈도**
- 메모리 = 파일시스템 (Git commits, progress.md, CLAUDE.md, 테스트 결과)

### 2.2 주요 레포

| 레포 | Stars | 타입 | 핵심 특징 |
|---|---|---|---|
| **anthropics/claude-code** (plugins/ralph-wiggum/) | 63,400 (부모) | 공식 Plugin (Arch A) | Stop hook 기반. **현재 깨짐** (CVE-2025-54795) |
| ghuntley/how-to-ralph-wiggum | ~1,200 | 가이드 (Arch B) | 원조. 5줄 bash loop |
| Th0rgal/open-ralph-wiggum | ~731 | CLI (Arch B) | Agent-agnostic (Claude/Codex/OpenCode) |
| mikeyobrien/ralph-orchestrator | — | Framework (Arch B) | 가장 고기능. Multi-backend, Hat 시스템, Web TUI |
| wiggumdev/ralph | — | npm TUI (Arch B) | Lifecycle hooks, completion detection |
| frankbria/ralph-claude-code | — | Bash (Arch B) | Dual-condition exit, rate limiting, 465 tests |
| vercel-labs/ralph-loop-agent | — | TS SDK (Arch B) | Vercel AI SDK wrapper, 컨텍스트 요약 포함 |
| dial481/ralph | — | Plugin (Arch A fix) | CVE-2025-54795 우회. Write tool로 상태 파일 생성 |

### 2.3 메모리 영속 메커니즘 (Architecture B)

- **Git commits**: 매 반복마다 커밋 → 세밀한 체크포인트
- **Progress/task 파일**: `progress.md`, `tasks.jsonl`, 마크다운 체크리스트
- **PRD/spec 파일**: 최종 상태 정의; 매 반복 읽기
- **Learnings/scratchpad**: `.agent/memories.md` 등 장기 계획
- **CLAUDE.md**: 세션 시작 시 자동 로드
- **테스트 결과**: 자동 검증 피드백 루프

---

## 3. RLM Skill 계열 (재귀적 LLM 컨텍스트 분해)

### 3.1 원논문

- **제목:** "Recursive Language Models"
- **저자:** Alex L. Zhang, Tim Kraska, Omar Khattab (MIT CSAIL / MIT OASYS Lab)
- **출판:** arXiv:2512.24601 (2025.12.31 v1, 2026.01.28 v2)
- **공식 구현:** alexzhang13/rlm (★~1,900, 372 forks)

#### 핵심 개념
- 전체 컨텍스트를 프롬프트에 넣는 대신, 프롬프트를 **외부 변수**로 취급
- LLM이 REPL 환경에서 프로그래밍적으로 컨텍스트를 분해하고 재귀 호출
- 모델 컨텍스트 윈도의 **100배** 이상 입력 처리 가능
- Agent = **태스크** 기준 분해 vs RLM = **컨텍스트** 기준 분해

### 3.2 Claude Code RLM 구현체

| 레포 | Stars | 통합방식 | 핵심 특징 |
|---|---|---|---|
| **brainqub3/claude_code_RLM** | **305** | Skill + Sub-agent | Claude Code 특화 1위. Root(Opus)+Sub(Haiku)+Python REPL |
| BowTiedSwan/rlm-skill | 134 | Skill 파일 | Native/Strict 2모드. Map-Reduce 병렬 에이전트 |
| rand/rlm-claude-code | 50 | Plugin (Python) | 가장 고기능. Complexity Classifier, 모델 자동 라우팅 |
| EncrEor/rlm-claude | 11 | MCP 서버 | 14 MCP 도구, 3-zone 메모리, PreCompact hook |
| zircote/rlm-rs | 0 | Rust CLI + Plugin | 4가지 청킹 전략, BM25+semantic 하이브리드 검색 |

### 3.3 주요 구현 상세

#### brainqub3/claude_code_RLM (★305)
- **Root LLM** (Opus 4.5): 오케스트레이션
- **Sub-LLM** (Haiku): `.claude/agents/rlm-subcall.md` 서브에이전트로 청크별 분석
- **External Environment**: Python REPL (`rlm_repl.py`)로 상태 유지 + 청킹 유틸리티
- **워크플로**: `/rlm` 호출 → REPL 초기화 → 문서 분할 → Haiku 청크 분석 → 결과 합성

#### BowTiedSwan/rlm-skill (★134)
- **Native Mode**: `grep`/`find`로 빠른 파일시스템 탐색, 의존성 없음
- **Strict Mode**: `rlm.py` 엔진으로 프로그래밍적 슬라이싱
- **파이프라인**: Index → Filter → Map (병렬 에이전트) → Reduce
- 키워드 자동 트리거: "analyze codebase", "scan all files", "RLM"

#### rand/rlm-claude-code (★50)
- **Complexity Classifier**: 토큰 수, 파일 간 참조, 쿼리 패턴 분석
- **Model Selection**: Opus/Sonnet/Haiku 자동 라우팅
- **REPL 샌드박스**: `peek()`, `search()`, `llm()`, `llm_batch()`, `map_reduce()`, `find_relevant()` + 메모리 연산
- **Persistence**: SQLite+WAL, 계층적 메모리 진화 (task → session → long-term → archive)
- **재귀 깊이**: 0-3 레벨 configurable

#### EncrEor/rlm-claude (★11)
- **14 MCP 도구**로 3가지 필러: Insights (결정/사실), Chunks (대화 세그먼트), Retention (Active→Archive→Purge)
- **PreCompact 훅**: `/compact` 시 자동 스냅샷 → 세션 간 무손실 메모리
- **검색**: Regex + BM25 + Model2Vec/FastEmbed semantic + hybrid fusion
- **SHA-256 중복 제거**, 2MB 청크 크기 제한

---

## 4. OpenClaw 확장 관점 비교 평가

### 4.1 문제 해결 대상 비교

| 솔루션 | 해결하는 문제 | 한계 |
|---|---|---|
| claude-mem | 세션 간 메모리 영속, 자동 캡처/검색 | 단일 세션 내 컨텍스트 관리는 미해결 |
| Ralph Loop | 단일 태스크의 무한 반복 실행, 컨텍스트 오버플로 방지 | 메모리가 파일에만 의존, 미묘한 추론 맥락 손실 |
| RLM Skill | 초대형 컨텍스트 분석 (윈도 100배+) | 실전 검증 부족, sub-LLM API 비용 |

### 4.2 OpenClaw 아키텍처 호환성

| 기준 | claude-mem | Ralph Loop | RLM Skill |
|---|---|---|---|
| **Plugin Hook 활용** | `session_start/end`, `before_tool_call`, `tool_result_persist`, `before/after_compaction` 활용 가능 | 외부 루프만 적용 가능 (Stop hook 구조 다름) | `registerTool()`로 커스텀 도구 등록 가능 |
| **Skill 시스템 활용** | 불가 (자동 트리거 필요) | 불가 (외부 실행) | Skill 파일로 `/rlm` 명령 제공 가능하나 자동 트리거 불가 |
| **MCP 호환** | MCP 사용하지만 OpenClaw은 MCP 미지원 → **직접 포팅 필요** | MCP 무관 | EncrEor 구현만 MCP → **직접 포팅 필요** |
| **Gemini 3 Pro 호환** | ChromaDB/SQLite 독립 → 호환 | 모델 무관 → 완전 호환 | Sub-LLM 호출이 핵심 → Gemini API로 대체 필요 |
| **8GB RAM 영향** | +200-500MB (ChromaDB+SQLite+Worker) | 거의 없음 (파일 기반) | +50-100MB (Python REPL) |

### 4.3 기존 OpenClaw 시스템과의 겹침

| OpenClaw 기존 기능 | claude-mem 대응 | Ralph Loop 대응 | RLM 대응 |
|---|---|---|---|
| MEMORY.md bootstrap | `SessionStart` hook으로 메모리 주입 | CLAUDE.md 자동 로드 | — |
| memoryFlush | `Stop`/`SessionEnd` hook 자동 저장 | Git commit으로 영속화 | PreCompact hook (EncrEor) |
| memory_search 도구 | 3단계 검색 (더 정교) | 불가 | BM25+semantic 검색 |
| Context Pruning | — | fresh context로 우회 | 청킹으로 우회 |
| session-memory hook | `PostToolUse` 자동 캡처 | 파일 기반 | Chunks 자동 저장 |

---

## 5. 추천 전략

OpenClaw의 컨텍스트 관리를 확장하려면 **3가지를 조합**:

### 5.1 우선순위 1: claude-mem 패턴의 Plugin 구현
- OpenClaw Plugin Hook (`session_start`, `tool_result_persist`, `before_compaction`)으로 구현
- SQLite + 벡터 검색 (Gemini embedding API 활용)
- `registerTool()`로 `mem-search` 커스텀 도구 등록
- **가장 자연스러운 통합 경로** — 14개 Plugin Hook이 이미 존재

### 5.2 우선순위 2: Ralph Loop (Architecture B) 외부 래퍼
- 대규모 태스크 처리 시 `openclaw` CLI를 반복 호출하는 외부 스크립트
- OpenClaw 내부 수정 없이 적용 가능
- 기존 memoryFlush + MEMORY.md bootstrap과 자연스럽게 연동

### 5.3 우선순위 3: RLM 청킹 전략의 도구화
- `registerTool()`로 `rlm-analyze` 커스텀 도구 등록
- 대용량 파일/코드베이스 분석 시 sub-agent 패턴 활용
- Gemini 3 Pro의 1M 토큰 윈도에서는 긴급성이 낮음

---

## 6. 소스

- https://github.com/thedotmack/claude-mem
- https://github.com/supermemoryai/claude-supermemory
- https://github.com/doobidoo/mcp-memory-service
- https://github.com/GMaN1911/claude-cognitive
- https://github.com/memvid/claude-brain
- https://github.com/anthropics/claude-code (plugins/ralph-wiggum/)
- https://github.com/ghuntley/how-to-ralph-wiggum
- https://github.com/Th0rgal/open-ralph-wiggum
- https://github.com/mikeyobrien/ralph-orchestrator
- https://github.com/wiggumdev/ralph
- https://github.com/frankbria/ralph-claude-code
- https://arxiv.org/abs/2512.24601
- https://github.com/alexzhang13/rlm
- https://github.com/brainqub3/claude_code_RLM
- https://github.com/BowTiedSwan/rlm-skill
- https://github.com/rand/rlm-claude-code
- https://github.com/EncrEor/rlm-claude
- https://github.com/zircote/rlm-rs
