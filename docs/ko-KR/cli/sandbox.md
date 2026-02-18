---
title: 샌드박스 CLI
summary: "샌드박스 컨테이너를 관리하고 유효 샌드박스 정책을 점검합니다"
read_when: "샌드박스 컨테이너를 관리하거나 샌드박스/도구 정책 행동을 디버깅할 때."
status: active
---

# 샌드박스 CLI

격리된 에이전트 실행을 위한 Docker 기반 샌드박스 컨테이너를 관리합니다.

## 개요

OpenClaw는 보안을 위해 에이전트를 격리된 Docker 컨테이너에서 실행할 수 있습니다. `sandbox` 명령은 특히 업데이트나 설정 변경 후에 이러한 컨테이너를 관리하는 데 도움이 됩니다.

## 명령어

### `openclaw sandbox explain`

유효한 샌드박스 모드/범위/작업공간 접근, 샌드박스 도구 정책 및 권한 상승 게이트(문제 해결 설정 키 경로와 함께)를 점검합니다.

```bash
openclaw sandbox explain
openclaw sandbox explain --session agent:main:main
openclaw sandbox explain --agent work
openclaw sandbox explain --json
```

### `openclaw sandbox list`

모든 샌드박스 컨테이너의 상태 및 설정을 나열합니다.

```bash
openclaw sandbox list
openclaw sandbox list --browser  # 브라우저 컨테이너만 나열
openclaw sandbox list --json     # JSON 출력
```

**출력 내용:**

- 컨테이너 이름과 상태(실행 중/중지됨)
- Docker 이미지 및 설정 일치 여부
- 연령(생성된 이후 경과 시간)
- 유휴 시간(마지막 사용 이후 경과 시간)
- 관련 세션/에이전트

### `openclaw sandbox recreate`

업데이트된 이미지/설정으로 다시 생성하도록 샌드박스 컨테이너를 제거합니다.

```bash
openclaw sandbox recreate --all                # 모든 컨테이너 다시 생성
openclaw sandbox recreate --session main       # 특정 세션
openclaw sandbox recreate --agent mybot        # 특정 에이전트
openclaw sandbox recreate --browser            # 브라우저 컨테이너만
openclaw sandbox recreate --all --force        # 확인 건너뛰기
```

**옵션:**

- `--all`: 모든 샌드박스 컨테이너 다시 생성
- `--session <key>`: 특정 세션의 컨테이너 다시 생성
- `--agent <id>`: 특정 에이전트의 컨테이너 다시 생성
- `--browser`: 브라우저 컨테이너만 다시 생성
- `--force`: 확인 프롬프트 건너뛰기

**중요:** 에이전트가 다음에 사용될 때 컨테이너가 자동으로 다시 생성됩니다.

## 사용 사례

### Docker 이미지 업데이트 후

```bash
# 새 이미지 가져오기
docker pull openclaw-sandbox:latest
docker tag openclaw-sandbox:latest openclaw-sandbox:bookworm-slim

# 새 이미지를 사용하도록 설정 업데이트
# 설정 편집: agents.defaults.sandbox.docker.image (또는 agents.list[].sandbox.docker.image)

# 컨테이너 다시 생성
openclaw sandbox recreate --all
```

### 샌드박스 설정 변경 후

```bash
# 설정 편집: agents.defaults.sandbox.* (또는 agents.list[].sandbox.*)

# 새 설정 적용을 위해 다시 생성
openclaw sandbox recreate --all
```

### setupCommand 변경 후

```bash
openclaw sandbox recreate --all
# 또는 단일 에이전트만:
openclaw sandbox recreate --agent family
```

### 특정 에이전트만

```bash
# 단일 에이전트의 컨테이너만 업데이트
openclaw sandbox recreate --agent alfred
```

## 이것이 필요한 이유는?

**문제:** 샌드박스 Docker 이미지나 설정을 업데이트할 때:

- 기존 컨테이너는 오래된 설정으로 계속 실행됩니다
- 컨테이너는 24시간 비활성 상태 후에만 제거됩니다
- 자주 사용되는 에이전트는 오래된 컨테이너를 무한정 실행 상태로 유지합니다

**해결책:** `openclaw sandbox recreate`를 사용하여 오래된 컨테이너를 강제 제거하십시오. 필요 시 자동으로 현재 설정으로 다시 생성됩니다.

팁: 수동 `docker rm`보다 `openclaw sandbox recreate`를 선호하십시오. 게이트웨이의 컨테이너 네이밍을 사용하고 범위/세션 키가 변경될 때 불일치를 피합니다.

## 구성

샌드박스 설정은 `~/.openclaw/openclaw.json`의 `agents.defaults.sandbox`에서 관리됩니다 (각 에이전트 별 오버라이드는 `agents.list[].sandbox`에 설정합니다):

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
          // ... 더 많은 Docker 옵션
        },
        "prune": {
          "idleHours": 24, // 24시간 유휴 후 자동 삭제
          "maxAgeDays": 7, // 7일 후 자동 삭제
        },
      },
    },
  },
}
```

## 참조

- [샌드박스 문서](/gateway/sandboxing)
- [에이전트 설정](/concepts/agent-workspace)
- [Doctor 명령어](/gateway/doctor) - 샌드박스 설정 점검
