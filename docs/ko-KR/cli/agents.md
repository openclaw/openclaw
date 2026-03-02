---
summary: "격리된 에이전트 (워크스페이스 + 라우팅 + 인증) 를 나열/추가/삭제/바인딩/아이덴티티 설정하기"
read_when:
  - 여러 격리된 에이전트 (워크스페이스 + 라우팅 + 인증) 를 원할 때
title: "agents"
---

# `openclaw agents`

격리된 에이전트를 관리합니다 (워크스페이스 + 인증 + 라우팅).

관련 사항:

- 다중 에이전트 라우팅: [Multi-Agent Routing](/concepts/multi-agent)
- 에이전트 워크스페이스: [Agent workspace](/concepts/agent-workspace)

## 예시

```bash
openclaw agents list
openclaw agents add work --workspace ~/.openclaw/workspace-work
openclaw agents bindings
openclaw agents bind --agent work --bind telegram:ops
openclaw agents unbind --agent work --bind telegram:ops
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
openclaw agents set-identity --agent main --avatar avatars/openclaw.png
openclaw agents delete work
```

## 라우팅 바인딩

특정 에이전트로 인바운드 채널 트래픽을 고정하려면 라우팅 바인딩을 사용합니다.

바인딩 나열:

```bash
openclaw agents bindings
openclaw agents bindings --agent work
openclaw agents bindings --json
```

바인딩 추가:

```bash
openclaw agents bind --agent work --bind telegram:ops --bind discord:guild-a
```

`accountId` 를 생략하면 (`--bind <channel>`), OpenClaw 는 채널 기본값 및 플러그인 설정 후크에서 계정 범위를 해결합니다.

### 바인딩 범위 동작

- `accountId` 없는 바인딩은 채널 기본 계정만 일치합니다.
- `accountId: "*"` 는 채널 전체 폴백 (모든 계정) 이고 명시적 계정 바인딩보다 덜 구체적입니다.
- 동일한 에이전트가 이미 `accountId` 없는 일치하는 채널 바인딩이 있고 나중에 명시적 또는 해결된 `accountId` 로 바인딩하면, OpenClaw 는 중복을 추가하는 대신 기존 바인딩을 제자리에서 업그레이드합니다.

예시:

```bash
# 초기 채널 전용 바인딩
openclaw agents bind --agent work --bind telegram

# 나중에 계정 범위의 바인딩으로 업그레이드
openclaw agents bind --agent work --bind telegram:ops
```

업그레이드 후, 해당 바인딩의 라우팅은 `telegram:ops` 로 범위 지정됩니다. 기본 계정 라우팅도 원하면 명시적으로 추가합니다 (예: `--bind telegram:default`).

바인딩 제거:

```bash
openclaw agents unbind --agent work --bind telegram:ops
openclaw agents unbind --agent work --all
```

## 아이덴티티 파일

각 에이전트 워크스페이스는 워크스페이스 루트에 `IDENTITY.md` 를 포함할 수 있습니다:

- 예시 경로: `~/.openclaw/workspace/IDENTITY.md`
- `set-identity --from-identity` 는 워크스페이스 루트 (또는 명시적 `--identity-file`) 에서 읽습니다

아바타 경로는 워크스페이스 루트를 기준으로 해결됩니다.

## 아이덴티티 설정

`set-identity` 는 필드를 `agents.list[].identity` 로 쓰기합니다:

- `name`
- `theme`
- `emoji`
- `avatar` (워크스페이스 상대 경로, http(s) URL 또는 데이터 URI)

`IDENTITY.md` 에서 로드:

```bash
openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity
```

명시적으로 필드 무시:

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

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/cli/agents.md
workflow: 15
