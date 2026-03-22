---
summary: "채널별 라우팅 규칙 (WhatsApp, Telegram, Discord, Slack) 및 공유 컨텍스트"
read_when:
  - 채널 라우팅 또는 인박스 동작을 변경하는 경우
title: "채널 라우팅"
x-i18n:
  source_path: docs/channels/channel-routing.md
---

# 채널 및 라우팅

OpenClaw 는 **메시지가 온 채널로 응답을 다시 라우팅**합니다. 모델은 채널을 선택하지 않으며, 라우팅은 결정적이고 호스트 구성에 의해 제어됩니다.

## 주요 용어

- **채널**: `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`, `webchat`.
- **AccountId**: 채널별 계정 인스턴스 (지원되는 경우).
- 선택적 채널 기본 계정: `channels.<channel>.defaultAccount` 는 아웃바운드 경로에서 `accountId` 를 지정하지 않을 때 사용할 계정을 선택합니다.
  - 다중 계정 설정에서는 두 개 이상의 계정이 구성된 경우 명시적 기본값 (`defaultAccount` 또는 `accounts.default`) 을 설정하세요. 이것이 없으면 폴백 라우팅이 첫 번째 정규화된 계정 ID 를 선택할 수 있습니다.
- **AgentId**: 격리된 워크스페이스 + 세션 저장소 ("두뇌").
- **SessionKey**: 컨텍스트를 저장하고 동시성을 제어하는 데 사용되는 버킷 키.

## 세션 키 형태 (예시)

다이렉트 메시지는 에이전트의 **main** 세션으로 축소됩니다:

- `agent:<agentId>:<mainKey>` (기본값: `agent:main:main`)

그룹과 채널은 채널별로 격리됩니다:

- 그룹: `agent:<agentId>:<channel>:group:<id>`
- 채널/룸: `agent:<agentId>:<channel>:channel:<id>`

스레드:

- Slack/Discord 스레드는 기본 키에 `:thread:<threadId>` 를 추가합니다.
- Telegram 포럼 토픽은 그룹 키에 `:topic:<topicId>` 를 포함합니다.

예시:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## 메인 DM 라우트 고정

`session.dmScope` 가 `main` 일 때, 다이렉트 메시지는 하나의 메인 세션을 공유할 수 있습니다.
세션의 `lastRoute` 가 비소유자 DM 에 의해 덮어쓰이는 것을 방지하기 위해, OpenClaw 는 다음 조건이 모두 참일 때 `allowFrom` 에서 고정된 소유자를 추론합니다:

- `allowFrom` 에 와일드카드가 아닌 항목이 정확히 하나 있음.
- 해당 항목이 해당 채널의 구체적인 발신자 ID 로 정규화될 수 있음.
- 인바운드 DM 발신자가 해당 고정된 소유자와 일치하지 않음.

이 불일치 상황에서 OpenClaw 는 여전히 인바운드 세션 메타데이터를 기록하지만, 메인 세션 `lastRoute` 업데이트는 건너뜁니다.

## 라우팅 규칙 (에이전트 선택 방법)

라우팅은 각 인바운드 메시지에 대해 **하나의 에이전트**를 선택합니다:

1. **정확한 피어 매치** (`peer.kind` + `peer.id` 가 있는 `bindings`).
2. **부모 피어 매치** (스레드 상속).
3. **길드 + 역할 매치** (Discord) `guildId` + `roles` 를 통해.
4. **길드 매치** (Discord) `guildId` 를 통해.
5. **팀 매치** (Slack) `teamId` 를 통해.
6. **계정 매치** (해당 채널의 `accountId`).
7. **채널 매치** (해당 채널의 모든 계정, `accountId: "*"`).
8. **기본 에이전트** (`agents.list[].default`, 없으면 첫 번째 목록 항목, `main` 으로 폴백).

바인딩에 여러 매치 필드 (`peer`, `guildId`, `teamId`, `roles`) 가 포함된 경우, 해당 바인딩이 적용되려면 **제공된 모든 필드가 일치**해야 합니다.

매치된 에이전트가 사용할 워크스페이스와 세션 저장소를 결정합니다.

## 브로드캐스트 그룹 (여러 에이전트 실행)

브로드캐스트 그룹을 사용하면 OpenClaw 가 **정상적으로 응답할 때** (예: WhatsApp 그룹에서 멘션/활성화 게이팅 후) 동일한 피어에 대해 **여러 에이전트**를 실행할 수 있습니다.

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

참조: [Broadcast Groups](/channels/broadcast-groups).

## 구성 개요

- `agents.list`: 명명된 에이전트 정의 (워크스페이스, 모델 등).
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

세션 저장소는 상태 디렉토리 (기본값 `~/.openclaw`) 하위에 있습니다:

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- JSONL 트랜스크립트는 저장소 옆에 위치

`session.store` 와 `{agentId}` 템플릿을 통해 저장소 경로를 재정의할 수 있습니다.

Gateway 및 ACP 세션 검색은 기본 `agents/` 루트와 템플릿화된 `session.store` 루트 하위의 디스크 기반 에이전트 저장소도 스캔합니다. 검색된 저장소는 해결된 에이전트 루트 내에 있어야 하며 일반 `sessions.json` 파일을 사용해야 합니다. 심볼릭 링크와 루트 외부 경로는 무시됩니다.

## WebChat 동작

WebChat 은 **선택된 에이전트**에 연결되며 에이전트의 메인 세션을 기본값으로 사용합니다. 이로 인해 WebChat 에서 해당 에이전트의 크로스 채널 컨텍스트를 한 곳에서 볼 수 있습니다.

## 응답 컨텍스트

인바운드 응답에는 다음이 포함됩니다:

- `ReplyToId`, `ReplyToBody`, `ReplyToSender` (사용 가능한 경우).
- 인용된 컨텍스트는 `Body` 에 `[Replying to ...]` 블록으로 추가됩니다.

이것은 채널 간에 일관됩니다.
