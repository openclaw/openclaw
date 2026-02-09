---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — 게이트웨이 실행, 조회, 검색"
read_when:
  - CLI 에서 Gateway 를 실행할 때 (개발 또는 서버)
  - Gateway 인증, 바인드 모드, 연결성을 디버깅할 때
  - Bonjour 를 통해 게이트웨이를 검색할 때 (LAN + tailnet)
title: "gateway"
---

# Gateway CLI

Gateway(게이트웨이)는 OpenClaw 의 WebSocket 서버입니다 (채널, 노드, 세션, 훅).

이 페이지의 하위 명령은 `openclaw gateway …` 아래에 있습니다.

관련 문서:

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/discovery](/gateway/discovery)
- [/gateway/configuration](/gateway/configuration)

## Gateway 실행

로컬 Gateway 프로세스를 실행합니다:

```bash
openclaw gateway
```

포그라운드 별칭:

```bash
openclaw gateway run
```

참고 사항:

- 기본적으로 Gateway 는 `~/.openclaw/openclaw.json` 에서 `gateway.mode=local` 이 설정되어 있지 않으면 시작을 거부합니다. 임시/개발 실행에는 `--allow-unconfigured` 을 사용하십시오.
- 인증 없이 loopback 을 넘어 바인딩하는 것은 차단됩니다 (안전 가드레일).
- `SIGUSR1` 는 인증된 경우 프로세스 내부 재시작을 트리거합니다 (`commands.restart` 을 활성화하거나 gateway 도구/설정 apply/update 를 사용하십시오).
- `SIGINT`/`SIGTERM` 핸들러는 gateway 프로세스를 중지하지만, 커스텀 터미널 상태를 복원하지는 않습니다. TUI 또는 raw-mode 입력으로 CLI 를 감싸는 경우, 종료 전에 터미널을 복원하십시오.

### 옵션

- `--port <port>`: WebSocket 포트 (기본값은 설정/환경 변수에서 가져오며, 보통 `18789`).
- `--bind <loopback|lan|tailnet|auto|custom>`: 리스너 바인드 모드.
- `--auth <token|password>`: 인증 모드 오버라이드.
- `--token <token>`: 토큰 오버라이드 (프로세스에 대해 `OPENCLAW_GATEWAY_TOKEN` 도 설정).
- `--password <password>`: 비밀번호 오버라이드 (프로세스에 대해 `OPENCLAW_GATEWAY_PASSWORD` 도 설정).
- `--tailscale <off|serve|funnel>`: Tailscale 를 통해 Gateway 를 노출합니다.
- `--tailscale-reset-on-exit`: 종료 시 Tailscale serve/funnel 설정을 리셋합니다.
- `--allow-unconfigured`: 설정에 `gateway.mode=local` 없이도 gateway 시작을 허용합니다.
- `--dev`: 누락된 경우 개발용 설정 + 워크스페이스를 생성합니다 (BOOTSTRAP.md 건너뜀).
- `--reset`: 개발용 설정 + 자격 증명 + 세션 + 워크스페이스를 리셋합니다 (`--dev` 필요).
- `--force`: 시작 전에 선택된 포트의 기존 리스너를 종료합니다.
- `--verbose`: 상세 로그.
- `--claude-cli-logs`: 콘솔에 claude-cli 로그만 표시합니다 (stdout/stderr 활성화).
- `--ws-log <auto|full|compact>`: websocket 로그 스타일 (기본값 `auto`).
- `--compact`: `--ws-log compact` 의 별칭.
- `--raw-stream`: 원시 모델 스트림 이벤트를 jsonl 로 기록합니다.
- `--raw-stream-path <path>`: 원시 스트림 jsonl 경로.

## 실행 중인 Gateway 조회

모든 조회 명령은 WebSocket RPC 를 사용합니다.

출력 모드:

- 기본값: 사람이 읽기 쉬운 형식 (TTY 에서 색상 적용).
- `--json`: 기계 판독용 JSON (스타일/스피너 없음).
- `--no-color` (또는 `NO_COLOR=1`): 사람용 레이아웃을 유지하면서 ANSI 를 비활성화합니다.

공통 옵션 (지원되는 경우):

- `--url <url>`: Gateway WebSocket URL.
- `--token <token>`: Gateway 토큰.
- `--password <password>`: Gateway 비밀번호.
- `--timeout <ms>`: 타임아웃/버짓 (명령별로 상이).
- `--expect-final`: '최종' 응답을 대기합니다 (에이전트 호출).

참고: `--url` 을 설정하면, CLI 는 설정이나 환경 변수의 자격 증명으로 폴백하지 않습니다.
`--token` 또는 `--password` 를 명시적으로 전달하십시오. 명시적 자격 증명이 없으면 오류입니다.

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

- `--url <url>`: 프로브 URL 오버라이드.
- `--token <token>`: 프로브용 토큰 인증.
- `--password <password>`: 프로브용 비밀번호 인증.
- `--timeout <ms>`: 프로브 타임아웃 (기본값 `10000`).
- `--no-probe`: RPC 프로브를 건너뜁니다 (서비스만 표시).
- `--deep`: 시스템 레벨 서비스도 스캔합니다.

### `gateway probe`

`gateway probe` 는 '모든 것을 디버그'하는 명령입니다. 항상 다음을 프로브합니다:

- 설정된 원격 gateway (설정된 경우), 그리고
- localhost (loopback) — **원격이 설정되어 있어도**.

여러 gateway 가 도달 가능하면 모두 출력합니다. 격리된 프로파일/포트 (예: 구조용 봇) 를 사용하는 경우 여러 gateway 를 지원하지만, 대부분의 설치에서는 여전히 단일 gateway 를 실행합니다.

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### SSH 를 통한 원격 (Mac 앱과 동일)

macOS 앱의 'Remote over SSH' 모드는 로컬 포트 포워딩을 사용하여, loopback 에만 바인딩된 원격 gateway 도 `ws://127.0.0.1:<port>` 에서 접근 가능하게 합니다.

CLI 동등 기능:

```bash
openclaw gateway probe --ssh user@gateway-host
```

옵션:

- `--ssh <target>`: `user@host` 또는 `user@host:port` (포트 기본값은 `22`).
- `--ssh-identity <path>`: 아이덴티티 파일.
- `--ssh-auto`: 발견된 첫 번째 gateway 호스트를 SSH 대상으로 선택합니다 (LAN/WAB 전용).

설정 (선택 사항, 기본값으로 사용):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

저수준 RPC 헬퍼입니다.

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

참고 사항:

- `gateway install` 는 `--port`, `--runtime`, `--token`, `--force`, `--json` 을 지원합니다.
- 라이프사이클 명령은 스크립팅을 위해 `--json` 을 허용합니다.

## 게이트웨이 검색 (Bonjour)

`gateway discover` 는 Gateway 비콘 (`_openclaw-gw._tcp`) 을 스캔합니다.

- 멀티캐스트 DNS-SD: `local.`
- 유니캐스트 DNS-SD (Wide-Area Bonjour): 도메인을 선택하고 (예: `openclaw.internal.`) 분할 DNS + DNS 서버를 설정하십시오; [/gateway/bonjour](/gateway/bonjour) 를 참고하십시오.

Bonjour 디스커버리가 활성화된 gateway (기본값) 만 비콘을 광고합니다.

Wide-Area 디스커버리 레코드에는 다음 (TXT) 이 포함됩니다:

- `role` (gateway 역할 힌트)
- `transport` (전송 힌트, 예: `gateway`)
- `gatewayPort` (WebSocket 포트, 보통 `18789`)
- `sshPort` (SSH 포트; 없을 경우 기본값 `22`)
- `tailnetDns` (가능한 경우 MagicDNS 호스트명)
- `gatewayTls` / `gatewayTlsSha256` (TLS 활성화 + 인증서 지문)
- `cliPath` (원격 설치를 위한 선택적 힌트)

### `gateway discover`

```bash
openclaw gateway discover
```

옵션:

- `--timeout <ms>`: 명령별 타임아웃 (browse/resolve); 기본값 `2000`.
- `--json`: 기계 판독용 출력 (스타일/스피너도 비활성화).

예시:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
