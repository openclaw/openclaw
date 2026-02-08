---
read_when: You want per-agent sandboxing or per-agent tool allow/deny policies in a multi-agent gateway.
status: active
summary: 에이전트별 샌드박스 + 도구 제한 사항, 우선 순위 및 예
title: 다중 에이전트 샌드박스 및 도구
x-i18n:
    generated_at: "2026-02-08T16:07:52Z"
    model: gtx
    provider: google-translate
    source_hash: 78364bcf0612a5e7572ffbc5352147cc352bd58acf9515c25cd7daa5f7b26d4f
    source_path: tools/multi-agent-sandbox-tools.md
    workflow: 15
---

# 다중 에이전트 샌드박스 및 도구 구성

## 개요

이제 다중 에이전트 설정의 각 에이전트는 다음을 가질 수 있습니다.

- **샌드박스 구성** (`agents.list[].sandbox` 재정의 `agents.defaults.sandbox`)
- **도구 제한** (`tools.allow` / `tools.deny`, 플러스 `agents.list[].tools`)

이를 통해 서로 다른 보안 프로필을 사용하여 여러 에이전트를 실행할 수 있습니다.

- 전체 액세스 권한을 갖춘 개인 비서
- 제한된 도구를 사용하는 가족/직장 에이전트
- 샌드박스의 공개 에이전트

`setupCommand` 다음에 속한다 `sandbox.docker` (전역 또는 에이전트별) 한 번 실행됩니다.
컨테이너가 생성될 때.

인증은 에이전트별로 이루어집니다. 각 에이전트는 자체에서 읽습니다. `agentDir` 인증 스토어:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

자격 증명은 **~ 아니다** 에이전트 간에 공유됩니다. 재사용하지 않음 `agentDir` 에이전트 전반에 걸쳐.
크리드를 공유하려면 복사하세요. `auth-profiles.json` 다른 상담원에게 `agentDir`.

샌드박싱이 런타임에 어떻게 작동하는지 알아보려면 다음을 참조하세요. [샌드박싱](/gateway/sandboxing).
"이것이 왜 차단되나요?" 디버깅에 대해서는 다음을 참조하세요. [샌드박스 vs 도구 정책 vs 상승](/gateway/sandbox-vs-tool-policy-vs-elevated) 그리고 `openclaw sandbox explain`.

---

## 구성 예

### 예 1: 개인 + 제한된 가족 대리인

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

- `main` 에이전트: 호스트에서 실행, 전체 도구 액세스
- `family` 에이전트: Docker에서 실행됩니다(에이전트당 하나의 컨테이너). `read` 도구

---

### 예 2: 공유 샌드박스를 사용하는 작업 에이전트

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

### 예시 2b: 글로벌 코딩 프로필 + 메시징 전용 에이전트

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

- 기본 에이전트는 코딩 도구를 얻습니다.
- `support` 에이전트는 메시징 전용입니다(+ Slack 도구)

---

### 예 3: 에이전트당 다양한 샌드박스 모드

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

전역(`agents.defaults.*`) 및 에이전트별(`agents.list[].*`) 구성이 존재합니다:

### 샌드박스 구성

에이전트별 설정이 전역보다 우선 적용됩니다.

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**참고:**

- `agents.list[].sandbox.{docker,browser,prune}.*` 재정의 `agents.defaults.sandbox.{docker,browser,prune}.*` 해당 에이전트에 대해(샌드박스 범위가 다음으로 확인되면 무시됨) `"shared"`).

### 도구 제한

필터링 순서는 다음과 같습니다.

1. **도구 프로필** (`tools.profile` 또는 `agents.list[].tools.profile`)
2. **제공자 도구 프로필** (`tools.byProvider[provider].profile` 또는 `agents.list[].tools.byProvider[provider].profile`)
3. **글로벌 도구 정책** (`tools.allow` / `tools.deny`)
4. **공급자 도구 정책** (`tools.byProvider[provider].allow/deny`)
5. **에이전트별 도구 정책** (`agents.list[].tools.allow/deny`)
6. **에이전트 제공자 정책** (`agents.list[].tools.byProvider[provider].allow/deny`)
7. **샌드박스 도구 정책** (`tools.sandbox.tools` 또는 `agents.list[].tools.sandbox.tools`)
8. **하위 에이전트 도구 정책** (`tools.subagents.tools`, 해당되는 경우)

각 수준에서는 도구를 추가로 제한할 수 있지만 이전 수준에서 거부된 도구를 다시 부여할 수는 없습니다.
만약에 `agents.list[].tools.sandbox.tools` 설정되면 대체됩니다. `tools.sandbox.tools` 그 대리인을 위해서요.
만약에 `agents.list[].tools.profile` 설정되어 있으면 재정의됩니다. `tools.profile` 그 대리인을 위해서요.
공급자 도구 키는 다음 중 하나를 허용합니다. `provider` (예: `google-antigravity`) 또는 `provider/model` (예: `openai/gpt-5.2`).

### 도구 그룹(약칭)

도구 정책(글로벌, 에이전트, 샌드박스) 지원 `group:*` 여러 구체적인 도구로 확장되는 항목:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: 모든 내장 OpenClaw 도구(공급자 플러그인 제외)

### 승격 모드

`tools.elevated` 전역 기준(발신자 기반 허용 목록)입니다. `agents.list[].tools.elevated` 특정 에이전트에 대해 상승된 권한을 추가로 제한할 수 있습니다(둘 다 허용해야 함).

완화 패턴:

- 부인하다 `exec` 신뢰할 수 없는 에이전트의 경우(`agents.list[].tools.deny: ["exec"]`)
- 제한된 에이전트로 라우팅되는 발신자를 허용 목록에 추가하지 마세요.
- 승격된 전역 비활성화(`tools.elevated.enabled: false`) 샌드박스 실행만 원하는 경우
- 에이전트당 승격된 기능을 비활성화합니다(`agents.list[].tools.elevated.enabled: false`) 민감한 프로필의 경우

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

**이후(다른 프로필을 가진 다중 에이전트):**

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

유산 `agent.*` 구성은 다음에 의해 마이그레이션됩니다. `openclaw doctor`; 선호하다 `agents.defaults` + `agents.list` 앞으로.

---

## 도구 제한의 예

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

### 통신전용 Agent

```json
{
  "tools": {
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## 일반적인 함정: "메인이 아닌"

`agents.defaults.sandbox.mode: "non-main"` 기반으로 `session.mainKey` (기본 `"main"`),
상담원 아이디가 아닙니다. 그룹/채널 세션은 항상 자체 키를 갖습니다.
메인이 아닌 것으로 간주되어 샌드박스 처리됩니다. 상담원이 절대 하지 않기를 원하는 경우
샌드박스, 설정 `agents.list[].sandbox.mode: "off"`.

---

## 테스트

다중 에이전트 샌드박스 및 도구를 구성한 후:

1. **에이전트 해결 방법을 확인하세요.**

   ```exec
   openclaw agents list --bindings
   ```

2. **샌드박스 컨테이너를 확인합니다.**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **테스트 도구 제한 사항:**
   - 제한된 도구가 필요한 메시지 보내기
   - 에이전트가 거부된 도구를 사용할 수 없는지 확인

4. **로그 모니터링:**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## 문제 해결

### 그럼에도 불구하고 에이전트가 샌드박스 처리되지 않음 `mode: "all"`

- 전역이 있는지 확인하십시오. `agents.defaults.sandbox.mode` 그게 우선이야
- 에이전트별 구성이 우선하므로 설정하세요. `agents.list[].sandbox.mode: "all"`

### 거부 목록에도 불구하고 도구를 계속 사용할 수 있습니다.

- 도구 필터링 순서 확인: 글로벌 → 에이전트 → 샌드박스 → 하위 에이전트
- 각 레벨은 추가 제한만 가능하며 다시 부여할 수는 없습니다.
- 로그로 확인합니다. `[tools] filtering tools for agent:${agentId}`

### 에이전트별로 컨테이너가 격리되지 않음

- 세트 `scope: "agent"` 에이전트별 샌드박스 구성에서
- 기본값은 `"session"` 세션당 하나의 컨테이너를 생성합니다.

---

## 참조

- [다중 에이전트 라우팅](/concepts/multi-agent)
- [샌드박스 구성](/gateway/configuration#agentsdefaults-sandbox)
- [세션 관리](/concepts/session)
