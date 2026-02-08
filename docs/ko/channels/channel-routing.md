---
read_when:
    - 채널 라우팅 또는 받은 편지함 동작 변경
summary: 채널(WhatsApp, Telegram, Discord, Slack) 및 공유 컨텍스트별 라우팅 규칙
title: 채널 라우팅
x-i18n:
    generated_at: "2026-02-08T15:47:11Z"
    model: gtx
    provider: google-translate
    source_hash: cfc2cade2984225dd4c78aadc6ccdc36d209e19dd6ef2fc6e2aedac67ea758ef
    source_path: channels/channel-routing.md
    workflow: 15
---

# 채널 및 라우팅

OpenClaw 경로 응답 **메시지가 전송된 채널로 돌아가기**. 는
모델은 채널을 선택하지 않습니다. 라우팅은 결정적이며 다음에 의해 제어됩니다.
호스트 구성.

## 주요 용어

- **채널**: `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`, `webchat`.
- **계정 ID**: 채널별 계정 인스턴스(지원되는 경우)
- **에이전트 ID**: 격리된 작업 공간 + 세션 저장소("브레인").
- **세션키**: 컨텍스트를 저장하고 동시성을 제어하는 ​​데 사용되는 버킷 키입니다.

## 세션 키 형태(예)

다이렉트 메시지는 상담원에게 접혀집니다. **기본** 세션:

- `agent:<agentId>:<mainKey>` (기본: `agent:main:main`)

그룹과 채널은 채널별로 격리된 상태로 유지됩니다.

- 여러 떼: `agent:<agentId>:<channel>:group:<id>`
- 채널/방: `agent:<agentId>:<channel>:channel:<id>`

스레드:

- Slack/Discord 스레드 추가 `:thread:<threadId>` 기본 키에.
- 전보 포럼 주제 삽입 `:topic:<topicId>` 그룹 키에 있습니다.

예:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## 라우팅 규칙(상담원 선택 방법)

라우팅 픽 **에이전트 1명** 각 인바운드 메시지에 대해:

1. **정확한 동료 일치** (`bindings` ~와 함께 `peer.kind` + `peer.id`).
2. **길드전** (디스코드)를 통해 `guildId`.
3. **팀전** (슬랙)을 통해 `teamId`.
4. **계정 일치** (`accountId` 채널에서).
5. **채널 일치** (해당 채널의 모든 계정)
6. **기본 에이전트** (`agents.list[].default`, 그렇지 않으면 첫 번째 목록 항목으로 대체 `main`).

일치하는 에이전트에 따라 사용되는 작업 영역과 세션 저장소가 결정됩니다.

## 브로드캐스트 그룹(여러 에이전트 실행)

방송 그룹을 통해 실행할 수 있습니다. **여러 에이전트** 같은 동료에게 **OpenClaw가 일반적으로 응답할 때** (예: WhatsApp 그룹에서 언급/활성화 게이팅 이후)

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

보다: [방송 그룹](/channels/broadcast-groups).

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

세션 저장소는 상태 디렉터리(기본값) 아래에 있습니다. `~/.openclaw`):

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- JSONL 성적표는 매장과 함께 제공됩니다.

다음을 통해 상점 경로를 재정의할 수 있습니다. `session.store` 그리고 `{agentId}` 템플릿.

## 웹챗 행동

WebChat은 다음에 연결됩니다. **선택한 에이전트** 기본값은 상담원의 기본입니다.
세션. 이 때문에 WebChat을 사용하면 해당 항목에 대한 교차 채널 컨텍스트를 확인할 수 있습니다.
한 곳에서 에이전트.

## 응답 컨텍스트

인바운드 응답에는 다음이 포함됩니다.

- `ReplyToId`, `ReplyToBody`, 그리고 `ReplyToSender` 가능한 경우.
- 인용된 컨텍스트가 다음에 추가됩니다. `Body` 로서 `[Replying to ...]` 차단하다.

이는 채널 전반에 걸쳐 일관됩니다.
