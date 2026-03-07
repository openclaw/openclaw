---
name: tmux-claudecode
description: tmux로 Claude Code CLI 세션 제어 (코드 작업, 이슈 픽스)
---

# tmux-claudecode

tmux로 Claude Code CLI 세션을 제어해서 코드 작업을 시킨다.

## 언제 쓰나

- 코드 작업 (구현, 리팩토링, 버그 픽스)
- 멀티스텝 태스크
- 병렬 작업 (여러 세션 동시 실행)
- 백그라운드 작업 (채팅 블록 안 함)

## Quick Start

```bash
# 소켓 경로
SOCKET="${TMPDIR:-/tmp}/openclaw-tmux-sockets/openclaw.sock"

# 세션 생성 + Claude Code 실행
tmux -S "$SOCKET" new -d -s "claude-myproject" -c ~/myproject
tmux -S "$SOCKET" resize-window -t "claude-myproject" -x 300 -y 80
tmux -S "$SOCKET" send-keys -t "claude-myproject" 'claude' Enter

# 3초 대기 후 프롬프트 전송
sleep 3
tmux -S "$SOCKET" send-keys -t "claude-myproject" -l 'Fix bug in auth module. Commit and push when done.'
tmux -S "$SOCKET" send-keys -t "claude-myproject" Enter
```

## 프롬프트 규칙

- **영어로 작성** (Claude Code 최적화)
- **`-l` 플래그 필수** (특수문자 처리)
- **끝에 "Commit and push when done"**

## 워크플로우

### 1. 세션 생성

```bash
SOCKET="${TMPDIR:-/tmp}/openclaw-tmux-sockets/openclaw.sock"
SESSION="claude-myproject"
PROJECT_DIR="~/myproject"

tmux -S "$SOCKET" new -d -s "$SESSION" -c "$PROJECT_DIR"
tmux -S "$SOCKET" resize-window -t "$SESSION" -x 300 -y 80
tmux -S "$SOCKET" send-keys -t "$SESSION" 'claude' Enter
sleep 3
```

### 2. 프롬프트 전송

```bash
tmux -S "$SOCKET" send-keys -t "$SESSION" -l 'Your task here. Commit and push when done.'
tmux -S "$SOCKET" send-keys -t "$SESSION" Enter
```

### 3. 상태 확인

```bash
tmux -S "$SOCKET" capture-pane -p -J -t "$SESSION":0.0 -S -100
```

**상태 판단:**

| 상태     | 신호                                     |
| -------- | ---------------------------------------- |
| thinking | Tool 실행 중, 응답 생성 중               |
| ready    | 셸 프롬프트 (`❯` 또는 `$`), 입력 대기 중 |
| error    | 에러 메시지, rate limit                  |
| stuck    | 15분 이상 변화 없음                      |

### 4. 완료 확인

- 셸 프롬프트 복귀 (`❯` 또는 `➜` 또는 `$`)
- "Committed and pushed" 메시지

## 비인터랙티브 모드 (단순 작업)

```bash
# -p 플래그로 바로 실행 (결과만 출력)
claude -p "Fix the bug in auth.ts and show the diff" --allowedTools Edit,Read

# 파이프 입력
echo "Summarize the README" | claude -p
```

## 모델 변경

```bash
# claude 실행 시 모델 지정
tmux -S "$SOCKET" send-keys -t "$SESSION" -l 'claude --model claude-opus-4-6'
tmux -S "$SOCKET" send-keys -t "$SESSION" Enter

# 실행 중 /model 명령으로 변경
tmux -S "$SOCKET" send-keys -t "$SESSION" -l '/model'
tmux -S "$SOCKET" send-keys -t "$SESSION" Enter
```

## Rate Limit 복구

```bash
# ESC로 취소 후 continue
tmux -S "$SOCKET" send-keys -t "$SESSION" Escape
sleep 1
tmux -S "$SOCKET" send-keys -t "$SESSION" -l 'continue'
tmux -S "$SOCKET" send-keys -t "$SESSION" Enter
```

## Idle 세션 채찍질

```bash
tmux -S "$SOCKET" send-keys -t "$SESSION" Escape
tmux -S "$SOCKET" send-keys -t "$SESSION" -l 'continue'
tmux -S "$SOCKET" send-keys -t "$SESSION" Enter
```

## 병렬 이슈 작업

```bash
SOCKET="${TMPDIR:-/tmp}/openclaw-tmux-sockets/openclaw.sock"

# 이슈별 worktree
git worktree add ../project-issue-1 -b feature/issue-1
git worktree add ../project-issue-2 -b feature/issue-2

# 세션별 작업
tmux -S "$SOCKET" new -d -s "issue-1" -c ~/project-issue-1
tmux -S "$SOCKET" send-keys -t "issue-1" 'claude' Enter
sleep 3
tmux -S "$SOCKET" send-keys -t "issue-1" -l 'Fix issue #1. Commit and push when done.'
tmux -S "$SOCKET" send-keys -t "issue-1" Enter

tmux -S "$SOCKET" new -d -s "issue-2" -c ~/project-issue-2
tmux -S "$SOCKET" send-keys -t "issue-2" 'claude' Enter
sleep 3
tmux -S "$SOCKET" send-keys -t "issue-2" -l 'Fix issue #2. Commit and push when done.'
tmux -S "$SOCKET" send-keys -t "issue-2" Enter
```

## 세션 추적

`memory/tmux-sessions.json`:

```json
{
  "sessions": {
    "claude-myproject": {
      "project": "~/myproject",
      "task": "Fix auth bug",
      "status": "running"
    }
  }
}
```

**status:** `running` | `completed` | `failed` | `stuck`

## 세션 종료

```bash
SOCKET="${TMPDIR:-/tmp}/openclaw-tmux-sockets/openclaw.sock"
tmux -S "$SOCKET" kill-session -t "$SESSION"
```
