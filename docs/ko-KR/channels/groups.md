---
summary: "Group chat behavior across surfaces (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"
read_when:
  - Changing group chat behavior or mention gating
title: "Groups"
x-i18n:
  source_hash: 5380e07ea01f4a8fa8803d020feb5beba50da4f48817509ba848fdd71c12d250
---

# 그룹

OpenClaw는 WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams 등 여러 표면에서 그룹 채팅을 일관되게 처리합니다.

## 초보자 소개(2분)

OpenClaw는 귀하의 메시징 계정에 "살아 있습니다". 별도의 WhatsApp 봇 사용자가 없습니다.
**귀하**가 그룹에 속해 있는 경우 OpenClaw는 해당 그룹을 보고 거기에 응답할 수 있습니다.

기본 동작:

- 그룹이 제한됩니다(`groupPolicy: "allowlist"`).
- 멘션 게이팅을 명시적으로 비활성화하지 않는 한 답글에는 멘션이 필요합니다.

번역: 허용 목록에 있는 발신자는 이를 언급하여 OpenClaw를 실행할 수 있습니다.

> 요약;DR
>
> - **DM 액세스**는 `*.allowFrom`에 의해 제어됩니다.
> - **그룹 액세스**는 `*.groupPolicy` + 허용 목록(`*.groups`, `*.groupAllowFrom`)에 의해 제어됩니다.
> - **응답 트리거**는 멘션 게이팅(`requireMention`, `/activation`)에 의해 제어됩니다.

빠른 흐름(그룹 메시지는 어떻게 되나요?):

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![그룹 메시지 흐름](/images/groups-flow.svg)

원한다면...

| 목표                                  | 무엇을 설정할 것인가                                       |
| ------------------------------------- | ---------------------------------------------------------- |
| 모든 그룹을 허용하지만 @멘션에만 응답 | `groups: { "*": { requireMention: true } }`                |
| 모든 그룹 답장 비활성화               | `groupPolicy: "disabled"`                                  |
| 특정 그룹만                           | `groups: { "<group-id>": { ... } }` (`"*"` 키 없음)        |
| 귀하만 그룹으로 트리거할 수 있습니다  | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]` |

## 세션 키

- 그룹 세션은 `agent:<agentId>:<channel>:group:<id>` 세션 키를 사용합니다(룸/채널은 `agent:<agentId>:<channel>:channel:<id>`를 사용합니다).
- 텔레그램 포럼 주제는 그룹 ID에 `:topic:<threadId>`를 추가하여 각 주제마다 고유한 세션을 갖습니다.
- 직접 채팅은 기본 세션(또는 구성된 경우 보낸 사람별)을 사용합니다.
- 그룹 세션에서는 하트비트를 건너뜁니다.

## 패턴: 개인 DM + 공개 그룹(단일 에이전트)

예. "개인" 트래픽이 **DM**이고 "공용" 트래픽이 **그룹**인 경우에 잘 작동합니다.

이유: 단일 에이전트 모드에서 DM은 일반적으로 **기본** 세션 키(`agent:main:main`)에 있는 반면, 그룹은 항상 **비기본** 세션 키(`agent:main:<channel>:group:<id>`)를 사용합니다. `mode: "non-main"`를 사용하여 샌드박싱을 활성화하면 해당 그룹 세션은 기본 DM 세션이 호스트에 유지되는 동안 Docker에서 실행됩니다.

이는 하나의 에이전트 "브레인"(공유 작업 공간 + 메모리)을 제공하지만 실행 상태는 두 가지입니다.

- **DM**: 전체 도구(호스트)
- **그룹**: 샌드박스 + 제한된 도구(Docker)

> 완전히 별도의 작업 공간/페르소나가 필요한 경우("개인"과 "공용"이 혼합되어서는 안 됨) 두 번째 에이전트 + 바인딩을 사용하세요. [다중 에이전트 라우팅](/concepts/multi-agent)을 참조하세요.

예(호스트의 DM, 샌드박스 그룹 + 메시징 전용 도구):

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

"호스트 액세스 없음" 대신 "그룹은 폴더 X만 볼 수 있음"을 원하십니까? `workspaceAccess: "none"`를 유지하고 허용 목록에 있는 경로만 샌드박스에 마운트합니다.

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
            "~/FriendsShared:/data:ro",
          ],
        },
      },
    },
  },
}
```

관련 항목:

- 구성 키 및 기본값: [게이트웨이 구성](/gateway/configuration#agentsdefaultssandbox)
- 도구가 차단된 이유 디버깅: [샌드박스 vs 도구 정책 vs 상승](/gateway/sandbox-vs-tool-policy-vs-elevated)
- 바인드 마운트 세부사항: [샌드박싱](/gateway/sandboxing#custom-bind-mounts)

## 표시 라벨

- UI 레이블은 사용 가능한 경우 `displayName`를 사용하며 `<channel>:<token>` 형식으로 지정됩니다.
- `#room`는 룸/채널용으로 예약되어 있습니다. 그룹 채팅에서는 `g-<slug>`(소문자, 공백 -> `-`, 유지 `#@+._-`)를 사용합니다.

## 그룹 정책

그룹/방 메시지가 채널별로 처리되는 방식을 제어합니다.

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "disabled", // "open" | "disabled" | "allowlist"
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "disabled",
      groupAllowFrom: ["123456789", "@username"],
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

| 정책          | 행동                                                              |
| ------------- | ----------------------------------------------------------------- |
| `"open"`      | 그룹은 허용 목록을 우회합니다. 멘션 게이팅은 여전히 ​​적용됩니다. |
| `"disabled"`  | 모든 그룹 메시지를 완전히 차단합니다.                             |
| `"allowlist"` | 구성된 허용 목록과 일치하는 그룹/방만 허용합니다.                 |

참고:

- `groupPolicy`는 멘션 게이팅(@멘션 필요)과 별개입니다.
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams: `groupAllowFrom` 사용(대체: 명시적 `allowFrom`).
- Discord: 허용 목록은 `channels.discord.guilds.<id>.channels`를 사용합니다.
- Slack: 허용 목록은 `channels.slack.channels`를 사용합니다.
- 매트릭스: 허용 목록은 `channels.matrix.groups`(방 ID, 별칭 또는 이름)를 사용합니다. 발신자를 제한하려면 `channels.matrix.groupAllowFrom`를 사용하세요. 방별 `users` 허용 목록도 지원됩니다.
- 그룹 DM은 별도로 관리됩니다(`channels.discord.dm.*`, `channels.slack.dm.*`).
- 텔레그램 허용 목록은 사용자 ID(`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) 또는 사용자 이름(`"@alice"` 또는 `"alice"`)과 일치할 수 있습니다. 접두사는 대소문자를 구분하지 않습니다.
- 기본값은 `groupPolicy: "allowlist"`입니다. 그룹 허용 목록이 비어 있으면 그룹 메시지가 차단됩니다.

빠른 정신 모델(그룹 메시지 평가 순서):

1. `groupPolicy` (열기/비활성화/허용 목록)
2. 그룹 허용 목록(`*.groups`, `*.groupAllowFrom`, 채널별 허용 목록)
3. 게이팅 언급 (`requireMention`, `/activation`)

## 게이팅 언급(기본값)

그룹별로 재정의되지 않는 한 그룹 메시지에는 멘션이 필요합니다. 기본값은 `*.groups."*"` 아래 하위 시스템별로 적용됩니다.

봇 메시지에 응답하는 것은 암시적 멘션으로 간주됩니다(채널이 응답 메타데이터를 지원하는 경우). 이는 Telegram, WhatsApp, Slack, Discord 및 Microsoft Teams에 적용됩니다.

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

- `mentionPatterns`는 대소문자를 구분하지 않는 정규식입니다.
- 명시적인 언급을 제공하는 표면은 여전히 ​​통과됩니다. 패턴은 대체입니다.
- 에이전트별 재정의: `agents.list[].groupChat.mentionPatterns` (여러 에이전트가 그룹을 공유하는 경우 유용함)
- 멘션 게이팅은 멘션 감지가 가능한 경우에만 시행됩니다(네이티브 멘션 또는 `mentionPatterns`가 구성됨).
- Discord 기본값은 `channels.discord.guilds."*"`에 적용됩니다(길드/채널별로 재정의 가능).
- 그룹 내역 컨텍스트는 채널 전반에 걸쳐 균일하게 래핑되며 **보류 전용**입니다(멘션 게이팅으로 인해 메시지 건너뛰기). 전역 기본값에는 `messages.groupChat.historyLimit`를 사용하고 재정의에는 `channels.<channel>.historyLimit`(또는 `channels.<channel>.accounts.*.historyLimit`)를 사용합니다. 비활성화하려면 `0`를 설정하세요.

## 그룹/채널 도구 제한 사항(선택 사항)

일부 채널 구성은 **특정 그룹/룸/채널** 내에서 사용할 수 있는 도구를 제한하는 기능을 지원합니다.

- `tools`: 전체 그룹에 대한 도구를 허용/거부합니다.
- `toolsBySender`: 그룹 내의 발신자별 재정의(키는 채널에 따라 발신자 ID/사용자 이름/이메일/전화번호입니다). `"*"`를 와일드카드로 사용하세요.

해결 순서(가장 구체적인 승리):

1. 그룹/채널 `toolsBySender` 일치
2. 그룹/채널 `tools`
3. 기본값 (`"*"`) `toolsBySender` 일치
4. 기본값 (`"*"`) `tools`

예(텔레그램):

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { tools: { deny: ["exec"] } },
        "-1001234567890": {
          tools: { deny: ["exec", "read", "write"] },
          toolsBySender: {
            "123456789": { alsoAllow: ["exec"] },
          },
        },
      },
    },
  },
}
```

참고:

- 글로벌/에이전트 도구 정책에 추가로 그룹/채널 도구 제한이 적용됩니다(거부 여전히 승리).
- 일부 채널은 룸/채널에 대해 서로 다른 중첩을 사용합니다(예: Discord `guilds.*.channels.*`, Slack `channels.*`, MS Teams `teams.*.channels.*`).

## 그룹 허용 목록

`channels.whatsapp.groups`, `channels.telegram.groups` 또는 `channels.imessage.groups`가 구성되면 키가 그룹 허용 목록으로 작동합니다. 기본 멘션 동작을 설정하면서 모든 그룹을 허용하려면 `"*"`를 사용하세요.

일반적인 의도(복사/붙여넣기):

1. 모든 그룹 답장 비활성화

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

3. 모든 그룹을 허용하되 언급을 요구함(명시적)

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. 소유자만 그룹(WhatsApp)으로 트리거할 수 있습니다.

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

## 활성화(소유자 전용)

그룹 소유자는 그룹별 활성화를 전환할 수 있습니다.

- `/activation mention`
- `/activation always`

소유자는 `channels.whatsapp.allowFrom`(또는 설정되지 않은 경우 봇 자체 E.164)에 의해 결정됩니다. 명령을 독립형 메시지로 보냅니다. 다른 표면은 현재 `/activation`를 무시합니다.

## 컨텍스트 필드

그룹 인바운드 페이로드 세트:

- `ChatType=group`
- `GroupSubject` (알려진 경우)
- `GroupMembers` (알려진 경우)
- `WasMentioned` (게이팅 결과 언급)
- 텔레그램 포럼 주제에는 `MessageThreadId` 및 `IsForum`도 포함됩니다.

에이전트 시스템 프롬프트에는 새 그룹 세션의 첫 번째 차례에 그룹 소개가 포함됩니다. 모델이 인간처럼 반응하고, 마크다운 테이블을 피하고, 리터럴 `\n` 시퀀스를 입력하지 않도록 상기시킵니다.

## iMessage 관련 사항

- 라우팅이나 허용 목록 작성 시 `chat_id:<id>`를 선호합니다.
- 채팅 목록: `imsg chats --limit 20`.
- 그룹 답글은 항상 동일한 `chat_id`로 돌아갑니다.

## WhatsApp 세부 사항

WhatsApp 전용 동작(기록 삽입, 멘션 처리 세부정보)은 [그룹 메시지](/channels/group-messages)를 참조하세요.
