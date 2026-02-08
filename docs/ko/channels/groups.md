---
read_when:
    - 그룹 채팅 동작 변경 또는 게이팅 언급
summary: 다양한 플랫폼(WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)에서 그룹 채팅 동작
title: 여러 떼
x-i18n:
    generated_at: "2026-02-08T15:50:20Z"
    model: gtx
    provider: google-translate
    source_hash: 5380e07ea01f4a8fa8803d020feb5beba50da4f48817509ba848fdd71c12d250
    source_path: channels/groups.md
    workflow: 15
---

# 여러 떼

OpenClaw는 WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams 등 여러 표면에서 그룹 채팅을 일관되게 처리합니다.

## 초보자 소개(2분)

OpenClaw는 귀하의 메시징 계정에 "살아 있습니다". 별도의 WhatsApp 봇 사용자가 없습니다.
만약에 **너** OpenClaw는 그룹에 속해 있으면 해당 그룹을 보고 응답할 수 있습니다.

기본 동작:

- 그룹은 제한됩니다(`groupPolicy: "allowlist"`).
- 멘션 게이팅을 명시적으로 비활성화하지 않는 한 회신에는 멘션이 필요합니다.

번역: 허용 목록에 있는 발신자는 이를 언급하여 OpenClaw를 실행할 수 있습니다.

> TL;DR
>
> - **DM접속** 에 의해 제어됩니다 `*.allowFrom`.
> - **그룹 액세스** 에 의해 제어됩니다 `*.groupPolicy` + 허용 목록(`*.groups`, `*.groupAllowFrom`).
> - **응답 트리거** 멘션 게이팅에 의해 제어됩니다(`requireMention`, `/activation`).

빠른 흐름(그룹 메시지는 어떻게 되나요?):

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![그룹 메시지 흐름](/images/groups-flow.svg)

원한다면...

| Goal                                         | What to set                                                |
| -------------------------------------------- | ---------------------------------------------------------- |
| Allow all groups but only reply on @mentions | `groups: { "*": { requireMention: true } }`                |
| Disable all group replies                    | `groupPolicy: "disabled"`                                  |
| Only specific groups                         | `groups: { "<group-id>": { ... } }` (no `"*"` key)         |
| Only you can trigger in groups               | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]` |

## 세션 키

- 그룹 세션 사용 `agent:<agentId>:<channel>:group:<id>` 세션 키(방/채널 사용 `agent:<agentId>:<channel>:channel:<id>`).
- 텔레그램 포럼 주제 추가 `:topic:<threadId>` 각 주제에 자체 세션이 있도록 그룹 ID에 추가합니다.
- 직접 채팅은 기본 세션(또는 구성된 경우 발신자별)을 사용합니다.
- 그룹 세션에서는 하트비트를 건너뜁니다.

## 패턴: 개인 DM + 공개 그룹(단일 에이전트)

예. "개인" 트래픽이 다음과 같은 경우에 적합합니다. **DM** 귀하의 "공용" 트래픽은 **여러 떼**.

이유: 단일 에이전트 모드에서 DM은 일반적으로 **기본** 세션 키(`agent:main:main`), 그룹에서는 항상 **메인이 아닌** 세션 키(`agent:main:<channel>:group:<id>`). 샌드박싱을 활성화하면 `mode: "non-main"`, 해당 그룹 세션은 기본 DM 세션이 호스트에 유지되는 동안 Docker에서 실행됩니다.

이는 하나의 에이전트 "브레인"(공유 작업 공간 + 메모리)을 제공하지만 실행 상태는 두 가지입니다.

- **DM**: 전체 도구(호스트)
- **여러 떼**: 샌드박스 + 제한된 도구(Docker)

> 완전히 별도의 작업 공간/페르소나가 필요한 경우("개인"과 "공용"이 혼합되어서는 안 됨) 두 번째 에이전트 + 바인딩을 사용하세요. 보다 [다중 에이전트 라우팅](/concepts/multi-agent).

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

"호스트 액세스 없음" 대신 "그룹은 폴더 X만 볼 수 있음"을 원하십니까? 유지하다 `workspaceAccess: "none"` 허용 목록에 있는 경로만 샌드박스에 마운트합니다.

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

관련된:

- 구성 키 및 기본값: [게이트웨이 구성](/gateway/configuration#agentsdefaultssandbox)
- 도구가 차단된 이유 디버깅: [샌드박스 vs 도구 정책 vs 상승](/gateway/sandbox-vs-tool-policy-vs-elevated)
- 바인드 마운트 세부사항: [샌드박싱](/gateway/sandboxing#custom-bind-mounts)

## 라벨 표시

- UI 라벨 사용 `displayName` 사용 가능한 경우 다음과 같은 형식으로 지정됩니다. `<channel>:<token>`.
- `#room` 룸/채널용으로 예약되어 있습니다. 그룹 채팅 사용 `g-<slug>` (소문자, 공백 -> `-`, 유지하다 `#@+._-`).

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

| Policy        | Behavior                                                     |
| ------------- | ------------------------------------------------------------ |
| `"open"`      | Groups bypass allowlists; mention-gating still applies.      |
| `"disabled"`  | Block all group messages entirely.                           |
| `"allowlist"` | Only allow groups/rooms that match the configured allowlist. |

참고:

- `groupPolicy` 멘션 게이팅(@멘션 필요)과는 별개입니다.
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams: 사용 `groupAllowFrom` (대체: 명시적 `allowFrom`).
- Discord: 허용 목록 사용 `channels.discord.guilds.<id>.channels`.
- Slack: 허용 목록 사용 `channels.slack.channels`.
- 매트릭스: 허용 목록 사용 `channels.matrix.groups` (방 ID, 별칭 또는 이름). 사용 `channels.matrix.groupAllowFrom` 발신자를 제한하기 위해; 객실별 `users` 허용 목록도 지원됩니다.
- 그룹 DM은 별도로 관리됩니다(`channels.discord.dm.*`, `channels.slack.dm.*`).
- 텔레그램 허용 목록은 사용자 ID(`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) 또는 사용자 이름(`"@alice"` 또는 `"alice"`); 접두사는 대소문자를 구분하지 않습니다.
- 기본값은 `groupPolicy: "allowlist"`; 그룹 허용 목록이 비어 있으면 그룹 메시지가 차단됩니다.

빠른 정신 모델(그룹 메시지 평가 순서):

1. `groupPolicy` (열림/비활성화/허용 목록)
2. 그룹 허용 목록(`*.groups`, `*.groupAllowFrom`, 채널별 허용 목록)
3. 게이팅 언급(`requireMention`, `/activation`)

## 멘션 게이팅(기본값)

그룹별로 재정의되지 않는 한 그룹 메시지에는 멘션이 필요합니다. 기본값은 하위 시스템별로 적용됩니다. `*.groups."*"`.

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

- `mentionPatterns` 대소 문자를 구분하지 않는 정규식입니다.
- 명시적인 언급을 제공하는 표면은 여전히 ​​통과됩니다. 패턴은 대체입니다.
- 에이전트별 재정의: `agents.list[].groupChat.mentionPatterns` (여러 상담원이 그룹을 공유할 때 유용합니다)
- 멘션 게이팅은 멘션 감지가 가능한 경우에만 시행됩니다(기본 멘션 또는 `mentionPatterns` 구성되어 있습니다).
- Discord 기본값은 다음과 같습니다. `channels.discord.guilds."*"` (길드/채널별로 재정의 가능)
- 그룹 기록 컨텍스트는 채널 전반에 걸쳐 균일하게 래핑되며 **보류 전용** (멘션 게이팅으로 인해 메시지가 건너뛰었습니다); 사용 `messages.groupChat.historyLimit` 전역 기본값의 경우 `channels.<channel>.historyLimit` (또는 `channels.<channel>.accounts.*.historyLimit`) 재정의의 경우. 세트 `0` 비활성화합니다.

## 그룹/채널 도구 제한 사항(선택 사항)

일부 채널 구성은 사용 가능한 도구 제한을 지원합니다. **특정 그룹/방/채널 내부**.

- `tools`: 전체 그룹에 대한 도구를 허용/거부합니다.
- `toolsBySender`: 그룹 내의 발신자별 재정의(키는 채널에 따라 발신자 ID/사용자 이름/이메일/전화번호입니다). 사용 `"*"` 와일드카드로.

해결 순서(가장 구체적인 승리):

1. 그룹/채널 `toolsBySender` 성냥
2. 그룹/채널 `tools`
3. 기본 (`"*"`)`toolsBySender` 성냥
4. 기본 (`"*"`)`tools`

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
- 일부 채널은 룸/채널에 대해 서로 다른 중첩을 사용합니다(예: Discord `guilds.*.channels.*`, 슬랙 `channels.*`, MS 팀즈 `teams.*.channels.*`).

## 그룹 허용 목록

언제 `channels.whatsapp.groups`, `channels.telegram.groups`, 또는 `channels.imessage.groups` 구성되면 키는 그룹 허용 목록으로 작동합니다. 사용 `"*"` 기본 멘션 동작을 설정하면서 모든 그룹을 허용합니다.

일반적인 의도(복사/붙여넣기):

1. 모든 그룹 답장 비활성화

```json5
{
  channels: { whatsapp: { groupPolicy: "disabled" } },
}
```

2. 특정 그룹만 허용(WhatsApp)

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

3. 모든 그룹을 허용하지만 언급이 필요함(명시적)

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

소유자는 다음에 의해 결정됩니다. `channels.whatsapp.allowFrom` (또는 설정되지 않은 경우 봇의 자체 E.164). 명령을 독립형 메시지로 보냅니다. 현재 다른 표면은 무시합니다. `/activation`.

## 컨텍스트 필드

그룹 인바운드 페이로드 세트:

- `ChatType=group`
- `GroupSubject` (알려진 경우)
- `GroupMembers` (알려진 경우)
- `WasMentioned` (게이팅 결과 언급)
- 텔레그램 포럼 주제에는 다음이 포함됩니다. `MessageThreadId` 그리고 `IsForum`.

에이전트 시스템 프롬프트에는 새 그룹 세션의 첫 번째 차례에 그룹 소개가 포함됩니다. 모델이 사람처럼 반응하고, 마크다운 테이블을 피하고, 리터럴 입력을 피하도록 상기시킵니다. `\n` 시퀀스.

## iMessage 관련 사항

- 선호하다 `chat_id:<id>` 라우팅하거나 허용 목록에 추가할 때.
- 채팅 나열: `imsg chats --limit 20`.
- 그룹 답글은 항상 동일하게 돌아갑니다. `chat_id`.

## WhatsApp 세부 사항

보다 [그룹 메시지](/channels/group-messages) WhatsApp 전용 동작(기록 삽입, 처리 세부 사항 언급)
