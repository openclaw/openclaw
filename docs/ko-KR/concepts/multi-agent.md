---
summary: "멀티 에이전트 라우팅: 격리된 에이전트, 채널 계정, 및 바인딩"
title: Multi-Agent Routing
read_when: "하나의 게이트웨이 프로세스에서 다수의 격리된 에이전트(워크스페이스 + 인증)를 원할 때."
status: active
---

# Multi-Agent Routing

목표: 하나의 실행중인 게이트웨이에서 여러 _격리된_ 에이전트(독립된 워크스페이스 + `agentDir` + 세션), 그리고 다수의 채널 계정(예: 두 개의 WhatsApp)을 운영하는 것입니다. 바인딩을 통해 들어오는 메세지가 에이전트로 라우팅됩니다.

## “하나의 에이전트”란?

**에이전트**는 자체적으로 완전한 범위를 가진 지능체입니다:

- **워크스페이스** (파일, AGENTS.md/SOUL.md/USER.md, 로컬 노트, 페르소나 규칙).
- **상태 디렉토리** (`agentDir`) 인증 프로파일, 모델 레지스트리 및 에이전트별 설정.
- **세션 저장소** (`~/.openclaw/agents/<agentId>/sessions` 이하의 채팅 기록과 라우팅 상태).

인증 프로파일은 **에이전트별**입니다. 각 에이전트는 자신의 프로파일을 읽습니다:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

주 에이전트 자격 증명은 자동으로 공유되지 **않습니다**. `agentDir`을 에이전트 간에 재사용하지 마십시오 (인증/세션 충돌을 유발할 수 있습니다). 자격 증명을 공유하려면, 다른 에이전트의 `agentDir`에 `auth-profiles.json`을 복사하십시오.

스킬은 각 워크스페이스의 `skills/` 폴더를 통해 에이전트별로 가능하며, 공통 스킬은 `~/.openclaw/skills`에서 이용할 수 있습니다. [스킬: 에이전트별 vs 공통](/ko-KR/tools/skills#per-agent-vs-shared-skills)을 참조하십시오.

게이트웨이는 **하나의 에이전트**(기본값) 또는 **여러 에이전트**를 나란히 호스팅할 수 있습니다.

**워크스페이스 주의사항:** 각 에이전트의 워크스페이스는 **기본 현재 작업 디렉토리(cwd)**이며, 고정된 샌드박스가 아닙니다. 상대 경로는 워크스페이스 내부에서 해결되지만, 절대 경로는 샌드박스 격리가 활성화되지 않은 한 다른 호스트 위치에 도달할 수 있습니다. [샌드박스 격리](/ko-KR/gateway/sandboxing)를 참조하십시오.

## 경로 (빠른 맵)

- 설정: `~/.openclaw/openclaw.json` (또는 `OPENCLAW_CONFIG_PATH`)
- 상태 디렉토리: `~/.openclaw` (또는 `OPENCLAW_STATE_DIR`)
- 워크스페이스: `~/.openclaw/workspace` (또는 `~/.openclaw/workspace-<agentId>`)
- 에이전트 디렉토리: `~/.openclaw/agents/<agentId>/agent` (또는 `agents.list[].agentDir`)
- 세션: `~/.openclaw/agents/<agentId>/sessions`

### 단일 에이전트 모드 (기본값)

아무 것도 하지 않으면, OpenClaw는 단일 에이전트를 실행합니다:

- `agentId`는 **`main`**으로 기본 설정됩니다.
- 세션은 `agent:main:<mainKey>`로 키가 지정됩니다.
- 워크스페이스는 `~/.openclaw/workspace`(또는 `OPENCLAW_PROFILE`이 설정되었을 때 `~/.openclaw/workspace-<profile>`)로 기본 설정됩니다.
- 상태는 `~/.openclaw/agents/main/agent`로 기본 설정됩니다.

## 에이전트 도우미

새로운 격리된 에이전트를 추가하려면 에이전트 마법사를 사용하십시오:

```bash
openclaw agents add work
```

그런 다음 들어오는 메시지를 라우팅하기 위해 `binding`을 추가하십시오 (또는 마법사에게 맡기십시오).

확인은 다음과 같이 수행합니다:

```bash
openclaw agents list --bindings
```

## 여러 에이전트 = 여러 사람, 여러 인격

**여러 에이전트**를 사용하면 각 `agentId`는 **완전한 격리된 페르소나**가 됩니다:

- **다른 전화번호/계정** (각 채널 `accountId`별).
- **다른 인격** (`AGENTS.md` 및 `SOUL.md`와 같은 에이전트별 워크스페이스 파일별).
- **별도의 인증 및 세션** (명시적으로 활성화되지 않는 한 상호작용 없음).

이를 통해 **여러 사람**이 하나의 게이트웨이 서버를 공유하면서도 AI "두뇌"와 데이터를 격리할 수 있습니다.

## 하나의 WhatsApp 번호, 여러 사람 (DM 분할)

**하나의 WhatsApp 계정**에서 **다른 WhatsApp 다이렉트 메시지**를 다른 에이전트로 라우팅할 수 있습니다. 송신자 E.164(예: `+15551234567`)와 `peer.kind: "direct"`로 매칭하십시오. 답장은 동일한 WhatsApp 번호에서 계속 나오므로 에이전트별 발신자 식별은 없습니다.

중요 세부사항: 다이렉트 채팅은 에이전트의 **주 세션 키**로 병합되므로, 진정한 분리를 위해서는 **사람당 하나의 에이전트**가 필요합니다.

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

참고 사항:

- 다이렉트 메시지 접근 제어는 **WhatsApp 계정당 전역**(페어링/허용 목록)이며, 에이전트별이 아닙니다.
- 공유 그룹의 경우 그룹을 하나의 에이전트에 바인딩하거나 [방송 그룹](/ko-KR/channels/broadcast-groups)을 사용하십시오.

## 라우팅 규칙 (메시지가 에이전트를 선택하는 방식)

바인딩은 **결정론적**이며 **가장 구체적인 것이 승리합니다**:

1. `peer` 매칭 (정확한 DM/그룹/채널 ID)
2. `parentPeer` 매칭 (스레드 상속)
3. `guildId + roles` (Discord 역할 라우팅)
4. `guildId` (Discord)
5. `teamId` (Slack)
6. 채널에 대한 `accountId` 매칭
7. 채널 수준 매칭 (`accountId: "*"`)
8. 기본 에이전트로 대체 (`agents.list[].default`, 아니면 첫 번째 리스트 항목, 기본값: `main`)

같은 계층에서 여러 바인딩이 일치하는 경우, 설정 순서에서 첫 번째 항목이 우선합니다.
바인딩이 여러 매칭 필드를 설정한 경우 (예: `peer` + `guildId`), 모든 지정된 필드가 필요합니다 (`AND` 의미).

## 다중 계정 / 전화번호

다수의 계정을 지원하는 채널 (예: WhatsApp)은 `accountId`를 사용하여 각 로그인을 식별합니다. 각 `accountId`는 다른 에이전트로 라우팅될 수 있으므로, 하나의 서버가 세션 섞임 없이 여러 전화번호를 호스트할 수 있습니다.

## 개념

- `agentId`: 하나의 “뇌” (워크스페이스, 에이전트별 인증, 에이전트별 세션 저장소).
- `accountId`: 하나의 채널 계정 인스턴스 (예: WhatsApp 계정 `"personal"` vs `"biz"`).
- `binding`: `(channel, accountId, peer)` 및 선택적으로 guild/team ID별로 메시지를 `agentId`로 라우팅합니다.
- 다이렉트 채팅은 `agent:<agentId>:<mainKey>`로 압축됩니다 (에이전트별 “주”; `session.mainKey`).

## 빠른 시작

<Steps>
  <Step title="각 에이전트 워크스페이스 생성">

마법사를 사용하거나 워크스페이스를 수동으로 생성합니다:

```bash
openclaw agents add coding
openclaw agents add social
```

각 에이전트는 `SOUL.md`, `AGENTS.md` 및 선택적 `USER.md`를 포함한 자체 워크스페이스와 `~/.openclaw/agents/<agentId>` 아래의 전용 `agentDir` 및 세션 저장소를 받습니다.

  </Step>

  <Step title="채널 계정 생성">

선호하는 채널에서 에이전트당 하나의 계정을 생성합니다:

- Discord: 에이전트당 하나의 봇, Message Content Intent 활성화, 각 토큰 복사.
- Telegram: BotFather를 통해 에이전트당 하나의 봇, 각 토큰 복사.
- WhatsApp: 계정당 각 전화번호 링크.

```bash
openclaw channels login --channel whatsapp --account work
```

채널 가이드 참조: [Discord](/ko-KR/channels/discord), [Telegram](/ko-KR/channels/telegram), [WhatsApp](/ko-KR/channels/whatsapp).

  </Step>

  <Step title="에이전트, 계정 및 바인딩 추가">

`agents.list` 아래에 에이전트를 추가하고, `channels.<channel>.accounts` 아래에 채널 계정을 추가하며, `bindings`로 연결합니다 (아래 예제 참조).

  </Step>

  <Step title="재시작 및 확인">

```bash
openclaw gateway restart
openclaw agents list --bindings
openclaw channels status --probe
```

  </Step>
</Steps>

## 플랫폼 예제

### Discord 봇 에이전트별

각 Discord 봇 계정은 고유한 `accountId`에 매핑됩니다. 각 계정을 에이전트에 바인딩하고 봇별 허용 목록을 유지합니다.

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

참고 사항:

- 각 봇을 길드에 초대하고 Message Content Intent를 활성화합니다.
- 토큰은 `channels.discord.accounts.<id>.token`에 있습니다 (기본 계정은 `DISCORD_BOT_TOKEN` 사용 가능).

### Telegram 봇 에이전트별

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

참고 사항:

- BotFather로 에이전트당 하나의 봇을 생성하고 각 토큰을 복사합니다.
- 토큰은 `channels.telegram.accounts.<id>.botToken`에 있습니다 (기본 계정은 `TELEGRAM_BOT_TOKEN` 사용 가능).

### WhatsApp 번호 에이전트별

게이트웨이를 시작하기 전에 각 계정을 링크합니다:

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

  // 결정론적 라우팅: 첫 번째 매칭이 승리 (가장 구체적인 것부터).
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

    // 선택적 피어별 오버라이드 (예: 특정 그룹을 work 에이전트로 보냄).
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630...@g.us" },
      },
    },
  ],

  // 기본적으로 꺼짐: 에이전트 간 메시징은 명시적으로 활성화되고 허용 목록에 추가되어야 함.
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
          // 선택적 오버라이드. 기본값: ~/.openclaw/credentials/whatsapp/personal
          // authDir: "~/.openclaw/credentials/whatsapp/personal",
        },
        biz: {
          // 선택적 오버라이드. 기본값: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

## 예시: WhatsApp 일상 대화 + Telegram 집중 작업

채널로 분할: WhatsApp을 빠른 일상 에이전트로 라우팅하고 Telegram을 Opus 에이전트로 라우팅.

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

참고 사항:

- 채널에 대한 다중 계정을 사용 중인 경우, 바인딩에 `accountId`를 추가하십시오 (예: `{ channel: "whatsapp", accountId: "personal" }`).
- 단일 DM/그룹을 Opus로 라우팅하면서 나머지는 채팅에 남겨두려면 그 피어에 대한 `match.peer` 바인딩을 추가하십시오; 피어 매칭은 항상 채널 전역 규칙보다 우선합니다.

## 예시: 동일 채널, Opus로 하나의 피어

WhatsApp을 빠른 에이전트에 유지하고 하나의 DM을 Opus로 라우팅하십시오:

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

피어 바인딩은 항상 승리하므로, 채널 전역 규칙보다 위에 두십시오.

## 가족 에이전트를 WhatsApp 그룹에 바인딩

특정 WhatsApp 그룹에 가족 전용 에이전트를 바인딩하고 멘션 게이팅과 엄격한 도구 정책을 사용하십시오:

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

참고 사항:

- 도구 허용/거부 목록은 **도구**이지 스킬이 아님. 스킬이 바이너리를 실행해야 하는 경우, `exec`이 허용되어 있고 해당 바이너리가 샌드박스에 존재하는지 확인하십시오.
- 더 엄격한 게이트를 위해 `agents.list[].groupChat.mentionPatterns`을 설정하고 채널에 대한 그룹 허용 목록을 유지하십시오.

## 에이전트별 샌드박스 및 도구 설정

v2026.1.6부터 각 에이전트는 자체적인 샌드박스 및 도구 제한을 가질 수 있습니다:

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // 개인 에이전트에 샌드박스 없음
        },
        // 도구 제한 없음 - 모든 도구 사용 가능
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // 항상 샌드박스
          scope: "agent",  // 에이전트당 하나의 컨테이너
          docker: {
            // 컨테이너 생성 후 선택적 일회성 설정
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // 읽기 도구만 허용
          deny: ["exec", "write", "edit", "apply_patch"],    // 나머지는 허용 안 함
        },
      },
    ],
  },
}
```

참고: `setupCommand`는 `sandbox.docker` 아래에 있으며, 컨테이너 생성 시 한 번 실행됩니다. 에이전트별 `sandbox.docker.*` 재정의는 해석된 범위가 `"shared"`인 경우 무시됩니다.

**혜택:**

- **보안 격리**: 신뢰할 수 없는 에이전트에 대한 도구 제한
- **자원 관리**: 특정 에이전트의 샌드박스를 유지하면서 다른 에이전트는 호스트에 유지
- **유연한 정책**: 에이전트별로 다른 권한

참고: `tools.elevated`는 **전역적**이고 발신자 기반이며, 에이전트별로 구성할 수 없습니다. 에이전트별 경계를 설정하려면 `agents.list[].tools`를 사용하여 `exec`을 거부하십시오. 그룹 대상화를 위해 `agents.list[].groupChat.mentionPatterns`를 설정하여 멘션이 의도된 에이전트에 정확히 매핑되도록 합니다.

자세한 예시는 [Multi-Agent Sandbox & Tools](/ko-KR/tools/multi-agent-sandbox-tools)를 참조하십시오.
