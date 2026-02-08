---
read_when:
    - 게이트웨이 프로세스 실행 또는 디버깅
summary: 게이트웨이 서비스, 수명 주기 및 운영에 대한 런북
title: 게이트웨이 런북
x-i18n:
    generated_at: "2026-02-08T15:55:28Z"
    model: gtx
    provider: google-translate
    source_hash: e59d842824f892f68dc9260cceeb33321367bc50ac8ca578b9a3854c51cebae3
    source_path: gateway/index.md
    workflow: 15
---

# 게이트웨이 서비스 런북

최종 업데이트 날짜: 2025-12-09

## 그것은 무엇입니까

- 단일 Baileys/Telegram 연결과 제어/이벤트 평면을 소유하는 상시 실행 프로세스입니다.
- 레거시를 대체합니다. `gateway` 명령. CLI 진입점: `openclaw gateway`.
- 중지될 때까지 실행됩니다. 치명적인 오류가 발생하면 0이 아닌 값으로 종료되므로 감독자가 이를 다시 시작합니다.

## 실행 방법(로컬)

```bash
openclaw gateway --port 18789
# for full debug/trace logs in stdio:
openclaw gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
openclaw gateway --force
# dev loop (auto-reload on TS changes):
pnpm gateway:watch
```

- 핫 리로드 시계 구성 `~/.openclaw/openclaw.json` (또는 `OPENCLAW_CONFIG_PATH`).
  - 기본 모드: `gateway.reload.mode="hybrid"` (핫 적용 안전 변경 사항, 중요 시 다시 시작)
  - 핫 리로드는 다음을 통해 프로세스 내 다시 시작을 사용합니다. **SIGUSR1** 필요할 때.
  - 다음으로 비활성화 `gateway.reload.mode="off"`.
- WebSocket 제어 평면을 다음에 바인딩합니다. `127.0.0.1:<port>` (기본값 18789).
- 동일한 포트는 HTTP(제어 UI, 후크, A2UI)도 제공합니다. 단일 포트 멀티플렉스.
  - OpenAI 채팅 완료(HTTP): [`/v1/chat/completions`](/gateway/openai-http-api).
  - OpenResponse(HTTP): [`/v1/responses`](/gateway/openresponses-http-api).
  - 도구 호출(HTTP): [`/tools/invoke`](/gateway/tools-invoke-http-api).
- 기본적으로 Canvas 파일 서버를 시작합니다. `canvasHost.port` (기본 `18793`), 서빙 `http://<gateway-host>:18793/__openclaw__/canvas/` ~에서 `~/.openclaw/workspace/canvas`. 다음으로 비활성화 `canvasHost.enabled=false` 또는 `OPENCLAW_SKIP_CANVAS_HOST=1`.
- 표준 출력에 기록합니다. launchd/systemd를 사용하여 활성 상태를 유지하고 로그를 회전하세요.
- 통과하다 `--verbose` 문제 해결 시 디버그 로깅(핸드셰이크, req/res, 이벤트)을 로그 파일에서 stdio로 미러링합니다.
- `--force` 용도 `lsof` 선택한 포트에서 리스너를 찾으려면 SIGTERM을 보내고, 종료된 내용을 기록한 다음 게이트웨이를 시작합니다(다음과 같은 경우 빠르게 실패함). `lsof` 누락되었습니다).
- 감독자(launchd/systemd/mac 앱 하위 프로세스 모드)에서 실행하는 경우 일반적으로 중지/재시작 시 다음 메시지가 전송됩니다. **SIGTERM**; 오래된 빌드에서는 다음과 같이 나타날 수 있습니다. `pnpm` `ELIFECYCLE` 종료 코드 **143** (SIGTERM) 이는 충돌이 아닌 정상적인 종료입니다.
- **SIGUSR1** 승인되면 프로세스 중 다시 시작을 트리거합니다(게이트웨이 도구/구성 적용/업데이트 또는 활성화). `commands.restart` 수동으로 다시 시작하는 경우).
- 기본적으로 게이트웨이 인증이 필요합니다. 설정 `gateway.auth.token` (또는 `OPENCLAW_GATEWAY_TOKEN`) 또는 `gateway.auth.password`. 클라이언트는 보내야 합니다 `connect.params.auth.token/password` Tailscale Serve ID를 사용하지 않는 한.
- 이제 마법사는 루프백 시에도 기본적으로 토큰을 생성합니다.
- 포트 우선순위: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > 기본값 `18789`.

## 원격 액세스

- Tailscale/VPN이 선호됩니다. 그렇지 않으면 SSH 터널:

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- 클라이언트는 다음에 연결합니다. `ws://127.0.0.1:18789` 터널을 통해.
- 토큰이 구성된 경우 클라이언트는 이를 토큰에 포함해야 합니다. `connect.params.auth.token` 터널 너머에서도요.

## 다중 게이트웨이(동일한 호스트)

일반적으로 불필요합니다. 하나의 게이트웨이가 여러 메시징 채널과 에이전트에 서비스를 제공할 수 있습니다. 중복성 또는 엄격한 격리를 위해서만 여러 게이트웨이를 사용하십시오(예: 구조 봇).

상태 + 구성을 분리하고 고유 포트를 사용하는 경우 지원됩니다. 전체 가이드: [다중 게이트웨이](/gateway/multiple-gateways).

서비스 이름은 프로필을 인식합니다.

- 맥OS: `bot.molt.<profile>` (유산 `com.openclaw.*` 아직 존재할 수도 있음)
- 리눅스: `openclaw-gateway-<profile>.service`
- 윈도우: `OpenClaw Gateway (<profile>)`

설치 메타데이터는 서비스 구성에 포함됩니다.

- `OPENCLAW_SERVICE_MARKER=openclaw`
- `OPENCLAW_SERVICE_KIND=gateway`
- `OPENCLAW_SERVICE_VERSION=<version>`

Rescue-Bot 패턴: 두 번째 게이트웨이를 자체 프로필, 상태 디렉토리, 작업 공간 및 기본 포트 간격으로 격리된 상태로 유지합니다. 전체 가이드: [구조봇 가이드](/gateway/multiple-gateways#rescue-bot-guide).

### 개발자 프로필(`--dev`)

빠른 경로: 기본 설정을 건드리지 않고 완전히 격리된 개발 인스턴스(config/state/workspace)를 실행합니다.

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
# then target the dev instance:
openclaw --dev status
openclaw --dev health
```

기본값(env/flags/config를 통해 재정의될 수 있음):

- `OPENCLAW_STATE_DIR=~/.openclaw-dev`
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
- `OPENCLAW_GATEWAY_PORT=19001` (게이트웨이 WS + HTTP)
- 브라우저 제어 서비스 포트 = `19003` (파생: `gateway.port+2`, 루프백만 해당)
- `canvasHost.port=19005` (파생: `gateway.port+4`)
- `agents.defaults.workspace` 기본값은 `~/.openclaw/workspace-dev` 당신이 달릴 때 `setup`/`onboard` 아래에 `--dev`.

파생 포트(경험 법칙):

- 기본 포트 = `gateway.port` (또는 `OPENCLAW_GATEWAY_PORT`/`--port`)
- 브라우저 제어 서비스 포트 = 기본 + 2(루프백 전용)
- `canvasHost.port = base + 4` (또는 `OPENCLAW_CANVAS_HOST_PORT` / 구성 재정의)
- 브라우저 프로필 CDP 포트는 다음에서 자동 할당됩니다. `browser.controlPort + 9 .. + 108` (프로필별로 지속됨)

인스턴스별 체크리스트:

- 고유한 `gateway.port`
- 고유한 `OPENCLAW_CONFIG_PATH`
- 고유한 `OPENCLAW_STATE_DIR`
- 고유한 `agents.defaults.workspace`
- 별도의 WhatsApp 번호(WA를 사용하는 경우)

프로필당 서비스 설치:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

예:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

## 프로토콜(운영자 보기)

- 전체 문서: [게이트웨이 프로토콜](/gateway/protocol) 그리고 [브리지 프로토콜(레거시)](/gateway/bridge-protocol).
- 클라이언트의 필수 첫 번째 프레임: `req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`.
- 게이트웨이 응답 `res {type:"res", id, ok:true, payload:hello-ok }` (또는 `ok:false` 오류가 발생한 후 닫힙니다).
- 악수 후:
  - 요청: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - 이벤트: `{type:"event", event, payload, seq?, stateVersion?}`
- 구조화된 현재 상태 항목: `{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }` (WS 클라이언트의 경우, `instanceId` 에서 온다 `connect.client.instanceId`).
- `agent` 응답은 2단계입니다: 첫 번째 `res` 확인 `{runId,status:"accepted"}`, 그다음 최종 `res` `{runId,status:"ok"|"error",summary}` 실행이 끝난 후; 스트리밍된 출력은 다음과 같이 도착합니다. `event:"agent"`.

## 방법(초기 세트)

- `health` — 전체 상태 스냅샷(와 같은 모양) `openclaw health --json`).
- `status` — 짧은 ​​요약.
- `system-presence` — 현재 존재 목록.
- `system-event` — 현재 상태/시스템 메모를 게시합니다(구조화).
- `send` — 활성 채널을 통해 메시지를 보냅니다.
- `agent` — 에이전트 차례를 실행합니다(동일한 연결에서 이벤트를 다시 스트리밍합니다).
- `node.list` — 페어링된 + 현재 연결된 노드 목록(포함) `caps`, `deviceFamily`, `modelIdentifier`, `paired`, `connected`, 그리고 광고 `commands`).
- `node.describe` — 노드 설명(기능 + 지원됨) `node.invoke` 명령; 페어링된 노드와 현재 연결된 페어링되지 않은 노드에 대해 작동합니다.
- `node.invoke` — 노드에서 명령을 호출합니다(예: `canvas.*`, `camera.*`).
- `node.pair.*` — 페어링 수명 주기(`request`, `list`, `approve`, `reject`, `verify`).

참조: [있음](/concepts/presence) 현재 상태가 생성/중복 제거되는 방식과 안정적인 이유 `client.instanceId` 중요합니다.

## 이벤트

- `agent` — 에이전트 실행에서 스트리밍된 도구/출력 이벤트(seq 태그 지정).
- `presence` — 연결된 모든 클라이언트에 현재 상태 업데이트(stateVersion이 포함된 델타)가 푸시됩니다.
- `tick` — 활성 상태를 확인하기 위해 주기적으로 keepalive/no-op를 수행합니다.
- `shutdown` — 게이트웨이가 종료 중입니다. 페이로드에는 다음이 포함됩니다. `reason` 그리고 선택사항 `restartExpectedMs`. 클라이언트가 다시 연결되어야 합니다.

## 웹챗 통합

- WebChat은 기록, 보내기, 중단 및 이벤트에 대해 Gateway WebSocket과 직접 통신하는 기본 SwiftUI UI입니다.
- 원격 사용은 동일한 SSH/Tailscale 터널을 통과합니다. 게이트웨이 토큰이 구성된 경우 클라이언트는 이 토큰을 포함합니다. `connect`.
- macOS 앱은 단일 WS(공유 연결)를 통해 연결됩니다. 초기 스냅샷에서 현재 상태를 수화하고 청취합니다. `presence` UI를 업데이트하는 이벤트입니다.

## 입력 및 유효성 검사

- 서버는 프로토콜 정의에서 내보낸 JSON 스키마에 대해 AJV를 사용하여 모든 인바운드 프레임의 유효성을 검사합니다.
- 클라이언트(TS/Swift)는 생성된 유형을 사용합니다(TS 직접, 저장소 생성기를 통한 Swift).
- 프로토콜 정의는 진실의 원천입니다. 다음을 사용하여 스키마/모델을 재생성합니다.
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`

## 연결 스냅샷

- `hello-ok` 포함 `snapshot` ~와 함께 `presence`, `health`, `stateVersion`, 그리고 `uptimeMs` ...을 더한 `policy {maxPayload,maxBufferedBytes,tickIntervalMs}` 클라이언트가 추가 요청 없이 즉시 렌더링할 수 있습니다.
- `health`/`system-presence` 수동 새로 고침에는 계속 사용할 수 있지만 연결 시에는 필요하지 않습니다.

## 오류 코드(res.error 모양)

- 오류 사용 `{ code, message, details?, retryable?, retryAfterMs? }`.
- 표준 코드:
  - `NOT_LINKED` — WhatsApp이 인증되지 않았습니다.
  - `AGENT_TIMEOUT` — 상담원이 구성된 기한 내에 응답하지 않았습니다.
  - `INVALID_REQUEST` — 스키마/매개변수 검증이 실패했습니다.
  - `UNAVAILABLE` — 게이트웨이가 종료 중이거나 종속성을 사용할 수 없습니다.

## Keepalive 동작

- `tick` 이벤트(또는 WS ping/pong)가 주기적으로 발생하므로 클라이언트는 트래픽이 발생하지 않는 경우에도 게이트웨이가 살아 있음을 알 수 있습니다.
- 전송/에이전트 승인은 별도의 응답으로 유지됩니다. 센드에 대한 틱을 오버로드하지 마십시오.

## 재생 / 공백

- 이벤트는 재생되지 않습니다. 클라이언트는 시퀀스 간격을 감지하고 새로 고쳐야 합니다(`health` + `system-presence`) 계속하기 전에. WebChat 및 macOS 클라이언트는 이제 간격이 있을 때 자동으로 새로 고침됩니다.

## 감독(macOS 예)

- 서비스를 활성 상태로 유지하려면 launchd를 사용하십시오.
  - 프로그램: 경로 `openclaw`
  - 인수: `gateway`
  - KeepAlive: 사실
  - StandardOut/Err: 파일 경로 또는 `syslog`
- 실패하면 launchd가 다시 시작됩니다. 치명적인 잘못된 구성은 운영자가 알 수 있도록 계속 종료되어야 합니다.
- LaunchAgent는 사용자별로 이루어지며 로그인된 세션이 필요합니다. 헤드리스 설정의 경우 사용자 정의 LaunchDaemon(제공되지 않음)을 사용하십시오.
  - `openclaw gateway install` 쓴다 `~/Library/LaunchAgents/bot.molt.gateway.plist`
     (또는 `bot.molt.<profile>.plist`; 유산 `com.openclaw.*` 정리됩니다).
  - `openclaw doctor` LaunchAgent 구성을 감사하고 이를 현재 기본값으로 업데이트할 수 있습니다.

## 게이트웨이 서비스 관리(CLI)

설치/시작/중지/재시작/상태에 대해 게이트웨이 CLI를 사용하십시오.

```bash
openclaw gateway status
openclaw gateway install
openclaw gateway stop
openclaw gateway restart
openclaw logs --follow
```

참고:

- `gateway status` 기본적으로 서비스의 확인된 포트/구성을 사용하여 게이트웨이 RPC를 검색합니다(다음으로 재정의됨). `--url`).
- `gateway status --deep` 시스템 수준 검색(LaunchDaemons/시스템 장치)을 추가합니다.
- `gateway status --no-probe` RPC 프로브를 건너뜁니다(네트워킹이 중단된 경우 유용함).
- `gateway status --json` 스크립트에 안정적입니다.
- `gateway status` 보고서 **감독자 런타임** (launchd/systemd 실행 중)과 별도로 **RPC 연결 가능성** (WS 연결 + 상태 RPC).
- `gateway status` "로컬 호스트와 LAN 바인딩"의 혼동과 프로필 불일치를 방지하기 위해 구성 경로 + 프로브 대상을 인쇄합니다.
- `gateway status` 서비스가 실행 중인 것처럼 보이지만 포트가 닫혀 있는 경우 마지막 게이트웨이 오류 줄을 포함합니다.
- `logs` RPC를 통해 게이트웨이 파일 로그 추적(수동 없음) `tail`/`grep` 필요).
- 다른 게이트웨이와 유사한 서비스가 감지되면 OpenClaw 프로필 서비스가 아닌 한 CLI에서 경고합니다.
  우리는 여전히 추천합니다 **머신당 하나의 게이트웨이** 대부분의 설정에서; 중복성 또는 구조 봇을 위해 격리된 프로필/포트를 사용합니다. 보다 [다중 게이트웨이](/gateway/multiple-gateways).
  - 대청소: `openclaw gateway uninstall` (현재 서비스) 및 `openclaw doctor` (레거시 마이그레이션).
- `gateway install` 이미 설치되어 있으면 작동하지 않습니다. 사용 `openclaw gateway install --force` 다시 설치하려면(프로필/환경/경로 변경)

번들로 제공되는 Mac 앱:

- OpenClaw.app은 노드 기반 게이트웨이 릴레이를 번들로 묶고 라벨이 붙은 사용자별 LaunchAgent를 설치할 수 있습니다.
  `bot.molt.gateway` (또는 `bot.molt.<profile>`; 유산 `com.openclaw.*` 라벨은 여전히 ​​깨끗하게 언로드됩니다.)
- 깔끔하게 멈추려면 다음을 사용하세요. `openclaw gateway stop` (또는 `launchctl bootout gui/$UID/bot.molt.gateway`).
- 다시 시작하려면 다음을 사용하십시오. `openclaw gateway restart` (또는 `launchctl kickstart -k gui/$UID/bot.molt.gateway`).
  - `launchctl` LaunchAgent가 설치된 경우에만 작동합니다. 그렇지 않으면 사용 `openclaw gateway install` 첫 번째.
  - 라벨을 다음으로 교체하세요. `bot.molt.<profile>` 명명된 프로필을 실행할 때.

## 감독(시스템 사용자 단위)

OpenClaw는 다음을 설치합니다. **시스템화된 사용자 서비스** Linux/WSL2에서는 기본적으로. 우리
단일 사용자 컴퓨터에 대한 사용자 서비스를 권장합니다(더 간단한 환경, 사용자별 구성).
사용 **시스템 서비스** 다중 사용자 또는 상시 접속 서버의 경우(지속되지 않음)
필수, 공유 감독).

`openclaw gateway install` 사용자 단위를 씁니다. `openclaw doctor` 감사
단위이며 현재 권장 기본값과 일치하도록 업데이트할 수 있습니다.

만들다 `~/.config/systemd/user/openclaw-gateway[-<profile>].service`:

```
[Unit]
Description=OpenClaw Gateway (profile: <profile>, v<version>)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/openclaw gateway --port 18789
Restart=always
RestartSec=5
Environment=OPENCLAW_GATEWAY_TOKEN=
WorkingDirectory=/home/youruser

[Install]
WantedBy=default.target
```

느린 활성화(사용자 서비스가 로그아웃/유휴 상태를 유지하는 데 필요함):

```
sudo loginctl enable-linger youruser
```

온보딩은 Linux/WSL2에서 이를 실행합니다(sudo를 묻는 메시지가 표시될 수 있음, 쓰기 `/var/lib/systemd/linger`).
그런 다음 서비스를 활성화합니다.

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

**대체(시스템 서비스)** - 상시 접속 또는 다중 사용자 서버의 경우 다음을 수행할 수 있습니다.
시스템을 설치하다 **체계** 사용자 단위 대신 단위를 사용합니다(지체할 필요 없음).
만들다 `/etc/systemd/system/openclaw-gateway[-<profile>].service` (위의 단위를 복사하고,
스위치 `WantedBy=multi-user.target`, 세트 `User=` + `WorkingDirectory=`), 그 다음에:

```
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

## 윈도우(WSL2)

Windows 설치에서는 다음을 사용해야 합니다. **WSL2** 위의 Linux systemd 섹션을 따르세요.

## 운영 점검

- 활동성: WS를 열고 보내기 `req:connect` → 기대하다 `res` ~와 함께 `payload.type="hello-ok"` (스냅샷 포함).
- 준비 상태: 전화 `health` → 기대하다 `ok: true` 그리고 연결된 채널은 `linkChannel` (해당되는 경우).
- 디버그: 구독 `tick` 그리고 `presence` 이벤트; 보장하다 `status` 연결된/인증 연령을 표시합니다. 현재 상태 항목에는 게이트웨이 호스트와 연결된 클라이언트가 표시됩니다.

## 안전 보장

- 기본적으로 호스트당 하나의 게이트웨이를 가정합니다. 여러 프로필을 실행하는 경우 포트/상태를 분리하고 올바른 인스턴스를 대상으로 지정하세요.
- Baileys 연결을 직접 대체할 수 없습니다. 게이트웨이가 다운되면 빠른 실패를 보냅니다.
- 연결되지 않은 첫 번째 프레임 또는 잘못된 JSON이 거부되고 소켓이 닫힙니다.
- 정상 종료: 방출 `shutdown` 마감 전 이벤트; 클라이언트는 닫기 + 다시 연결을 처리해야 합니다.

## CLI 도우미

- `openclaw gateway health|status` — 게이트웨이 WS를 통해 상태/상태를 요청합니다.
- `openclaw message send --target <num> --message "hi" [--media ...]` — 게이트웨이를 통해 보냅니다(WhatsApp의 경우 멱등성).
- `openclaw agent --message "hi" --to <num>` — 에이전트 차례를 실행합니다(기본적으로 최종 대기).
- `openclaw gateway call <method> --params '{"k":"v"}'` — 디버깅을 위한 원시 메서드 호출자입니다.
- `openclaw gateway stop|restart` — 감독되는 게이트웨이 서비스(launchd/systemd)를 중지/다시 시작합니다.
- 게이트웨이 도우미 하위 명령은 다음에서 실행 중인 게이트웨이를 가정합니다. `--url`; 더 이상 자동으로 생성되지 않습니다.

## 마이그레이션 지침

- 사용 중지 `openclaw gateway` 레거시 TCP 제어 포트.
- 필수 연결 및 구조화된 존재를 통해 WS 프로토콜을 사용하도록 클라이언트를 업데이트합니다.
