---
read_when:
    - 여러 개의 격리된 에이전트(작업 공간 + 라우팅 + 인증)가 필요합니다.
summary: '`openclaw agents`에 대한 CLI 참조(ID 나열/추가/삭제/설정)'
title: 자치령 대표
x-i18n:
    generated_at: "2026-02-08T15:47:33Z"
    model: gtx
    provider: google-translate
    source_hash: 30556d81636a9ad8972573cc6b498e620fd266e1dfb16eef3f61096ea62f9896
    source_path: cli/agents.md
    workflow: 15
---

# `openclaw agents`

격리된 에이전트를 관리합니다(작업 공간 + 인증 + 라우팅).

관련된:

- 다중 에이전트 라우팅: [다중 에이전트 라우팅](/concepts/multi-agent)
- 에이전트 작업 영역: [상담원 작업공간](/concepts/agent-workspace)

## 예

```bash
openclaw agents list
openclaw agents add work --workspace ~/.openclaw/workspace-work
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
openclaw agents set-identity --agent main --avatar avatars/openclaw.png
openclaw agents delete work
```

## 신원 파일

각 에이전트 작업 영역에는 다음이 포함될 수 있습니다. `IDENTITY.md` 작업공간 루트에서:

- 예시 경로: `~/.openclaw/workspace/IDENTITY.md`
- `set-identity --from-identity` 작업공간 루트(또는 명시적 `--identity-file`)

아바타 경로는 작업공간 루트를 기준으로 확인됩니다.

## 정체성 설정

`set-identity` 필드를 씁니다. `agents.list[].identity`:

- `name`
- `theme`
- `emoji`
- `avatar` (작업공간 상대 경로, http(s) URL 또는 데이터 URI)

다음에서 로드 `IDENTITY.md`:

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
