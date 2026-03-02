---
summary: "표면 간 그룹 채팅 동작 (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams/Zalo)"
read_when:
  - 그룹 채팅 동작 또는 언급 게이팅 변경 중
title: "그룹"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: channels/groups.md
  workflow: 15
---

# 그룹

OpenClaw 는 표면 간에 그룹 채팅을 일관되게 취급합니다: WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams, Zalo.

## 초보자 소개 (2 분)

OpenClaw 는 당신 자신의 메시징 계정에 "산다". 별도의 WhatsApp 봇 사용자가 없습니다.
**당신이** 그룹에 있으면 OpenClaw 는 해당 그룹을 보고 거기에 응답할 수 있습니다.

기본 동작:

- 그룹은 제한됩니다 (`groupPolicy: "allowlist"`).
- 회신은 명시적으로 언급 게이팅을 비활성화하지 않으면 언급을 필요로 합니다.

변환: 허용 목록에 있는 발신자는 언급하여 OpenClaw 를 트리거할 수 있습니다.

> TL;DR
>
> - **DM 접근** 은 `*.allowFrom` 으로 제어됩니다.
> - **그룹 접근** 은 `*.groupPolicy` + 허용 목록 (`*.groups`, `*.groupAllowFrom`) 으로 제어됩니다.
> - **회신 트리거** 는 언급 게이팅 (`requireMention`, `/activation`) 으로 제어됩니다.

빠른 흐름 (그룹 메시지에 어떤 일이 일어나는가):

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![그룹 메시지 흐름](/images/groups-flow.svg)

당신이 원한다면...

| 목표                                       | 설정 내용                                                  |
| ------------------------------------------ | ---------------------------------------------------------- |
| 모든 그룹 허용하지만 @mentions 에서만 회신 | `groups: { "*": { requireMention: true } }`                |
| 모든 그룹 회신 비활성화                    | `groupPolicy: "disabled"`                                  |
| 특정 그룹만                                | `groups: { "<group-id>": { ... } }` (no `"*"` key)         |
| 당신만 그룹에서 트리거할 수 있음           | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]` |

## 세션 키

- 그룹 세션은 `agent:<agentId>:<channel>:group:<id>` 세션 키를 사용합니다 (방/채널은 `agent:<agentId>:<channel>:channel:<id>` 사용).
- Telegram 포럼 토픽은 그룹 ID 에 `:topic:<threadId>` 를 추가하여 각 토픽이 자신의 세션을 가집니다.
- 직접 채팅은 주 세션을 사용합니다 (또는 구성된 경우 발신자별).
- 하트비트는 그룹 세션에 대해 건너뜁니다.

## 패턴: 개인 DM + 공개 그룹 (단일 에이전트)

네 — "개인" 트래픽이 **DM** 이고 "공개" 트래픽이 **그룹** 이면 잘 작동합니다.

이유: 단일 에이전트 모드에서 DM 은 일반적으로 **주** 세션 키 (`agent:main:main`) 에 도착하는 반면 그룹은 항상 **비주** 세션 키 (`agent:main:<channel>:group:<id>`) 를 사용합니다. `mode: "non-main"` 으로 샌드박싱을 활성화하면 해당 그룹 세션은 Docker 에서 실행되는 반면 주 DM 세션은 호스트에 유지됩니다.

이것은 하나의 에이전트 "뇌" (공유 워크스페이스 + 메모리) 를 제공하지만 두 개의 실행 자세를 제공합니다:

- **DM**: 전체 도구 (호스트)
- **그룹**: 샌드박스 + 제한된 도구 (Docker)

> 진정으로 별도의 워크스페이스/페르소나가 필요한 경우 ("개인" 및 "공개" 는 절대 혼합되지 않아야 함) 두 번째 에이전트 + 바인딩을 사용합니다. [다중 에이전트 라우팅](/concepts/multi-agent) 을 참고하세요.

예제 (호스트의 DM, 샌드박스된 그룹 + 메시징 전용 도구):

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // groups/channels are non-main -> sandboxed
        scope: "session", // strongest isolation (one container per group/channel)
        workspaceAccess: "none",
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        // If allow is non-empty, everything else is blocked (deny still wins).
        allow: ["group:messaging", "group:sessions"],
        deny: ["group:runtime", "group:fs", "group:ui", "nodes", "cron", "gateway"],
      },
    },
  },
}
```

"호스트 접근 없음" 대신 "그룹은 폴더 X 만 볼 수 있음" 을 원하십니까? `workspaceAccess: "none"` 을 유지하고 샌드박스에 허용 목록에 있는 경로만 마운트합니다:

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main",
        scope: "session",
        workspaceAccess: "none",
        docker: {
          binds: [
            // hostPath:containerPath:mode
            "/home/user/FriendsShared:/data:ro",
          ],
        },
      },
    },
  },
}
```

관련:

- 구성 키 및 기본값: [Gateway 구성](/gateway/configuration#agentsdefaultssandbox)
- 도구가 차단된 이유 디버깅: [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
- 바인드 마운트 세부 사항: [샌드박싱](/gateway/sandboxing#custom-bind-mounts)

## 표시 레이블

- UI 레이블은 `displayName` (사용 가능한 경우) 을 사용하며 `<channel>:<token>` 로 형식화됩니다.
- `#room` 은 방/채널용으로 예약되어 있습니다. 그룹 채팅은 `g-<slug>` 을 사용합니다 (소문자, spaces -> `-`, keep `#@+._-`).

## 그룹 정책

채널당 그룹/방 메시지를 처리하는 방법을 제어합니다:

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789"], // numeric Telegram user id (wizard can resolve @username)
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

| 정책          | 동작                                                                |
| ------------- | ------------------------------------------------------------------- |
| `"open"`      | 그룹은 허용 목록을 무시합니다. mention-gating 은 여전히 적용됩니다. |
| `"disabled"`  | 모든 그룹 메시지를 완전히 차단합니다.                               |
| `"allowlist"` | 구성된 허용 목록과 일치하는 그룹/방만 허용합니다.                   |

참고:

- `groupPolicy` 는 언급 게이팅 (@mentions 필요) 과 별개입니다.
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams/Zalo: `groupAllowFrom` 사용 (폴백: 명시적 `allowFrom`).
- DM 페어링 승인 (`*-allowFrom` 저장소 항목) 은 DM 접근에만 적용됩니다. 그룹 발신자 권한 부여는 그룹 허용 목록으로 명시적으로 유지됩니다.
- Discord: 허용 목록은 `channels.discord.guilds.<id>.channels` 를 사용합니다.
- Slack: 허용 목록은 `channels.slack.channels` 를 사용합니다.
- Matrix: 허용 목록은 `channels.matrix.groups` 을 사용합니다 (방 ID, alias 또는 이름). `channels.matrix.groupAllowFrom` 을 사용하여 발신자를 제한합니다. 방별 `users` 허용 목록도 지원됩니다.
- 그룹 DM 은 별도로 제어됩니다 (`channels.discord.dm.*`, `channels.slack.dm.*`).
- Telegram 허용 목록은 사용자 ID (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) 또는 사용자명 (`"@alice"` 또는 `"alice"`) 과 일치할 수 있습니다. 접두사는 대소문자를 구분하지 않습니다.
- 기본값은 `groupPolicy: "allowlist"`. 그룹 허용 목록이 비어 있으면 그룹 메시지가 차단됩니다.
- 런타임 보안: 공급자 블록이 완전히 누락된 경우 (`channels.<provider>` 부재), 그룹 정책은 `channels.defaults.groupPolicy` 를 상속하는 대신 일반적으로 fail-closed 모드 (`allowlist`) 로 폴백합니다.

빠른 정신 모델 (그룹 메시지에 대한 평가 순서):

1. `groupPolicy` (open/disabled/allowlist)
2. 그룹 허용 목록 (`*.groups`, `*.groupAllowFrom`, 채널 특정 허용 목록)
3. 언급 게이팅 (`requireMention`, `/activation`)

## 언급 게이팅 (기본)

그룹 메시지는 그룹별로 재정의되지 않으면 언급이 필요합니다. 기본값은 `*.groups."*"` 아래 서브시스템별로 있습니다.

봇 메시지에 회신하는 것은 암시적 언급으로 계산됩니다 (채널이 회신 메타데이터를 지원하는 경우). 이는 Telegram, WhatsApp, Slack, Discord 및 Microsoft Teams에 적용됩니다.

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
    imessage: {
      groups: {
        "*": { requireMention: true },
        "123": { requireMention: false },
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

- `mentionPatterns` 은 대소문자를 구분하지 않는 정규식입니다.
- 명시적 언급을 제공하는 표면은 여전히 통과합니다. 패턴은 폴백입니다.
- 에이전트별 재정의: `agents.list[].groupChat.mentionPatterns` (여러 에이전트가 그룹을 공유할 때 유용).
- 언급 게이팅은 언급 감지가 가능할 때만 강제됩니다 (네이티브 언급 또는 `mentionPatterns` 구성).
- Discord 기본값은 `channels.discord.guilds."*"` 에 있습니다 (guild/채널별로 재정의 가능).
- 그룹 이력 컨텍스트는 채널 전체에서 균일하게 래핑되며 **pending 만** 입니다 (언급 게이팅으로 인해 건너뛴 메시지). 글로벌 기본값으로 `messages.groupChat.historyLimit` 을 사용하고 재정의를 위해 `channels.<channel>.historyLimit` (또는 `channels.<channel>.accounts.*.historyLimit`) 을 사용합니다. `0` 으로 설정하여 비활성화합니다.

## 그룹/채널 도구 제한 (선택 사항)

일부 채널 구성은 **특정 그룹/방/채널 내에서** 사용 가능한 도구를 제한하는 것을 지원합니다.

- `tools`: 전체 그룹에 대한 도구 허용/거부.
- `toolsBySender`: 그룹 내 발신자별 재정의.
  명시적 키 접두사 사용:
  `id:<senderId>`, `e164:<phone>`, `username:<handle>`, `name:<displayName>` 및 `"*"` 와일드카드.
  레거시 접두사 없는 키는 여전히 허용되며 `id:` 로만 일치합니다.

해석 순서 (가장 구체적인 것이 wins):

1. 그룹/채널 `toolsBySender` 일치
2. 그룹/채널 `tools`
3. 기본 (`"*"`) `toolsBySender` 일치
4. 기본 (`"*"`) `tools`

예제 (Telegram):

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { tools: { deny: ["exec"] } },
        "-1001234567890": {
          tools: { deny: ["exec", "read", "write"] },
          toolsBySender: {
            "id:123456789": { alsoAllow: ["exec"] },
          },
        },
      },
    },
  },
}
```

참고:

- 그룹/채널 도구 제한은 글로벌/에이전트 도구 정책에 추가로 적용됩니다 (거부가 여전히 wins).
- 일부 채널은 방/채널에 대해 다른 nesting 을 사용합니다 (예: Discord `guilds.*.channels.*`, Slack `channels.*`, MS Teams `teams.*.channels.*`).

## 그룹 허용 목록

`channels.whatsapp.groups`, `channels.telegram.groups` 또는 `channels.imessage.groups` 이 구성되면 키는 그룹 허용 목록으로 작동합니다. 기본 언급 동작을 설정하면서 모든 그룹을 허용하려면 `"*"` 을 사용합니다.

일반적인 의도 (복사/붙여넣기):

1. 모든 그룹 회신 비활성화

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. 특정 그룹만 허용 (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "123@g.us": { requireMention: true },
        "456@g.us": { requireMention: false },
      },
    },
  },
}
```

3. 모든 그룹 허용하지만 언급 필요 (명시적)

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. 당신만 그룹에서 트리거할 수 있음 (WhatsApp)

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## 활성화 (소유자 전용)

그룹 소유자는 그룹별 활성화를 전환할 수 있습니다:

- `/activation mention`
- `/activation always`

소유자는 `channels.whatsapp.allowFrom` 으로 결정됩니다 (또는 설정되지 않을 때 봇의 자체 E.164). 명령을 standalone 메시지로 전송합니다. 다른 표면은 현재 `/activation` 을 무시합니다.

## 컨텍스트 필드

그룹 인바운드 페이로드 세트:

- `ChatType=group`
- `GroupSubject` (알려진 경우)
- `GroupMembers` (알려진 경우)
- `WasMentioned` (언급 게이팅 결과)
- Telegram 포럼 토픽은 `MessageThreadId` 및 `IsForum` 도 포함합니다.

에이전트 시스템 프롬프트는 새 그룹 세션의 첫 번째 회전에서 그룹 소개를 포함합니다. 이것은 모델에 인간처럼 응답하도록 상기시키고 Markdown 표를 피하고 literal `\n` 시퀀스를 입력하지 않도록 상기합니다.

## iMessage 특성

- 라우팅 또는 허용 목록 작성 시 `chat_id:<id>` 를 선호합니다.
- 채팅 나열: `imsg chats --limit 20`.
- 그룹 회신은 항상 같은 `chat_id` 로 돌아갑니다.

## WhatsApp 특성

WhatsApp 전용 동작은 [그룹 메시지](/channels/group-messages) 를 참고하세요 (이력 주입, 언급 처리 세부 사항).
