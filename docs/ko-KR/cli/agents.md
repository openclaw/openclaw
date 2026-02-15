---
summary: "CLI reference for `openclaw agents` (list/add/delete/set identity)"
read_when:
  - You want multiple isolated agents (workspaces + routing + auth)
title: "agents"
x-i18n:
  source_hash: 30556d81636a9ad8972573cc6b498e620fd266e1dfb16eef3f61096ea62f9896
---

# `openclaw agents`

격리된 에이전트를 관리합니다(작업 공간 + 인증 + 라우팅).

관련 항목:

- 다중 에이전트 라우팅: [다중 에이전트 라우팅](/concepts/multi-agent)
- 에이전트 작업공간: [에이전트 작업공간](/concepts/agent-workspace)

## 예

```bash
openclaw agents list
openclaw agents add work --workspace ~/.openclaw/workspace-work
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
openclaw agents set-identity --agent main --avatar avatars/openclaw.png
openclaw agents delete work
```

## 신원 파일

각 에이전트 작업 영역은 작업 영역 루트에 `IDENTITY.md`를 포함할 수 있습니다.

- 예시 경로: `~/.openclaw/workspace/IDENTITY.md`
- `set-identity --from-identity`는 작업공간 루트(또는 명시적인 `--identity-file`)에서 읽습니다.

아바타 경로는 작업공간 루트를 기준으로 확인됩니다.

## 신원 설정

`set-identity`는 `agents.list[].identity`에 필드를 씁니다.

- `name`
- `theme`
- `emoji`
- `avatar` (작업공간 상대 경로, http(s) URL 또는 데이터 URI)

`IDENTITY.md`에서 로드:

```bash
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
```

필드를 명시적으로 재정의합니다.

```bash
openclaw agents set-identity --agent main --name "OpenClaw" --emoji "🦞" --avatar avatars/openclaw.png
```

구성 샘플:

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
