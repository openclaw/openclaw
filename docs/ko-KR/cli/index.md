---
summary: "OpenClaw CLI 참조 (명령, 하위 명령 및 옵션)"
read_when:
  - CLI 명령이나 옵션을 추가하거나 수정할 때
  - 새로운 명령 표면을 문서화할 때
title: "CLI 참조"
---

# CLI 참조

이 페이지는 현재 CLI 동작을 설명합니다. 명령이 변경되면 이 문서를 업데이트합니다.

## 명령 페이지

- [`setup`](/cli/setup)
- [`onboard`](/cli/onboard)
- [`configure`](/cli/configure)
- [`config`](/cli/config)
- [`completion`](/cli/completion)
- [`doctor`](/cli/doctor)
- [`dashboard`](/cli/dashboard)
- [`reset`](/cli/reset)
- [`uninstall`](/cli/uninstall)
- [`update`](/cli/update)
- [`message`](/cli/message)
- [`agent`](/cli/agent)
- [`agents`](/cli/agents)
- [`acp`](/cli/acp)
- [`status`](/cli/status)
- [`health`](/cli/health)
- [`sessions`](/cli/sessions)
- [`gateway`](/cli/gateway)
- [`logs`](/cli/logs)
- [`system`](/cli/system)
- [`models`](/cli/models)
- [`memory`](/cli/memory)
- [`directory`](/cli/directory)
- [`nodes`](/cli/nodes)
- [`devices`](/cli/devices)
- [`node`](/cli/node)
- [`approvals`](/cli/approvals)
- [`sandbox`](/cli/sandbox)
- [`tui`](/cli/tui)
- [`browser`](/cli/browser)
- [`cron`](/cli/cron)
- [`dns`](/cli/dns)
- [`docs`](/cli/docs)
- [`hooks`](/cli/hooks)
- [`webhooks`](/cli/webhooks)
- [`pairing`](/cli/pairing)
- [`qr`](/cli/qr)
- [`plugins`](/cli/plugins) (플러그인 명령)
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`secrets`](/cli/secrets)
- [`skills`](/cli/skills)
- [`daemon`](/cli/daemon) (Gateway 서비스 명령을 위한 레거시 별칭)
- [`clawbot`](/cli/clawbot) (레거시 별칭 네임스페이스)
- [`voicecall`](/cli/voicecall) (플러그인; 설치된 경우)

## 전역 플래그

- `--dev`: `~/.openclaw-dev` 아래의 상태 격리 및 기본 포트 이동.
- `--profile <name>`: `~/.openclaw-<name>` 아래의 상태 격리.
- `--no-color`: ANSI 색상 비활성화.
- `--update`: `openclaw update` 의 약어 (소스 설치만).
- `-V`, `--version`, `-v`: 버전을 인쇄하고 종료.

## 출력 스타일

- ANSI 색상 및 진행 지표는 TTY 세션에서만 렌더링됩니다.
- OSC-8 하이퍼링크는 지원하는 터미널에서 클릭 가능한 링크로 렌더링됩니다. 그렇지 않으면 일반 URL 로 폴백합니다.
- `--json` (및 지원하는 곳에 `--plain`) 은 깔끔한 출력을 위해 스타일을 비활성화합니다.
- `--no-color` 는 ANSI 스타일을 비활성화합니다. `NO_COLOR=1` 도 지원됩니다.
- 장기 실행 명령은 진행 지표 (지원되는 경우 OSC 9;4) 를 표시합니다.

## 색상 팔레트

OpenClaw 는 CLI 출력을 위해 로브스터 팔레트를 사용합니다.

- `accent` (#FF5A2D): 제목, 레이블, 기본 강조.
- `accentBright` (#FF7A3D): 명령 이름, 강조.
- `accentDim` (#D14A22): 보조 강조 텍스트.
- `info` (#FF8A5B): 정보 값.
- `success` (#2FBF71): 성공 상태.
- `warn` (#FFB020): 경고, 폴백, 주의.
- `error` (#E23D2D): 오류, 실패.
- `muted` (#8B7F77): 약화, 메타데이터.

팔레트 진실의 원천: `src/terminal/palette.ts` (별칭: "lobster seam").

## 명령 트리

```
openclaw [--dev] [--profile <name>] <command>
  setup
  onboard
  configure
  config
    get
    set
    unset
  completion
  doctor
  dashboard
  security
    audit
  secrets
    reload
    migrate
  reset
  uninstall
  update
  channels
    list
    status
    logs
    add
    remove
    login
    logout
  directory
  skills
    list
    info
    check
  plugins
    list
    info
    install
    enable
    disable
    doctor
  memory
    status
    index
    search
  message
  agent
  agents
    list
    add
    delete
  acp
  status
  health
  sessions
  gateway
    call
    health
    status
    probe
    discover
    install
    uninstall
    start
    stop
    restart
    run
  daemon
    status
    install
    uninstall
    start
    stop
    restart
  logs
  system
    event
    heartbeat last|enable|disable
    presence
  models
    list
    status
    set
    set-image
    aliases list|add|remove
    fallbacks list|add|remove|clear
    image-fallbacks list|add|remove|clear
    scan
    auth add|setup-token|paste-token
    auth order get|set|clear
  sandbox
    list
    recreate
    explain
  cron
    status
    list
    add
    edit
    rm
    enable
    disable
    runs
    run
  nodes
  devices
  node
    run
    status
    install
    uninstall
    start
    stop
    restart
  approvals
    get
    set
    allowlist add|remove
  browser
    status
    start
    stop
    reset-profile
    tabs
    open
    focus
    close
    profiles
    create-profile
    delete-profile
    screenshot
    snapshot
    navigate
    resize
    click
    type
    press
    hover
    drag
    select
    upload
    fill
    dialog
    wait
    evaluate
    console
    pdf
  hooks
    list
    info
    check
    enable
    disable
    install
    update
  webhooks
    gmail setup|run
  pairing
    list
    approve
  qr
  clawbot
    qr
  docs
  dns
    setup
  tui
```

참고: 플러그인은 추가 최상위 명령을 추가할 수 있습니다 (예: `openclaw voicecall`).

## 보안

- `openclaw security audit` — 공통 보안 위험에 대한 구성 + 로컬 상태 감사.
- `openclaw security audit --deep` — 최선의 노력 라이브 Gateway 프로브.
- `openclaw security audit --fix` — 안전한 기본값을 강화하고 상태/구성을 chmod 합니다.

## 비밀

- `openclaw secrets reload` — refs 를 다시 해결하고 원자적으로 런타임 스냅샷을 스왑합니다.
- `openclaw secrets audit` — 평문 잔여, 미해결 refs 및 우선 순위 드리프트를 스캔합니다.
- `openclaw secrets configure` — 제공자 설정 + SecretRef 매핑 + preflight/apply 를 위한 대화형 도우미.
- `openclaw secrets apply --from <plan.json>` — 이전에 생성한 계획을 적용합니다 (`--dry-run` 지원).

## 플러그인

확장 프로그램 및 해당 구성을 관리합니다:

- `openclaw plugins list` — 플러그인 검색 (머신 출력을 위해 `--json` 사용).
- `openclaw plugins info <id>` — 플러그인에 대한 세부 정보 표시.
- `openclaw plugins install <path|.tgz|npm-spec>` — 플러그인 설치 (또는 `plugins.load.paths` 에 플러그인 경로 추가).
- `openclaw plugins enable <id>` / `disable <id>` — `plugins.entries.<id>.enabled` 토글.
- `openclaw plugins doctor` — 플러그인 로드 오류 보고.

대부분의 플러그인 변경에는 Gateway 재시작이 필요합니다. [/plugin](/tools/plugin) 을 참조합니다.

## 메모리

`MEMORY.md` + `memory/*.md` 에 대한 벡터 검색:

- `openclaw memory status` — 인덱스 통계 표시.
- `openclaw memory index` — 메모리 파일 다시 인덱싱.
- `openclaw memory search "<query>"` (또는 `--query "<query>"`) — 메모리에 대해 의미 검색.

## 채팅 슬래시 명령

채팅 메시지는 `/...` 명령을 지원합니다 (텍스트 및 기본). [/tools/slash-commands](/tools/slash-commands) 를 참조합니다.

강조 표시:

- `/status` 빠른 진단.
- `/config` 지속된 구성 변경.
- `/debug` 런타임 전용 구성 무시 (메모리, 디스크 아님; `commands.debug: true` 필요).

## 설정 + 온보딩

### `setup`

구성 + 워크스페이스를 초기화합니다.

옵션:

- `--workspace <dir>`: 에이전트 워크스페이스 경로 (기본값 `~/.openclaw/workspace`).
- `--wizard`: 온보딩 마법사 실행.
- `--non-interactive`: 프롬프트 없이 마법사 실행.
- `--mode <local|remote>`: 마법사 모드.
- `--remote-url <url>`: 원격 Gateway URL.
- `--remote-token <token>`: 원격 Gateway 토큰.

마법사는 모든 마법사 플래그가 존재할 때 자동으로 실행됩니다 (`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`).

### `onboard`

Gateway, 워크스페이스 및 Skills 을 설정하는 대화형 마법사입니다.

옵션은 [/cli/index](/cli/index) 참조 (매우 여러 개).

### `configure`

대화형 구성 마법사 (모델, 채널, Skills, Gateway).

### `config`

비대화형 구성 도우미 (get/set/unset). 하위 명령 없이 `openclaw config` 를 실행하면 마법사를 시작합니다.

하위 명령:

- `config get <path>`: 구성 값 인쇄 (dot/bracket 경로).
- `config set <path> <value>`: 값 설정 (JSON5 또는 원시 문자열).
- `config unset <path>`: 값 제거.

### `doctor`

건강 검사 + 빠른 수정 (구성 + Gateway + 레거시 서비스).

옵션:

- `--no-workspace-suggestions`: 워크스페이스 메모리 힌트 비활성화.
- `--yes`: 프롬프트 없이 기본값 수락 (헤드리스).
- `--non-interactive`: 프롬프트 건너뛰기; 안전한 마이그레이션만 적용.
- `--deep`: 시스템 서비스에서 추가 Gateway 설치 스캔.

## 채널 도우미

### `channels`

채팅 채널 계정을 관리합니다 (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (플러그인)/Signal/iMessage/MS Teams).

자세한 내용: [/cli/channels](/cli/channels)

### `skills`

사용 가능한 Skills 및 준비 정보를 나열하고 검사합니다.

하위 명령:

- `skills list`: Skills 나열 (하위 명령이 없을 때 기본값).
- `skills info <name>`: 하나의 Skill 에 대한 세부 정보 표시.
- `skills check`: 준비된 항목 vs 누락된 요구 사항 요약.

옵션:

- `--eligible`: 준비된 Skills 만 표시.
- `--json`: JSON 출력 (스타일 없음).
- `-v`, `--verbose`: 누락된 요구 사항 세부 정보 포함.

팁: `npx clawhub` 을 사용하여 Skills 를 검색, 설치 및 동기화합니다.

### `pairing`

채널 전체에 걸쳐 DM 페어링 요청을 승인합니다.

자세한 내용: [/cli/pairing](/cli/pairing)

### `devices`

Gateway 장치 페어링 항목 및 역할별 장치 토큰을 관리합니다.

자세한 내용: [/cli/devices](/cli/devices)

### `webhooks gmail`

Gmail Pub/Sub 후크 설정 + 실행자. [/automation/gmail-pubsub](/automation/gmail-pubsub) 를 참조합니다.

### `dns setup`

광역 검색 DNS 도우미 (CoreDNS + Tailscale). [/gateway/discovery](/gateway/discovery) 를 참조합니다.

## 메시징 + 에이전트

### `message`

통합 아웃바운드 메시징 + 채널 작업.

자세한 내용: [/cli/message](/cli/message)

### `agent`

Gateway 를 통해 에이전트 차례 실행 (임베드된 경우 `--local` 사용).

자세한 내용: [/cli/agent](/cli/agent)

### `agents`

격리된 에이전트를 관리합니다 (워크스페이스 + 인증 + 라우팅).

자세한 내용: [/cli/agents](/cli/agents)

### `acp`

ACP 브리지를 실행합니다.

자세한 내용: [/cli/acp](/cli/acp)

### `status`

연결된 세션 건강 및 최근 수신자를 표시합니다.

옵션:

- `--json`
- `--all` (완전한 진단; 읽기 전용, 붙여넣기 가능)
- `--deep` (채널 프로브)
- `--usage` (모델 제공자 사용/할당량 표시)
- `--timeout <ms>`
- `--verbose`
- `--debug` (alias for `--verbose`)

### `health`

실행 중인 Gateway 에서 건강을 가져옵니다.

### `sessions`

저장된 대화 세션을 나열합니다.

### `gateway`

WebSocket Gateway 를 실행합니다.

자세한 내용: [/cli/gateway](/cli/gateway)

### `logs`

RPC 를 통해 Gateway 파일 로그를 테일합니다.

자세한 내용: [/cli/gateway](/cli/gateway)

## 모델

자세한 내용: [/concepts/models](/concepts/models)

## 시스템

### `system event`

시스템 이벤트를 큐에 넣고 선택적으로 하트비트를 트리거합니다 (Gateway RPC).

### `system heartbeat last|enable|disable`

하트비트 제어 (Gateway RPC).

### `system presence`

시스템 현재 위치 항목을 나열합니다 (Gateway RPC).

## Cron

예약된 작업을 관리합니다 (Gateway RPC). [/automation/cron-jobs](/automation/cron-jobs) 를 참조합니다.

자세한 내용: [/cli/cron](/cli/cron)

## 노드 호스트

`node` 는 **헤드리스 노드 호스트** 를 실행하거나 백그라운드 서비스로 관리합니다.

자세한 내용: [/cli/node](/cli/node)

## 노드

`nodes` 는 Gateway 와 통신하고 페어링된 노드를 대상으로 합니다.

자세한 내용: [/nodes](/nodes)

## 브라우저

브라우저 제어 CLI (전용 Chrome/Brave/Edge/Chromium).

자세한 내용: [/cli/browser](/cli/browser)

## 문서 검색

### `docs [query...]`

라이브 문서 인덱스를 검색합니다.

## TUI

### `tui`

Gateway 에 연결된 터미널 UI 를 엽니다.

옵션:

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>` (기본값: `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/cli/index.md
workflow: 15
