---
summary: "표면 전반에서의 그룹 채팅 동작 (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"
read_when:
  - 그룹 채팅 동작 또는 멘션 게이팅을 변경할 때
title: "그룹"
---

# 그룹

OpenClaw 는 WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams 전반에서 그룹 채팅을 일관되게 처리합니다.

## 초보자 소개 (2분)

OpenClaw 는 사용자의 자체 메시징 계정에서 “동작”합니다. 별도의 WhatsApp 봇 사용자는 존재하지 않습니다.
**사용자 본인**이 어떤 그룹에 속해 있다면, OpenClaw 는 해당 그룹을 보고 그곳에서 응답할 수 있습니다.

기본 동작:

- 그룹은 제한됩니다 (`groupPolicy: "allowlist"`).
- 명시적으로 멘션 게이팅을 비활성화하지 않는 한, 응답에는 멘션이 필요합니다.

번역하면: 허용 목록에 있는 발신자는 OpenClaw 를 멘션함으로써 OpenClaw 를 트리거할 수 있습니다.

> TL;DR
>
> - **DM 접근**은 `*.allowFrom` 로 제어됩니다.
> - **그룹 접근**은 `*.groupPolicy` + 허용 목록 (`*.groups`, `*.groupAllowFrom`) 으로 제어됩니다.
> - **응답 트리거**는 멘션 게이팅 (`requireMention`, `/activation`) 으로 제어됩니다.

빠른 흐름 (그룹 메시지에 발생하는 일):

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![Group message flow](/images/groups-flow.svg)

원하는 목표가 있다면…

| 목표                                | 설정할 항목                                                              |
| --------------------------------- | ------------------------------------------------------------------- |
| 모든 그룹을 허용하되 @멘션에만 응답 | `groups: { "*": { requireMention: true } }`                         |
| 모든 그룹 응답 비활성화                     | `groupPolicy: "disabled"`                                           |
| 특정 그룹만 허용                         | `groups: { "<group-id>": { ... } }` (`"*"` 키 없음) |
| 그룹에서 오직 본인만 트리거 가능                | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]`          |

## 세션 키

- 그룹 세션은 `agent:<agentId>:<channel>:group:<id>` 세션 키를 사용합니다 (룸/채널은 `agent:<agentId>:<channel>:channel:<id>` 사용).
- Telegram 포럼 토픽은 그룹 ID 에 `:topic:<threadId>` 를 추가하여 각 토픽이 자체 세션을 갖도록 합니다.
- 다이렉트 채팅은 메인 세션 (또는 설정된 경우 발신자별 세션) 을 사용합니다.
- 그룹 세션에서는 하트비트가 생략됩니다.

## 패턴: 개인 DMs + 공개 그룹 (단일 에이전트)

예 — “개인” 트래픽이 **DMs** 이고 “공개” 트래픽이 **그룹** 인 경우 잘 작동합니다.

이유: 단일 에이전트 모드에서 DMs 는 일반적으로 **메인** 세션 키 (`agent:main:main`) 로 들어오며, 그룹은 항상 **비-메인** 세션 키 (`agent:main:<channel>:group:<id>`) 를 사용합니다. `mode: "non-main"` 로 샌드박스화를 활성화하면, 해당 그룹 세션은 Docker 에서 실행되고 메인 DM 세션은 호스트에서 유지됩니다.

이렇게 하면 하나의 에이전트 “두뇌” (공유 워크스페이스 + 메모리) 를 사용하면서, 두 가지 실행 방식이 제공됩니다:

- **DMs**: 전체 도구 (호스트)
- **그룹**: 샌드박스 + 제한된 도구 (Docker)

> 진정으로 분리된 워크스페이스/페르소나 (“개인” 과 “공개” 가 절대 섞이면 안 되는 경우) 가 필요하다면, 두 번째 에이전트 + 바인딩을 사용하십시오. [Multi-Agent Routing](/concepts/multi-agent) 을 참고하십시오.

예시 (DMs 는 호스트, 그룹은 샌드박스 + 메시징 전용 도구):

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

Want “groups can only see folder X” instead of “no host access”? “호스트 접근 없음” 대신 “그룹은 폴더 X 만 볼 수 있음” 이 필요하다면, `workspaceAccess: "none"` 를 유지하고 허용 목록에 있는 경로만 샌드박스에 마운트하십시오:

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

- 구성 키와 기본값: [Gateway configuration](/gateway/configuration#agentsdefaultssandbox)
- 도구가 차단되는 이유 디버깅: [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)
- 바인드 마운트 세부 사항: [Sandboxing](/gateway/sandboxing#custom-bind-mounts)

## 표시 레이블

- UI 레이블은 사용 가능한 경우 `displayName` 를 사용하며, `<channel>:<token>` 형식으로 표시됩니다.
- `#room` 는 룸/채널용으로 예약되어 있으며, 그룹 채팅은 `g-<slug>` 를 사용합니다 (소문자, 공백은 `-` 로 변환, `#@+._-` 유지).

## 그룹 정책

채널별로 그룹/룸 메시지를 처리하는 방식을 제어합니다:

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

| 정책            | 동작                                                  |
| ------------- | --------------------------------------------------- |
| `"open"`      | 그룹은 허용 목록을 우회하며, 멘션 게이팅은 여전히 적용됩니다. |
| `"disabled"`  | 모든 그룹 메시지를 완전히 차단합니다.               |
| `"allowlist"` | 구성된 허용 목록과 일치하는 그룹/룸만 허용합니다.        |

참고:

- `groupPolicy` 는 멘션 게이팅 (@멘션 요구) 과는 별개입니다.
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams: `groupAllowFrom` 를 사용합니다 (대체: 명시적 `allowFrom`).
- Discord: 허용 목록은 `channels.discord.guilds.<id>.channels` 를 사용합니다.
- Slack: 허용 목록은 `channels.slack.channels` 를 사용합니다.
- Matrix: 허용 목록은 `channels.matrix.groups` (룸 ID, 별칭 또는 이름) 를 사용합니다. 발신자 제한에는 `channels.matrix.groupAllowFrom` 를 사용하며, 룸별 `users` 허용 목록도 지원됩니다.
- 그룹 DMs 는 별도로 제어됩니다 (`channels.discord.dm.*`, `channels.slack.dm.*`).
- Telegram 허용 목록은 사용자 ID (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) 또는 사용자 이름 (`"@alice"` 또는 `"alice"`) 과 일치할 수 있으며, 접두사는 대소문자를 구분하지 않습니다.
- 기본값은 `groupPolicy: "allowlist"` 이며, 그룹 허용 목록이 비어 있으면 그룹 메시지는 차단됩니다.

빠른 개념 모델 (그룹 메시지 평가 순서):

1. `groupPolicy` (open/disabled/allowlist)
2. 그룹 허용 목록 (`*.groups`, `*.groupAllowFrom`, 채널별 허용 목록)
3. 멘션 게이팅 (`requireMention`, `/activation`)

## 멘션 게이팅 (기본값)

그룹 메시지는 그룹별로 재정의하지 않는 한 멘션이 필요합니다. 기본값은 `*.groups."*"` 하위의 서브시스템별로 존재합니다.

봇 메시지에 대한 답장은 (채널이 답장 메타데이터를 지원하는 경우) 암묵적 멘션으로 간주됩니다. 이는 Telegram, WhatsApp, Slack, Discord, Microsoft Teams 에 적용됩니다.

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

- `mentionPatterns` 는 대소문자를 구분하지 않는 정규식입니다.
- 명시적 멘션을 제공하는 표면은 그대로 통과하며, 패턴은 대체 수단입니다.
- 에이전트별 재정의: `agents.list[].groupChat.mentionPatterns` (여러 에이전트가 하나의 그룹을 공유할 때 유용).
- 멘션 게이팅은 멘션 감지가 가능한 경우에만 적용됩니다 (네이티브 멘션 또는 `mentionPatterns` 이 구성된 경우).
- Discord 기본값은 `channels.discord.guilds."*"` 에 있으며 (길드/채널별 재정의 가능).
- Group history context is wrapped uniformly across channels and is **pending-only** (messages skipped due to mention gating); use `messages.groupChat.historyLimit` for the global default and `channels.<channel>.historyLimit` (또는 `channels.<channel>.accounts.*.historyLimit`) 를 사용하십시오. 비활성화하려면 `0` 를 설정하십시오.

## 그룹/채널 도구 제한 (선택 사항)

일부 채널 구성은 **특정 그룹/룸/채널 내부** 에서 사용 가능한 도구를 제한하는 것을 지원합니다.

- `tools`: 그룹 전체에 대한 도구 허용/차단.
- `toolsBySender`: 그룹 내 발신자별 재정의 (키는 채널에 따라 발신자 ID/사용자 이름/이메일/전화번호). 와일드카드로 `"*"` 를 사용하십시오.

해결 순서 (가장 구체적인 항목이 우선):

1. 그룹/채널 `toolsBySender` 일치
2. 그룹/채널 `tools`
3. 기본값 (`"*"`) `toolsBySender` 일치
4. 기본값 (`"*"`) `tools`

예시 (Telegram):

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

- 그룹/채널 도구 제한은 전역/에이전트 도구 정책에 추가로 적용됩니다 (차단이 항상 우선).
- 일부 채널은 룸/채널에 대해 다른 중첩 구조를 사용합니다 (예: Discord `guilds.*.channels.*`, Slack `channels.*`, MS Teams `teams.*.channels.*`).

## 그룹 허용 목록

`channels.whatsapp.groups`, `channels.telegram.groups`, 또는 `channels.imessage.groups` 가 구성되면, 해당 키는 그룹 허용 목록으로 동작합니다. 기본 멘션 동작을 유지하면서 모든 그룹을 허용하려면 `"*"` 를 사용하십시오.

일반적인 의도 (복사/붙여넣기):

1. 모든 그룹 응답 비활성화

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

3. 모든 그룹 허용하되 멘션 필요 (명시적)

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. 그룹에서 소유자만 트리거 가능 (WhatsApp)

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

그룹 소유자는 그룹별 활성화를 토글할 수 있습니다:

- `/activation mention`
- `/activation always`

소유자는 `channels.whatsapp.allowFrom` (또는 미설정 시 봇 자체의 E.164) 로 결정됩니다. 명령은 단독 메시지로 전송하십시오. 다른 표면은 현재 `/activation` 을 무시합니다.

## 컨텍스트 필드

그룹 인바운드 페이로드는 다음을 설정합니다:

- `ChatType=group`
- `GroupSubject` (알려진 경우)
- `GroupMembers` (알려진 경우)
- `WasMentioned` (멘션 게이팅 결과)
- Telegram 포럼 토픽은 `MessageThreadId` 및 `IsForum` 도 포함합니다.

에이전트 시스템 프롬프트에는 새로운 그룹 세션의 첫 턴에 그룹 소개가 포함됩니다. 이는 모델에게 사람처럼 응답하고, Markdown 표를 피하며, 리터럴 `\n` 시퀀스를 입력하지 않도록 상기시킵니다.

## iMessage 세부 사항

- 라우팅 또는 허용 목록에서는 `chat_id:<id>` 를 우선 사용하십시오.
- 채팅 목록: `imsg chats --limit 20`.
- 그룹 응답은 항상 동일한 `chat_id` 로 반환됩니다.

## WhatsApp 세부 사항

WhatsApp 전용 동작 (히스토리 주입, 멘션 처리 세부 사항) 은 [Group messages](/channels/group-messages) 를 참고하십시오.
