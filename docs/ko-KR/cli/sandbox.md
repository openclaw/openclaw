---
title: Sandbox CLI
summary: "Manage sandbox containers and inspect effective sandbox policy"
read_when: "You are managing sandbox containers or debugging sandbox/tool-policy behavior."
status: active
x-i18n:
  source_hash: 6e1186f26c77e188206ce5e198ab624d6b38bc7bb7c06e4d2281b6935c39e347
---

# 샌드박스 CLI

격리된 에이전트 실행을 위해 Docker 기반 샌드박스 컨테이너를 관리합니다.

## 개요

OpenClaw는 보안을 위해 격리된 Docker 컨테이너에서 에이전트를 실행할 수 있습니다. `sandbox` 명령은 특히 업데이트 또는 구성 변경 후에 이러한 컨테이너를 관리하는 데 도움이 됩니다.

## 명령

### `openclaw sandbox explain`

**유효한** 샌드박스 모드/범위/작업 공간 액세스, 샌드박스 도구 정책 및 상승된 게이트(수정 구성 키 경로 포함)를 검사합니다.

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

모든 샌드박스 컨테이너를 상태 및 구성과 함께 나열합니다.

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**출력에는 다음이 포함됩니다.**

- 컨테이너 이름 및 상태(실행 중/중지)
- Docker 이미지 및 구성과 일치하는지 여부
- 연령(생성 이후 시간)
- 유휴 시간(마지막 사용 이후 시간)
- 관련 세션/에이전트

### `openclaw sandbox recreate`

업데이트된 이미지/구성으로 다시 생성하려면 샌드박스 컨테이너를 제거하세요.

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**옵션:**

- `--all`: 모든 샌드박스 컨테이너를 다시 생성합니다.
- `--session <key>`: 특정 세션에 대한 컨테이너 다시 생성
- `--agent <id>`: 특정 에이전트에 대한 컨테이너를 다시 생성합니다.
- `--browser`: 브라우저 컨테이너만 다시 생성
- `--force`: 확인 메시지 건너뛰기

**중요:** 다음에 에이전트를 사용할 때 컨테이너는 자동으로 다시 생성됩니다.

## 사용 사례

### Docker 이미지 업데이트 후

```bash
# Pull new image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
openclaw sandbox recreate --all
```

### 샌드박스 구성 변경 후

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
openclaw sandbox recreate --all
```

### setupCommand를 변경한 후

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### 특정 상담원에게만 해당

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## 이것이 왜 필요한가요?

**문제:** 샌드박스 Docker 이미지 또는 구성을 업데이트하는 경우:

- 기존 컨테이너는 이전 설정으로 계속 실행됩니다.
- 컨테이너는 24시간 동안 활동이 없는 경우에만 정리됩니다.
- 정기적으로 사용되는 에이전트는 오래된 컨테이너를 무기한 실행 상태로 유지합니다.

**해결책:** `openclaw sandbox recreate`를 사용하여 오래된 컨테이너를 강제로 제거하세요. 다음에 필요할 때 현재 설정으로 자동으로 다시 생성됩니다.

팁: 수동 `docker rm`보다 `openclaw sandbox recreate`를 선호하세요. 그것은
게이트웨이의 컨테이너 이름 지정 및 범위/세션 키 변경 시 불일치를 방지합니다.

## 구성

샌드박스 설정은 `agents.defaults.sandbox` 아래 `~/.openclaw/openclaw.json`에 있습니다(에이전트별 재정의는 `agents.list[].sandbox`에 있음).

```jsonc
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "all", // off, non-main, all
        "scope": "agent", // session, agent, shared
        "docker": {
          "image": "openclaw-sandbox:bookworm-slim",
          "containerPrefix": "openclaw-sbx-",
          // ... more Docker options
        },
        "prune": {
          "idleHours": 24, // Auto-prune after 24h idle
          "maxAgeDays": 7, // Auto-prune after 7 days
        },
      },
    },
  },
}
```

## 참고 항목

- [샌드박스 문서](/gateway/sandboxing)
- [에이전트 구성](/concepts/agent-workspace)
- [닥터 명령](/gateway/doctor) - 샌드박스 설정 확인
