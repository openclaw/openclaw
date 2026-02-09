---
summary: "채널별 라우팅 규칙 (WhatsApp, Telegram, Discord, Slack) 및 공유 컨텍스트"
read_when:
  - 채널 라우팅 또는 수신함 동작을 변경할 때
title: "채널 라우팅"
---

# 채널 & 라우팅

OpenClaw 는 **메시지가 들어온 채널로 다시 응답을 라우팅**합니다. 모델이 채널을 선택하지 않으며, 라우팅은 결정적이고 호스트 구성에 의해 제어됩니다.

## 핵심 용어

- **Channel**: `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`, `webchat`.
- **AccountId**: 채널별 계정 인스턴스 (지원되는 경우).
- **AgentId**: 격리된 작업 공간 + 세션 저장소 ('brain').
- **SessionKey**: 컨텍스트를 저장하고 동시성을 제어하는 데 사용되는 버킷 키.

## 세션 키 형태 (예시)

다이렉트 메시지는 에이전트의 **main** 세션으로 병합됩니다:

- `agent:<agentId>:<mainKey>` (기본값: `agent:main:main`)

그룹과 채널은 채널별로 격리된 상태를 유지합니다:

- 그룹: `agent:<agentId>:<channel>:group:<id>`
- 채널/룸: `agent:<agentId>:<channel>:channel:<id>`

스레드:

- Slack/Discord 스레드는 기본 키에 `:thread:<threadId>` 을 추가합니다.
- Telegram 포럼 토픽은 그룹 키에 `:topic:<topicId>` 를 포함합니다.

예시:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## 라우팅 규칙 (에이전트가 선택되는 방식)

라우팅은 각 인바운드 메시지에 대해 **하나의 에이전트**를 선택합니다:

1. **정확한 피어 매칭** (`bindings` 와 `peer.kind` + `peer.id`).
2. **길드 매칭** (Discord) — `guildId` 를 통해.
3. **팀 매칭** (Slack) — `teamId` 를 통해.
4. **계정 매칭** (채널의 `accountId`).
5. **채널 매칭** (해당 채널의 모든 계정).
6. **기본 에이전트** (`agents.list[].default`, 그렇지 않으면 목록의 첫 번째 항목, 최종 대안으로 `main`).

매칭된 에이전트가 어떤 작업 공간과 세션 저장소가 사용되는지를 결정합니다.

## 브로드캐스트 그룹 (여러 에이전트 실행)

브로드캐스트 그룹을 사용하면 OpenClaw 가 **일반적으로 응답을 보낼 상황에서** 동일한 피어에 대해 **여러 에이전트**를 실행할 수 있습니다 (예: WhatsApp 그룹에서 멘션/활성화 게이팅 이후).

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

참고: [Broadcast Groups](/channels/broadcast-groups).

## 구성 개요

- `agents.list`: 명명된 에이전트 정의 (작업 공간, 모델 등).
- `bindings`: 인바운드 채널/계정/피어를 에이전트에 매핑.

예시:

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

세션 저장소는 상태 디렉토리 아래에 위치합니다 (기본값 `~/.openclaw`):

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- JSONL 트랜스크립트는 저장소와 나란히 위치합니다

`session.store` 및 `{agentId}` 템플리팅을 통해 저장소 경로를 재정의할 수 있습니다.

## WebChat 동작

WebChat 은 **선택된 에이전트**에 연결되며, 기본적으로 에이전트의 main 세션을 사용합니다. 이로 인해 WebChat 에서는 해당 에이전트의 크로스 채널 컨텍스트를 한 곳에서 확인할 수 있습니다.

## 응답 컨텍스트

인바운드 응답에는 다음이 포함됩니다:

- 사용 가능한 경우 `ReplyToId`, `ReplyToBody`, `ReplyToSender`.
- 인용된 컨텍스트는 `Body` 에 `[Replying to ...]` 블록으로 추가됩니다.

이는 모든 채널에서 일관되게 적용됩니다.
