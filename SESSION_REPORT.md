# OpenClaw 아키텍처 분석 세션 보고서

**세션 일시:** 2026-02-02 ~ 2026-02-03
**분석자:** Claude Opus 4.5
**대상 레포:** https://github.com/openclaw/openclaw
**브랜치:** claude/code-review-g5IDI
**상태:** 퍼블릭 클로닝 레포 — 푸시 블로킹 (관리자 허가 필요)

---

## 목차

1. [보안 커밋 코드 리뷰](#1-보안-커밋-코드-리뷰)
2. [메모리 시스템 분석 검증](#2-메모리-시스템-분석-검증)
3. [Hook 시스템 아키텍처](#3-hook-시스템-아키텍처)
4. [Hook ↔ 세션 메모리 의존성](#4-hook--세션-메모리-의존성)
5. [운영 사양 검토](#5-운영-사양-검토)
6. [컨텍스트 관리 솔루션 조사](#6-컨텍스트-관리-솔루션-조사)
7. [벡터 DB 현황 분석](#7-벡터-db-현황-분석)
8. [마이그레이션 기획 → 무효화](#8-마이그레이션-기획--무효화)
9. [3대 솔루션 정렬 검사](#9-3대-솔루션-정렬-검사)
10. [Ralph Loop + RLM 통합 전략](#10-ralph-loop--rlm-통합-전략)
11. [tool_choice 강제 주입 분석](#11-tool_choice-강제-주입-분석)
12. [결론 및 다음 단계](#12-결론-및-다음-단계)

---

## 1. 보안 커밋 코드 리뷰

**대상:** b796f6e..411d5fd (5개 커밋)

| 커밋 | 내용 | 평가 |
|---|---|---|
| b796f6e | 환경변수 검증 강화 | CWE-20 대응. 양호 |
| c3a1d2e | 웹 도구 하드닝 (URL 검증) | SSRF 방어. 양호 |
| d8f4e5a | 프롬프트 인젝션 방어 | 외부 콘텐츠 새니타이징. 양호 |
| e7b2c1f | exec 도구 커맨드 인젝션 방어 | CWE-78 대응. 양호 |
| 411d5fd | SSE 클라이언트 타임아웃 추가 | CWE-400 (DoS) 대응. 양호 |

**산출물:** `CODE_REVIEW.md` (로컬)

---

## 2. 메모리 시스템 분석 검증

외부 제공된 메모리 시스템 분석 보고서를 코드 기반으로 검증.

**정확도:** ~75-80%

### 주요 오류 정정 (9건)

| 섹션 | 원본 주장 | 사실 |
|---|---|---|
| 2.4 | 일일 로그 자동 참조 | **FALSE** — `resolveMemoryBootstrapEntries()`는 MEMORY.md만 로드 |
| 3.2 | memoryFlush 기본값 off | **FALSE** — `enabled ?? true` (기본 ON) |
| 3.2 | memoryFlush 프롬프트 (의역) | 실제: `"Pre-compaction memory flush turn..."`, `"Store durable memories now..."` |
| 4 | PRUNE 경로 (간략) | 2단계 알고리즘: soft trim(0.3) → hard clear(0.5), keepLastAssistants=3 |
| 5 | CLI `prune` 서브커맨드 존재 | **FALSE** — `status`, `index`, `search` 3개만 존재 |
| 7 | 소스 맵 (불완전) | 5+ 핵심 파일 누락 → 26개로 확장 |

**산출물:** `MEMORY_SYSTEM_ANALYSIS.md` (로컬)

---

## 3. Hook 시스템 아키텍처

### 2개 분리된 훅 시스템

| 시스템 | 위치 | 유형 | 트리거 |
|---|---|---|---|
| **Internal Hooks** | `src/hooks/` | 이벤트 기반 (command, session, agent, gateway) | 내부 이벤트 |
| **Plugin Hooks** | `src/plugins/hooks.ts` | 14종 (before/after 패턴) | 플러그인 등록 |

### Plugin Hook 14종

```
before_agent_start, agent_end,
before_compaction, after_compaction,
message_received, message_sending, message_sent,
before_tool_call, after_tool_call, tool_result_persist,
session_start, session_end,
gateway_start, gateway_stop
```

### Skill 시스템

- SKILL.md 마크다운 기반
- 시스템 프롬프트에 주입 (tool_use로 등록되지 않음)
- **자동 트리거 불가** — LLM 해석에 의존
- `SkillCommandDispatchSpec`: `kind: "tool"`, `toolName`, `argMode`

---

## 4. Hook ↔ 세션 메모리 의존성

### 5대 의존 경로

```
1. Bootstrap → Memory 주입
   workspace.ts → resolveMemoryBootstrapEntries() → MEMORY.md 로드

2. session-memory hook → 파일 생성
   handler.ts → /new 명령 → memory/{date}-{slug}.md 생성

3. memoryFlush → pre-compaction 저장
   memory-flush.ts → 토큰 임계값 도달 시 LLM에 저장 지시

4. tool_result_persist → 세션 기록
   session-tool-result-guard.ts → appendMessage 패치 → 동기 훅

5. transcript event → 인덱스 동기화
   transcript-events.ts → emitSessionTranscriptUpdate() → MemoryIndexManager
```

### 발견된 문제

- JSONL 파싱 중복 (handler.ts vs session-files.ts)
- memoryFlush 비결정적 (LLM 판단 의존)
- 레이스 컨디션 가능성 (watcher + 수동 인덱싱 동시 실행)

---

## 5. 운영 사양 검토

### RAM 요구사항

| 설정 | 최소 RAM | 출처 |
|---|---|---|
| API 기반 (Gemini/OpenAI) | **2GB** | fly.toml, raspberry-pi.md |
| 로컬 LLM 포함 | 16GB+ | digitalocean.md |

**결론:** 8GB + Gemini 3 Pro API = **매우 충분**

### Gemini 3 Pro 호환성

- 프로바이더 코드에 `gemini-3-pro-preview` 모델 존재
- 컨텍스트: 1,048,576 토큰 (1M)
- 최대 출력: 65,536 토큰
- memoryFlush 임계값: softThresholdTokens=4000 → 1M 기준 동작

---

## 6. 컨텍스트 관리 솔루션 조사

### 3대 카테고리, 20+ 레포 조사

#### 6.1 claude-mem 계열

| 레포 | Stars | 핵심 |
|---|---|---|
| thedotmack/claude-mem | ~18,100 | Plugin + SQLite/ChromaDB, 5 Lifecycle Hook |
| supermemoryai/claude-supermemory | ~1,900 | 클라우드 기반, 유료 |
| doobidoo/mcp-memory-service | ~1,300 | MCP 서버, Python |

#### 6.2 Ralph Loop 계열

| 레포 | Stars | 아키텍처 |
|---|---|---|
| anthropics/claude-code (plugins/ralph-wiggum/) | 63,400 (부모) | Stop Hook (A) — **현재 깨짐** |
| ghuntley/how-to-ralph-wiggum | ~1,200 | 외부 Bash 루프 (B) — 원조 |
| Th0rgal/open-ralph-wiggum | ~731 | Agent-agnostic |

#### 6.3 RLM Skill 계열

| 레포 | Stars | 핵심 |
|---|---|---|
| alexzhang13/rlm (공식) | ~1,900 | MIT CSAIL 논문 구현 |
| brainqub3/claude_code_RLM | 305 | Claude Code 특화 1위 |
| BowTiedSwan/rlm-skill | 134 | Native/Strict 2모드 |

**산출물:** `CONTEXT_MANAGEMENT_SOLUTIONS.md` (로컬)

---

## 7. 벡터 DB 현황 분석

### 핵심 발견: OpenClaw에 이미 벡터 DB 메모리 시스템이 존재

| 컴포넌트 | 구현 | 파일 |
|---|---|---|
| 벡터 저장 | SQLite + sqlite-vec (`vec0` 가상 테이블) | `src/memory/sqlite-vec.ts` |
| 텍스트 검색 | FTS5 + BM25 | `src/memory/manager-search.ts:136-187` |
| 하이브리드 검색 | 70% 벡터 + 30% BM25 | `src/memory/hybrid.ts:103` |
| 임베딩 프로바이더 | OpenAI / Gemini / Local / Auto | `src/memory/embeddings.ts` |
| 청킹 | 400토큰 / 80오버랩 | `src/memory/internal.ts:166-247` |

### 3개 SQLite 테이블

```
chunks      — 텍스트 + 임베딩 JSON + 메타데이터
chunks_vec  — vec0 벡터 인덱스 (Float32Array)
chunks_fts  — FTS5 전문검색 인덱스
```

---

## 8. 마이그레이션 기획 → 무효화

### 최초 기획: SQLite+sqlite-vec → Gemini File Search API (7 Phase)

**산출물:** `MIGRATION_PLAN.md` (로컬)

### 무효화 이유

문제 정의 오류. 실제 문제를 재진단한 결과:

```
[오진] 벡터 DB를 외부로 이전해야 한다
[정진] 임베딩 프로바이더만 Gemini로 전환하면 된다

해법: config에서 provider: "gemini" 설정 (1줄)
```

- sqlite-vec DB: 수 MB (8GB 서버에서 무시 가능)
- 로컬 임베딩(node-llama-cpp): `provider: "gemini"` 시 로드 안 됨
- Gemini 임베딩: 이미 지원됨 (`gemini-embedding-001`)
- BM25 + 라인 번호 + 튜닝: 모두 인덱싱 파이프라인 소속, 벡터 DB와 무관

**결론:** 7 Phase 마이그레이션 불필요. 설정값 1개로 해결.

---

## 9. 3대 솔루션 정렬 검사

### 교차 매트릭스

| 기능 | claude-mem | Ralph Loop | RLM | OpenClaw 기존 |
|---|:---:|:---:|:---:|:---:|
| 세션 간 메모리 영속 | 핵심 | 파일 보완 | — | **중복** |
| 자동 캡처 훅 | 핵심 | — | — | **중복** (14종) |
| 벡터+텍스트 검색 | 핵심 | — | — | **중복** (하이브리드) |
| 반복 실행 (fresh context) | — | 핵심 | — | 부분 (sessions.reset) |
| 서브에이전트 생성 | — | — | 핵심 | **중복** (sessions_spawn) |
| 에이전트 간 통신 | — | — | 핵심 | **중복** (sessions_send) |
| **분해 오케스트레이션** | — | — | 핵심 | **없음** |

### 정렬 결과

```
claude-mem  → OpenClaw과 거의 완전 중복. 흡수 불필요.
Ralph Loop  → 외부 패턴. 흡수 대상 아님.
RLM         → 프리미티브 중복, 오케스트레이션 전략만 부재.
```

---

## 10. Ralph Loop + RLM 통합 전략

### 사용자 제안 아키텍처

```
Ralph Loop (외부): 컨텍스트 황금비 도달 시 세션 종료 → fresh context 순환
  └─ RLM (내부): 각 순환 내 서브에이전트 병렬 분해 → 메인 컨텍스트 절약
```

### 레이어 분리

| 레이어 | 역할 | 효과 |
|---|---|---|
| Ralph Loop (외부) | 컨텍스트 밀도 관리 | 항상 최적 추론 구간 유지 |
| RLM (내부) | 컨텍스트 예산 효율화 | 한 순환당 처리량 극대화 |

### OpenClaw 기존 Context Pruning과의 차이

```
Context Pruning: 세션 유지, 오래된 부분 잘라냄 (손실 발생)
Ralph Loop:      세션 자체를 끊고 새로 시작 (손실 없음 — 파일로 전부 저장)
```

### 흡수에 필요한 것

OpenClaw 프리미티브 (이미 존재):
- `sessions_spawn` — 서브에이전트 생성 + 모델 오버라이드
- `sessions_send` / `sessions_history` — 에이전트 간 통신
- `sessions_list` — 상태 추적
- MEMORY.md + memory/ — 파일 기반 영속성

OpenClaw에 없는 것 (유일한 부재):
- **분해 오케스트레이션 전략** — 언제 분해, 어떻게 위임, 결과 병합

---

## 11. tool_choice 강제 주입 분석

### 현재 구현 (openresponses-http.ts:130-169)

```typescript
// tool_choice → 프롬프트 텍스트로 변환 (소프트 강제)
if (toolChoice === "required") {
  return {
    extraSystemPrompt: "You must call one of the available tools before responding.",
  };
}
```

**문제:** 시스템 프롬프트 주입은 LLM이 무시 가능.
**특히:** 저지능 모델 (Gemini 2.5 Flash 등)에서 미준수 가능성 높음.

### RLM 구조에서의 치명성

```
Root (Gemini 3 Pro)  → 프롬프트 지시 잘 따름 → 문제 없음
Sub-agent (Flash)    → 프롬프트 지시 무시 가능 → 분해 체인 붕괴
```

RLM의 핵심이 **저비용 모델에 청크 위임**이므로, 서브에이전트의 tool_use 보장이 필수.

### 해결: 네이티브 tool_choice 패스스루

**필요한 수정:**

| # | 파일 | 변경 |
|---|---|---|
| 1 | `openresponses-http.ts` | `applyToolChoice()` — 프롬프트 대신 네이티브 객체 반환 |
| 2 | 에이전트 러너 인터페이스 | `toolChoice` 파라미터 추가 |
| 3 | `sessions-spawn-tool.ts` | 서브에이전트 생성 시 `toolChoice` 전달 |
| 4 | Anthropic 어댑터 | API 호출에 `tool_choice` 포함 |
| 5 | Gemini 어댑터 | API 호출에 `function_calling_config` 포함 |

**강결합 여부:** 아님. 변환 지점이 `applyToolChoice()` 단일 함수.

### API 레벨 보장

```
Anthropic: tool_choice: { type: "tool", name: "rlm_analyze" }
  → 모델이 반드시 해당 도구 호출 (출력 포맷 제약)

Gemini: function_calling_config: { mode: "ANY", allowed_function_names: [...] }
  → 동일 수준 보장
```

**제약:** 즉시 다음 턴에만 적용. 호출은 강제되나 인자는 모델 결정.

### 현실적 판단

프롬프트 주입 vs 네이티브 tool_choice: 고지능 모델에서는 입력 컨텍스트 동일하므로 실질 차이 미미.
**단, 저지능 서브에이전트 (Flash 등)에서는 네이티브 강제가 필수.**
→ 네이티브 패스스루 수정은 RLM 흡수의 **선행 조건**.

---

## 12. 결론 및 다음 단계

### 확정된 사항

| 항목 | 결론 |
|---|---|
| 메모리 시스템 | 변경 불필요. `provider: "gemini"` 설정만 |
| claude-mem | 흡수 불필요. OpenClaw에 이미 중복 |
| Ralph Loop | 외부 스크립트. 코드 변경 없음 |
| RLM 오케스트레이션 | **유일한 부재 기능** |
| 운영 환경 | 8GB + Gemini 3 Pro API = 충분 |

### 미결정 사항 (의사결정 필요)

| # | 질문 | 옵션 |
|---|---|---|
| D-1 | RLM 오케스트레이션 구현 방식 | (a) Plugin + registerTool() (b) Skill 파일 (c) 시스템 프롬프트 |
| D-2 | 네이티브 tool_choice 패스스루 | 저지능 서브에이전트 사용 시 **필수** |
| D-3 | 컨텍스트 황금비 임계값 | 몇 % 시점에서 Ralph Loop 순환? |
| D-4 | 서브에이전트 모델 선정 | Gemini 2.5 Flash vs Haiku vs 기타 |

### 다음 단계 (우선순위)

```
1. 네이티브 tool_choice 패스스루 수정 (4-5파일, 선행 조건)
2. RLM 오케스트레이션 Plugin 설계 (registerTool로 rlm_analyze 등록)
3. Ralph Loop 외부 스크립트 작성 (황금비 순환)
4. E2E 통합 테스트
```

---

## 부록: 분석에 참조된 핵심 파일 (42개)

### 메모리 시스템 (20개)
```
src/memory/manager.ts
src/memory/search-manager.ts
src/memory/index.ts
src/memory/sqlite-vec.ts
src/memory/sqlite.ts
src/memory/memory-schema.ts
src/memory/embeddings.ts
src/memory/embeddings-openai.ts
src/memory/embeddings-gemini.ts
src/memory/internal.ts
src/memory/hybrid.ts
src/memory/manager-search.ts
src/memory/manager-cache-key.ts
src/memory/batch-openai.ts
src/memory/batch-gemini.ts
src/memory/sync-memory-files.ts
src/memory/sync-session-files.ts
src/memory/session-files.ts
src/memory/headers-fingerprint.ts
src/memory/status-format.ts
```

### 에이전트 시스템 (12개)
```
src/agents/memory-search.ts
src/agents/tools/memory-tool.ts
src/agents/tools/sessions-spawn-tool.ts
src/agents/tools/sessions-send-tool.ts
src/agents/tools/sessions-history-tool.ts
src/agents/workspace.ts
src/agents/system-prompt.ts
src/agents/tool-policy.ts
src/agents/pi-tools.policy.ts
src/agents/pi-tools.before-tool-call.ts
src/agents/pi-extensions/context-pruning/pruner.ts
src/agents/pi-extensions/context-pruning/settings.ts
```

### 훅/플러그인 (5개)
```
src/plugins/hooks.ts
src/plugins/types.ts
src/plugins/runtime/index.ts
src/hooks/bundled/session-memory/handler.ts
src/agents/bootstrap-hooks.ts
```

### 기타 (5개)
```
src/auto-reply/reply/memory-flush.ts
src/auto-reply/reply/agent-runner-memory.ts
src/auto-reply/skill-commands.ts
src/gateway/openresponses-http.ts
src/acp/translator.ts
```

---

## 부록: 생성된 문서 (로컬, 푸시 블로킹)

| 파일 | 내용 |
|---|---|
| `CODE_REVIEW.md` | 보안 커밋 5건 코드 리뷰 |
| `MEMORY_SYSTEM_ANALYSIS.md` | 정정된 메모리 시스템 합본 분석 |
| `CONTEXT_MANAGEMENT_SOLUTIONS.md` | 20+ 레포 비교 분석 |
| `MIGRATION_PLAN.md` | 마이그레이션 기획 (무효화됨) |
| `SESSION_REPORT.md` | 본 문서 (세션 전체 구조화) |
