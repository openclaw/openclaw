# ProntoLab Operations Runbook

> This document mirrors operational guidance maintained in `../PRONTOLAB.md` so ProntoLab-specific docs stay centralized under `prontolab/`.

## Scope

- Upstream sync workflow for `prontolab-openclaw`
- Version-skew prevention checklist
- Validation gate before finalizing sync

## Upstream Sync (Intent-Preserving, Anti-Skew)

### 1) Prepare sync branch

```bash
git fetch upstream --tags
git checkout sync-upstream-v2026.2.15
```

### 2) Merge upstream tag

```bash
git merge --no-ff v2026.2.15
```

### 3) Conflict policy

- Preserve ProntoLab intent first on runtime-critical areas:
  - `src/gateway/*`
  - `src/discord/monitor/*`
  - `src/infra/task-*`
  - `src/agents/tools/*`
- Integrate upstream behavior only when it does not change ProntoLab semantics.
- Do not mix test/helper/runtime files across `HEAD` and `MERGE_HEAD` within the same cluster.

### 4) Version-skew audit

```bash
for f in   src/test-utils/channel-plugins.ts   src/infra/outbound/message-action-runner.ts   src/infra/outbound/targets.ts   src/discord/send.ts   src/auto-reply/reply/get-reply-run.ts   src/agents/subagent-announce-queue.ts
do
  cur=$(git hash-object "$f")
  h=$(git rev-parse "HEAD:$f" 2>/dev/null || true)
  m=$(git rev-parse "MERGE_HEAD:$f" 2>/dev/null || true)
  [ "$cur" = "$h" ] && ah=true || ah=false
  [ "$cur" = "$m" ] && am=true || am=false
  echo "$f,AT_HEAD=$ah,AT_MERGE_HEAD=$am"
done
```

Interpretation:

- `AT_HEAD=true` means current file equals pre-merge side.
- `AT_MERGE_HEAD=true` means current file equals upstream side.
- A failing cluster should be aligned to one side instead of partial mixing.

### 5) Validation gate (required)

```bash
pnpm build
pnpm test:fast
```

If either command fails, do not finalize the sync.

## Source of truth

- Primary operational tracker: `../PRONTOLAB.md`
- ProntoLab design/docs index: `./README.md`

## Runtime Validation - Collaboration Conversations (2026-02-16)

### A) OpenClaw 이벤트 체인 확인

```bash
# spawn / response / complete 이벤트가 동일 conversationId로 묶이는지 확인
tail -n 200 ~/.openclaw/logs/coordination-events.ndjson
```

확인 포인트:

- `a2a.spawn`, `a2a.send`, `a2a.spawn_result`, `a2a.response`, `a2a.complete` 순서
- 동일 `conversationId` 유지
- `spawn_result.status`가 `accepted` 또는 `error`로 명시

### B) Task-Hub 반영 상태 확인

```bash
cd /Users/server/Projects/task-hub
/Applications/OrbStack.app/Contents/MacOS/xbin/docker compose up -d --build task-hub
/Applications/OrbStack.app/Contents/MacOS/xbin/docker compose ps task-hub

# Task-Hub(3102)가 맞는지 확인 (3001은 Persona)
/usr/bin/curl -sS http://127.0.0.1:3102/login | /usr/bin/grep -q "Task Hub" && echo "task-hub ok"

# Conversations API 프록시 점검 (로그인 쿠키 필요)
/usr/bin/curl -sS -i "http://127.0.0.1:3102/api/proxy/events?limit=3" -H "Cookie: task-hub-session=authenticated" | /usr/bin/head -n 20
```

확인 포인트:

- 컨테이너가 `Up` 상태
- Conversations 목록 제목이 고정 `Work Session`이 아닌 작업 요약 1줄로 표시

### C) 테스트 (기존 테스트 수정 없이 추가 테스트만 사용)

```bash
cd /Users/server/prontolab-openclaw
pnpm vitest run --config vitest.unit.config.ts \
  src/agents/tools/sessions-spawn-tool.events.test.ts \
  src/task-monitor/task-monitor-parser-integration.test.ts

# 라이브 협업 E2E (Task-Hub 3102 + Conversations 요약 검증 포함)
pnpm test:e2e:collab:live
```
