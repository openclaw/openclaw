---
summary: "에이전트별 샌드박스 + 도구 제한, 우선순위 및 예시"
title: 멀티 에이전트 샌드박스 & 도구
read_when: "멀티 에이전트 Gateway(게이트웨이)에서 에이전트별 샌드박스화 또는 에이전트별 도구 허용/차단 정책이 필요할 때."
status: active
---

# 멀티 에이전트 샌드박스 & 도구 구성

## 개요

멀티 에이전트 설정에서 각 에이전트는 이제 다음을 개별적으로 가질 수 있습니다:

- **샌드박스 구성** (`agents.list[].sandbox` 가 `agents.defaults.sandbox` 를 재정의)
- **도구 제한** (`tools.allow` / `tools.deny`, 그리고 `agents.list[].tools`)

이를 통해 서로 다른 보안 프로필을 가진 여러 에이전트를 실행할 수 있습니다:

- 전체 접근 권한을 가진 개인 비서
- 제한된 도구만 사용하는 가족/업무 에이전트
- 샌드박스에서 실행되는 공개용 에이전트

`setupCommand` 는 `sandbox.docker` (전역 또는 에이전트별) 아래에 속하며,
컨테이너가 생성될 때 한 번만 실행됩니다.

인증은 에이전트별입니다. 각 에이전트는 다음 위치에 있는 자체 `agentDir` 인증 저장소를 읽습니다:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

자격 증명은 에이전트 간에 **공유되지 않습니다**. 에이전트 간에 `agentDir` 를 절대 재사용하지 마십시오.
자격 증명을 공유하려면 `auth-profiles.json` 를 다른 에이전트의 `agentDir` 로 복사하십시오.

런타임에서 샌드박스화가 어떻게 동작하는지는 [Sandboxing](/gateway/sandboxing)을 참고하십시오.
“왜 이것이 차단되었는가?”를 디버깅하려면 [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated)와 `openclaw sandbox explain` 를 참고하십시오.

---

## 구성 예시

### 예시 1: 개인 + 제한된 가족 에이전트

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "name": "Personal Assistant",
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "family",
        "name": "Family Bot",
        "workspace": "~/.openclaw/workspace-family",
        "sandbox": {
          "mode": "all",
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch", "process", "browser"]
        }
      }
    ]
  },
  "bindings": [
    {
      "agentId": "family",
      "match": {
        "provider": "whatsapp",
        "accountId": "*",
        "peer": {
          "kind": "group",
          "id": "120363424282127706@g.us"
        }
      }
    }
  ]
}
```

**결과:**

- `main` 에이전트: 호스트에서 실행, 모든 도구 접근 가능
- `family` 에이전트: Docker 에서 실행(에이전트당 하나의 컨테이너), `read` 도구만 사용 가능

---

### 예시 2: 공유 샌드박스를 사용하는 업무 에이전트

```json
{
  "agents": {
    "list": [
      {
        "id": "personal",
        "workspace": "~/.openclaw/workspace-personal",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "work",
        "workspace": "~/.openclaw/workspace-work",
        "sandbox": {
          "mode": "all",
          "scope": "shared",
          "workspaceRoot": "/tmp/work-sandboxes"
        },
        "tools": {
          "allow": ["read", "write", "apply_patch", "exec"],
          "deny": ["browser", "gateway", "discord"]
        }
      }
    ]
  }
}
```

---

### 예시 2b: 전역 코딩 프로필 + 메시징 전용 에이전트

```json
{
  "tools": { "profile": "coding" },
  "agents": {
    "list": [
      {
        "id": "support",
        "tools": { "profile": "messaging", "allow": ["slack"] }
      }
    ]
  }
}
```

**결과:**

- 기본 에이전트는 코딩 도구를 사용 가능
- `support` 에이전트는 메시징 전용(+ Slack 도구)

---

### 예시 3: 에이전트별로 다른 샌드박스 모드

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main", // Global default
        "scope": "session"
      }
    },
    "list": [
      {
        "id": "main",
        "workspace": "~/.openclaw/workspace",
        "sandbox": {
          "mode": "off" // Override: main never sandboxed
        }
      },
      {
        "id": "public",
        "workspace": "~/.openclaw/workspace-public",
        "sandbox": {
          "mode": "all", // Override: public always sandboxed
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch"]
        }
      }
    ]
  }
}
```

---

## 구성 우선순위

전역 (`agents.defaults.*`) 과 에이전트별 (`agents.list[].*`) 구성이 모두 존재할 때:

### 샌드박스 구성

에이전트별 설정이 전역 설정을 재정의합니다:

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**참고 사항:**

- `agents.list[].sandbox.{docker,browser,prune}.*` 는 해당 에이전트에 대해 `agents.defaults.sandbox.{docker,browser,prune}.*` 를 재정의합니다(샌드박스 범위가 `"shared"` 로 해석될 경우 무시됨).

### 도구 제한

필터링 순서는 다음과 같습니다:

1. **도구 프로필** (`tools.profile` 또는 `agents.list[].tools.profile`)
2. **프로바이더 도구 프로필** (`tools.byProvider[provider].profile` 또는 `agents.list[].tools.byProvider[provider].profile`)
3. **전역 도구 정책** (`tools.allow` / `tools.deny`)
4. **프로바이더 도구 정책** (`tools.byProvider[provider].allow/deny`)
5. **에이전트별 도구 정책** (`agents.list[].tools.allow/deny`)
6. **에이전트 프로바이더 정책** (`agents.list[].tools.byProvider[provider].allow/deny`)
7. **샌드박스 도구 정책** (`tools.sandbox.tools` 또는 `agents.list[].tools.sandbox.tools`)
8. **하위 에이전트 도구 정책** (`tools.subagents.tools`, 해당되는 경우)

각 단계는 도구를 추가로 제한할 수 있지만, 이전 단계에서 거부된 도구를 다시 허용할 수는 없습니다.
`agents.list[].tools.sandbox.tools` 가 설정되면 해당 에이전트에 대해 `tools.sandbox.tools` 를 대체합니다.
`agents.list[].tools.profile` 가 설정되면 해당 에이전트에 대해 `tools.profile` 를 재정의합니다.
프로바이더 도구 키는 `provider` (예: `google-antigravity`) 또는 `provider/model` (예: `openai/gpt-5.2`) 형식을 모두 허용합니다.

### 도구 그룹(단축 표기)

도구 정책(전역, 에이전트, 샌드박스)은 여러 구체적인 도구로 확장되는 `group:*` 항목을 지원합니다:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: 모든 기본 제공 OpenClaw 도구(프로바이더 플러그인은 제외)

### Elevated 모드

`tools.elevated` 는 전역 기준선(발신자 기반 허용 목록)입니다. `agents.list[].tools.elevated` 는 특정 에이전트에 대해 Elevated 를 추가로 제한할 수 있으며, 두 조건이 모두 허용되어야 합니다.

완화 패턴:

- 신뢰할 수 없는 에이전트(`agents.list[].tools.deny: ["exec"]`)에 대해 `exec` 를 거부
- 제한된 에이전트로 라우팅되는 발신자를 허용 목록에 추가하지 않기
- 샌드박스 실행만 원한다면 전역적으로 Elevated 비활성화(`tools.elevated.enabled: false`)
- 민감한 프로필의 경우 에이전트별로 Elevated 비활성화(`agents.list[].tools.elevated.enabled: false`)

---

## 단일 에이전트에서 마이그레이션

**이전(단일 에이전트):**

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.openclaw/workspace",
      "sandbox": {
        "mode": "non-main"
      }
    }
  },
  "tools": {
    "sandbox": {
      "tools": {
        "allow": ["read", "write", "apply_patch", "exec"],
        "deny": []
      }
    }
  }
}
```

**이후(서로 다른 프로필을 가진 멀티 에이전트):**

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      }
    ]
  }
}
```

레거시 `agent.*` 구성은 `openclaw doctor` 에 의해 마이그레이션됩니다. 향후에는 `agents.defaults` + `agents.list` 사용을 권장합니다.

---

## 도구 제한 예시

### 읽기 전용 에이전트

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### 안전 실행 에이전트(파일 수정 없음)

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### 통신 전용 에이전트

```json
{
  "tools": {
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## 일반적인 함정: "non-main"

`agents.defaults.sandbox.mode: "non-main"` 는 에이전트 id 가 아니라 `session.mainKey` (기본값 `"main"`)를 기준으로 합니다. 그룹/채널 세션은 항상 자체 키를 가지므로 non-main 으로 처리되어 샌드박스화됩니다. 에이전트를 절대 샌드박스화하지 않으려면 `agents.list[].sandbox.mode: "off"` 를 설정하십시오.

---

## 테스트

멀티 에이전트 샌드박스 및 도구를 구성한 후:

1. **에이전트 해석 확인:**

   ```exec
   openclaw agents list --bindings
   ```

2. **샌드박스 컨테이너 확인:**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **도구 제한 테스트:**
   - 제한된 도구가 필요한 메시지 전송
   - 에이전트가 거부된 도구를 사용할 수 없는지 확인

4. **로그 모니터링:**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## 문제 해결

### `mode: "all"` 가 설정되었는데도 에이전트가 샌드박스화되지 않는 경우

- 이를 재정의하는 전역 `agents.defaults.sandbox.mode` 가 있는지 확인
- 에이전트별 구성이 우선하므로 `agents.list[].sandbox.mode: "all"` 를 설정

### 거부 목록이 있는데도 도구가 여전히 사용 가능한 경우

- 도구 필터링 순서 확인: 전역 → 에이전트 → 샌드박스 → 하위 에이전트
- 각 단계는 제한만 가능하며 다시 허용할 수는 없음
- 로그로 확인: `[tools] filtering tools for agent:${agentId}`

### 에이전트별로 컨테이너가 격리되지 않는 경우

- 에이전트별 샌드박스 구성에서 `scope: "agent"` 를 설정
- 기본값은 `"session"` 이며, 이는 세션당 하나의 컨테이너를 생성합니다

---

## 함께 보기

- [Multi-Agent Routing](/concepts/multi-agent)
- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Session Management](/concepts/session)
