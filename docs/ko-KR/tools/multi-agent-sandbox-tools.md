---
summary: "에이전트별 샌드박스 + 도구 제한, 우선순위 및 예제"
title: 다중 에이전트 샌드박스 & 도구
read_when: "다중 에이전트 게이트웨이에서 에이전트별 샌드박스 격리 또는 에이전트별 도구 허용/거부 정책이 필요할 때."
status: active
---

# 다중 에이전트 샌드박스 & 도구 설정

## 개요

다중 에이전트 설정에서 각 에이전트는 다음과 같은 자신의 구성을 가질 수 있습니다:

- **샌드박스 설정** (`agents.list[].sandbox`는 `agents.defaults.sandbox`를 덮어씁니다)
- **도구 제한** (`tools.allow` / `tools.deny`, 추가로 `agents.list[].tools`)

이를 통해 서로 다른 보안 프로파일을 가진 여러 에이전트를 실행할 수 있습니다:

- 전체 접근 권한이 있는 개인 비서
- 제한된 도구를 가진 가족/업무용 에이전트
- 샌드박스에서 실행되는 공개용 에이전트

`setupCommand`는 `sandbox.docker`(글로벌 또는 에이전트별) 하위에 속하며, 컨테이너 생성 시 한 번 실행됩니다.

인증은 에이전트별이며, 각 에이전트는 자신의 `agentDir` 인증 저장소에서 읽어옵니다:

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

자격 증명은 에이전트 간에 공유되지 않습니다. 절대로 `agentDir`를 여러 에이전트에 걸쳐 재사용하지 마세요.
자격 증명을 공유하려면 `auth-profiles.json`을 다른 에이전트의 `agentDir`에 복사하십시오.

런타임에서 샌드박스 격리가 어떻게 동작하는지에 대해서는 [샌드박스 격리](/ko-KR/gateway/sandboxing)를 참조하세요.
"왜 차단되었는지"에 대해 디버그하려면 [샌드박스 vs 도구 정책 vs 고급](/ko-KR/gateway/sandbox-vs-tool-policy-vs-elevated) 및 `openclaw sandbox explain`을 참조하세요.

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

- `main` 에이전트: 호스트에서 실행, 전체 도구 접근
- `family` 에이전트: Docker에서 실행 (에이전트당 하나의 컨테이너), `read` 도구만 사용

---

### 예시 2: 공유 샌드박스를 사용하는 업무용 에이전트

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

### 예시 2b: 글로벌 코딩 프로파일 + 메시징 전용 에이전트

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

- 기본 에이전트는 코딩 도구를 얻습니다
- `support` 에이전트는 메시징 전용 (+ Slack 도구)

---

### 예시 3: 에이전트별 서로 다른 샌드박스 모드

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main", // 글로벌 기본값
        "scope": "session"
      }
    },
    "list": [
      {
        "id": "main",
        "workspace": "~/.openclaw/workspace",
        "sandbox": {
          "mode": "off" // 오버라이드: main은 절대 샌드박스 격리 안 함
        }
      },
      {
        "id": "public",
        "workspace": "~/.openclaw/workspace-public",
        "sandbox": {
          "mode": "all", // 오버라이드: public은 항상 샌드박스 격리
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

글로벌 (`agents.defaults.*`) 및 에이전트별 (`agents.list[].*`) 구성이 모두 존재하는 경우:

### 샌드박스 설정

에이전트별 설정이 글로벌 설정을 덮어씁니다:

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**주의사항:**

- `agents.list[].sandbox.{docker,browser,prune}.*`는 해당 에이전트의 `agents.defaults.sandbox.{docker,browser,prune}.*`를 덮어씁니다 (샌드박스 범위가 `"shared"`로 해석되면 무시됩니다).

### 도구 제한

필터링 순서는 다음과 같습니다:

1. **도구 프로파일** (`tools.profile` 또는 `agents.list[].tools.profile`)
2. **프로바이더 도구 프로파일** (`tools.byProvider[provider].profile` 또는 `agents.list[].tools.byProvider[provider].profile`)
3. **글로벌 도구 정책** (`tools.allow` / `tools.deny`)
4. **프로바이더 도구 정책** (`tools.byProvider[provider].allow/deny`)
5. **에이전트별 도구 정책** (`agents.list[].tools.allow/deny`)
6. **에이전트 프로바이더 정책** (`agents.list[].tools.byProvider[provider].allow/deny`)
7. **샌드박스 도구 정책** (`tools.sandbox.tools` 또는 `agents.list[].tools.sandbox.tools`)
8. **하위 에이전트 도구 정책** (`tools.subagents.tools`, 해당하는 경우)

각 레벨은 도구를 추가로 제한할 수 있지만 이전 레벨에서 거부된 도구를 다시 허용할 수 없습니다.
`agents.list[].tools.sandbox.tools`가 설정되면 해당 에이전트의 `tools.sandbox.tools`를 대체합니다.
`agents.list[].tools.profile`이 설정되면 해당 에이전트의 `tools.profile`를 덮어씁니다.
프로바이더 도구 키는 `provider` (예: `google-antigravity`) 또는 `provider/model` (예: `openai/gpt-5.2`)를 허용합니다.

### 도구 그룹 (단축어)

도구 정책 (글로벌, 에이전트, 샌드박스)은 여러 구체적인 도구로 확장되는 `group:*` 항목을 지원합니다:

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: 모든 내장 OpenClaw 도구 (프로바이더 플러그인 제외)

### 고급 모드

`tools.elevated`는 글로벌 기준선 (송신자 기반 허용 목록)입니다. `agents.list[].tools.elevated`는 특정 에이전트에 대해 고급을 추가로 제한할 수 있습니다 (둘 다 허용해야 합니다).

완화 패턴:

- 신뢰할 수 없는 에이전트에 대해 `exec`를 거부합니다 (`agents.list[].tools.deny: ["exec"]`)
- 제한된 에이전트로 라우팅되는 송신자를 허용 목록에 추가하지 않습니다
- 전역에서 고급을 비활성화합니다 (`tools.elevated.enabled: false`)  샌드박스 실행만 원하는 경우
- 에이전트별로 고급을 비활성화합니다 (`agents.list[].tools.elevated.enabled: false`) 민감한 프로필의 경우

---

## 단일 에이전트에서 마이그레이션

**이전 (단일 에이전트):**

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

**이후 (다중 에이전트 및 다른 프로파일):**

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

기존의 `agent.*` 설정은 `openclaw doctor`에 의해 마이그레이션되며; 앞으로는 `agents.defaults` + `agents.list`를 선호합니다.

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

### 안전한 실행 에이전트 (파일 수정 불가)

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
    "sessions": { "visibility": "tree" },
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## 일반적인 실수: "non-main"

`agents.defaults.sandbox.mode: "non-main"`은 `session.mainKey` (기본값 `"main"`)에 기반하며,
에이전트 ID가 아닙니다. 그룹/채널 세션은 항상 자신만의 키를 가지므로
비주요로 간주되어 샌드박스 격리됩니다. 에이전트를 절대
샌드박스 격리하지 않으려면 `agents.list[].sandbox.mode: "off"`로 설정하세요.

---

## 테스트

다중 에이전트 샌드박스와 도구를 설정한 후:

1. **에이전트 해상도 확인:**

   ```exec
   openclaw agents list --bindings
   ```

2. **샌드박스 컨테이너 확인:**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **도구 제한 테스트:**
   - 제한된 도구가 필요한 메시지를 보냅니다
   - 에이전트가 거부된 도구를 사용할 수 없는지 확인합니다

4. **로그 모니터링:**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## 문제 해결

### `mode: "all"`임에도 불구하고 에이전트가 샌드박스 격리되지 않음

- 이를 덮어쓰는 글로벌 `agents.defaults.sandbox.mode`가 있는지 확인하세요
- 에이전트별 설정이 우선하므로 `agents.list[].sandbox.mode: "all"`로 설정하세요

### 거부 목록에도 여전히 사용 가능한 도구

- 도구 필터링 순서 확인: 글로벌 → 에이전트 → 샌드박스 → 하위 에이전트
- 각 레벨은 추가로 제한만 할 수 있고, 다시 허용할 수 없습니다
- 로그로 확인하세요: `[tools] filtering tools for agent:${agentId}`

### 에이전트당 컨테이너가 분리되지 않음

- 에이전트별 샌드박스 설정에서 `scope: "agent"`로 설정하세요
- 기본값은 `"session"`이며 세션별로 하나의 컨테이너를 생성합니다

---

## 추가 자료

- [다중 에이전트 라우팅](/ko-KR/concepts/multi-agent)
- [샌드박스 설정](/ko-KR/gateway/configuration#agentsdefaults-sandbox)
- [세션 관리](/ko-KR/concepts/session)