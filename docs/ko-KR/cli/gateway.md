---
summary: "OpenClaw Gateway CLI (`openclaw gateway`) — run, query, and discover gateways"
read_when:
  - Running the Gateway from the CLI (dev or servers)
  - Debugging Gateway auth, bind modes, and connectivity
  - Discovering gateways via Bonjour (LAN + tailnet)
title: "gateway"
x-i18n:
  source_hash: cbc1690e6be84073512f38551b84484c25caf13034668524360d6426fb3b0c74
---

# 게이트웨이 CLI

게이트웨이는 OpenClaw의 WebSocket 서버(채널, 노드, 세션, 후크)입니다.

이 페이지의 하위 명령은 `openclaw gateway …` 아래에 있습니다.

관련 문서:

- [/gateway/bonjour](/gateway/bonjour)
- [/gateway/발견](/gateway/discovery)
- [/gateway/구성](/gateway/configuration)

## 게이트웨이 실행

로컬 게이트웨이 프로세스를 실행합니다.

```bash
openclaw gateway
```

전경 별칭:

```bash
openclaw gateway run
```

참고:

- 기본적으로 `~/.openclaw/openclaw.json`에 `gateway.mode=local`가 설정되어 있지 않으면 게이트웨이는 시작을 거부합니다. 임시/개발 실행에는 `--allow-unconfigured`를 사용하세요.
- 인증 없이 루프백을 넘어서는 바인딩이 차단됩니다(안전 가드레일).
- `SIGUSR1`는 승인되면 프로세스 내 재시작을 트리거합니다(`commands.restart` 활성화 또는 게이트웨이 도구/구성 적용/업데이트 사용).
- `SIGINT`/`SIGTERM` 핸들러는 게이트웨이 프로세스를 중지하지만 사용자 정의 터미널 상태를 복원하지는 않습니다. TUI 또는 원시 모드 입력으로 CLI를 래핑하는 경우 종료하기 전에 터미널을 복원하십시오.

### 옵션

- `--port <port>`: WebSocket 포트(기본값은 config/env에서 제공되며 일반적으로 `18789`).
- `--bind <loopback|lan|tailnet|auto|custom>`: 리스너 바인드 모드.
- `--auth <token|password>`: 인증 모드 재정의.
- `--token <token>`: 토큰 재정의(프로세스에 대해 `OPENCLAW_GATEWAY_TOKEN`도 설정함)
- `--password <password>`: 비밀번호 재정의(프로세스에 대해 `OPENCLAW_GATEWAY_PASSWORD`도 설정함)
- `--tailscale <off|serve|funnel>`: Tailscale을 통해 게이트웨이를 노출합니다.
- `--tailscale-reset-on-exit`: 종료 시 Tailscale 서브/퍼널 구성을 재설정합니다.
- `--allow-unconfigured`: 구성에서 `gateway.mode=local` 없이 게이트웨이 시작을 허용합니다.
- `--dev`: 누락된 경우 개발 구성 + 작업공간을 생성합니다(BOOTSTRAP.md 건너뛰기).
- `--reset`: 개발 구성 + 자격 증명 + 세션 + 작업 공간을 재설정합니다(`--dev` 필요).
- `--force`: 시작하기 전에 선택한 포트의 기존 리스너를 모두 종료합니다.
- `--verbose`: 자세한 로그입니다.
- `--claude-cli-logs`: 콘솔에 claude-cli 로그만 표시합니다(그리고 stdout/stderr도 활성화합니다).
- `--ws-log <auto|full|compact>`: 웹소켓 로그 스타일(기본값 `auto`).
- `--compact`: `--ws-log compact`의 별칭입니다.
- `--raw-stream`: 원시 모델 스트림 이벤트를 jsonl에 기록합니다.
- `--raw-stream-path <path>`: 원시 스트림 jsonl 경로.

## 실행 중인 게이트웨이 쿼리

모든 쿼리 명령은 WebSocket RPC를 사용합니다.

출력 모드:

- 기본값: 사람이 읽을 수 있음(TTY로 표시됨)
- `--json`: 기계 판독 가능한 JSON(스타일링/스피너 없음).
- `--no-color` (또는 `NO_COLOR=1`): 휴먼 레이아웃을 유지하면서 ANSI를 비활성화합니다.

공유 옵션(지원되는 경우):

- `--url <url>`: 게이트웨이 WebSocket URL.
- `--token <token>`: 게이트웨이 토큰입니다.
- `--password <password>` : 게이트웨이 비밀번호입니다.
- `--timeout <ms>`: 시간 초과/예산(명령에 따라 다름).
- `--expect-final`: "최종" 응답(에이전트 호출)을 기다립니다.

참고: `--url`을 설정하면 CLI는 구성 또는 환경 자격 증명으로 대체되지 않습니다.
`--token` 또는 `--password`를 명시적으로 전달합니다. 명시적 자격 증명이 누락되면 오류가 발생합니다.

### `gateway health`

```bash
openclaw gateway health --url ws://127.0.0.1:18789
```

### `gateway status`

`gateway status`는 게이트웨이 서비스(launchd/systemd/schtasks)와 선택적 RPC 프로브를 보여줍니다.

```bash
openclaw gateway status
openclaw gateway status --json
```

옵션:

- `--url <url>`: 프로브 URL을 무시합니다.
- `--token <token>`: 프로브에 대한 토큰 인증입니다.
- `--password <password>`: 프로브에 대한 비밀번호 인증입니다.
- `--timeout <ms>`: 프로브 시간 초과(기본값 `10000`).
- `--no-probe`: RPC 프로브를 건너뜁니다(서비스 전용 보기).
- `--deep`: 시스템 수준 서비스도 검색합니다.

### `gateway probe`

`gateway probe`는 "모든 것을 디버그" 명령입니다. 항상 다음 사항을 조사합니다.

- 구성된 원격 게이트웨이(설정된 경우) 및
- localhost(루프백) **원격이 구성된 경우에도**.

여러 게이트웨이에 연결할 수 있으면 모두 인쇄합니다. 격리된 프로필/포트(예: 구조 봇)를 사용하는 경우 다중 게이트웨이가 지원되지만 대부분의 설치는 여전히 단일 게이트웨이를 실행합니다.

```bash
openclaw gateway probe
openclaw gateway probe --json
```

#### SSH를 통한 원격(Mac 앱 패리티)

macOS 앱 "SSH를 통한 원격" 모드는 로컬 포트 전달을 사용하므로 원격 게이트웨이(루프백에만 바인딩될 수 있음)는 `ws://127.0.0.1:<port>`에서 연결할 수 있습니다.

CLI에 해당:

```bash
openclaw gateway probe --ssh user@gateway-host
```

옵션:

- `--ssh <target>`: `user@host` 또는 `user@host:port` (포트 기본값은 `22`).
- `--ssh-identity <path>`: 신원 파일.
- `--ssh-auto`: 첫 번째로 검색된 게이트웨이 호스트를 SSH 대상으로 선택합니다(LAN/WAB에만 해당).

구성(선택 사항, 기본값으로 사용됨):

- `gateway.remote.sshTarget`
- `gateway.remote.sshIdentity`

### `gateway call <method>`

낮은 수준의 RPC 도우미.

```bash
openclaw gateway call status
openclaw gateway call logs.tail --params '{"sinceMs": 60000}'
```

## 게이트웨이 서비스 관리

```bash
openclaw gateway install
openclaw gateway start
openclaw gateway stop
openclaw gateway restart
openclaw gateway uninstall
```

참고:

- `gateway install`는 `--port`, `--runtime`, `--token`, `--force`, `--json`를 지원합니다.
- 라이프사이클 명령은 스크립팅을 위해 `--json`를 허용합니다.

## 게이트웨이 검색(Bonjour)

`gateway discover`는 게이트웨이 비콘(`_openclaw-gw._tcp`)을 검색합니다.

- 멀티캐스트 DNS-SD: `local.`
- 유니캐스트 DNS-SD(Wide-Area Bonjour): 도메인(예: `openclaw.internal.`)을 선택하고 분할 DNS + DNS 서버를 설정합니다. [/gateway/bonjour](/gateway/bonjour) 참조

Bonjour 검색이 활성화된(기본값) 게이트웨이만 비콘을 광고합니다.

광역 검색 기록에는 다음이 포함됩니다(TXT).

- `role` (게이트웨이 역할 힌트)
- `transport` (전송 힌트, 예: `gateway`)
- `gatewayPort` (WebSocket 포트, 일반적으로 `18789`)
- `sshPort` (SSH 포트; 없는 경우 기본값은 `22`)
- `tailnetDns` (MagicDNS 호스트 이름, 사용 가능한 경우)
- `gatewayTls` / `gatewayTlsSha256` (TLS 활성화 + 인증서 지문)
- `cliPath` (원격 설치에 대한 선택적 힌트)

### `gateway discover`

```bash
openclaw gateway discover
```

옵션:

- `--timeout <ms>`: 명령별 시간 초과(탐색/해결); 기본값 `2000`.
- `--json`: 기계 판독 가능 출력(스타일링/스피너도 비활성화됨).

예:

```bash
openclaw gateway discover --timeout 4000
openclaw gateway discover --json | jq '.beacons[].wsUrl'
```
