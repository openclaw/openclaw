---
summary: "Routing rules per channel (WhatsApp, Telegram, Discord, Slack) and shared context"
read_when:
  - Changing channel routing or inbox behavior
title: "Channel Routing"
x-i18n:
  source_hash: cfc2cade2984225dd4c78aadc6ccdc36d209e19dd6ef2fc6e2aedac67ea758ef
---

# 채널 및 라우팅

OpenClaw는 **메시지가 전송된 채널로** 회신을 라우팅합니다. 는
모델은 채널을 선택하지 않습니다. 라우팅은 결정적이며 다음에 의해 제어됩니다.
호스트 구성.

## 주요 용어

- **채널**: `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`, `webchat`.
- **AccountId**: 채널별 계정 인스턴스(지원되는 경우).
- **에이전트 ID**: 격리된 작업 공간 + 세션 저장소("브레인").
- **SessionKey**: 컨텍스트를 저장하고 동시성을 제어하는 ​​데 사용되는 버킷 키입니다.

## 세션 키 형태(예)

직접 메시지는 상담원의 **기본** 세션으로 축소됩니다.

- `agent:<agentId>:<mainKey>` (기본값: `agent:main:main`)

그룹과 채널은 채널별로 격리된 상태로 유지됩니다.

- 그룹: `agent:<agentId>:<channel>:group:<id>`
- 채널/방: `agent:<agentId>:<channel>:channel:<id>`

스레드:

- Slack/Discord 스레드는 기본 키에 `:thread:<threadId>`를 추가합니다.
- 텔레그램 포럼 주제는 그룹 키에 `:topic:<topicId>`를 포함합니다.

예:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## 라우팅 규칙(상담원 선택 방법)

라우팅에서는 각 수신 메시지에 대해 **하나의 에이전트**를 선택합니다.

1. **정확한 피어 일치** (`bindings`와 `peer.kind` + `peer.id`).
2. `guildId`을 통한 **길드 매치**(Discord).
3. `teamId`를 통한 **팀 경기**(Slack).
4. **계정 일치** (채널의 `accountId`).
5. **채널 일치**(해당 채널의 모든 계정).
6. **기본 에이전트** (`agents.list[].default`, 그렇지 않으면 첫 번째 목록 항목, `main`로 대체).

일치하는 에이전트에 따라 사용되는 작업 영역과 세션 저장소가 결정됩니다.

## 브로드캐스트 그룹(여러 에이전트 실행)

브로드캐스트 그룹을 사용하면 OpenClaw가 일반적으로 응답할 때 동일한 피어에 대해 **여러 에이전트**를 실행할 수 있습니다(예: WhatsApp 그룹에서 멘션/활성화 게이팅 후).

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

참조: [브로드캐스트 그룹](/channels/broadcast-groups).

## 구성 개요

- `agents.list`: 명명된 에이전트 정의(작업공간, 모델 등).
- `bindings`: 인바운드 채널/계정/피어를 에이전트에 매핑합니다.

예:

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

## 세션 저장

세션 저장소는 상태 디렉터리(기본값 `~/.openclaw`) 아래에 있습니다.

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- JSONL 성적표가 매장 옆에 게시됩니다.

`session.store` 및 `{agentId}` 템플릿을 통해 저장소 경로를 재정의할 수 있습니다.

## 웹챗 동작

WebChat은 **선택한 상담원**에 연결되며 기본적으로 상담원의 기본 상담원으로 설정됩니다.
세션. 이 때문에 WebChat을 사용하면 해당 항목에 대한 교차 채널 컨텍스트를 확인할 수 있습니다.
한 곳에서 에이전트.

## 응답 컨텍스트

인바운드 응답에는 다음이 포함됩니다.

- `ReplyToId`, `ReplyToBody`, `ReplyToSender` 사용 가능한 경우.
- 인용된 컨텍스트는 `Body`에 `[Replying to ...]` 블록으로 추가됩니다.

이는 채널 전반에 걸쳐 일관됩니다.
