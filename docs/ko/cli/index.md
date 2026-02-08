---
read_when:
    - CLI 명령 또는 옵션 추가 또는 수정
    - 새로운 명령 표면 문서화
summary: '`openclaw` 명령, 하위 명령 및 옵션에 대한 OpenClaw CLI 참조'
title: CLI 참조
x-i18n:
    generated_at: "2026-02-08T15:49:46Z"
    model: gtx
    provider: google-translate
    source_hash: 0013f522ac602176330b8a63589905c93be8fd250c83b23c5ffd1f9a1113cd72
    source_path: cli/index.md
    workflow: 15
---

# CLI 참조

이 페이지에서는 현재 CLI 동작을 설명합니다. 명령이 변경되면 이 문서를 업데이트하세요.

## 명령 페이지

- [`setup`](/cli/setup)
- [`onboard`](/cli/onboard)
- [`configure`](/cli/configure)
- [`config`](/cli/config)
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
- [`plugins`](/cli/plugins) (플러그인 명령)
- [`channels`](/cli/channels)
- [`security`](/cli/security)
- [`skills`](/cli/skills)
- [`voicecall`](/cli/voicecall) (플러그인; 설치된 경우)

## 글로벌 플래그

- `--dev`: 상태를 아래에 격리 `~/.openclaw-dev` 기본 포트를 이동합니다.
- `--profile <name>`: 상태를 아래에 격리 `~/.openclaw-<name>`.
- `--no-color`: ANSI 색상을 비활성화합니다.
- `--update`: 약어 `openclaw update` (소스 설치에만 해당)
- `-V`, `--version`, `-v`: 버전을 인쇄하고 종료합니다.

## 출력 스타일

- ANSI 색상 및 진행률 표시기는 TTY 세션에서만 렌더링됩니다.
- OSC-8 하이퍼링크는 지원되는 터미널에서 클릭 가능한 링크로 렌더링됩니다. 그렇지 않으면 일반 URL로 대체됩니다.
- `--json` (그리고 `--plain` 지원되는 경우) 깔끔한 출력을 위해 스타일을 비활성화합니다.
- `--no-color` ANSI 스타일을 비활성화합니다. `NO_COLOR=1` 또한 존중됩니다.
- 장기 실행 명령은 진행률 표시기를 표시합니다(지원되는 경우 OSC 9;4).

## 색상 팔레트

OpenClaw는 CLI 출력을 위해 랍스터 팔레트를 사용합니다.

- `accent` (#FF5A2D): 제목, 레이블, 주요 강조 표시.
- `accentBright` (#FF7A3D): 명령 이름, 강조.
- `accentDim` (#D14A22): 보조 강조 텍스트입니다.
- `info` (#FF8A5B): 정보용 값입니다.
- `success` (#2FBF71): 성공 상태입니다.
- `warn` (#FFB020): 경고, 대체, 주의.
- `error` (#E23D2D): 오류, 실패.
- `muted` (#8B7F77): 강조 해제, 메타데이터.

팔레트의 진실 소스: `src/terminal/palette.ts` (일명 "랍스터 솔기").

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
  doctor
  security
    audit
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
  docs
  dns
    setup
  tui
```

참고: 플러그인은 추가적인 최상위 명령을 추가할 수 있습니다(예: `openclaw voicecall`).

## 보안

- `openclaw security audit` — 일반적인 보안 풋건에 대한 감사 구성 + 로컬 상태.
- `openclaw security audit --deep` — 최선의 노력을 다하는 라이브 게이트웨이 프로브.
- `openclaw security audit --fix` — 안전한 기본값과 chmod 상태/구성을 강화합니다.

## 플러그인

확장 프로그램 및 해당 구성을 관리합니다.

- `openclaw plugins list` — 플러그인 검색(사용 `--json` 기계 출력의 경우).
- `openclaw plugins info <id>` — 플러그인에 대한 세부 정보를 표시합니다.
- `openclaw plugins install <path|.tgz|npm-spec>` — 플러그인 설치(또는 플러그인 경로 추가) `plugins.load.paths`).
- `openclaw plugins enable <id>` / `disable <id>` — 토글 `plugins.entries.<id>.enabled`.
- `openclaw plugins doctor` — 플러그인 로드 오류를 보고합니다.

대부분의 플러그인 변경에는 게이트웨이를 다시 시작해야 합니다. 보다 [/플러그인](/tools/plugin).

## 메모리

벡터 검색 종료 `MEMORY.md` + `memory/*.md`:

- `openclaw memory status` — 인덱스 통계를 표시합니다.
- `openclaw memory index` — 메모리 파일을 다시 색인화합니다.
- `openclaw memory search "<query>"` — 메모리에 대한 의미 검색.

## 채팅 슬래시 명령

채팅 메시지 지원 `/...` 명령(텍스트 및 기본). 보다 [/tools/슬래시 명령](/tools/slash-commands).

하이라이트:

- `/status` 빠른 진단을 위해.
- `/config` 지속적인 구성 변경의 경우.
- `/debug` 런타임 전용 구성 재정의(디스크가 아닌 메모리, 필요) `commands.debug: true`).

## 설정 + 온보딩

### `setup`

구성 + 작업공간을 초기화합니다.

옵션:

- `--workspace <dir>`: 에이전트 작업공간 경로(기본값 `~/.openclaw/workspace`).
- `--wizard`: 온보딩 마법사를 실행합니다.
- `--non-interactive`: 프롬프트 없이 마법사를 실행합니다.
- `--mode <local|remote>`: 마법사 모드.
- `--remote-url <url>`: 원격 게이트웨이 URL.
- `--remote-token <token>`: 원격 게이트웨이 토큰.

마법사 플래그가 있으면 마법사가 자동 실행됩니다(`--non-interactive`, `--mode`, `--remote-url`, `--remote-token`).

### `onboard`

게이트웨이, 작업 영역 및 기술을 설정하는 대화형 마법사입니다.

옵션:

- `--workspace <dir>`
- `--reset` (마법사 전에 구성 + 자격 증명 + 세션 + 작업 공간 재설정)
- `--non-interactive`
- `--mode <local|remote>`
- `--flow <quickstart|advanced|manual>` (수동은 고급의 별칭입니다)
- `--auth-choice <setup-token|token|chutes|openai-codex|openai-api-key|openrouter-api-key|ai-gateway-api-key|moonshot-api-key|moonshot-api-key-cn|kimi-code-api-key|synthetic-api-key|venice-api-key|gemini-api-key|zai-api-key|apiKey|minimax-api|minimax-api-lightning|opencode-zen|skip>`
- `--token-provider <id>` (비대화형, 다음과 함께 사용됨) `--auth-choice token`)
- `--token <token>` (비대화형, 다음과 함께 사용됨) `--auth-choice token`)
- `--token-profile-id <id>` (비대화형, 기본값: `<provider>:manual`)
- `--token-expires-in <duration>` (비대화형, 예: `365d`, `12h`)
- `--anthropic-api-key <key>`
- `--openai-api-key <key>`
- `--openrouter-api-key <key>`
- `--ai-gateway-api-key <key>`
- `--moonshot-api-key <key>`
- `--kimi-code-api-key <key>`
- `--gemini-api-key <key>`
- `--zai-api-key <key>`
- `--minimax-api-key <key>`
- `--opencode-zen-api-key <key>`
- `--gateway-port <port>`
- `--gateway-bind <loopback|lan|tailnet|auto|custom>`
- `--gateway-auth <token|password>`
- `--gateway-token <token>`
- `--gateway-password <password>`
- `--remote-url <url>`
- `--remote-token <token>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--install-daemon`
- `--no-install-daemon` (별명: `--skip-daemon`)
- `--daemon-runtime <node|bun>`
- `--skip-channels`
- `--skip-skills`
- `--skip-health`
- `--skip-ui`
- `--node-manager <npm|pnpm|bun>` (pnpm 권장, 게이트웨이 런타임에는 권장되지 않음)
- `--json`

### `configure`

대화형 구성 마법사(모델, 채널, 기술, 게이트웨이)

### `config`

비대화형 구성 도우미(가져오기/설정/설정 해제). 달리기 `openclaw config` 아니
하위 명령은 마법사를 시작합니다.

하위 명령:

- `config get <path>`: 구성 값(점/괄호 경로)을 인쇄합니다.
- `config set <path> <value>`: 값(JSON5 또는 원시 문자열)을 설정합니다.
- `config unset <path>`: 값을 제거합니다.

### `doctor`

상태 확인 + 빠른 수정(구성 + 게이트웨이 + 레거시 서비스)

옵션:

- `--no-workspace-suggestions`: 작업 공간 메모리 힌트를 비활성화합니다.
- `--yes`: 메시지를 표시하지 않고 기본값을 수락합니다(헤드리스).
- `--non-interactive`: 프롬프트 건너뛰기; 안전한 마이그레이션만 적용하세요.
- `--deep`: 추가 게이트웨이 설치를 위해 시스템 서비스를 검색합니다.

## 채널 도우미

### `channels`

채팅 채널 계정(WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost(플러그인)/Signal/iMessage/MS Teams)을 관리합니다.

하위 명령:

- `channels list`: 구성된 채널 및 인증 프로필을 표시합니다.
- `channels status`: 게이트웨이 연결 가능성 및 채널 상태 확인(`--probe` 추가 검사를 실행합니다. 사용 `openclaw health` 또는 `openclaw status --deep` 게이트웨이 상태 프로브의 경우).
- 팁: `channels status` 일반적인 잘못된 구성을 감지할 수 있는 경우 제안된 수정 사항과 함께 경고를 인쇄합니다. `openclaw doctor`).
- `channels logs`: 게이트웨이 로그 파일의 최근 채널 로그를 표시합니다.
- `channels add`: 플래그가 전달되지 않은 경우 마법사 스타일 설정; 플래그는 비대화형 모드로 전환됩니다.
- `channels remove`: 기본적으로 비활성화됩니다. 통과하다 `--delete` 프롬프트 없이 구성 항목을 제거합니다.
- `channels login`: 대화형 채널 로그인(WhatsApp 웹에만 해당)
- `channels logout`: 채널 세션에서 로그아웃합니다(지원되는 경우).

일반적인 옵션:

- `--channel <name>`:`whatsapp|telegram|discord|googlechat|slack|mattermost|signal|imessage|msteams`
- `--account <id>`: 채널 계정 ID(기본값 `default`)
- `--name <label>`: 계정의 표시 이름

`channels login` 옵션:

- `--channel <channel>` (기본 `whatsapp`; 지원하다 `whatsapp` / `web`)
- `--account <id>`
- `--verbose`

`channels logout` 옵션:

- `--channel <channel>` (기본 `whatsapp`)
- `--account <id>`

`channels list` 옵션:

- `--no-usage`: 모델 공급자 사용량/할당량 스냅샷을 건너뜁니다(OAuth/API 지원만 해당).
- `--json`: JSON 출력(다음을 제외한 사용법 포함) `--no-usage` 설정됨).

`channels logs` 옵션:

- `--channel <name|all>` (기본 `all`)
- `--lines <n>` (기본 `200`)
- `--json`

더 자세한 내용: [/개념/oauth](/concepts/oauth)

예:

```bash
openclaw channels add --channel telegram --account alerts --name "Alerts Bot" --token $TELEGRAM_BOT_TOKEN
openclaw channels add --channel discord --account work --name "Work Bot" --token $DISCORD_BOT_TOKEN
openclaw channels remove --channel discord --account work --delete
openclaw channels status --probe
openclaw status --deep
```

### `skills`

사용 가능한 기술과 준비 상태 정보를 나열하고 검사합니다.

하위 명령:

- `skills list`: 스킬을 나열합니다(하위 명령이 없는 경우 기본값).
- `skills info <name>`: 하나의 스킬에 대한 세부 정보를 표시합니다.
- `skills check`: 준비 요구사항과 누락된 요구사항 요약.

옵션:

- `--eligible`: 준비된 스킬만 보여줍니다.
- `--json`: JSON을 출력합니다(스타일링 없음).
- `-v`, `--verbose`: 누락된 요구사항 세부정보를 포함합니다.

팁: 사용 `npx clawhub` 스킬을 검색, 설치, 동기화합니다.

### `pairing`

채널 전반에 걸쳐 DM 페어링 요청을 승인합니다.

하위 명령:

- `pairing list <channel> [--json]`
- `pairing approve <channel> <code> [--notify]`

### `webhooks gmail`

Gmail Pub/Sub 후크 설정 + 실행기. 보다 [/자동화/gmail-pubsub](/automation/gmail-pubsub).

하위 명령:

- `webhooks gmail setup` (요구 `--account <email>`; 지원하다 `--project`, `--topic`, `--subscription`, `--label`, `--hook-url`, `--hook-token`, `--push-token`, `--bind`, `--port`, `--path`, `--include-body`, `--max-bytes`, `--renew-minutes`, `--tailscale`, `--tailscale-path`, `--tailscale-target`, `--push-endpoint`, `--json`)
- `webhooks gmail run` (동일한 플래그에 대한 런타임 재정의)

### `dns setup`

광역 검색 DNS 도우미(CoreDNS + Tailscale). 보다 [/게이트웨이/발견](/gateway/discovery).

옵션:

- `--apply`: CoreDNS 구성을 설치/업데이트합니다(sudo 필요, macOS만 해당).

## 메시징 + 상담원

### `message`

통합 아웃바운드 메시징 + 채널 작업.

보다: [/cli/메시지](/cli/message)

하위 명령:

- `message send|poll|react|reactions|read|edit|delete|pin|unpin|pins|permissions|search|timeout|kick|ban`
- `message thread <create|list|reply>`
- `message emoji <list|upload>`
- `message sticker <send|upload>`
- `message role <info|add|remove>`
- `message channel <info|list>`
- `message member info`
- `message voice status`
- `message event <list|create>`

예:

- `openclaw message send --target +15555550123 --message "Hi"`
- `openclaw message poll --channel discord --target channel:123 --poll-question "Snack?" --poll-option Pizza --poll-option Sushi`

### `agent`

게이트웨이를 통해 하나의 에이전트 차례를 실행합니다(또는 `--local` 내장).

필수의:

- `--message <text>`

옵션:

- `--to <dest>` (세션 키 및 선택적 전달용)
- `--session-id <id>`
- `--thinking <off|minimal|low|medium|high|xhigh>` (GPT-5.2 + Codex 모델만 해당)
- `--verbose <on|full|off>`
- `--channel <whatsapp|telegram|discord|slack|mattermost|signal|imessage|msteams>`
- `--local`
- `--deliver`
- `--json`
- `--timeout <seconds>`

### `agents`

격리된 에이전트를 관리합니다(작업 공간 + 인증 + 라우팅).

#### `agents list`

구성된 에이전트를 나열합니다.

옵션:

- `--json`
- `--bindings`

#### `agents add [name]`

격리된 새 에이전트를 추가합니다. 플래그(또는 `--non-interactive`) 통과되었습니다. `--workspace` 비대화형 모드에서는 필요합니다.

옵션:

- `--workspace <dir>`
- `--model <id>`
- `--agent-dir <dir>`
- `--bind <channel[:accountId]>` (반복 가능)
- `--non-interactive`
- `--json`

바인딩 사양 사용 `channel[:accountId]`. 언제 `accountId` WhatsApp에서는 생략되어 기본 계정 ID가 사용됩니다.

#### `agents delete <id>`

에이전트를 삭제하고 해당 작업공간 + 상태를 정리합니다.

옵션:

- `--force`
- `--json`

### `acp`

IDE를 게이트웨이에 연결하는 ACP 브리지를 실행합니다.

보다 [`acp`](/cli/acp) 전체 옵션 및 예시를 확인하세요.

### `status`

연결된 세션 상태와 최근 수신자를 표시합니다.

옵션:

- `--json`
- `--all` (전체 진단, 읽기 전용, 붙여넣기 가능)
- `--deep` (프로브 채널)
- `--usage` (모델 공급자 사용량/할당량 표시)
- `--timeout <ms>`
- `--verbose`
- `--debug` (별칭 `--verbose`)

참고:

- 개요에는 사용 가능한 경우 게이트웨이 + 노드 호스트 서비스 상태가 포함됩니다.

### 사용량 추적

OpenClaw는 OAuth/API 자격 증명을 사용할 수 있는 경우 공급자 사용량/할당량을 표시할 수 있습니다.

표면:

- `/status` (사용 가능한 경우 짧은 공급자 사용 라인을 추가합니다)
- `openclaw status --usage` (전체 공급자 분석 인쇄)
- macOS 메뉴 표시줄(컨텍스트 아래의 사용 섹션)

참고:

- 데이터는 공급자 사용 끝점에서 직접 가져옵니다(추정 없음).
- 공급자: Anthropic, GitHub Copilot, OpenAI Codex OAuth 및 Gemini CLI/Antigravity(해당 공급자 플러그인이 활성화된 경우).
- 일치하는 자격 증명이 없으면 사용량이 숨겨집니다.
- 세부정보: 참조 [사용량 추적](/concepts/usage-tracking).

### `health`

실행 중인 게이트웨이에서 상태를 가져옵니다.

옵션:

- `--json`
- `--timeout <ms>`
- `--verbose`

### `sessions`

저장된 대화 세션을 나열합니다.

옵션:

- `--json`
- `--verbose`
- `--store <path>`
- `--active <minutes>`

## 재설정 / 제거

### `reset`

로컬 구성/상태를 재설정합니다(CLI 설치 유지).

옵션:

- `--scope <config|config+creds+sessions|full>`
- `--yes`
- `--non-interactive`
- `--dry-run`

참고:

- `--non-interactive` 필요하다 `--scope` 그리고 `--yes`.

### `uninstall`

게이트웨이 서비스 + 로컬 데이터를 제거합니다(CLI는 유지됨).

옵션:

- `--service`
- `--state`
- `--workspace`
- `--app`
- `--all`
- `--yes`
- `--non-interactive`
- `--dry-run`

참고:

- `--non-interactive` 필요하다 `--yes` 명시적 범위(또는 `--all`).

## 게이트웨이

### `gateway`

WebSocket 게이트웨이를 실행합니다.

옵션:

- `--port <port>`
- `--bind <loopback|tailnet|lan|auto|custom>`
- `--token <token>`
- `--auth <token|password>`
- `--password <password>`
- `--tailscale <off|serve|funnel>`
- `--tailscale-reset-on-exit`
- `--allow-unconfigured`
- `--dev`
- `--reset` (개발 구성 + 자격 증명 + 세션 + 작업 공간 재설정)
- `--force` (포트의 기존 리스너 종료)
- `--verbose`
- `--claude-cli-logs`
- `--ws-log <auto|full|compact>`
- `--compact` (별칭 `--ws-log compact`)
- `--raw-stream`
- `--raw-stream-path <path>`

### `gateway service`

게이트웨이 서비스(launchd/systemd/schtasks)를 관리합니다.

하위 명령:

- `gateway status` (기본적으로 게이트웨이 RPC를 조사합니다)
- `gateway install` (서비스 설치)
- `gateway uninstall`
- `gateway start`
- `gateway stop`
- `gateway restart`

참고:

- `gateway status` 기본적으로 서비스의 확인된 포트/구성을 사용하여 게이트웨이 RPC를 검색합니다(다음으로 재정의됨). `--url/--token/--password`).
- `gateway status` 지원하다 `--no-probe`, `--deep`, 그리고 `--json` 스크립팅을 위해.
- `gateway status` 또한 레거시 또는 추가 게이트웨이 서비스를 감지할 수 있는 경우 표시합니다(`--deep` 시스템 수준 검사를 추가합니다). 프로필 이름이 지정된 OpenClaw 서비스는 최고 수준으로 처리되며 "추가"로 표시되지 않습니다.
- `gateway status` CLI가 사용하는 구성 경로와 서비스가 사용할 가능성이 있는 구성(서비스 환경) 및 확인된 프로브 대상 URL을 인쇄합니다.
- `gateway install|uninstall|start|stop|restart` 지원하다 `--json` 스크립팅용(기본 출력은 인간 친화적으로 유지됨)
- `gateway install` 기본값은 노드 런타임입니다. 롤빵은 **권장하지 않음** (WhatsApp/텔레그램 버그).
- `gateway install` 옵션:`--port`, `--runtime`, `--token`, `--force`, `--json`.

### `logs`

RPC를 통한 Tail Gateway 파일 로그.

참고:

- TTY 세션은 색상이 지정되고 구조화된 보기를 렌더링합니다. TTY가 아닌 경우 일반 텍스트로 대체됩니다.
- `--json` 줄로 구분된 JSON(줄당 하나의 로그 이벤트)을 내보냅니다.

예:

```bash
openclaw logs --follow
openclaw logs --limit 200
openclaw logs --plain
openclaw logs --json
openclaw logs --no-color
```

### `gateway <subcommand>`

게이트웨이 CLI 도우미(사용 `--url`, `--token`, `--password`, `--timeout`, `--expect-final` RPC 하위 명령의 경우).
통과할 때 `--url`, CLI는 구성 또는 환경 자격 증명을 자동 적용하지 않습니다.
포함하다 `--token` 또는 `--password` 명시적으로. 명시적 자격 증명이 누락되면 오류가 발생합니다.

하위 명령:

- `gateway call <method> [--params <json>]`
- `gateway health`
- `gateway status`
- `gateway probe`
- `gateway discover`
- `gateway install|uninstall|start|stop|restart`
- `gateway run`

일반 RPC:

- `config.apply` (검증 + 구성 쓰기 + 다시 시작 + 깨우기)
- `config.patch` (부분 업데이트 병합 + 다시 시작 + 깨우기)
- `update.run` (업데이트 실행 + 다시 시작 + 깨우기)

팁: 전화할 때 `config.set` / `config.apply` / `config.patch` 직접, 통과하다 `baseHash` ~에서
`config.get` 구성이 이미 존재하는 경우.

## 모델

보다 [/개념/모델](/concepts/models) 대체 동작 및 검색 전략을 위한 것입니다.

선호하는 인류학적 인증(설정 토큰):

```bash
claude setup-token
openclaw models auth setup-token --provider anthropic
openclaw models status
```

### `models` (뿌리)

`openclaw models` 의 별칭입니다 `models status`.

루트 옵션:

- `--status-json` (별칭 `models status --json`)
- `--status-plain` (별칭 `models status --plain`)

### `models list`

옵션:

- `--all`
- `--local`
- `--provider <name>`
- `--json`
- `--plain`

### `models status`

옵션:

- `--json`
- `--plain`
- `--check` (출구 1=만료됨/누락됨, 2=만료됨)
- `--probe` (구성된 인증 프로필의 실시간 프로브)
- `--probe-provider <name>`
- `--probe-profile <id>` (반복하거나 쉼표로 구분)
- `--probe-timeout <ms>`
- `--probe-concurrency <n>`
- `--probe-max-tokens <n>`

인증 저장소의 프로필에 대한 인증 개요 및 OAuth 만료 상태가 항상 포함됩니다.
`--probe` 실시간 요청을 실행합니다(토큰을 소비하고 속도 제한을 트리거할 수 있음).

### `models set <model>`

세트 `agents.defaults.model.primary`.

### `models set-image <model>`

세트 `agents.defaults.imageModel.primary`.

### `models aliases list|add|remove`

옵션:

- `list`:`--json`, `--plain`
- `add <alias> <model>`
- `remove <alias>`

### `models fallbacks list|add|remove|clear`

옵션:

- `list`:`--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models image-fallbacks list|add|remove|clear`

옵션:

- `list`:`--json`, `--plain`
- `add <model>`
- `remove <model>`
- `clear`

### `models scan`

옵션:

- `--min-params <b>`
- `--max-age-days <days>`
- `--provider <name>`
- `--max-candidates <n>`
- `--timeout <ms>`
- `--concurrency <n>`
- `--no-probe`
- `--yes`
- `--no-input`
- `--set-default`
- `--set-image`
- `--json`

### `models auth add|setup-token|paste-token`

옵션:

- `add`: 대화형 인증 도우미
- `setup-token`:`--provider <name>` (기본 `anthropic`), `--yes`
- `paste-token`:`--provider <name>`, `--profile-id <id>`, `--expires-in <duration>`

### `models auth order get|set|clear`

옵션:

- `get`:`--provider <name>`, `--agent <id>`, `--json`
- `set`:`--provider <name>`, `--agent <id>`, `<profileIds...>`
- `clear`:`--provider <name>`, `--agent <id>`

## 체계

### `system event`

시스템 이벤트를 대기열에 추가하고 선택적으로 하트비트(게이트웨이 RPC)를 트리거합니다.

필수의:

- `--text <text>`

옵션:

- `--mode <now|next-heartbeat>`
- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system heartbeat last|enable|disable`

하트비트 제어(게이트웨이 RPC).

옵션:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

### `system presence`

시스템 존재 항목을 나열합니다(게이트웨이 RPC).

옵션:

- `--json`
- `--url`, `--token`, `--timeout`, `--expect-final`

## 크론

예약된 작업을 관리합니다(게이트웨이 RPC). 보다 [/자동화/크론-작업](/automation/cron-jobs).

하위 명령:

- `cron status [--json]`
- `cron list [--all] [--json]` (기본적으로 테이블 출력; 사용 `--json` 원시용)
- `cron add` (별명: `create`; 필요하다 `--name` 그리고 정확히 그 중 하나 `--at` | `--every` | `--cron`, 정확히 하나의 페이로드 `--system-event` | `--message`)
- `cron edit <id>` (패치 필드)
- `cron rm <id>` (별칭: `remove`, `delete`)
- `cron enable <id>`
- `cron disable <id>`
- `cron runs --id <id> [--limit <n>]`
- `cron run <id> [--force]`

모두 `cron` 명령은 수락 `--url`, `--token`, `--timeout`, `--expect-final`.

## 노드 호스트

`node` 실행 **헤드리스 노드 호스트** 또는 백그라운드 서비스로 관리합니다. 보다
[`openclaw node`](/cli/node).

하위 명령:

- `node run --host <gateway-host> --port 18789`
- `node status`
- `node install [--host <gateway-host>] [--port <port>] [--tls] [--tls-fingerprint <sha256>] [--node-id <id>] [--display-name <name>] [--runtime <node|bun>] [--force]`
- `node uninstall`
- `node stop`
- `node restart`

## 노드

`nodes` 게이트웨이와 통신하고 쌍을 이루는 노드를 대상으로 합니다. 보다 [/노드](/nodes).

일반적인 옵션:

- `--url`, `--token`, `--timeout`, `--json`

하위 명령:

- `nodes status [--connected] [--last-connected <duration>]`
- `nodes describe --node <id|name|ip>`
- `nodes list [--connected] [--last-connected <duration>]`
- `nodes pending`
- `nodes approve <requestId>`
- `nodes reject <requestId>`
- `nodes rename --node <id|name|ip> --name <displayName>`
- `nodes invoke --node <id|name|ip> --command <command> [--params <json>] [--invoke-timeout <ms>] [--idempotency-key <key>]`
- `nodes run --node <id|name|ip> [--cwd <path>] [--env KEY=VAL] [--command-timeout <ms>] [--needs-screen-recording] [--invoke-timeout <ms>] <command...>` (mac 노드 또는 헤드리스 노드 호스트)
- `nodes notify --node <id|name|ip> [--title <text>] [--body <text>] [--sound <name>] [--priority <passive|active|timeSensitive>] [--delivery <system|overlay|auto>] [--invoke-timeout <ms>]` (맥 전용)

카메라:

- `nodes camera list --node <id|name|ip>`
- `nodes camera snap --node <id|name|ip> [--facing front|back|both] [--device-id <id>] [--max-width <px>] [--quality <0-1>] [--delay-ms <ms>] [--invoke-timeout <ms>]`
- `nodes camera clip --node <id|name|ip> [--facing front|back] [--device-id <id>] [--duration <ms|10s|1m>] [--no-audio] [--invoke-timeout <ms>]`

캔버스 + 화면:

- `nodes canvas snapshot --node <id|name|ip> [--format png|jpg|jpeg] [--max-width <px>] [--quality <0-1>] [--invoke-timeout <ms>]`
- `nodes canvas present --node <id|name|ip> [--target <urlOrPath>] [--x <px>] [--y <px>] [--width <px>] [--height <px>] [--invoke-timeout <ms>]`
- `nodes canvas hide --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas navigate <url> --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes canvas eval [<js>] --node <id|name|ip> [--js <code>] [--invoke-timeout <ms>]`
- `nodes canvas a2ui push --node <id|name|ip> (--jsonl <path> | --text <text>) [--invoke-timeout <ms>]`
- `nodes canvas a2ui reset --node <id|name|ip> [--invoke-timeout <ms>]`
- `nodes screen record --node <id|name|ip> [--screen <index>] [--duration <ms|10s>] [--fps <n>] [--no-audio] [--out <path>] [--invoke-timeout <ms>]`

위치:

- `nodes location get --node <id|name|ip> [--max-age <ms>] [--accuracy <coarse|balanced|precise>] [--location-timeout <ms>] [--invoke-timeout <ms>]`

## 브라우저

브라우저 제어 CLI(전용 Chrome/Brave/Edge/Chromium). 보다 [`openclaw browser`](/cli/browser) 그리고 [브라우저 도구](/tools/browser).

일반적인 옵션:

- `--url`, `--token`, `--timeout`, `--json`
- `--browser-profile <name>`

관리하다:

- `browser status`
- `browser start`
- `browser stop`
- `browser reset-profile`
- `browser tabs`
- `browser open <url>`
- `browser focus <targetId>`
- `browser close [targetId]`
- `browser profiles`
- `browser create-profile --name <name> [--color <hex>] [--cdp-url <url>]`
- `browser delete-profile --name <name>`

검사:

- `browser screenshot [targetId] [--full-page] [--ref <ref>] [--element <selector>] [--type png|jpeg]`
- `browser snapshot [--format aria|ai] [--target-id <id>] [--limit <n>] [--interactive] [--compact] [--depth <n>] [--selector <sel>] [--out <path>]`

행위:

- `browser navigate <url> [--target-id <id>]`
- `browser resize <width> <height> [--target-id <id>]`
- `browser click <ref> [--double] [--button <left|right|middle>] [--modifiers <csv>] [--target-id <id>]`
- `browser type <ref> <text> [--submit] [--slowly] [--target-id <id>]`
- `browser press <key> [--target-id <id>]`
- `browser hover <ref> [--target-id <id>]`
- `browser drag <startRef> <endRef> [--target-id <id>]`
- `browser select <ref> <values...> [--target-id <id>]`
- `browser upload <paths...> [--ref <ref>] [--input-ref <ref>] [--element <selector>] [--target-id <id>] [--timeout-ms <ms>]`
- `browser fill [--fields <json>] [--fields-file <path>] [--target-id <id>]`
- `browser dialog --accept|--dismiss [--prompt <text>] [--target-id <id>] [--timeout-ms <ms>]`
- `browser wait [--time <ms>] [--text <value>] [--text-gone <value>] [--target-id <id>]`
- `browser evaluate --fn <code> [--ref <ref>] [--target-id <id>]`
- `browser console [--level <error|warn|info>] [--target-id <id>]`
- `browser pdf [--target-id <id>]`

## 문서 검색

### `docs [query...]`

라이브 문서 색인을 검색하세요.

## TUI

### `tui`

게이트웨이에 연결된 터미널 UI를 엽니다.

옵션:

- `--url <url>`
- `--token <token>`
- `--password <password>`
- `--session <key>`
- `--deliver`
- `--thinking <level>`
- `--message <text>`
- `--timeout-ms <ms>` (기본값은 `agents.defaults.timeoutSeconds`)
- `--history-limit <n>`
