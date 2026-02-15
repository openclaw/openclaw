---
summary: "Multi-agent routing: isolated agents, channel accounts, and bindings"
title: Multi-Agent Routing
read_when: "You want multiple isolated agents (workspaces + auth) in one gateway process."
status: active
x-i18n:
  source_hash: 3f54d271823f92311491cf0be556c42b650290f47596f21431310cca0892e9a8
---

# 다중 에이전트 라우팅

목표: 실행 중인 하나의 게이트웨이에 여러 개의 _격리된_ 에이전트(별도의 작업 공간 + `agentDir` + 세션)와 여러 채널 계정(예: WhatsApp 2개)이 있습니다. 인바운드는 바인딩을 통해 에이전트로 라우팅됩니다.

## '원에이전트'란 무엇인가요?

**에이전트**는 다음과 같은 자체 기능을 갖춘 완전한 두뇌입니다.

- **작업 공간**(파일, AGENTS.md/SOUL.md/USER.md, 로컬 메모, 페르소나 규칙).
- 인증 프로필, 모델 레지스트리 및 에이전트별 구성에 대한 **상태 디렉터리**(`agentDir`).
- `~/.openclaw/agents/<agentId>/sessions` 아래의 **세션 저장소**(채팅 기록 + 라우팅 상태).

인증 프로필은 **에이전트별**입니다. 각 에이전트는 자체에서 다음을 읽습니다.

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

주 에이전트 자격 증명은 자동으로 공유되지 **않습니다**. 재사용하지 마세요 `agentDir`
에이전트 전체에 걸쳐(인증/세션 충돌이 발생함) 크레딧을 공유하고 싶다면,
`auth-profiles.json`을 다른 에이전트의 `agentDir`에 복사합니다.

스킬은 공유 스킬과 함께 각 작업 영역의 `skills/` 폴더를 통해 에이전트별로 제공됩니다.
`~/.openclaw/skills`에서 사용 가능합니다. [스킬: 에이전트별 vs 공유](/tools/skills#per-agent-vs-shared-skills)를 참조하세요.

게이트웨이는 **하나의 에이전트**(기본값) 또는 **여러 에이전트**를 나란히 호스팅할 수 있습니다.

**작업공간 참고:** 각 상담원의 작업공간은 하드가 아닌 **기본 cwd**입니다.
샌드박스. 상대 경로는 작업 공간 내에서 확인되지만 절대 경로는
샌드박싱이 활성화되지 않은 한 다른 호스트 위치에 도달합니다. 참조
[샌드박싱](/gateway/sandboxing).

## 경로(빠른 지도)

- 구성: `~/.openclaw/openclaw.json` (또는 `OPENCLAW_CONFIG_PATH`)
- 상태 디렉토리: `~/.openclaw` (또는 `OPENCLAW_STATE_DIR`)
- 작업공간: `~/.openclaw/workspace` (또는 `~/.openclaw/workspace-<agentId>`)
- 에이전트 디렉토리: `~/.openclaw/agents/<agentId>/agent` (또는 `agents.list[].agentDir`)
- 세션: `~/.openclaw/agents/<agentId>/sessions`

### 단일 에이전트 모드(기본값)

아무것도 하지 않으면 OpenClaw는 단일 에이전트를 실행합니다.

- `agentId` 기본값은 **`main`**입니다.
- 세션 키는 `agent:main:<mainKey>`로 입력됩니다.
- 작업공간의 기본값은 `~/.openclaw/workspace`(또는 `OPENCLAW_PROFILE`가 설정된 경우 `~/.openclaw/workspace-<profile>`)입니다.
- 상태 기본값은 `~/.openclaw/agents/main/agent`입니다.

## 상담원 도우미

에이전트 마법사를 사용하여 격리된 새 에이전트를 추가합니다.

```bash
openclaw agents add work
```

그런 다음 `bindings`를 추가하거나 마법사가 수행하도록 하여 인바운드 메시지를 라우팅합니다.

다음을 통해 확인하세요.

```bash
openclaw agents list --bindings
```

## 다중 에이전트 = 다중 사람, 다중 성격

**여러 에이전트**를 사용하면 각 `agentId`가 **완전히 격리된 페르소나**가 됩니다.

- **다른 전화번호/계정** (채널별 `accountId`).
- **다른 성격**(`AGENTS.md` 및 `SOUL.md`과 같은 에이전트별 작업 공간 파일).
- **별도의 인증 + 세션**(명시적으로 활성화하지 않는 한 혼선 없음).

이를 통해 **여러 사람**이 AI "브레인"과 데이터를 격리된 상태로 유지하면서 하나의 게이트웨이 서버를 공유할 수 있습니다.

## 하나의 WhatsApp 번호, 여러 사람(DM 분할)

**하나의 WhatsApp 계정**을 유지하면서 **다른 WhatsApp DM**을 다른 상담원에게 라우팅할 수 있습니다. 발신자 E.164(예: `+15551234567`)를 `peer.kind: "direct"`와 일치시킵니다. 응답은 여전히 ​​동일한 WhatsApp 번호에서 옵니다(에이전트별 발신자 ID 없음).

중요 세부정보: 직접 채팅은 상담원의 **기본 세션 키**로 축소되므로 진정한 격리를 위해서는 **1인당 상담원 1명**이 필요합니다.

예:

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

참고:

- DM 액세스 제어는 에이전트별이 아닌 **WhatsApp 계정별**(페어링/허용 목록)별로 적용됩니다.
- 공유 그룹의 경우 하나의 에이전트에 그룹을 묶거나 [브로드캐스트 그룹](/channels/broadcast-groups)을 사용하세요.

## 라우팅 규칙(메시지가 에이전트를 선택하는 방법)

바인딩은 **결정적**이며 **가장 구체적인 승리**입니다.

1. `peer` 일치 (정확한 DM/그룹/채널 ID)
2. `guildId` (불화)
3. `teamId` (슬랙)
4. `accountId` 채널 일치
5. 채널 수준 일치 (`accountId: "*"`)
6. 기본 에이전트로 대체(`agents.list[].default`, 그렇지 않은 경우 첫 번째 목록 항목, 기본값: `main`)

## 여러 계정/전화번호

**여러 계정**(예: WhatsApp)을 지원하는 채널은 `accountId`를 사용하여 식별합니다.
각 로그인. 각 `accountId`는 다른 에이전트로 라우팅될 수 있으므로 하나의 서버가 호스트할 수 있습니다.
세션을 혼합하지 않고 여러 전화 번호.

## 개념

- `agentId`: 하나의 "브레인"(작업 공간, 에이전트별 인증, 에이전트별 세션 저장소).
- `accountId`: 하나의 채널 계정 인스턴스(예: WhatsApp 계정 `"personal"` 대 `"biz"`).
- `binding`: 인바운드 메시지를 `(channel, accountId, peer)` 및 선택적으로 길드/팀 ID에 의해 `agentId`로 라우팅합니다.
- 직접 채팅은 `agent:<agentId>:<mainKey>`(에이전트별 "기본"; `session.mainKey`)로 축소됩니다.

## 예: WhatsApp 2개 → 에이전트 2개

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

  // Deterministic routing: first match wins (most-specific first).
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },

    // Optional per-peer override (example: send a specific group to work agent).
    {
      agentId: "work",
      match: {
        channel: "whatsapp",
        accountId: "personal",
        peer: { kind: "group", id: "1203630...@g.us" },
      },
    },
  ],

  // Off by default: agent-to-agent messaging must be explicitly enabled + allowlisted.
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
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/personal
          // authDir: "~/.openclaw/credentials/whatsapp/personal",
        },
        biz: {
          // Optional override. Default: ~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

## 예: WhatsApp 일일 채팅 + Telegram 심층 작업

채널별로 분할: WhatsApp을 빠른 일상 상담원에게 라우팅하고 Telegram을 Opus 상담원에게 라우팅합니다.

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

참고:

- 한 채널에 여러 계정이 있는 경우 바인딩에 `accountId`를 추가하세요(예: `{ channel: "whatsapp", accountId: "personal" }`).
- 단일 DM/그룹을 Opus로 라우팅하고 나머지는 채팅에 유지하려면 해당 피어에 대한 `match.peer` 바인딩을 추가하세요. 피어 매치는 항상 채널 전체 규칙보다 우선합니다.

## 예: 동일한 채널, Opus에 대한 하나의 피어

WhatsApp을 빠른 에이전트로 유지하되 DM 하나를 Opus로 라우팅하세요.

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

피어 바인딩은 항상 승리하므로 채널 전체 규칙보다 높게 유지하세요.

## WhatsApp 그룹에 연결된 가족 에이전트

멘션 게이팅을 통해 전담 가족 에이전트를 단일 WhatsApp 그룹에 바인딩
더욱 엄격한 도구 정책:

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

참고:

- 도구 허용/거부 목록은 스킬이 아닌 **도구**입니다. 스킬을 실행해야 하는 경우
  바이너리인 경우 `exec`가 허용되고 바이너리가 샌드박스에 존재하는지 확인하세요.
- 더 엄격한 게이팅을 위해서는 `agents.list[].groupChat.mentionPatterns`를 설정하고 유지하십시오.
  채널에 그룹 허용 목록이 활성화되었습니다.

## 에이전트별 샌드박스 및 도구 구성

v2026.1.6부터 각 에이전트에는 자체 샌드박스 및 도구 제한사항이 있을 수 있습니다.

```js
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: {
          mode: "off",  // No sandbox for personal agent
        },
        // No tool restrictions - all tools available
      },
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",     // Always sandboxed
          scope: "agent",  // One container per agent
          docker: {
            // Optional one-time setup after container creation
            setupCommand: "apt-get update && apt-get install -y git curl",
          },
        },
        tools: {
          allow: ["read"],                    // Only read tool
          deny: ["exec", "write", "edit", "apply_patch"],    // Deny others
        },
      },
    ],
  },
}
```

참고: `setupCommand`는 `sandbox.docker` 아래에 있으며 컨테이너 생성 시 한 번 실행됩니다.
해결된 범위가 `"shared"`인 경우 에이전트별 `sandbox.docker.*` 재정의는 무시됩니다.

**혜택:**

- **보안 격리**: 신뢰할 수 없는 에이전트에 대한 도구를 제한합니다.
- **리소스 제어**: 다른 에이전트를 호스트에 유지하면서 샌드박스 전용 에이전트
- **유연한 정책**: 에이전트마다 다른 권한

참고: `tools.elevated`는 **전역**이며 발신자 기반입니다. 에이전트별로 구성할 수 없습니다.
에이전트별 경계가 필요한 경우 `agents.list[].tools`를 사용하여 `exec`를 거부하세요.
그룹 타겟팅의 경우 `agents.list[].groupChat.mentionPatterns`를 사용하여 @mentions가 의도한 에이전트에 명확하게 매핑되도록 합니다.

자세한 예시는 [다중 에이전트 샌드박스 및 도구](/tools/multi-agent-sandbox-tools)를 참조하세요.
