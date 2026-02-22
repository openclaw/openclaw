---
summary: "다양한 플랫폼에서의 그룹 채팅 동작 (WhatsApp/Telegram/Discord/Slack/Signal/iMessage/Microsoft Teams)"
read_when:
  - 그룹 채팅 동작 또는 멘션 게이팅 변경
title: "Groups"
---

# Groups

OpenClaw는 WhatsApp, Telegram, Discord, Slack, Signal, iMessage, Microsoft Teams를 포함한 다양한 플랫폼에서 그룹 채팅을 일관되게 처리합니다.

## 초보자 소개 (2분)

OpenClaw는 사용자의 메시징 계정에서 실행됩니다. 별도의 WhatsApp 봇 사용자는 없습니다. **당신**이 그룹에 참여한 경우, OpenClaw는 해당 그룹을 확인하고 응답할 수 있습니다.

기본 동작:

- 그룹은 제한됩니다 (`groupPolicy: "allowlist"`).
- 응답에는 멘션이 필요하며, 멘션 게이팅을 명시적으로 비활성화하지 않는 한 그렇습니다.

번역: 허용 목록에 있는 발신자는 OpenClaw를 멘션하여 트리거할 수 있습니다.

> 요약
>
> - **다이렉트 메시지 접근**은 `*.allowFrom`으로 제어됩니다.
> - **그룹 접근**은 `*.groupPolicy` + 허용 목록 (`*.groups`, `*.groupAllowFrom`)으로 제어됩니다.
> - **응답 트리거**는 멘션 게이팅 (`requireMention`, `/activation`)으로 제어됩니다.

빠른 흐름 (그룹 메시지에 무슨 일이 발생하는지):

```
groupPolicy? disabled -> drop
groupPolicy? allowlist -> group allowed? no -> drop
requireMention? yes -> mentioned? no -> store for context only
otherwise -> reply
```

![Group message flow](/images/groups-flow.svg)

원하는 경우...

| 목표                                       | 설정                            |
| ------------------------------------------ | -------------------------------- |
| 모든 그룹을 허용하되 @mentions에만 응답      | `groups: { "*": { requireMention: true } }` |
| 모든 그룹 응답 비활성화                     | `groupPolicy: "disabled"`        |
| 특정 그룹만 허용                           | `groups: { "<group-id>": { ... } }` (no `"*"` key) |
| 그룹에서는 오직 본인만 트리거 가능         | `groupPolicy: "allowlist"`, `groupAllowFrom: ["+1555..."]` |

## 세션 키

- 그룹 세션은 `agent:<agentId>:<channel>:group:<id>` 세션 키를 사용합니다 (룸/채널은 `agent:<agentId>:<channel>:channel:<id>`를 사용).
- Telegram 포럼 주제는 그룹 ID에 `:topic:<threadId>` 를 추가합니다. 이를 통해 각 주제는 자체 세션을 가집니다.
- 직접 채팅은 메인 세션을 사용합니다 (또는 구성되어 있는 경우 발신자 별로).
- 그룹 세션에서는 하트비트가 건너뛰어집니다.

## 패턴: 개인 다이렉트 메시지 + 공개 그룹 (단일 에이전트)

네 — 개인 트래픽이 **다이렉트 메시지**이고 공공 트래픽이 **그룹**인 경우 잘 작동합니다.

이유: 단일 에이전트 모드에서 다이렉트 메시지는 일반적으로 **메인** 세션 키 (`agent:main:main`)에 배치되는 반면, 그룹은 항상 **비메인** 세션 키 (`agent:main:<channel>:group:<id>`)를 사용합니다. `mode: "non-main"`으로 샌드박스 격리를 활성화하면, 해당 그룹 세션은 Docker에서 실행되는 반면 메인 다이렉트 메시지 세션은 호스트에 남아있습니다.

이렇게 하면 하나의 에이전트 “뇌” (공유 작업 공간 + 메모리)가 있지만 두 가지 실행 자세를 갖게 됩니다:

- **다이렉트 메시지**: 전체 도구 (호스트)
- **그룹**: 샌드박스 격리 + 도구 제한 (Docker)

> 전혀 다른 작업 공간/페르소나가 필요하다면 (“개인”과 “공공”이 절대 혼합되지 않아야 함), 두 번째 에이전트 + 바인딩을 사용하세요. [Multi-Agent Routing](/ko-KR/concepts/multi-agent)을 참조하십시오.

예제 (호스트에서의 다이렉트 메시지, 제한 도구 및 메시징 전용으로 샌드박스된 그룹):

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

“그룹이 폴더 X만 볼 수 있음”을 원하십니까? “호스트 액세스 없음” 대신, `workspaceAccess: "none"`을 유지하고 허용 목록에 담긴 경로만 샌드박스에 마운트합니다:

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

관련 항목:

- 구성 키 및 기본값: [게이트웨이 구성](/ko-KR/gateway/configuration#agentsdefaultssandbox)
- 도구가 차단된 이유 디버깅: [샌드박스 vs 도구 정책 vs 상승된 권한](/ko-KR/gateway/sandbox-vs-tool-policy-vs-elevated)
- 바인드 마운트 세부사항: [샌드박스 격리](/ko-KR/gateway/sandboxing#custom-bind-mounts)

## 디스플레이 레이블

- UI 레이블은 사용할 수 있는 경우 `displayName`을 사용하여 `<channel>:<token>` 형식으로 포맷됩니다.
- `#room`은 방/채널에 예약되어 있으며, 그룹 채팅은 `g-<slug>`를 사용합니다 (소문자, 공백 -> `-`, `#@+._-` 유지).

## 그룹 정책

채널별로 그룹/방 메시지 처리 방법을 제어합니다:

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

| 정책            | 동작                                                |
| ------------- | --------------------------------------------------- |
| `"open"`      | 그룹이 허용 목록을 우회함; 멘션 게이팅은 여전히 적용됩니다. |
| `"disabled"`  | 모든 그룹 메시지를 완전히 차단합니다.                       |
| `"allowlist"` | 구성된 허용 목록과 일치하는 그룹/방만 허용합니다.           |

참고 사항:

- `groupPolicy`는 멘션 게이팅과 별개입니다 (멘션이 필요함).
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams: `groupAllowFrom` 사용 (백업: 명시적 `allowFrom`).
- Discord: 허용 목록은 `channels.discord.guilds.<id>.channels`를 사용합니다.
- Slack: 허용 목록은 `channels.slack.channels`를 사용합니다.
- Matrix: 허용 목록은 `channels.matrix.groups`를 사용합니다 (방 ID, 별칭 또는 이름). 발신자를 제한하려면 `channels.matrix.groupAllowFrom`을 사용하세요; 방별 `users` 허용 목록도 지원됩니다.
- 그룹 다이렉트 메시지는 별도로 제어됩니다 (`channels.discord.dm.*`, `channels.slack.dm.*`).
- Telegram 허용 목록은 사용자 ID (`"123456789"`, `"telegram:123456789"`, `"tg:123456789"`) 또는 사용자 이름 (`"@alice"` 또는 `"alice"`)과 일치할 수 있습니다; 접두사는 대소문자를 구분하지 않습니다.
- 기본값은 `groupPolicy: "allowlist"`입니다; 그룹 허용 목록이 비어 있으면 그룹 메시지가 차단됩니다.

빠른 정신 모델 (그룹 메시지에 대한 평가 순서):

1. `groupPolicy` (open/disabled/allowlist)
2. 그룹 허용 목록 (`*.groups`, `*.groupAllowFrom`, 채널별 허용 목록)
3. 멘션 게이팅 (`requireMention`, `/activation`)

## 멘션 게이팅 (기본값)

그룹 메시지는 그룹별로 오버라이드되지 않는 한 멘션이 필요합니다. 기본값은 `*.groups."*"` 하의 서브시스템 별로 존재합니다.

봇 메시지에 대한 응답은 암묵적인 멘션으로 간주됩니다 (채널이 응답 메타데이터를 지원하는 경우). 이는 Telegram, WhatsApp, Slack, Discord, Microsoft Teams에 적용됩니다.

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

참고 사항:

- `mentionPatterns`는 대소문자를 구분하지 않는 정규식입니다.
- 명시적 멘션을 제공하는 표면은 여전히 통과합니다; 패턴은 백업입니다.
- 에이전트별 오버라이드: `agents.list[].groupChat.mentionPatterns` (여러 에이전트가 그룹을 공유할 때 유용).
- 멘션 감지가 가능한 경우에만 멘션 게이팅이 적용됩니다 (네이티브 멘션 또는 `mentionPatterns`가 구성되어 있음).
- Discord 기본값은 `channels.discord.guilds."*"`에 있으며, 길드/채널별로 오버라이드 가능합니다.
- 그룹 역사 컨텍스트는 채널 전반에 걸쳐 균일하게 감싸여 있으며 **보류 중**입니다 (멘션 게이팅에 의해 건너뛴 메시지); 글로벌 기본값에 대해서는 `messages.groupChat.historyLimit` 및 오버라이드를 위해 `channels.<channel>.historyLimit` (또는 `channels.<channel>.accounts.*.historyLimit`)을 사용하세요. 비활성화하려면 `0`을 설정합니다.

## 그룹/채널 도구 제한 (선택 사항)

일부 채널 구성은 특정 그룹/방/채널 내에서 사용할 수 있는 도구를 제한하는 것을 지원합니다.

- `tools`: 전체 그룹에 대한 도구 허용/거부.
- `toolsBySender`: 그룹 내 발신자별 오버라이드 (키는 채널에 따라 발신자 ID/사용자 이름/이메일/전화번호가 될 수 있음). 와일드카드로 `"*"`을 사용하세요.

해결 순서 (가장 구체적인 것이 우선):

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
            "123456789": { alsoAllow: ["exec"] },
          },
        },
      },
    },
  },
}
```

참고 사항:

- 그룹/채널 도구 제한은 글로벌/에이전트 도구 정책에 추가로 적용됩니다 (거부가 여전히 이깁니다).
- 일부 채널은 방/채널에 대해 다른 중첩을 사용합니다 (예: Discord `guilds.*.channels.*`, Slack `channels.*`, MS Teams `teams.*.channels.*`).

## 그룹 허용 목록

`channels.whatsapp.groups`, `channels.telegram.groups`, 또는 `channels.imessage.groups`가 구성된 경우, 키는 그룹 허용 목록으로 작동합니다. 모든 그룹을 허용하면서도 기본 멘션 동작을 설정하려면 `"*"`을 사용합니다.

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

3. 모든 그룹을 허용하되 멘션 필요 (명시적)

```json5
{
  channels: {
    whatsapp: {
      groups: { "*": { requireMention: true } },
    },
  },
}
```

4. 그룹에서는 오직 소유자만 트리거 가능 (WhatsApp)

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

소유자는 `channels.whatsapp.allowFrom` (또는 설정되지 않은 경우 봇의 자체 E.164)에 의해 결정됩니다. 명령을 독립된 메시지로 전송하세요. 다른 표면들은 현재 `/activation`을 무시합니다.

## 컨텍스트 필드

그룹 인바운드 페이로드 설정:

- `ChatType=group`
- `GroupSubject` (알려진 경우)
- `GroupMembers` (알려진 경우)
- `WasMentioned` (멘션 게이팅 결과)
- Telegram 포럼 주제는 `MessageThreadId` 및 `IsForum`도 포함합니다.

에이전트 시스템 프롬프트는 새로운 그룹 세션의 첫 번째 차례에 그룹 소개를 포함합니다. 모델에게 사람처럼 응답하고, Markdown 표를 피하며, 문자 그대로의 `\n` 시퀀스를 피하라고 알려줍니다.

## iMessage 특성

- 라우팅 또는 허용 목록화 시 `chat_id:<id>`를 선호합니다.
- 채팅 목록: `imsg chats --limit 20`.
- 그룹 응답은 항상 동일한 `chat_id`로 돌아갑니다.

## WhatsApp 특성

WhatsApp 전용 동작 (히스토리 주입, 멘션 처리 세부사항)에 대해서는 [그룹 메시지](/ko-KR/channels/group-messages)를 참조하십시오.