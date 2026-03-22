---
summary: "`openclaw daemon` CLI 레퍼런스 (Gateway 서비스 관리를 위한 레거시 별칭)"
read_when:
  - 스크립트에서 아직 `openclaw daemon ...`을 사용하고 있을 때
  - 서비스 라이프사이클 명령어가 필요할 때 (install/start/stop/restart/status)
title: "daemon"
x-i18n:
  source_path: "docs/cli/daemon.md"
---

# `openclaw daemon`

Gateway 서비스 관리 명령어의 레거시 별칭입니다.

`openclaw daemon ...`은 `openclaw gateway ...` 서비스 명령어와 동일한 서비스 제어 인터페이스에 매핑됩니다.

## 사용법

```bash
openclaw daemon status
openclaw daemon install
openclaw daemon start
openclaw daemon stop
openclaw daemon restart
openclaw daemon uninstall
```

## 하위 명령어

- `status`: 서비스 설치 상태를 표시하고 Gateway 상태를 프로브
- `install`: 서비스 설치 (`launchd`/`systemd`/`schtasks`)
- `uninstall`: 서비스 제거
- `start`: 서비스 시작
- `stop`: 서비스 중지
- `restart`: 서비스 재시작

## 공통 옵션

- `status`: `--url`, `--token`, `--password`, `--timeout`, `--no-probe`, `--require-rpc`, `--deep`, `--json`
- `install`: `--port`, `--runtime <node|bun>`, `--token`, `--force`, `--json`
- 라이프사이클 (`uninstall|start|stop|restart`): `--json`

참고:

- `status`는 가능한 경우 프로브 인증을 위해 설정된 인증 SecretRef를 해석합니다.
- 필요한 인증 SecretRef가 이 명령 경로에서 해석되지 않는 경우, `daemon status --json`은 프로브 연결/인증이 실패할 때 `rpc.authWarning`을 보고합니다. `--token`/`--password`를 명시적으로 전달하거나 시크릿 소스를 먼저 해석하세요.
- 프로브가 성공하면 미해석 인증 참조 경고는 오탐을 방지하기 위해 억제됩니다.
- Linux systemd 설치에서 `status` 토큰 드리프트 검사는 유닛 소스의 `Environment=`와 `EnvironmentFile=`를 모두 포함합니다.
- 토큰 인증에 토큰이 필요하고 `gateway.auth.token`이 SecretRef로 관리되는 경우, `install`은 SecretRef가 해석 가능한지 검증하지만 해석된 토큰을 서비스 환경 메타데이터에 저장하지 않습니다.
- 토큰 인증에 토큰이 필요하고 설정된 토큰 SecretRef가 해석되지 않으면, install은 폴백 평문을 저장하지 않고 닫힙니다.
- `gateway.auth.token`과 `gateway.auth.password`가 모두 설정되어 있고 `gateway.auth.mode`가 설정되지 않은 경우, mode가 명시적으로 설정될 때까지 install이 차단됩니다.

## 권장

현재 문서와 예시는 [`openclaw gateway`](/cli/gateway)를 참조하세요.
