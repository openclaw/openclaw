---
summary: "멀티 에이전트 라우팅: 격리된 에이전트, 채널 계정, 바인딩"
title: 멀티 에이전트 라우팅
read_when: "하나의 게이트웨이 프로세스에서 여러 개의 격리된 에이전트(워크스페이스 + 인증)와 채널 계정을 원할 때"
status: active
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: docs/concepts/multi-agent.md
  workflow: 15
---

# 멀티 에이전트 라우팅

목표: 하나의 실행 중인 Gateway에서 여러 개의 _격리된_ 에이전트(별도의 워크스페이스 + `agentDir` + 세션)와 여러 채널 계정(예: 두 개의 WhatsApp)을 지원합니다. 인바운드는 바인딩을 통해 에이전트로 라우팅됩니다.

## "하나의 에이전트"란?

**에이전트**는 다음을 보유한 완전히 범위가 지정된 두뇌입니다:

- **워크스페이스**(파일, AGENTS.md/SOUL.md/USER.md, 로컬 노트, 페르소나 규칙).
- **상태 디렉터리**(`agentDir`) - 인증 프로필, 모델 레지스트리, 에이전트당 설정.
- **세션 저장소**(`~/.openclaw/agents/<agentId>/sessions` 하의 채팅 기록 + 라우팅 상태).

인증 프로필은 **에이전트당** 관리됩니다. 각 에이전트는 다음에서 읽습니다:

```text
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

메인 에이전트 자격증명은 **자동으로 공유되지 않습니다**. 에이전트 간에 `agentDir`을 재사용하지 마세요(인증/세션 충돌이 발생합니다). 자격증명을 공유하려면 다른 에이전트의 `agentDir`에 `auth-profiles.json`을 복사하세요.

스킬은 각 워크스페이스의 `skills/` 폴더를 통해 에이전트당 관리되며, 공유 스킬은 `~/.openclaw/skills`에서 사용 가능합니다. [스킬: 에이전트당 vs 공유](/tools/skills#per-agent-vs-shared-skills)를 참조하세요.

Gateway는 **하나의 에이전트**(기본값) 또는 **많은 에이전트**를 나란히 호스트할 수 있습니다.

**워크스페이스 주의사항:** 각 에이전트의 워크스페이스는 **기본 cwd**이지만 하드 샌드박스는 아닙니다. 상대 경로는 워크스페이스 내에서 확인되지만 절대 경로는 샌드박싱이 활성화되지 않은 한 다른 호스트 위치에 도달할 수 있습니다. [샌드박싱](/gateway/sandboxing)을 참조하세요.

## 경로(빠른 맵)

- 설정: `~/.openclaw/openclaw.json` (또는 `OPENCLAW_CONFIG_PATH`)
- 상태 디렉터리: `~/.openclaw` (또는 `OPENCLAW_STATE_DIR`)
- 워크스페이스: `~/.openclaw/workspace` (또는 `~/.openclaw/workspace-<agentId>`)
- 에이전트 디렉터리: `~/.openclaw/agents/<agentId>/agent` (또는 `agents.list[].agentDir`)
- 세션: `~/.openclaw/agents/<agentId>/sessions`

### 단일 에이전트 모드(기본값)

아무것도 하지 않으면 OpenClaw는 단일 에이전트를 실행합니다:

- `agentId`는 **`main`**으로 기본 설정됩니다.
- 세션은 `agent:main:<mainKey>`로 키됩니다.
- 워크스페이스는 기본값으로 `~/.openclaw/workspace` (또는 `OPENCLAW_PROFILE`이 설정되면 `~/.openclaw/workspace-<profile>`)입니다.
- 상태는 기본값으로 `~/.openclaw/agents/main/agent`입니다.

## 에이전트 헬퍼

에이전트 마법사를 사용하여 새로운 격리된 에이전트를 추가하세요:

```bash
openclaw agents add work
```

그런 다음 `bindings`을 추가하거나(또는 마법사가 해주도록) 인바운드 메시지를 라우팅하세요.

다음을 사용하여 확인하세요:

```bash
openclaw agents list --bindings
```

## 빠른 시작

<Steps>
  <Step title="각 에이전트 워크스페이스 생성">

마법사를 사용하거나 워크스페이스를 수동으로 생성하세요:

```bash
openclaw agents add coding
openclaw agents add social
```

각 에이전트는 `SOUL.md`, `AGENTS.md`, 선택적 `USER.md`가 있는 자신의 워크스페이스를 받으며, `~/.openclaw/agents/<agentId>` 아래의 전용 `agentDir` 및 세션 저장소가 있습니다.

  </Step>

  <Step title="채널 계정 생성">

각 에이전트를 위해 선호하는 채널에 계정을 하나씩 생성하세요:

- Discord: 에이전트당 하나의 봇, Message Content Intent 활성화, 각 토큰 복사.
- Telegram: BotFather를 통해 에이전트당 하나의 봇, 각 토큰 복사.
- WhatsApp: 계정당 각 전화번호 연결.

```bash
openclaw channels login --channel whatsapp --account work
```

채널 가이드를 참조하세요: [Discord](/channels/discord), [Telegram](/channels/telegram), [WhatsApp](/channels/whatsapp).

  </Step>

  <Step title="에이전트, 계정, 바인딩 추가">

`agents.list` 아래에 에이전트를 추가하고, `channels.<channel>.accounts` 아래에 채널 계정을 추가하고, `bindings`으로 연결하세요(아래 예제).

  </Step>

  <Step title="재시작 및 확인">

```bash
openclaw gateway restart
openclaw agents list --bindings
openclaw channels status --probe
```

  </Step>
</Steps>

## 여러 에이전트 = 여러 사람, 여러 성격

**여러 에이전트**를 사용하면 각 `agentId`는 **완전히 격리된 페르소나**가 됩니다:

- **다양한 전화번호/계정**(채널 `accountId`당).
- **다양한 성격**(`AGENTS.md` 및 `SOUL.md`와 같은 에이전트별 워크스페이스 파일).
- **별도의 인증 + 세션**(명시적으로 활성화되지 않는 한 교차 대화 없음).

이를 통해 **여러 사람**은 하나의 Gateway 서버를 공유하면서 AI "두뇌"와 데이터를 격리할 수 있습니다.

## 하나의 WhatsApp 번호, 여러 사람(DM 분할)

**한 개의 WhatsApp 계정**을 유지하면서 **다양한 WhatsApp DM**을 다양한 에이전트로 라우팅할 수 있습니다. 발신자 E.164(예: `+15551234567`)와 `peer.kind: "direct"`로 일치하세요. 회신은 여전히 같은 WhatsApp 번호에서 나옵니다(에이전트당 발신자 정체성 없음).

중요한 세부사항: 직접 채팅은 에이전트의 **메인 세션 키**로 축소되므로 진정한 격리에는 **사람당 하나의 에이전트**가 필요합니다.

예제:

```json5
{
  agents: {
    list: [
      { id: "alex", workspace: "~/.openclaw/workspace-alex" },
      { id: "mia", workspace: "~/.openclaw/workspace-mia" },
    ],
  },
  bindings: [
    {
      agentId: "alex",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551230001" } },
    },
    {
      agentId: "mia",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551230002" } },
    },
  ],
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: ["+15551230001", "+15551230002"],
    },
  },
}
```

주의사항:

- DM 접근 제어는 **에이전트별이 아닌 WhatsApp 계정당 전역**(페어링/허용 목록)입니다.
- 공유 그룹의 경우 그룹을 하나의 에이전트로 바인딩하거나 [브로드캐스트 그룹](/channels/broadcast-groups)을 사용하세요.

## 라우팅 규칙(메시지가 에이전트를 선택하는 방법)

바인딩은 **결정적**이며 **가장 구체적인 것이 우선합니다**:

1. `peer` 일치(정확한 DM/그룹/채널 id)
2. `parentPeer` 일치(스레드 상속)
3. `guildId + roles` (Discord 역할 라우팅)
4. `guildId` (Discord)
5. `teamId` (Slack)
6. 채널에 대한 `accountId` 일치
7. 채널 수준 일치(`accountId: "*"`)
8. 기본 에이전트로 폴백(`agents.list[].default`, 아니면 첫 번째 목록 항목, 기본값: `main`)

동일한 계층에서 여러 바인딩이 일치하면 설정 순서의 첫 번째가 우선합니다.
바인딩이 여러 일치 필드를 설정하면(예: `peer` + `guildId`), 지정된 모든 필드가 필요합니다(`AND` 의미론).

중요한 계정 범위 세부사항:

- `accountId`를 생략하는 바인딩은 기본 계정만 일치합니다.
- 모든 계정에서 채널 전체 폴백을 위해 `accountId: "*"`를 사용하세요.
- 나중에 명시적 계정 id를 사용하여 동일한 에이전트에 대해 동일한 바인딩을 추가하면 OpenClaw는 복제하는 대신 기존 채널 전용 바인딩을 계정 범위로 업그레이드합니다.

## 여러 계정 / 전화번호

**여러 계정**을 지원하는 채널(예: WhatsApp)은 `accountId`를 사용하여 각 로그인을 식별합니다. 각 `accountId`는 다양한 에이전트로 라우팅될 수 있으므로 하나의 서버는 세션을 혼합하지 않고 여러 전화번호를 호스트할 수 있습니다.

## 개념

- `agentId`: 하나의 "두뇌"(워크스페이스, 에이전트별 인증, 에이전트별 세션 저장소).
- `accountId`: 하나의 채널 계정 인스턴스(예: WhatsApp 계정 `"personal"` vs `"biz"`).
- `binding`: 인바운드 메시지를 `(channel, accountId, peer)` 및 선택적으로 길드/팀 id로 `agentId`로 라우팅합니다.
- 직접 채팅은 `agent:<agentId>:<mainKey>`로 축소됩니다(에이전트당 "메인"; `session.mainKey`).

## 플랫폼 예제

### 에이전트당 Discord 봇

각 Discord 봇 계정은 고유한 `accountId`로 매핑됩니다. 각 계정을 에이전트로 바인딩하고 봇당 허용 목록을 유지하세요.

```json5
{
  agents: {
    list: [
      { id: "main", workspace: "~/.openclaw/workspace-main" },
      { id: "coding", workspace: "~/.openclaw/workspace-coding" },
    ],
  },
  bindings: [
    { agentId: "main", match: { channel: "discord", accountId: "default" } },
    { agentId: "coding", match: { channel: "discord", accountId: "coding" } },
  ],
  channels: {
    discord: {
      groupPolicy: "allowlist",
      accounts: {
        default: {
          token: "DISCORD_BOT_TOKEN_MAIN",
          guilds: {
            "123456789012345678": {
              channels: {
                "222222222222222222": { allow: true, requireMention: false },
              },
            },
          },
        },
        coding: {
          token: "DISCORD_BOT_TOKEN_CODING",
          guilds: {
            "123456789012345678": {
              channels: {
                "333333333333333333": { allow: true, requireMention: false },
              },
            },
          },
        },
      },
    },
  },
}
```

주의사항:

- 각 봇을 길드로 초대하고 Message Content Intent를 활성화하세요.
- 토큰은 `channels.discord.accounts.<id>.token`에 있습니다(기본 계정은 `DISCORD_BOT_TOKEN`을 사용할 수 있음).

### 에이전트당 Telegram 봇

```json5
{
  agents: {
    list: [
      { id: "main", workspace: "~/.openclaw/workspace-main" },
      { id: "alerts", workspace: "~/.openclaw/workspace-alerts" },
    ],
  },
  bindings: [
    { agentId: "main", match: { channel: "telegram", accountId: "default" } },
    { agentId: "alerts", match: { channel: "telegram", accountId: "alerts" } },
  ],
  channels: {
    telegram: {
      accounts: {
        default: {
          botToken: "123456:ABC...",
          dmPolicy: "pairing",
        },
        alerts: {
          botToken: "987654:XYZ...",
          dmPolicy: "allowlist",
          allowFrom: ["tg:123456789"],
        },
      },
    },
  },
}
```

주의사항:

- BotFather로 에이전트당 하나의 봇을 생성하고 각 토큰을 복사하세요.
- 토큰은 `channels.telegram.accounts.<id>.botToken`에 있습니다(기본 계정은 `TELEGRAM_BOT_TOKEN`을 사용할 수 있음).

### 에이전트당 WhatsApp 번호

게이트웨이를 시작하기 전에 각 계정을 연결하세요:

```bash
openclaw channels login --channel whatsapp --account personal
openclaw channels login --channel whatsapp --account biz
```

`~/.openclaw/openclaw.json` (JSON5):

```js
{
  agents: {
    list: [
      {
        id: "home",
        default: true,
        name: "Home",
        workspace: "~/.openclaw/workspace-home",
        agentDir: "~/.openclaw/agents/home/agent",
      },
      {
        id: "work",
        name: "Work",
        workspace: "~/.openclaw/workspace-work",
        agentDir: "~/.openclaw/agents/work/agent",
      },
    ],
  },

  // 결정적 라우팅: 첫 번째 일치 우선(가장 구체적인 것 우선).
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

    // 선택적 피어당 무시(예: 특정 그룹을 work 에이전트로 전송).
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630...@g.us" },
      },
    },
  ],

  // 기본값으로 비활성화: 에이전트 간 메시징은 명시적으로 활성화 + 허용 목록이어야 합니다.
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },

  channels: {
    whatsapp: {
      accounts: {
        personal: {
          // 선택적 무시. 기본값: ~/.openclaw/credentials/whatsapp/personal
          // authDir: "~/.openclaw/credentials/whatsapp/personal",
        },
        biz: {
          // 선택적 무시. 기본값: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

## 예제: WhatsApp 일일 채팅 + Telegram 깊은 일

채널별로 분할: WhatsApp을 빠른 일상 에이전트로 라우팅하고 Telegram을 Opus 에이전트로 라우팅하세요.

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    { agentId: "chat", match: { channel: "whatsapp" } },
    { agentId: "opus", match: { channel: "telegram" } },
  ],
}
```

주의사항:

- 채널에 대한 여러 계정이 있는 경우 바인딩에 `accountId`를 추가하세요(예: `{ channel: "whatsapp", accountId: "personal" }`).
- 하나의 DM/그룹을 Opus로 라우팅하면서 나머지를 채팅으로 유지하려면 해당 피어에 대해 `match.peer` 바인딩을 추가하세요; 피어 일치는 항상 채널 전체 규칙보다 우선합니다.

## 예제: 동일한 채널, 하나의 피어를 Opus로

WhatsApp을 빠른 에이전트에서 유지하지만 하나의 DM을 Opus로 라우팅하세요:

```json5
{
  agents: {
    list: [
      {
        id: "chat",
        name: "Everyday",
        workspace: "~/.openclaw/workspace-chat",
        model: "anthropic/claude-sonnet-4-5",
      },
      {
        id: "opus",
        name: "Deep Work",
        workspace: "~/.openclaw/workspace-opus",
        model: "anthropic/claude-opus-4-6",
      },
    ],
  },
  bindings: [
    {
      agentId: "opus",
      match: { channel: "whatsapp", peer: { kind: "direct", id: "+15551234567" } },
    },
    { agentId: "chat", match: { channel: "whatsapp" } },
  ],
}
```

피어 바인딩은 항상 우선하므로 채널 전체 규칙 위에 유지하세요.

## WhatsApp 그룹에 바인딩된 가족 에이전트

언급 게이트 및 더 엄격한 도구 정책을 사용하여 전용 가족 에이전트를 단일 WhatsApp 그룹에 바인딩하세요:

```json5
{
  agents: {
    list: [
      {
        id: "family",
        name: "Family",
        workspace: "~/.openclaw/workspace-family",
        identity: { name: "Family Bot" },
        groupChat: {
          mentionPatterns: ["@family", "@familybot", "@Family Bot"],
        },
        sandbox: {
          mode: "all",
          scope: "agent",
        },
        tools: {
          allow: [
            "exec",
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "browser", "canvas", "nodes", "cron"],
        },
      },
    ],
  },
  bindings: [
    {
      agentId: "family",
      match: {
        channel: "whatsapp",
        peer: { kind: "group", id: "120363999999999999@g.us" },
      },
    },
  ],
}
```

주의사항:

- 도구 허용/거부 목록은 **도구**이지 스킬이 아닙니다. 스킬이 바이너리를 실행해야 하는 경우 `exec`이 허용되고 바이너리가 샌드박스에 존재하는지 확인하세요.
- 더 엄격한 게이트를 위해 `agents.list[].groupChat.mentionPatterns`을 설정하고 채널에 대해 그룹 허용 목록을 활성화로 유지하세요.

## 에이전트별 샌드박스 및 도구 구성

v2026.1.6부터 각 에이전트는 자신의 샌드박스 및 도구 제한을 가질 수 있습니다:

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // 개인 에이전트용 샌드박스 없음
        },
        // 도구 제한 없음 - 모든 도구 사용 가능
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // 항상 샌드박스됨
          scope: "agent",  // 에이전트당 하나의 컨테이너
          docker: {
            // 선택적 컨테이너 생성 후 일회성 설정
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // read 도구만
          deny: ["exec", "write", "edit", "apply_patch"],    // 다른 것 거부
        },
      },
    ],
  },
}
```

주의: `setupCommand`는 `sandbox.docker` 아래에 있고 컨테이너 생성 시 한 번 실행됩니다.
해석된 범위가 `"shared"`일 때 에이전트별 `sandbox.docker.*` 재정의는 무시됩니다.

**장점:**

- **보안 격리**: 신뢰할 수 없는 에이전트를 위한 도구 제한
- **리소스 제어**: 다른 에이전트는 호스트에서 유지하면서 특정 에이전트를 샌드박스화
- **유연한 정책**: 에이전트별 다양한 권한

주의: `tools.elevated`는 **전역**이며 발신자 기반입니다; 에이전트별로 설정할 수 없습니다.
에이전트별 경계가 필요한 경우 `agents.list[].tools`를 사용하여 `exec`을 거부하세요.
그룹 대상 지정을 위해 `agents.list[].groupChat.mentionPatterns`을 사용하여 @언급이 의도된 에이전트로 깔끔하게 매핑되도록 하세요.

[멀티 에이전트 샌드박스 & 도구](/tools/multi-agent-sandbox-tools)를 참조하여 자세한 예제를 확인하세요.
