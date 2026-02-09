---
title: 샌드박스 CLI
summary: "샌드박스 컨테이너를 관리하고 적용되는 샌드박스 정책을 검사합니다"
read_when: "샌드박스 컨테이너를 관리하거나 샌드박스/도구 정책 동작을 디버깅할 때."
status: active
---

# 샌드박스 CLI

격리된 에이전트 실행을 위해 Docker 기반 샌드박스 컨테이너를 관리합니다.

## 개요

OpenClaw 는 보안을 위해 에이전트를 격리된 Docker 컨테이너에서 실행할 수 있습니다. `sandbox` 명령은 특히 업데이트 또는 구성 변경 이후에 이러한 컨테이너를 관리하는 데 도움이 됩니다.

## 명령

### `openclaw sandbox explain`

**적용되는** 샌드박스 모드/범위/워크스페이스 접근, 샌드박스 도구 정책, 그리고 상승된 게이트(수정용 설정 키 경로 포함)를 검사합니다.

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

상태와 구성을 포함하여 모든 샌드박스 컨테이너를 나열합니다.

```bash
openclaw sandbox list
openclaw sandbox list --browser  # List only browser containers
openclaw sandbox list --json     # JSON output
```

**출력에는 다음이 포함됩니다:**

- 컨테이너 이름과 상태(실행 중/중지됨)
- Docker 이미지 및 설정과의 일치 여부
- 경과 시간 (생성 이후)
- 유휴 시간(마지막 사용 이후 경과 시간)
- 연결된 세션/에이전트

### `openclaw sandbox recreate`

업데이트된 이미지/설정으로 재생성하도록 샌드박스 컨테이너를 제거합니다.

```bash
openclaw sandbox recreate --all                # Recreate all containers
openclaw sandbox recreate --session main       # Specific session
openclaw sandbox recreate --agent mybot        # Specific agent
openclaw sandbox recreate --browser            # Only browser containers
openclaw sandbox recreate --all --force        # Skip confirmation
```

**옵션:**

- `--all`: 모든 샌드박스 컨테이너 재생성
- `--session <key>`: 특정 세션의 컨테이너 재생성
- `--agent <id>`: 특정 에이전트의 컨테이너 재생성
- `--browser`: 브라우저 컨테이너만 재생성
- `--force`: 확인 프롬프트 건너뛰기

**중요:** 컨테이너는 에이전트가 다음에 사용될 때 자동으로 재생성됩니다.

## 사용 사례

### Docker 이미지 업데이트 이후

```bash
# Pull new image
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# Update config to use new image
# Edit config: agents.defaults.sandbox.docker.image (or agents.list[].sandbox.docker.image)

# Recreate containers
openclaw sandbox recreate --all
```

### 샌드박스 구성 변경 이후

```bash
# Edit config: agents.defaults.sandbox.* (or agents.list[].sandbox.*)

# Recreate to apply new config
openclaw sandbox recreate --all
```

### setupCommand 변경 이후

```bash
openclaw sandbox recreate --all
# or just one agent:
openclaw sandbox recreate --agent family
```

### 특정 에이전트만 대상으로 할 때

```bash
# Update only one agent's containers
openclaw sandbox recreate --agent alfred
```

## 왜 이것이 필요한가요?

**문제:** 샌드박스 Docker 이미지 또는 구성을 업데이트하면 다음과 같은 문제가 발생합니다:

- 기존 컨테이너는 이전 설정으로 계속 실행됩니다
- 컨테이너는 24 시간 동안 비활성 상태일 때만 정리됩니다
- 자주 사용되는 에이전트는 이전 컨테이너가 무기한 실행 상태로 유지됩니다

**해결책:** `openclaw sandbox recreate` 를 사용하여 이전 컨테이너를 강제로 제거하십시오. 이후 필요할 때 현재 설정으로 자동 재생성됩니다.

팁: 수동 `docker rm` 보다 `openclaw sandbox recreate` 사용을 권장합니다. 이는
Gateway(게이트웨이)의 컨테이너 명명 규칙을 사용하며, 범위/세션 키가 변경될 때 불일치를 방지합니다.

## 구성

샌드박스 설정은 `~/.openclaw/openclaw.json` 의 `agents.defaults.sandbox` 아래에 위치합니다(에이전트별 재정의는 `agents.list[].sandbox` 에 위치):

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

- [Sandbox Documentation](/gateway/sandboxing)
- [Agent Configuration](/concepts/agent-workspace)
- [Doctor Command](/gateway/doctor) - 샌드박스 설정 확인
