---
summary: "여러 플랫폼에서의 그룹 채팅 동작 (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams/Zalo)"
read_when:
  - 그룹 채팅 동작이나 멘션 게이팅을 변경하는 경우
title: "그룹"
x-i18n:
  source_path: docs/channels/groups.md
---

# 그룹

OpenClaw 는 여러 플랫폼에서 그룹 채팅을 일관되게 처리합니다: WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams, Zalo.

## 초보자 소개 (2 분)

OpenClaw 는 자신의 메시징 계정에서 "살아"있습니다. 별도의 WhatsApp 봇 사용자가 없습니다.
**자신이** 그룹에 있으면 OpenClaw 는 해당 그룹을 볼 수 있고 그곳에서 응답할 수 있습니다.

기본 동작:

- 그룹은 제한됩니다 (`groupPolicy: "allowlist"`).
- 멘션 게이팅을 명시적으로 비활성화하지 않는 한 응답에는 멘션이 필요합니다.

번역: 허용된 발신자가 멘션하여 OpenClaw 를 트리거할 수 있습니다.

> TL;DR
>
> - **DM 접근**은 `*.allowFrom` 으로 제어합니다.
> - **그룹 접근**은 `*.groupPolicy` + 허용 목록 (`*.groups`, `*.groupAllowFrom`) 으로 제어합니다.
> - **응답 트리거**는 멘션 게이팅 (`requireMention`, `/activation`) 으로 제어합니다.

빠른 흐름 (그룹 메시지에 무슨 일이 일어나는가):

```
groupPolicy? disabled -> 드롭
groupPolicy? allowlist -> 그룹 허용됨? 아니요 -> 드롭
requireMention? yes -> 멘션됨? 아니요 -> 컨텍스트용으로만 저장
그 외 -> 응답
```

![그룹 메시지 흐름](/images/groups-flow.svg)

원하는 경우...

| 목표                              | 설정할 것                                                  |
| --------------------------------- | ---------------------------------------------------------- |
| 모든 그룹 허용하되 @멘션에만 응답 | `groups: { "*": { requireMention: true } }`                |
| 모든 그룹 응답 비활성화           | `groupPolicy: "disabled"`                                  |
| 특정 그룹만                       | `groups: { "<group-id>": { ... } }` (`"*"` 키 없이)        |
| 그룹에서 자신만 트리거 가능       | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]` |

## 세션 키

- 그룹 세션은 `agent:<agentId>:<channel>:group:<id>` 세션 키를 사용합니다 (룸/채널은 `agent:<agentId>:<channel>:channel:<id>` 사용).
- Telegram 포럼 토픽은 그룹 ID 에 `:topic:<threadId>` 를 추가하여 각 토픽이 자체 세션을 가집니다.
- 다이렉트 채팅은 메인 세션을 사용합니다 (또는 구성된 경우 발신자별).
- 그룹 세션에서는 하트비트가 건너뛰어집니다.

## 패턴: 개인 DM + 공개 그룹 (단일 에이전트)

예 — **DM** 이 "개인" 트래픽이고 **그룹** 이 "공개" 트래픽인 경우 잘 작동합니다.

이유: 단일 에이전트 모드에서 DM 은 일반적으로 **메인** 세션 키 (`agent:main:main`) 에 도달하고, 그룹은 항상 **메인이 아닌** 세션 키 (`agent:main:<channel>:group:<id>`) 를 사용합니다. `mode: "non-main"` 으로 샌드박싱을 활성화하면, 해당 그룹 세션은 Docker 에서 실행되고 메인 DM 세션은 호스트에 남습니다.

이를 통해 하나의 에이전트 "두뇌" (공유 워크스페이스 + 메모리) 를 갖되, 두 가지 실행 자세를 가질 수 있습니다:

- **DM**: 전체 도구 (호스트)
- **그룹**: 샌드박스 + 제한된 도구 (Docker)

> 진정으로 별도의 워크스페이스/페르소나가 필요한 경우 ("개인"과 "공개"가 절대 섞이면 안 되는 경우), 두 번째 에이전트 + 바인딩을 사용하세요. [Multi-Agent Routing](/concepts/multi-agent) 을 참조하세요.

관련:

- 구성 키와 기본값: [Gateway configuration](/gateway/configuration-reference#agents-defaults-sandbox)
- 도구가 차단되는 이유 디버깅: [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
- 바인드 마운트 세부 사항: [Sandboxing](/gateway/sandboxing#custom-bind-mounts)

## 그룹 정책

채널별로 그룹/룸 메시지 처리 방식을 제어합니다:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789"], // 숫자 Telegram 사용자 ID (마법사가 @username 을 확인 가능)
    },
    signal: {
      groupPolicy: "disabled",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "disabled",
      groupAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "disabled",
      groupAllowFrom: ["user@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: { channels: { help: { allow: true } } },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
    matrix: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["@owner:example.org"],
      groups: {
        "!roomId:example.org": { allow: true },
        "#alias:example.org": { allow: true },
      },
    },
  },
}
```

| 정책          | 동작                                                            |
| ------------- | --------------------------------------------------------------- |
| `"open"`      | 그룹이 허용 목록을 우회합니다. 멘션 게이팅은 여전히 적용됩니다. |
| `"disabled"`  | 모든 그룹 메시지를 완전히 차단합니다.                           |
| `"allowlist"` | 구성된 허용 목록과 일치하는 그룹/룸만 허용합니다.               |

참고:

- `groupPolicy` 는 멘션 게이팅 (@멘션 필요) 과 별개입니다.
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams/Zalo: `groupAllowFrom` 을 사용합니다 (폴백: 명시적 `allowFrom`).
- DM 페어링 승인 (`*-allowFrom` 저장소 항목) 은 DM 접근에만 적용됩니다. 그룹 발신자 권한은 그룹 허용 목록에 명시적입니다.
- Discord: 허용 목록은 `channels.discord.guilds.<id>.channels` 를 사용합니다.
- Slack: 허용 목록은 `channels.slack.channels` 를 사용합니다.
- Matrix: 허용 목록은 `channels.matrix.groups` 를 사용합니다 (룸 ID, 별칭, 이름).
- 기본값은 `groupPolicy: "allowlist"` 입니다. 그룹 허용 목록이 비어 있으면 그룹 메시지가 차단됩니다.
- 런타임 안전: 프로바이더 블록이 완전히 없는 경우 (`channels.<provider>` 부재), 그룹 정책은 `channels.defaults.groupPolicy` 를 상속하는 대신 실패 시 닫기 모드 (일반적으로 `allowlist`) 로 폴백합니다.

## 멘션 게이팅 (기본값)

그룹 메시지는 그룹별로 재정의하지 않는 한 멘션이 필요합니다.

봇 메시지에 대한 응답은 암묵적 멘션으로 간주됩니다 (채널이 응답 메타데이터를 지원하는 경우). 이것은 Telegram, WhatsApp, Slack, Discord, Microsoft Teams 에 적용됩니다.

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
        "123@g.us": { requireMention: false },
      },
    },
    telegram: {
      groups: {
        "*": { requireMention: true },
        "123456789": { requireMention: false },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          mentionPatterns: ["@openclaw", "openclaw", "\\+15555550123"],
          historyLimit: 50,
        },
      },
    ],
  },
}
```

참고:

- `mentionPatterns` 는 대소문자를 구분하지 않는 안전 정규식 패턴입니다.
- 명시적 멘션을 제공하는 플랫폼은 여전히 통과합니다. 패턴은 폴백입니다.
- 에이전트별 재정의: `agents.list[].groupChat.mentionPatterns`.

## 그룹/채널 도구 제한 (선택)

일부 채널 구성은 특정 그룹/룸/채널 **내에서** 사용 가능한 도구를 제한하는 것을 지원합니다.

- `tools`: 전체 그룹에 대한 도구 허용/거부.
- `toolsBySender`: 그룹 내 발신자별 재정의.
  명시적 키 접두사 사용: `id:<senderId>`, `e164:<phone>`, `username:<handle>`, `name:<displayName>`, `"*"` 와일드카드.

확인 순서 (가장 구체적인 것이 우선):

1. 그룹/채널 `toolsBySender` 매치
2. 그룹/채널 `tools`
3. 기본 (`"*"`) `toolsBySender` 매치
4. 기본 (`"*"`) `tools`

## 그룹 허용 목록

`channels.whatsapp.groups`, `channels.telegram.groups`, 또는 `channels.imessage.groups` 가 구성된 경우, 키가 그룹 허용 목록으로 작동합니다. 기본 멘션 동작을 설정하면서 모든 그룹을 허용하려면 `"*"` 를 사용합니다.

## 활성화 (소유자 전용)

그룹 소유자가 그룹별 활성화를 전환할 수 있습니다:

- `/activation mention`
- `/activation always`

소유자는 `channels.whatsapp.allowFrom` (또는 미설정 시 봇의 자체 E.164) 으로 결정됩니다. 독립 메시지로 명령을 보내세요. 다른 플랫폼은 현재 `/activation` 을 무시합니다.

## 컨텍스트 필드

그룹 인바운드 페이로드 설정:

- `ChatType=group`
- `GroupSubject` (알려진 경우)
- `GroupMembers` (알려진 경우)
- `WasMentioned` (멘션 게이팅 결과)
- Telegram 포럼 토픽에는 `MessageThreadId` 와 `IsForum` 도 포함됩니다.

에이전트 시스템 프롬프트에는 새 그룹 세션의 첫 턴에 그룹 소개가 포함됩니다.

## iMessage 세부 사항

- 라우팅이나 허용 목록에서 `chat_id:<id>` 를 권장합니다.
- 채팅 목록: `imsg chats --limit 20`.
- 그룹 응답은 항상 동일한 `chat_id` 로 돌아갑니다.

## WhatsApp 세부 사항

WhatsApp 전용 동작 (기록 주입, 멘션 처리 세부 사항) 은 [Group messages](/channels/group-messages) 를 참조하세요.
