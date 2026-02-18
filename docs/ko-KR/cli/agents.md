---
summary: "`openclaw agents` (목록/추가/삭제/정체성 설정)의 CLI 참조"
read_when:
  - 여러 개의 격리된 에이전트 (작업공간 + 라우팅 + 인증) 사용을 원할 때
title: "agents"
---

# `openclaw agents`

격리된 에이전트 (작업공간 + 인증 + 라우팅) 관리.

관련 항목:

- 다중 에이전트 라우팅: [Multi-Agent Routing](/concepts/multi-agent)
- 에이전트 작업공간: [Agent workspace](/concepts/agent-workspace)

## 예제

```bash
openclaw agents list
openclaw agents add work --workspace ~/.openclaw/workspace-work
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
openclaw agents set-identity --agent main --avatar avatars/openclaw.png
openclaw agents delete work
```

## 정체성 파일

각 에이전트 작업공간은 작업공간 루트에 `IDENTITY.md`를 포함할 수 있습니다:

- 예제 경로: `~/.openclaw/workspace/IDENTITY.md`
- `set-identity --from-identity`는 작업공간 루트에서 읽어옵니다 (또는 명시적인 `--identity-file`).

아바타 경로는 작업공간 루트를 기준으로 해석됩니다.

## 정체성 설정

`set-identity`는 `agents.list[].identity`에 필드를 작성합니다:

- `name`
- `theme`
- `emoji`
- `avatar` (작업공간 기준 경로, http(s) URL 또는 데이터 URI)

`IDENTITY.md`에서 불러오기:

```bash
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
```

필드를 명시적으로 덮어쓰기:

```bash
openclaw agents set-identity --agent main --name "OpenClaw" --emoji "🦞" --avatar avatars/openclaw.png
```

설정 샘플:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "OpenClaw",
          theme: "space lobster",
          emoji: "🦞",
          avatar: "avatars/openclaw.png",
        },
      },
    ],
  },
}
```
