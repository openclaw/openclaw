---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — Run, query, and discover 게이트웨이"
read_when:
  - CLI 에서 게이트웨이 실행하기 (개발자용 또는 서버용)
  - 게이트웨이 인증, 바인드 모드 및 연결 디버깅
  - Bonjour 로 게이트웨이 검색(LAN + tailnet)
title: "게이트웨이"
---

# Gateway CLI

게이트웨이는 OpenClaw의 WebSocket 서버입니다 (채널, 노드, 세션, 후크).

이 페이지의 하위 명령어는 `openclaw gateway …` 에 속합니다.

관련 문서:

- [/gateway/bonjour](/ko-KR/gateway/bonjour)
- [/gateway/discovery](/ko-KR/gateway/discovery)
- [/gateway/configuration](/ko-KR/gateway/configuration)

## Run the Gateway

로컬 게이트웨이 프로세스를 실행합니다:

```bash
openclaw gateway
```

포어그라운드 별칭:

```bash
openclaw gateway run
```

주의사항:

- 기본적으로 게이트웨이는 `~/.openclaw/openclaw.json` 에 `gateway.mode=local` 을 설정하지 않으면 시작이 거부됩니다. 임시/개발 실행의 경우 `--allow-unconfigured` 를 사용하세요.
- 인증 없이 루프백을 넘어 바인딩하는 것은 차단됩니다 (안전 보호).
- `SIGUSR1` 는 권한이 부여된 경우 인프로세스 재시작을 트리거합니다 (`commands.restart`는 기본적으로 활성화됩니다; 수동 재시작을 차단하려면 `commands.restart: false`로 설정하세요. 게이트웨이 도구/설정 적용/업데이트는 계속 허용됩니다).
- `SIGINT`/`SIGTERM` 핸들러는 게이트웨이 프로세스를 중지하지만 사용자 정의 터미널 상태를 복원하지는 않습니다. CLI를 TUI 또는 원시 모드 입력으로 감싸는 경우 종료 전에 터미널을 복원하세요.

### Options

- `--port <port>`: WebSocket 포트 (기본값은 설정/환경 변수에서 오며, 보통 `18789` 입니다).
- `--bind <loopback|lan|tailnet|auto|custom>`: 리스너 바인드 모드.
- `--auth <token|password>`: 인증 모드 재정의.
- `--token <token>`: 토큰 재정의 (또한 프로세스에 `OPENCLAW_GATEWAY_TOKEN` 을 설정).
- `--password <password>`: 비밀번호 재정의 (또한 프로세스에 `OPENCLAW_GATEWAY_PASSWORD` 를 설정).
- `--tailscale <off|serve|funnel>`: Tailscale을 통해 게이트웨이 노출.
- `--tailscale-reset-on-exit`: 종료 시 Tailscale serve/funnel 설정을 재설정.
- `--allow-unconfigured`: 구성에 `gateway.mode=local`을 설정하지 않고 게이트웨이를 시작하도록 허용.
- `--dev`: 개발 설정 + 작업 공간을 생성합니다 (없을 경우 BOOTSTRAP.md를 건너뜁니다).
- `--reset`: 개발 설정 + 자격 증명 + 세션 + 작업 공간을 재설정합니다 (`--dev` 필요).
- `--force`: 시작 전에 선택한 포트의 기존 리스너를 종료.
- `--verbose`: 자세한 로그.
- `--claude-cli-logs`: 콘솔에 claude-cli 로그만 표시 (stdout/stderr 활성화).
- `--ws-log <auto|full|compact>`: 웹소켓 로그 스타일 (기본은 `auto`).
- `--compact`: `--ws-log compact`의 별칭.
- `--raw-stream`: 원시 모델 스트림 이벤트를 jsonl로 기록.
- `--raw-stream-path <path>`: 원시 스트림 jsonl 경로.

## Query a running Gateway

모든 쿼리 명령어는 WebSocket RPC를 사용합니다.

출력 모드:

- 기본값: 사람이 읽을 수 있는 형식 (TTY에서 색상 있음).
- `--json`: 기계가 읽을 수 있는 JSON (스타일링/로딩 스피너 없음).
- `--no-color` (또는 `NO_COLOR=1`): 사람 읽기 형식을 유지하면서 ANSI 비활성화.

공유 옵션 (지원되는 경우):

- `--url <url>`: 게이트웨이 WebSocket URL.
- `--token <token>`: 게이트웨이 토큰.
- `--password <password>`: 게이트웨이 비밀번호.
- `--timeout <ms>`: 대기 시간/예산 (명령어마다 다름).
- `--expect-final`: “최종” 응답을 기다립니다 (에이전트 호출).

참고: `--url`을 설정할 때, CLI는 구성 또는 환경 자격 증명을 대체하지 않습니다. 명시적으로 `--token` 또는 `--password`를 전달하세요. 명시적 자격 증명이 누락되면 오류가 발생합니다.

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status`는 게이트웨이 서비스 (launchd/systemd/schtasks)와 선택적 RPC 프로브를 보여줍니다.

```bash
openclaw gateway status
openclaw gateway status --json
```

옵션:

- `--url <url>`: 프로브 URL을 재정의.
- `--token <token>`: 프로브에 대한 토큰 인증.
- `--password <password>`: 프로브에 대한 비밀번호 인증.
- `--timeout <ms>`: 프로브 타임아웃 (기본 `10000`).
- `--no-probe`: RPC 프로브를 건너뜀 (서비스 전용 보기).
- `--deep`: 시스템 수준의 서비스도 스캔.

### `gateway probe`

`gateway probe`는 “모든 것을 디버그” 명령어입니다. 항상 다음을 프로브합니다:

- 설정된 원격 게이트웨이 (설정된 경우), 및
- 로컬호스트 (루프백) **원격이 설정된 경우에도**.

여러 게이트웨이가 도달 가능한 경우 모두 출력합니다. 고립된 프로파일/포트를 사용할 때 여러 게이트웨이를 지원하지만 (예: 구조 봇), 대부분의 설치는 여전히 단일 게이트웨이를 실행합니다.

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### 원격 SSH (Mac 앱 동등성)

macOS 앱 “원격 SSH” 모드는 로컬 포트 포워드를 사용하여 원격 게이트웨이 (루프백에만 바인딩될 수 있음)가 `ws://127.0.0.1:<포트>`에서 도달 가능해지도록 합니다.

CLI 동등명령어:

```bash
openclaw gateway probe --ssh user@gateway-host
```

옵션:

- `--ssh <target>`: `user@host` 또는 `user@host:port` (포트 기본값은 `22`).
- `--ssh-identity <path>`: 식별 파일.
- `--ssh-auto`: 발견된 첫 번째 게이트웨이 호스트를 SSH 대상 (LAN/WAB 전용)으로 선택.

설정 (선택사항, 기본값으로 사용됨):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

Low-level RPC 도구.

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Manage the Gateway service

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

주의사항:

- `gateway install`은 `--port`, `--runtime`, `--token`, `--force`, `--json`을 지원합니다.
- 라이프사이클 명령어는 스크립팅을 위해 `--json`을 허용합니다.

## Discover gateways (Bonjour)

`gateway discover`는 게이트웨이 비콘 (`_openclaw-gw._tcp`)을 검색합니다.

- 멀티캐스트 DNS-SD: `local.`
- 유니캐스트 DNS-SD (광역 Bonjour): 도메인을 선택 (예: `openclaw.internal.`) 하고 분할 DNS + DNS 서버를 설정합니다. 자세한 사항은 [/gateway/bonjour](/ko-KR/gateway/bonjour)를 참조하세요.

Bonjour 검색을 활성화한 게이트웨이만 (기본값) 비콘을 광고합니다.

광역 검색 기록에는 다음이 포함됩니다 (TXT):

- `role` (게이트웨이 역할 힌트)
- `transport` (전송 힌트, 예: `게이트웨이`)
- `gatewayPort` (WebSocket 포트, 보통 `18789`)
- `sshPort` (SSH 포트; 기본 설정은 없으면 `22`)
- `tailnetDns` (사용 가능 시 MagicDNS 호스트명)
- `gatewayTls` / `gatewayTlsSha256` (TLS 활성화 + 인증서 지문)
- `cliPath` (원격 설치를 위한 선택적 힌트)

### `gateway discover`

```bash
openclaw gateway discover
```

옵션:

- `--timeout <ms>`: 명령어 별 타임아웃 (브라우징/해결); 기본 `2000`.
- `--json`: 기계가 읽을 수 있는 출력 (스타일링/로딩 스피너 비활성화).

예시:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
