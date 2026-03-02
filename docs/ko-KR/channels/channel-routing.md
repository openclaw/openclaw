---
summary: "채널별 라우팅 규칙 (WhatsApp, Telegram, Discord, Slack) 및 공유 컨텍스트"
read_when:
  - 채널 라우팅 또는 받은 편지함 동작 변경 중
title: "채널 라우팅"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: channels/channel-routing.md
  workflow: 15
---

# 채널 및 라우팅

OpenClaw 는 회신을 **메시지가 온 채널로** 라우팅합니다. 모델은 채널을 선택하지 않습니다. 라우팅은 결정적이며 호스트 구성으로 제어됩니다.

## 핵심 용어

- **Channel**: `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`, `webchat`.
- **AccountId**: 채널별 계정 인스턴스 (지원되는 경우).
- **AgentId**: 격리된 워크스페이스 + 세션 저장소 ("뇌").
- **SessionKey**: 컨텍스트를 저장하고 동시성을 제어하는 데 사용되는 버킷 키.

## 세션 키 형태 (예제)

직접 메시지는 에이전트의 **main** 세션으로 축소됩니다:

- `agent:<agentId>:<mainKey>` (기본: `agent:main:main`)

그룹 및 채널은 채널별로 격리된 상태로 유지됩니다:

- 그룹: `agent:<agentId>:<channel>:group:<id>`
- 채널/방: `agent:<agentId>:<channel>:channel:<id>`

스레드:

- Slack/Discord 스레드는 기본 키에 `:thread:<threadId>` 를 추가합니다.
- Telegram 포럼 토픽은 그룹 키에 `:topic:<topicId>` 를 포함합니다.

예제:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## 라우팅 규칙 (에이전트를 선택하는 방법)

라우팅은 각 인바운드 메시지에 대해 **하나의 에이전트를** 선택합니다:

1. **정확한 peer 일치** (`bindings` 과 `peer.kind` + `peer.id`).
2. **부모 peer 일치** (스레드 상속).
3. **Guild + roles 일치** (Discord) via `guildId` + `roles`.
4. **Guild 일치** (Discord) via `guildId`.
5. **Team 일치** (Slack) via `teamId`.
6. **계정 일치** (채널의 `accountId`).
7. **채널 일치** (해당 채널의 모든 계정, `accountId: "*"`).
8. **기본 에이전트** (`agents.list[].default`, 그렇지 않으면 첫 번째 나열 항목, 폴백 `main`).

바인딩이 여러 일치 필드를 포함할 때 (`peer`, `guildId`, `teamId`, `roles`), **제공된 모든 필드가 일치해야** 해당 바인딩이 적용됩니다.

일치된 에이전트는 사용할 워크스페이스 및 세션 저장소를 결정합니다.

## 브로드캐스트 그룹 (여러 에이전트 실행)

브로드캐스트 그룹을 사용하면 OpenClaw 가 보통 회신할 때 (예: WhatsApp 그룹에서 mention/activation 게이팅 후) **같은 peer 에 대해 여러 에이전트를** 실행할 수 있습니다.

구성:

```json5
{
  broadcast: {
    strategy: "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"],
    "+15555550123": ["support", "logger"],
  },
}
```

참고: [브로드캐스트 그룹](/channels/broadcast-groups).

## 구성 개요

- `agents.list`: 명명된 에이전트 정의 (워크스페이스, 모델 등).
- `bindings`: 인바운드 채널/계정/peer 을 에이전트에 매핑합니다.

예제:

```json5
{
  agents: {
    list: [{ id: "support", name: "Support", workspace: "~/.openclaw/workspace-support" }],
  },
  bindings: [
    { match: { channel: "slack", teamId: "T123" }, agentId: "support" },
    { match: { channel: "telegram", peer: { kind: "group", id: "-100123" } }, agentId: "support" },
  ],
}
```

## 세션 저장소

세션 저장소는 상태 디렉토리 (기본 `~/.openclaw`) 아래에 있습니다:

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- JSONL 기록은 저장소 옆에 있습니다

`session.store` 및 `{agentId}` 템플릿을 통해 저장소 경로를 재정의할 수 있습니다.

## WebChat 동작

WebChat 은 **선택된 에이전트에** 연결되고 에이전트의 주 세션으로 기본값입니다. 이 때문에 WebChat 을 사용하면 한 곳에서 해당 에이전트에 대한 채널 간 컨텍스트를 볼 수 있습니다.

## 회신 컨텍스트

인바운드 회신 포함:

- `ReplyToId`, `ReplyToBody` 및 `ReplyToSender` (사용 가능한 경우).
- 인용 컨텍스트는 `[Replying to ...]` 블록으로 `Body` 에 추가됩니다.

이는 채널 간에 일관성이 있습니다.
