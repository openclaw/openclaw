---
read_when: You want multiple isolated agents (workspaces + auth) in one gateway process.
status: active
summary: '다중 에이전트 라우팅: 격리된 에이전트, 채널 계정 및 바인딩'
title: 다중 에이전트 라우팅
x-i18n:
    generated_at: "2026-02-08T15:51:48Z"
    model: gtx
    provider: google-translate
    source_hash: aa2b77f4707628ca6d45af471d9e45a38f779b5bc99e1cc50bc368826acc96a5
    source_path: concepts/multi-agent.md
    workflow: 15
---

# 다중 에이전트 라우팅

목표: 여러 _외딴_ 에이전트(별도의 작업 공간 + `agentDir` + 세션) 및 실행 중인 하나의 게이트웨이에 여러 채널 계정(예: WhatsApp 2개)이 포함됩니다. 인바운드는 바인딩을 통해 에이전트로 라우팅됩니다.

## "원 에이전트"란 무엇입니까?

안 **대리인** 다음과 같은 자체 기능을 갖춘 완전한 범위의 두뇌입니다.

- **작업공간** (파일, AGENTS.md/SOUL.md/USER.md, 로컬 메모, 페르소나 규칙).
- **상태 디렉토리** (`agentDir`) 인증 프로필, 모델 레지스트리 및 에이전트별 구성의 경우.
- **세션 저장소** (채팅 기록 + 라우팅 상태) 아래 `~/.openclaw/agents/<agentId>/sessions`.

인증 프로필은 다음과 같습니다. **에이전트별**. 각 에이전트는 자체에서 다음을 읽습니다.

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

주 에이전트 자격 증명은 다음과 같습니다. **~ 아니다** 자동으로 공유됩니다. 재사용하지 않음 `agentDir`
에이전트 전체에 걸쳐(인증/세션 충돌이 발생함) 크레딧을 공유하고 싶다면,
복사 `auth-profiles.json` 다른 상담원에게 `agentDir`.

스킬은 각 작업 공간을 통해 에이전트별로 결정됩니다. `skills/` 폴더, 공유 스킬 포함
에서 이용 가능 `~/.openclaw/skills`. 보다 [기술: 에이전트별 vs. 공유](/tools/skills#per-agent-vs-shared-skills).

게이트웨이는 호스트할 수 있습니다. **에이전트 1명** (기본값) 또는 **많은 에이전트** 나란히.

**작업공간 참고사항:** 각 상담원의 작업공간은 **기본 cwd**, 어렵지 않아요
샌드박스. 상대 경로는 작업 공간 내에서 확인되지만 절대 경로는
샌드박싱이 활성화되지 않은 한 다른 호스트 위치에 도달합니다. 보다
[샌드박싱](/gateway/sandboxing).

## 경로(빠른 지도)

- 구성: `~/.openclaw/openclaw.json` (또는 `OPENCLAW_CONFIG_PATH`)
- 상태 디렉토리: `~/.openclaw` (또는 `OPENCLAW_STATE_DIR`)
- 작업 공간: `~/.openclaw/workspace` (또는 `~/.openclaw/workspace-<agentId>`)
- 상담원 디렉토리: `~/.openclaw/agents/<agentId>/agent` (또는 `agents.list[].agentDir`)
- 세션: `~/.openclaw/agents/<agentId>/sessions`

### 단일 에이전트 모드(기본값)

아무것도 하지 않으면 OpenClaw는 단일 에이전트를 실행합니다.

- `agentId` 기본값은 **`main`**.
- 세션의 키는 다음과 같습니다. `agent:main:<mainKey>`.
- 작업공간의 기본값은 `~/.openclaw/workspace` (또는 `~/.openclaw/workspace-<profile>` 언제 `OPENCLAW_PROFILE` 설정됨).
- 상태 기본값은 다음과 같습니다. `~/.openclaw/agents/main/agent`.

## 상담원 도우미

에이전트 마법사를 사용하여 격리된 새 에이전트를 추가합니다.

```bash
openclaw agents add work
```

그런 다음 추가 `bindings` (또는 마법사가 수행하도록 함) 인바운드 메시지를 라우팅합니다.

다음을 통해 확인하세요.

```bash
openclaw agents list --bindings
```

## 다중 에이전트 = 다중 사람, 다중 성격

와 함께 **여러 에이전트**, 각 `agentId` 가 된다 **완전히 고립된 페르소나**:

- **다른 전화번호/계좌** (채널당 `accountId`).
- **다양한 성격** (다음과 같은 에이전트별 작업 영역 파일 `AGENTS.md` 그리고 `SOUL.md`).
- **별도의 인증 + 세션** (명시적으로 활성화하지 않는 한 혼선이 없습니다).

이렇게 하면 **여러 사람** AI "브레인"과 데이터를 격리된 상태로 유지하면서 하나의 게이트웨이 서버를 공유합니다.

## 하나의 WhatsApp 번호, 여러 사람(DM 분할)

라우팅할 수 있습니다. **다양한 WhatsApp DM** 계속 머무르는 동안 다른 상담원에게 **하나의 WhatsApp 계정**. 발신자 E.164 일치(예: `+15551234567`) 와 함께 `peer.kind: "dm"`. 응답은 여전히 ​​동일한 WhatsApp 번호에서 옵니다(에이전트별 발신자 ID 없음).

중요 세부정보: 직접 채팅은 상담원의 채팅으로 축소됩니다. **기본 세션 키**, 따라서 진정한 격리가 필요합니다. **1인당 에이전트 1명**.

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
    { agentId: "alex", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230001" } } },
    { agentId: "mia", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551230002" } } },
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

- DM 접근 통제는 **WhatsApp 계정별 글로벌** (페어링/허용 목록), 에이전트별이 아닙니다.
- 공유 그룹의 경우 그룹을 하나의 에이전트에 바인딩하거나 [방송 그룹](/channels/broadcast-groups).

## 라우팅 규칙(메시지가 상담원을 선택하는 방법)

바인딩은 **결정론적인** 그리고 **가장 구체적인 승리**:

1. `peer` 일치(정확한 DM/그룹/채널 ID)
2. `guildId` (불화)
3. `teamId` (느슨하게)
4. `accountId` 채널 일치
5. 채널 수준 일치(`accountId: "*"`)
6. 기본 에이전트로 대체(`agents.list[].default`, 그렇지 않으면 첫 번째 목록 항목, 기본값: `main`)

## 여러 계정/전화번호

지원하는 채널 **여러 계정** (예: WhatsApp) 사용 `accountId` 식별하다
각 로그인. 각 `accountId` 다른 에이전트로 라우팅될 수 있으므로 하나의 서버에서 호스팅할 수 있습니다.
세션을 혼합하지 않고 여러 전화 번호.

## 개념

- `agentId`: 하나의 "브레인"(작업 공간, 에이전트별 인증, 에이전트별 세션 저장소).
- `accountId`: 하나의 채널 계정 인스턴스(예: WhatsApp 계정 `"personal"` 대 `"biz"`).
- `binding`: 인바운드 메시지를 다음으로 라우팅합니다. `agentId` ~에 의해 `(channel, accountId, peer)` 그리고 선택적으로 길드/팀 ID.
- 직접 채팅은 다음으로 축소됩니다. `agent:<agentId>:<mainKey>` (에이전트별 "기본"; `session.mainKey`).

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

- 한 채널에 여러 계정이 있는 경우 다음을 추가하세요. `accountId` 바인딩에 (예를 들어 `{ channel: "whatsapp", accountId: "personal" }`).
- 단일 DM/그룹을 Opus로 라우팅하고 나머지는 채팅에 유지하려면 다음을 추가하세요. `match.peer` 해당 피어에 대한 구속력; 피어 매치는 항상 채널 전체 규칙보다 우선합니다.

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
    { agentId: "opus", match: { channel: "whatsapp", peer: { kind: "dm", id: "+15551234567" } } },
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

- 도구 허용/거부 목록은 다음과 같습니다. **도구**, 실력이 아닙니다. 스킬을 실행해야 하는 경우
  바이너리, 보장 `exec` 허용되며 바이너리가 샌드박스에 존재합니다.
- 보다 엄격한 게이팅을 위해 다음을 설정하십시오. `agents.list[].groupChat.mentionPatterns` 그리고 유지
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

메모: `setupCommand` 아래에 산다 `sandbox.docker` 컨테이너 생성 시 한 번 실행됩니다.
에이전트별 `sandbox.docker.*` 해결된 범위가 다음인 경우 재정의가 무시됩니다. `"shared"`.

**이익:**

- **보안 격리**: 신뢰할 수 없는 에이전트에 대한 도구를 제한합니다.
- **자원 제어**: 다른 에이전트를 호스트에 유지하면서 샌드박스 전용 에이전트
- **유연한 정책**: 에이전트별로 권한이 다름

메모: `tools.elevated` ~이다 **글로벌** 발신자 기반; 에이전트별로 구성할 수 없습니다.
에이전트별 경계가 필요한 경우 다음을 사용하세요. `agents.list[].tools` 부정하다 `exec`.
그룹 타겟팅의 경우 `agents.list[].groupChat.mentionPatterns` 따라서 @멘션은 의도한 에이전트에 깔끔하게 매핑됩니다.

보다 [다중 에이전트 샌드박스 및 도구](/tools/multi-agent-sandbox-tools) 자세한 예를 보려면.
