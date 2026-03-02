---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — Gateway 실행, 쿼리 및 검색"
read_when:
  - CLI 에서 Gateway 를 실행할 때 (dev 또는 서버)
  - Gateway 인증, 바인드 모드 및 연결성을 디버깅할 때
  - Bonjour (LAN + tailnet) 를 통해 Gateway 를 검색할 때
title: "gateway"
---

# Gateway CLI

Gateway 는 OpenClaw 의 WebSocket 서버입니다 (채널, 노드, 세션, 후크).

이 페이지의 하위 명령은 `openclaw gateway …` 아래에 있습니다.

관련 문서:

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## Gateway 실행

로컬 Gateway 프로세스 실행:

```bash
openclaw gateway
```

포어그라운드 별칭:

```bash
openclaw gateway run
```

참고:

- 기본적으로 Gateway 는 `~/.openclaw/openclaw.json` 에서 `gateway.mode=local` 이 설정되지 않으면 시작을 거부합니다. 임시/개발 실행을 위해 `--allow-unconfigured` 를 사용합니다.
- 인증 없이 loopback 을 넘어 바인딩하는 것은 차단됩니다 (보안 가드레일).
- `SIGUSR1` 은 인증된 경우 프로세스 내 재시작을 트리거합니다 (`commands.restart` 기본 활성화; `commands.restart: false` 설정하여 수동 재시작 차단, Gateway 도구/구성 적용/업데이트는 여전히 허용).
- `SIGINT`/`SIGTERM` 핸들러는 Gateway 프로세스를 중지하지만 사용자 정의 터미널 상태를 복원하지 않습니다. CLI 를 TUI 또는 raw-mode 입력으로 래핑하면 종료 전에 터미널을 복원합니다.

### 옵션

- `--port <port>`: WebSocket 포트 (기본값은 구성/env 에서; 보통 `18789`).
- `--bind <loopback|lan|tailnet|auto|custom>`: 리스너 바인드 모드.
- `--auth <token|password>`: 인증 모드 무시.
- `--token <token>`: 토큰 무시 (프로세스에 대해 `OPENCLAW_GATEWAY_TOKEN` 도 설정).
- `--password <password>`: 비밀번호 무시 (프로세스에 대해 `OPENCLAW_GATEWAY_PASSWORD` 도 설정).
- `--tailscale <off|serve|funnel>`: Tailscale 을 통해 Gateway 노출.
- `--tailscale-reset-on-exit`: 종료 시 Tailscale serve/funnel 구성 초기화.
- `--allow-unconfigured`: 구성에서 `gateway.mode=local` 없이 Gateway 시작 허용.
- `--dev`: 없으면 개발 구성 + 워크스페이스 생성 (BOOTSTRAP.md 건너뜀).
- `--reset`: 개발 구성 + 자격 증명 + 세션 + 워크스페이스 초기화 (`--dev` 필요).
- `--force`: 시작 전에 선택한 포트의 기존 리스너를 종료합니다.
- `--verbose`: 상세 로그.
- `--claude-cli-logs`: 콘솔에 claude-cli 로그만 표시 (및 stdout/stderr 활성화).
- `--ws-log <auto|full|compact>`: websocket 로그 스타일 (기본값 `auto`).
- `--compact`: alias for `--ws-log compact`.
- `--raw-stream`: 원시 모델 스트림 이벤트를 jsonl 로 기록합니다.
- `--raw-stream-path <path>`: 원시 스트림 jsonl 경로.

## 실행 중인 Gateway 쿼리

모든 쿼리 명령은 WebSocket RPC 를 사용합니다.

출력 모드:

- 기본값: 사람이 읽을 수 있는 형식 (TTY 에서 색상 지정).
- `--json`: 머신이 읽을 수 있는 JSON (스타일/스피너 없음).
- `--no-color` (또는 `NO_COLOR=1`): ANSI 비활성화 (사람 레이아웃 유지).

공유 옵션 (지원하는 경우):

- `--url <url>`: Gateway WebSocket URL.
- `--token <token>`: Gateway 토큰.
- `--password <password>`: Gateway 비밀번호.
- `--timeout <ms>`: 시간 제한/예산 (명령별로 다름).
- `--expect-final`: "최종" 응답을 기다립니다 (에이전트 호출).

참고: `--url` 을 설정하면 CLI 는 구성 또는 환경 자격 증명으로 폴백하지 않습니다.
명시적으로 `--token` 또는 `--password` 를 전달합니다. 명시적 자격 증명이 없으면 오류입니다.

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status` 는 Gateway 서비스 (launchd/systemd/schtasks) 와 선택적 RPC 프로브를 표시합니다.

```bash
openclaw gateway status
openclaw gateway status --json
```

옵션:

- `--url <url>`: 프로브 URL 무시.
- `--token <token>`: 프로브에 대한 토큰 인증.
- `--password <password>`: 프로브에 대한 비밀번호 인증.
- `--timeout <ms>`: 프로브 시간 제한 (기본값 `10000`).
- `--no-probe`: RPC 프로브 건너뛰기 (서비스만 보기).
- `--deep`: 시스템 수준 서비스도 스캔합니다.

### `gateway probe`

`gateway probe` 는 "모든 것을 디버그" 명령입니다. 항상 프로브합니다:

- 구성된 원격 Gateway (설정된 경우), 그리고
- localhost (loopback) **원격이 구성된 경우에도**.

여러 Gateway 에 도달할 수 있으면 모두 인쇄합니다. 격리된 프로필/포트를 사용할 때 여러 Gateway 가 지원됩니다 (예: 복구 봇), 하지만 대부분의 설치는 여전히 단일 Gateway 를 실행합니다.

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### 원격 over SSH (Mac 앱 동등)

macOS 앱 "Remote over SSH" 모드는 로컬 포트 포워드를 사용하므로 원격 Gateway (loopback 에만 바인딩될 수 있음) 는 `ws://127.0.0.1:<port>` 에서 도달 가능해집니다.

CLI 등가:

```bash
openclaw gateway probe --ssh user@gateway-host
```

옵션:

- `--ssh <target>`: `user@host` 또는 `user@host:port` (포트 기본값 `22`).
- `--ssh-identity <path>`: 신원 파일.
- `--ssh-auto`: 첫 번째로 검색된 Gateway 호스트를 SSH 대상으로 선택 (LAN/WAB 전용).

구성 (선택적, 기본값으로 사용):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

저수준 RPC 도우미.

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## Gateway 서비스 관리

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

참고:

- `gateway install` 은 `--port`, `--runtime`, `--token`, `--force`, `--json` 을 지원합니다.
- 라이프사이클 명령은 스크립팅을 위해 `--json` 을 허용합니다.

## Gateway 검색 (Bonjour)

`gateway discover` 는 Gateway beacons (`_openclaw-gw._tcp`) 를 스캔합니다.

- Multicast DNS-SD: `local.`
- Unicast DNS-SD (Wide-Area Bonjour): 도메인을 선택하고 (예: `openclaw.internal.`) 분할 DNS + DNS 서버를 설정합니다. [/gateway/bonjour](/gateway/bonjour) 를 참조합니다.

Bonjour 검색이 활성화된 Gateway 만 (기본값) beacon 을 광고합니다.

광역 검색 레코드에 포함됨 (TXT):

- `role` (Gateway 역할 힌트)
- `transport` (전송 힌트, 예: `gateway`)
- `gatewayPort` (WebSocket 포트, 일반적으로 `18789`)
- `sshPort` (SSH 포트; 없으면 `22` 기본값)
- `tailnetDns` (MagicDNS 호스트명, 사용 가능한 경우)
- `gatewayTls` / `gatewayTlsSha256` (TLS 활성화 + 인증서 지문)
- `cliPath` (원격 설치에 대한 선택적 힌트)

### `gateway discover`

```bash
openclaw gateway discover
```

옵션:

- `--timeout <ms>`: 명령별 시간 제한 (찾아보기/해결); 기본값 `2000`.
- `--json`: 머신이 읽을 수 있는 출력 (스타일/스피너 비활성화).

예시:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/cli/gateway.md
workflow: 15
