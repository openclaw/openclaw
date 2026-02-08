---
summary: "멀티 에이전트 라우팅: 격리된 에이전트, 채널 계정, 바인딩"
title: 멀티 에이전트 라우팅
read_when: "하나의 Gateway(게이트웨이) 프로세스에서 여러 개의 격리된 에이전트(워크스페이스 + 인증)를 사용하려는 경우."
status: active
x-i18n:
  source_path: concepts/multi-agent.md
  source_hash: aa2b77f4707628ca
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:24:57Z
---

# 멀티 에이전트 라우팅

목표: 하나의 실행 중인 Gateway(게이트웨이)에서 여러 개의 _격리된_ 에이전트(별도의 워크스페이스 + `agentDir` + 세션), 그리고 여러 채널 계정(예: WhatsApp 두 개)을 함께 운영합니다. 인바운드 메시지는 바인딩을 통해 특정 에이전트로 라우팅됩니다.

## “하나의 에이전트”란?

**에이전트**는 다음을 각각 독립적으로 가지는 완전히 범위가 지정된 두뇌입니다:

- **워크스페이스** (파일, AGENTS.md/SOUL.md/USER.md, 로컬 노트, 페르소나 규칙).
- **상태 디렉토리** (`agentDir`) — 인증 프로파일, 모델 레지스트리, 에이전트별 설정.
- **세션 저장소** (채팅 기록 + 라우팅 상태) — `~/.openclaw/agents/<agentId>/sessions` 하위.

인증 프로파일은 **에이전트별**입니다. 각 에이전트는 다음 위치에서만 읽습니다:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

메인 에이전트 자격 증명은 자동으로 공유되지 **않습니다**. `agentDir` 를
에이전트 간에 재사용하지 마십시오(인증/세션 충돌을 유발합니다). 자격 증명을
공유하려면 `auth-profiles.json` 를 다른 에이전트의 `agentDir` 로 복사하십시오.

Skills 는 각 워크스페이스의 `skills/` 폴더를 통해 에이전트별로 관리되며,
공유 Skills 는 `~/.openclaw/skills` 에서 사용할 수 있습니다.
[Skills: per-agent vs shared](/tools/skills#per-agent-vs-shared-skills)를 참고하십시오.

Gateway(게이트웨이)는 **하나의 에이전트**(기본값) 또는 **여러 에이전트**를 나란히 호스팅할 수 있습니다.

**워크스페이스 참고:** 각 에이전트의 워크스페이스는 **기본 cwd** 이며, 강제
샌드박스가 아닙니다. 상대 경로는 워크스페이스 내부로 해석되지만, 절대 경로는
샌드박스화가 활성화되지 않은 경우 다른 호스트 위치에 접근할 수 있습니다.
[Sandboxing](/gateway/sandboxing)을 참고하십시오.

## 경로(빠른 맵)

- 설정: `~/.openclaw/openclaw.json` (또는 `OPENCLAW_CONFIG_PATH`)
- 상태 디렉토리: `~/.openclaw` (또는 `OPENCLAW_STATE_DIR`)
- 워크스페이스: `~/.openclaw/workspace` (또는 `~/.openclaw/workspace-<agentId>`)
- 에이전트 디렉토리: `~/.openclaw/agents/<agentId>/agent` (또는 `agents.list[].agentDir`)
- 세션: `~/.openclaw/agents/<agentId>/sessions`

### 단일 에이전트 모드(기본값)

아무 설정도 하지 않으면 OpenClaw 는 단일 에이전트로 실행됩니다:

- `agentId` 의 기본값은 **`main`** 입니다.
- 세션은 `agent:main:<mainKey>` 로 키가 지정됩니다.
- 워크스페이스 기본값은 `~/.openclaw/workspace` 입니다(`OPENCLAW_PROFILE` 이 설정되면 `~/.openclaw/workspace-<profile>`).
- 상태 기본값은 `~/.openclaw/agents/main/agent` 입니다.

## 에이전트 헬퍼

에이전트 마법사를 사용하여 새로운 격리된 에이전트를 추가하십시오:

```bash
openclaw agents add work
```

그런 다음 인바운드 메시지를 라우팅하기 위해 `bindings` 를 추가하십시오
(또는 마법사에 맡기십시오).

다음으로 확인합니다:

```bash
openclaw agents list --bindings
```

## 여러 에이전트 = 여러 사람, 여러 페르소나

**여러 에이전트**를 사용하면 각 `agentId` 는 **완전히 격리된 페르소나**가 됩니다:

- **서로 다른 전화번호/계정** (채널 `accountId` 별).
- **서로 다른 성격** (에이전트별 워크스페이스 파일, 예: `AGENTS.md`, `SOUL.md`).
- **분리된 인증 + 세션** (명시적으로 활성화하지 않는 한 상호 간섭 없음).

이를 통해 **여러 사람**이 하나의 Gateway(게이트웨이) 서버를 공유하면서도 AI “두뇌”와 데이터를 격리할 수 있습니다.

## 하나의 WhatsApp 번호, 여러 사람(DM 분리)

**하나의 WhatsApp 계정**을 유지한 채로 **서로 다른 WhatsApp 다이렉트 메시지**를
각기 다른 에이전트로 라우팅할 수 있습니다. 발신자 E.164(예: `+15551234567`)를
`peer.kind: "dm"` 로 매칭합니다. 응답은 동일한 WhatsApp 번호에서 전송됩니다
(에이전트별 발신자 식별은 없음).

중요한 세부 사항: 다이렉트 채팅은 에이전트의 **메인 세션 키**로 병합되므로,
진정한 격리를 위해서는 **사람당 하나의 에이전트**가 필요합니다.

예시:

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

- DM 접근 제어는 에이전트별이 아니라 **WhatsApp 계정 전역**(페어링/허용 목록)입니다.
- 공유 그룹의 경우, 해당 그룹을 하나의 에이전트에 바인딩하거나
  [Broadcast groups](/channels/broadcast-groups)를 사용하십시오.

## 라우팅 규칙(메시지가 에이전트를 선택하는 방식)

바인딩은 **결정적**이며 **가장 구체적인 규칙이 우선**됩니다:

1. `peer` 매치(정확한 DM/그룹/채널 id)
2. `guildId` (Discord)
3. `teamId` (Slack)
4. 채널에 대한 `accountId` 매치
5. 채널 수준 매치(`accountId: "*"`)
6. 기본 에이전트로 폴백(`agents.list[].default`, 없으면 목록의 첫 항목, 기본값: `main`)

## 여러 계정 / 전화번호

**여러 계정**을 지원하는 채널(예: WhatsApp)은 `accountId` 를 사용하여
각 로그인을 식별합니다. 각 `accountId` 는 서로 다른 에이전트로 라우팅될 수 있으므로,
하나의 서버에서 여러 전화번호를 세션 혼합 없이 호스팅할 수 있습니다.

## 개념

- `agentId`: 하나의 “두뇌”(워크스페이스, 에이전트별 인증, 에이전트별 세션 저장소).
- `accountId`: 하나의 채널 계정 인스턴스(예: WhatsApp 계정 `"personal"` vs `"biz"`).
- `binding`: `(channel, accountId, peer)` 및 선택적으로 길드/팀 id 로 인바운드 메시지를 `agentId` 로 라우팅합니다.
- 다이렉트 채팅은 `agent:<agentId>:<mainKey>` 로 병합됩니다(에이전트별 “메인”; `session.mainKey`).

## 예시: WhatsApp 두 개 → 에이전트 두 개

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

## 예시: WhatsApp 일상 대화 + Telegram 집중 작업

채널로 분리: WhatsApp 은 빠른 일상용 에이전트로, Telegram 은 Opus 에이전트로 라우팅합니다.

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

- 채널에 여러 계정이 있는 경우, 바인딩에 `accountId` 를 추가하십시오
  (예: `{ channel: "whatsapp", accountId: "personal" }`).
- 단일 DM/그룹만 Opus 로 라우팅하고 나머지는 채팅 에이전트에 유지하려면,
  해당 피어에 대해 `match.peer` 바인딩을 추가하십시오. 피어 매치는 항상 채널 전체 규칙보다 우선합니다.

## 예시: 동일 채널에서 특정 피어만 Opus

WhatsApp 은 빠른 에이전트에 유지하되, 하나의 DM 만 Opus 로 라우팅합니다:

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

피어 바인딩이 항상 우선하므로, 채널 전체 규칙보다 위에 두십시오.

## WhatsApp 그룹에 바인딩된 가족 에이전트

멘션 게이팅과 더 엄격한 도구 정책을 적용한 전용 가족 에이전트를
하나의 WhatsApp 그룹에 바인딩합니다:

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

- 도구 허용/차단 목록은 **Skills** 가 아니라 **도구**입니다. Skill 이 바이너리를 실행해야 하는 경우,
  `exec` 가 허용되어 있고 해당 바이너리가 샌드박스에 존재하는지 확인하십시오.
- 더 엄격한 게이팅을 위해 `agents.list[].groupChat.mentionPatterns` 를 설정하고,
  채널의 그룹 허용 목록을 활성화된 상태로 유지하십시오.

## 에이전트별 샌드박스 및 도구 구성

v2026.1.6 부터 각 에이전트는 자체 샌드박스와 도구 제한을 가질 수 있습니다:

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

참고: `setupCommand` 는 `sandbox.docker` 하위에 있으며 컨테이너 생성 시 한 번 실행됩니다.
해결된 범위가 `"shared"` 인 경우, 에이전트별 `sandbox.docker.*` 오버라이드는 무시됩니다.

**이점:**

- **보안 격리**: 신뢰되지 않은 에이전트에 대한 도구 제한
- **리소스 제어**: 특정 에이전트만 샌드박스화하고 다른 에이전트는 호스트에서 유지
- **유연한 정책**: 에이전트별 상이한 권한

참고: `tools.elevated` 는 **전역**이며 발신자 기반입니다. 에이전트별로 구성할 수 없습니다.
에이전트별 경계를 원한다면, `agents.list[].tools` 를 사용하여 `exec` 를 거부하십시오.
그룹 대상 지정에는 `agents.list[].groupChat.mentionPatterns` 를 사용하여 @멘션이 의도한 에이전트로 깔끔하게 매핑되도록 하십시오.

자세한 예시는 [Multi-Agent Sandbox & Tools](/tools/multi-agent-sandbox-tools)를 참고하십시오.
