# 소스 코드 참조 + 설정 스냅샷

> Sisyphus 패턴 구현 시 참고할 소스 코드 위치와 현재 설정 상태.
>
> 관련 문서: [SISYPHUS-DESIGN.md](./SISYPHUS-DESIGN.md) | [IMPLEMENTATION-GUIDE.md](./IMPLEMENTATION-GUIDE.md)

---

## 1. 핵심 코드 참조

### 1.1 Workspace 결정

**파일**: `src/agents/agent-scope.ts:168-184`

```typescript
export function resolveAgentWorkspaceDir(cfg: OpenClawConfig, agentId: string) {
  const id = normalizeAgentId(agentId);
  const configured = resolveAgentConfig(cfg, id)?.workspace?.trim();
  if (configured) return resolveUserPath(configured);
  // ... 기본 에이전트 fallback ...
  const stateDir = resolveStateDir(process.env);
  return path.join(stateDir, `workspace-${id}`);
}
```

**동작**: `agentId`가 `"explorer"`이면 `~/.openclaw/workspace-explorer/`에서 bootstrap 파일 로드.

### 1.2 sessions_spawn 도구

**파일**: `src/agents/tools/sessions-spawn-tool.ts`

핵심 로직 (line 144-168):

```typescript
const targetAgentId = requestedAgentId ? normalizeAgentId(requestedAgentId) : requesterAgentId; // agentId 미지정 → 부모 자신

if (targetAgentId !== requesterAgentId) {
  const allowAgents = resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ?? [];
  // allowAgents에 없으면 forbidden 반환
}

const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
```

스키마 파라미터: `task`(필수), `label`, `agentId`, `model`, `thinking`, `runTimeoutSeconds`, `cleanup`

Sub-agent 재귀 차단 (line 122-127): `isSubagentSessionKey` 체크로 sub-agent의 sub-agent spawn 금지.

### 1.3 Sub-Agent 도구 정책

**파일**: `src/agents/pi-tools.policy.ts:79-106`

```typescript
const DEFAULT_SUBAGENT_TOOL_DENY = [
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "gateway",
  "agents_list",
  "whatsapp_login",
  "session_status",
  "cron",
  "memory_search",
  "memory_get",
];
```

Config의 `tools.subagents.tools.deny`가 `DEFAULT_SUBAGENT_TOOL_DENY`에 합산됨.

### 1.4 Sub-Agent 시스템 프롬프트

**파일**: `src/agents/subagent-announce.ts:374-424`

`buildSubagentSystemPrompt()` — ~20줄 고정 시스템 프롬프트 생성.
내용: Subagent Context, Role, Rules (Stay focused, Complete task, Be ephemeral), Output Format.

### 1.5 promptMode 결정

**파일**: `src/agents/pi-embedded-runner/run/attempt.ts:342`

```typescript
const promptMode = isSubagentSessionKey(params.sessionKey) ? "minimal" : "full";
```

`promptMode="minimal"` 효과: Self-Update, Model Aliases, Group Chat Context 등 생략.
단, **Task Tracking (CRITICAL - MANDATORY)는 여전히 포함됨** (system-prompt.ts:414-417).

### 1.6 Bootstrap 파일

**파일**: `src/agents/workspace.ts:23-31`

파일 목록: `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`, `MEMORY.md`

**한도**: `DEFAULT_BOOTSTRAP_MAX_CHARS = 20_000` (bootstrap.ts:84)
초과 시 head 70% + tail 20% + 중간 생략 방식으로 트리밍.

Sub-agent는 bootstrap 시 **AGENTS.md와 TOOLS.md만** 로딩 (filterBootstrapFilesForSession).

---

## 2. Config 타입 참조

### 2.1 tools.subagents

```typescript
// src/config/types.tools.ts:446-453
subagents?: {
  tools?: {
    allow?: string[];  // 허용 목록 (설정 시 이것만 허용)
    deny?: string[];   // 추가 차단 목록 (DEFAULT에 합산)
  };
};
```

### 2.2 agents.defaults.subagents

```typescript
// src/config/types.agent-defaults.ts:210-223
subagents?: {
  maxConcurrent?: number;
  archiveAfterMinutes?: number;
  model?: string | ModelConfig;
  thinking?: string;
  announceDeliveryTimeoutMs?: number;
};
```

### 2.3 per-agent subagents

```typescript
// src/config/zod-schema.agent-runtime.ts:472-489
subagents?: {
  allowAgents?: string[];    // cross-agent spawn 허용 대상
  model?: string | ModelConfig;
  thinking?: string;
};
```

---

## 3. 에이전트 설정 스냅샷 (2026-02-12)

### 3.1 에이전트 목록

| ID       | 이름 | 역할          | 모델       | AGENTS.md 크기 | Bootstrap 한도 대비 |
| -------- | ---- | ------------- | ---------- | -------------- | ------------------- |
| ruda     | 루다 | 팀 리더       | opus-4-6   | 21,458 bytes   | 초과 (트리밍됨)     |
| eden     | 이든 | 개발          | opus-4-5   | 23,886 bytes   | 초과 (트리밍됨)     |
| seum     | 세움 | 인프라        | opus-4-5   | 18,182 bytes   | 91%                 |
| dajim    | 다짐 | QA            | opus-4-5   | 14,320 bytes   | 72%                 |
| yunseul  | 윤슬 | 마케팅        | sonnet-4-5 | 17,140 bytes   | 86%                 |
| miri     | 미리 | 비즈니스 분석 | sonnet-4-5 | 16,762 bytes   | 84%                 |
| onsae    | 온새 | 개인비서      | sonnet-4-5 | 18,256 bytes   | 91%                 |
| ieum     | 이음 | 소셜 커뮤니티 | sonnet-4-5 | 8,016 bytes    | 40%                 |
| nuri     | 누리 | CS/커뮤니티   | sonnet-4-5 | 7,567 bytes    | 38%                 |
| hangyeol | 한결 | 법무          | sonnet-4-5 | 9,793 bytes    | 49%                 |
| grim     | 그림 | UI/UX         | sonnet-4-5 | 6,733 bytes    | 34%                 |

### 3.2 에이전트별 도구 설정

| 에이전트 | tools.allow                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| ruda     | read, write, edit, exec, web_search, web_fetch, message, group:sessions, group:task, group:milestone          |
| eden     | exec, read, write, edit, apply_patch, browser, web_search, web_fetch, message, group:sessions, group:task     |
| seum     | exec, read, write, edit, message, nodes, browser, web_search, web_fetch, group:sessions, group:task           |
| dajim    | read, write, edit, exec, web_search, web_fetch, message, group:sessions, group:task                           |
| yunseul  | read, write, edit, browser, web_search, web_fetch, message, group:sessions, group:task                        |
| miri     | read, write, edit, exec, browser, web_search, web_fetch, message, group:sessions, group:task, group:milestone |
| onsae    | read, write, edit, exec, web_search, web_fetch, message, group:sessions, group:task                           |
| ieum     | read, write, edit, web_search, web_fetch, message, group:sessions, group:task                                 |
| nuri     | read, write, edit, exec, web_search, web_fetch, message, group:sessions, group:task                           |
| hangyeol | read, write, edit, exec, web_search, web_fetch, message, group:sessions, group:task                           |
| grim     | read, write, edit, browser, web_search, web_fetch, message, group:sessions, group:task                        |

### 3.3 서버 환경

| 항목         | 값                                 |
| ------------ | ---------------------------------- |
| 서버         | Mac Mini (Yoonui-Macmini)          |
| SSH          | (내부 네트워크 — 별도 공유)        |
| 설정 파일    | `~/.openclaw/openclaw.json`        |
| Workspace    | `~/.openclaw/workspace-{agentId}/` |
| Gateway 포트 | 18789                              |
| Task-Hub     | Docker (OrbStack), port 3102→3000  |

---

## 4. 2026-02-16 변경 반영 (협업/Conversations)

### 4.1 Spawn 대화 이벤트 체인 (Gateway)

다음 이벤트 체인이 추가되어, Task-Hub Conversations에서 spawn 기반 협업 흐름이 끊기지 않고 보이도록 정렬됨:

- `a2a.spawn` → `a2a.send` → `a2a.spawn_result` → `a2a.response` → `a2a.complete`
- `conversationId`를 spawn 시점에 생성해 전 단계 이벤트에 공유
- `spawn_result`에 `status`, `error`, `replyPreview`, `runId`를 포함

핵심 파일:

- `src/agents/tools/sessions-spawn-tool.ts`
- `src/agents/subagent-registry.ts`
- `src/agents/subagent-announce.ts`
- `src/infra/events/schemas.ts`

### 4.2 Task Continuation + Team State 정합성

`task-continuation-runner`의 team-state 업데이트 경로를 workspace 기준에서 stateDir 기준으로 정리하여,
실행 중/유휴 상태가 Task-Hub에 일관되게 반영되도록 보정함.

핵심 파일:

- `src/infra/task-continuation-runner.ts`

### 4.3 Task Monitor 서버 연동 강화

- `parseTaskFileMd`를 export하여 통합 테스트 가능하게 변경
- task 파일 변경 시 `task_step_update` WebSocket 이벤트 브로드캐스트
- coordination log 변경 시 `continuation_event` 브로드캐스트
- `/api/workspace-file` 쓰기 요청에 토큰/루프백 인증 추가
- `/api/milestones` 프록시 시 Cookie + query 전달

핵심 파일:

- `scripts/task-monitor-server.ts`
- `src/task-monitor/task-monitor-parser-integration.test.ts`

### 4.4 Task-Hub Conversations UX/인증 반영 (외부 레포 연동)

Task-Hub(`/Users/server/Projects/task-hub`)의 Conversations 화면에서:

- 세션 제목 고정값 `Work Session` 제거
- `label`, `[Goal]`, 메시지 본문 기반 1줄 요약 노출
- 참여 에이전트 요약(`A · B 외 n`) 노출
- Conversations는 `conversation.main` 역할(메인↔메인 `a2a.send/response/complete`)만 표시
- spawn/subagent 흐름(`a2a.spawn`, `a2a.spawn_result`, subagent 관련 `a2a.*`)은 Events/Tasks에서 표시
- continuation/plan/unblock/zombie/task 신호는 Conversations가 아니라 상태/운영 뷰에서 소비
- Conversations는 상위 카테고리(`engineering_build` 등)를 고정 배지 항목으로 먼저 제시하고, 선택 후 해당 뷰로 진입

관련 파일:

- `/Users/server/Projects/task-hub/src/app/conversations/page.tsx`
- `/Users/server/Projects/task-hub/src/lib/auth-session.ts`
- `/Users/server/Projects/task-hub/src/app/api/proxy/[...path]/route.ts`
- `/Users/server/Projects/task-hub/src/middleware.ts`

### 4.5 신규 테스트

- `src/agents/tools/sessions-spawn-tool.events.test.ts`
- `src/task-monitor/task-monitor-parser-integration.test.ts`

---

_작성일: 2026-02-16 | 기준 시점: 2026-02-16 서버 점검_
