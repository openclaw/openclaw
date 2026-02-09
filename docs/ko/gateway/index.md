---
summary: "Gateway 서비스의 런북, 수명 주기 및 운영 가이드"
read_when:
  - Gateway 프로세스를 실행하거나 디버깅할 때
title: "Gateway 런북"
---

# Gateway 서비스 런북

마지막 업데이트: 2025-12-09

## 무엇인가요

- 단일 Baileys/Telegram 연결과 제어/이벤트 플레인을 소유하는 항상 실행되는 프로세스입니다.
- 레거시 `gateway` 명령을 대체합니다. CLI 진입점: `openclaw gateway`.
- 중지될 때까지 실행되며, 치명적 오류 시 non-zero 코드로 종료되어 감독자가 재시작합니다.

## 실행 방법 (로컬)

```bash
openclaw gateway --port 18789
# for full debug/trace logs in stdio:
openclaw gateway --port 18789 --verbose
# if the port is busy, terminate listeners then start:
openclaw gateway --force
# dev loop (auto-reload on TS changes):
pnpm gateway:watch
```

- 구성 핫 리로드는 `~/.openclaw/openclaw.json` (또는 `OPENCLAW_CONFIG_PATH`)를 감시합니다.
  - 기본 모드: `gateway.reload.mode="hybrid"` (안전한 변경은 핫 적용, 중요 변경은 재시작).
  - 핫 리로드는 필요 시 **SIGUSR1**을 통한 프로세스 내 재시작을 사용합니다.
  - `gateway.reload.mode="off"`로 비활성화할 수 있습니다.
- WebSocket 제어 플레인을 `127.0.0.1:<port>`에 바인딩합니다 (기본값 18789).
- 동일한 포트에서 HTTP도 제공합니다 (제어 UI, 훅, A2UI). 단일 포트 멀티플렉스입니다.
  - OpenAI Chat Completions (HTTP): [`/v1/chat/completions`](/gateway/openai-http-api).
  - OpenResponses (HTTP): [`/v1/responses`](/gateway/openresponses-http-api).
  - Tools Invoke (HTTP): [`/tools/invoke`](/gateway/tools-invoke-http-api).
- 기본적으로 `canvasHost.port`에서 Canvas 파일 서버를 시작합니다 (기본값 `18793`), `~/.openclaw/workspace/canvas`에서 `http://<gateway-host>:18793/__openclaw__/canvas/`를 제공합니다. `canvasHost.enabled=false` 또는 `OPENCLAW_SKIP_CANVAS_HOST=1`로 비활성화할 수 있습니다.
- 로그는 stdout으로 출력되며, launchd/systemd를 사용해 프로세스를 유지하고 로그를 순환하십시오.
- 문제 해결 시 `--verbose`을 전달하면 로그 파일의 디버그 로깅(핸드셰이크, 요청/응답, 이벤트)을 stdio로 미러링합니다.
- `--force`는 선택한 포트에서 리스너를 찾기 위해 `lsof`를 사용하고, SIGTERM을 보내며, 종료한 항목을 로그로 남긴 뒤 Gateway를 시작합니다 (`lsof`가 없으면 즉시 실패).
- 감독자(launchd/systemd/mac 앱 자식 프로세스 모드) 하에서 실행 중인 경우, 중지/재시작은 일반적으로 **SIGTERM**을 보냅니다. 이전 빌드에서는 이를 `pnpm` `ELIFECYCLE` 종료 코드 **143** (SIGTERM)으로 표시할 수 있으며, 이는 크래시가 아닌 정상 종료입니다.
- **SIGUSR1**은 권한이 있는 경우 프로세스 내 재시작을 트리거합니다 (Gateway 도구/구성 적용/업데이트 또는 수동 재시작을 위해 `commands.restart` 활성화).
- Gateway 인증은 기본적으로 필요합니다: `gateway.auth.token` (또는 `OPENCLAW_GATEWAY_TOKEN`) 또는 `gateway.auth.password`를 설정하십시오. 클라이언트는 Tailscale Serve ID를 사용하지 않는 한 `connect.params.auth.token/password`을 전송해야 합니다.
- 마법사는 이제 loopback에서도 기본적으로 토큰을 생성합니다.
- 포트 우선순위: `--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > 기본값 `18789`.

## 원격 접근

- Tailscale/VPN을 권장하며, 그렇지 않으면 SSH 터널을 사용하십시오:

  ```bash
  ssh -N -L 18789:127.0.0.1:18789 user@host
  ```

- 이후 클라이언트는 터널을 통해 `ws://127.0.0.1:18789`에 연결합니다.

- 토큰이 구성된 경우, 터널을 통해서도 클라이언트는 `connect.params.auth.token`에 이를 포함해야 합니다.

## 다중 Gateway (동일 호스트)

대부분 불필요합니다. 하나의 Gateway로 여러 메시징 채널과 에이전트를 서비스할 수 있습니다. 중복성이나 엄격한 격리(예: 구조용 봇)가 필요한 경우에만 여러 Gateway를 사용하십시오.

상태와 구성을 분리하고 고유한 포트를 사용하면 지원됩니다. 전체 가이드: [Multiple gateways](/gateway/multiple-gateways).

서비스 이름은 프로필을 인식합니다:

- macOS: `bot.molt.<profile>` (레거시 `com.openclaw.*`가 여전히 존재할 수 있음)
- Linux: `openclaw-gateway-<profile>.service`
- Windows: `OpenClaw Gateway (<profile>)`

설치 메타데이터는 서비스 구성에 포함됩니다:

- `OPENCLAW_SERVICE_MARKER=openclaw`
- `OPENCLAW_SERVICE_KIND=gateway`
- `OPENCLAW_SERVICE_VERSION=<version>`

Rescue-Bot 패턴: 자체 프로필, 상태 디렉토리, 워크스페이스 및 기본 포트 간격을 가진 두 번째 Gateway를 격리해 유지하십시오. 전체 가이드: [Rescue-bot guide](/gateway/multiple-gateways#rescue-bot-guide).

### Dev 프로필 (`--dev`)

빠른 경로: 기본 설정을 건드리지 않고 완전히 격리된 개발 인스턴스(구성/상태/워크스페이스)를 실행합니다.

```bash
openclaw --dev setup
openclaw --dev gateway --allow-unconfigured
# then target the dev instance:
openclaw --dev status
openclaw --dev health
```

기본값 (env/플래그/구성으로 재정의 가능):

- `OPENCLAW_STATE_DIR=~/.openclaw-dev`
- `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
- `OPENCLAW_GATEWAY_PORT=19001` (Gateway WS + HTTP)
- 브라우저 제어 서비스 포트 = `19003` (파생: `gateway.port+2`, loopback 전용)
- `canvasHost.port=19005` (파생: `gateway.port+4`)
- `agents.defaults.workspace`의 기본값은 `--dev` 하에서 `setup`/`onboard`를 실행하면 `~/.openclaw/workspace-dev`로 변경됩니다.

파생 포트 (경험칙):

- 기본 포트 = `gateway.port` (또는 `OPENCLAW_GATEWAY_PORT` / `--port`)
- 브라우저 제어 서비스 포트 = 기본값 + 2 (loopback 전용)
- `canvasHost.port = base + 4` (또는 `OPENCLAW_CANVAS_HOST_PORT` / 구성 재정의)
- 브라우저 프로필 CDP 포트는 `browser.controlPort + 9 .. + 108`부터 자동 할당됩니다 (프로필별로 유지).

인스턴스별 체크리스트:

- 고유한 `gateway.port`
- 고유한 `OPENCLAW_CONFIG_PATH`
- 고유한 `OPENCLAW_STATE_DIR`
- 고유한 `agents.defaults.workspace`
- 별도의 WhatsApp 번호 (WA 사용 시)

프로필별 서비스 설치:

```bash
openclaw --profile main gateway install
openclaw --profile rescue gateway install
```

예시:

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json OPENCLAW_STATE_DIR=~/.openclaw-a openclaw gateway --port 19001
OPENCLAW_CONFIG_PATH=~/.openclaw/b.json OPENCLAW_STATE_DIR=~/.openclaw-b openclaw gateway --port 19002
```

## 프로토콜 (운영자 관점)

- 전체 문서: [Gateway protocol](/gateway/protocol) 및 [Bridge protocol (legacy)](/gateway/bridge-protocol).
- 클라이언트의 필수 첫 프레임: `req {type:"req", id, method:"connect", params:{minProtocol,maxProtocol,client:{id,displayName?,version,platform,deviceFamily?,modelIdentifier?,mode,instanceId?}, caps, auth?, locale?, userAgent? } }`.
- Gateway는 `res {type:"res", id, ok:true, payload:hello-ok }`로 응답합니다 (또는 오류 시 `ok:false` 후 종료).
- 핸드셰이크 이후:
  - 요청: `{type:"req", id, method, params}` → `{type:"res", id, ok, payload|error}`
  - 이벤트: `{type:"event", event, payload, seq?, stateVersion?}`
- 구조화된 presence 항목: `{host, ip, version, platform?, deviceFamily?, modelIdentifier?, mode, lastInputSeconds?, ts, reason?, tags?[], instanceId? }` (WS 클라이언트의 경우 `instanceId`는 `connect.client.instanceId`에서 옵니다).
- `agent` 응답은 2단계입니다: 먼저 `res` ack `{runId,status:"accepted"}`, 이후 실행이 끝나면 최종 `res` `{runId,status:"ok"|"error",summary}`; 스트리밍 출력은 `event:"agent"`로 도착합니다.

## 메서드 (초기 세트)

- `health` — 전체 상태 스냅샷 (`openclaw health --json`와 동일한 형태).
- `status` — 간단 요약.
- `system-presence` — 현재 presence 목록.
- `system-event` — presence/시스템 노트 게시(구조화).
- `send` — 활성 채널을 통해 메시지 전송.
- `agent` — 에이전트 턴 실행 (동일 연결로 이벤트 스트림).
- `node.list` — 페어링된 + 현재 연결된 노드 목록 (`caps`, `deviceFamily`, `modelIdentifier`, `paired`, `connected` 및 광고된 `commands` 포함).
- `node.describe` — 노드 설명 (기능 + 지원되는 `node.invoke` 명령; 페어링된 노드와 현재 연결된 미페어링 노드 모두에 대해 작동).
- `node.invoke` — 노드의 명령 호출 (예: `canvas.*`, `camera.*`).
- `node.pair.*` — 페어링 수명 주기 (`request`, `list`, `approve`, `reject`, `verify`).

또한 참조: presence가 어떻게 생성/중복 제거되는지와 안정적인 `client.instanceId`가 중요한 이유는 [Presence](/concepts/presence)를 참고하십시오.

## 이벤트

- `agent` — 에이전트 실행에서 스트리밍되는 도구/출력 이벤트 (시퀀스 태그 포함).
- `presence` — presence 업데이트 (stateVersion을 포함한 델타)가 모든 연결된 클라이언트로 푸시됩니다.
- `tick` — 주기적인 keepalive/no-op로 생존 여부를 확인합니다.
- `shutdown` — Gateway가 종료 중임을 알림; 페이로드에는 `reason` 및 선택적으로 `restartExpectedMs`가 포함됩니다. 클라이언트는 재연결해야 합니다.

## WebChat 통합

- WebChat은 히스토리, 전송, 중단 및 이벤트를 위해 Gateway WebSocket과 직접 통신하는 네이티브 SwiftUI UI입니다.
- 원격 사용은 동일한 SSH/Tailscale 터널을 사용하며, gateway 토큰이 구성된 경우 클라이언트는 `connect` 동안 이를 포함합니다.
- macOS 앱은 단일 WS(공유 연결)로 연결하며, 초기 스냅샷에서 presence를 하이드레이션하고 `presence` 이벤트를 수신해 UI를 업데이트합니다.

## 타이핑 및 검증

- 서버는 모든 수신 프레임을 프로토콜 정의에서 생성된 JSON Schema에 대해 AJV로 검증합니다.
- 클라이언트(TS/Swift)는 생성된 타입을 소비합니다(TS는 직접, Swift는 저장소의 생성기를 통해).
- 프로토콜 정의가 단일 진실의 원천입니다. 다음으로 스키마/모델을 재생성하십시오:
  - `pnpm protocol:gen`
  - `pnpm protocol:gen:swift`

## 연결 스냅샷

- `hello-ok`에는 `snapshot`가 포함되며, `presence`, `health`, `stateVersion`, `uptimeMs`와 `policy {maxPayload,maxBufferedBytes,tickIntervalMs}`가 포함되어 추가 요청 없이 즉시 렌더링할 수 있습니다.
- `health`/`system-presence`는 수동 새로 고침을 위해 계속 제공되지만, 연결 시 필수는 아닙니다.

## 오류 코드 (res.error 형태)

- 오류는 `{ code, message, details?, retryable?, retryAfterMs? }`를 사용합니다.
- 표준 코드:
  - `NOT_LINKED` — WhatsApp 인증되지 않음.
  - `AGENT_TIMEOUT` — 구성된 마감 시간 내에 에이전트가 응답하지 않음.
  - `INVALID_REQUEST` — 스키마/매개변수 검증 실패.
  - `UNAVAILABLE` — Gateway가 종료 중이거나 의존성이 사용 불가.

## Keepalive 동작

- `tick` 이벤트(또는 WS ping/pong)는 트래픽이 없을 때도 Gateway가 살아 있음을 알리기 위해 주기적으로 전송됩니다.
- 전송/에이전트 승인 응답은 별도의 응답으로 유지되며, tick을 전송에 과도하게 사용하지 마십시오.

## 재생 / 간격

- 이벤트는 재생되지 않습니다. 클라이언트는 시퀀스 간격을 감지하고 계속하기 전에 (`health` + `system-presence`)로 새로 고쳐야 합니다. WebChat 및 macOS 클라이언트는 이제 간격 발생 시 자동 새로 고침을 수행합니다.

## 감독 (macOS 예시)

- launchd를 사용해 서비스를 유지하십시오:
  - Program: `openclaw`의 경로
  - Arguments: `gateway`
  - KeepAlive: true
  - StandardOut/Err: 파일 경로 또는 `syslog`
- 실패 시 launchd가 재시작하며, 치명적 구성 오류는 운영자가 인지하도록 계속 종료되어야 합니다.
- LaunchAgents는 사용자별이며 로그인된 세션이 필요합니다. 헤드리스 환경에서는 커스텀 LaunchDaemon을 사용하십시오(미제공).
  - `openclaw gateway install`는 `~/Library/LaunchAgents/bot.molt.gateway.plist`를 작성합니다
    (또는 `bot.molt.<profile>.plist`; 레거시 `com.openclaw.*`은 정리됩니다).
  - `openclaw doctor`는 LaunchAgent 구성을 감사하고 현재 기본값으로 업데이트할 수 있습니다.

## Gateway 서비스 관리 (CLI)

설치/시작/중지/재시작/상태에는 Gateway CLI를 사용하십시오:

```bash
openclaw gateway status
openclaw gateway install
openclaw gateway stop
openclaw gateway restart
openclaw logs --follow
```

참고 사항:

- `gateway status`는 기본적으로 서비스의 해석된 포트/구성을 사용해 Gateway RPC를 프로브합니다(`--url`로 재정의 가능).
- `gateway status --deep`는 시스템 수준 스캔(LaunchDaemons/systemd 유닛)을 추가합니다.
- `gateway status --no-probe`는 RPC 프로브를 건너뜁니다(네트워킹이 다운된 경우 유용).
- `gateway status --json`는 스크립트용으로 안정적입니다.
- `gateway status`는 **감독자 런타임**(launchd/systemd 실행 중)과 **RPC 도달성**(WS 연결 + 상태 RPC)을 별도로 보고합니다.
- `gateway status`는 “localhost vs LAN 바인드” 혼동과 프로필 불일치를 피하기 위해 구성 경로 + 프로브 대상을 출력합니다.
- `gateway status`는 서비스가 실행 중으로 보이나 포트가 닫혀 있을 때 마지막 Gateway 오류 라인을 포함합니다.
- `logs`는 RPC를 통해 Gateway 파일 로그를 tail 합니다(수동 `tail`/`grep` 불필요).
- 다른 gateway 유사 서비스가 감지되면, OpenClaw 프로필 서비스가 아닌 경우 CLI가 경고합니다.
  대부분의 설정에서는 **머신당 하나의 Gateway**를 권장합니다. 중복성이나 구조용 봇을 위해 격리된 프로필/포트를 사용하십시오. [Multiple gateways](/gateway/multiple-gateways)를 참고하십시오.
  - 정리: `openclaw gateway uninstall` (현재 서비스) 및 `openclaw doctor` (레거시 마이그레이션).
- `gateway install`는 이미 설치된 경우 no-op이며, 재설치하려면 `openclaw gateway install --force`을 사용하십시오(프로필/env/경로 변경).

번들된 mac 앱:

- OpenClaw.app은 Node 기반 gateway 릴레이를 번들링하고, 사용자별 LaunchAgent를
  `bot.molt.gateway` (또는 `bot.molt.<profile>`; 레거시 `com.openclaw.*` 레이블도 정상적으로 언로드됨) 라벨로 설치할 수 있습니다.
- 정상적으로 중지하려면 `openclaw gateway stop` (또는 `launchctl bootout gui/$UID/bot.molt.gateway`)를 사용하십시오.
- 재시작하려면 `openclaw gateway restart` (또는 `launchctl kickstart -k gui/$UID/bot.molt.gateway`)를 사용하십시오.
  - `launchctl`는 LaunchAgent가 설치된 경우에만 동작하며, 그렇지 않으면 먼저 `openclaw gateway install`를 사용하십시오.
  - 명명된 프로필을 실행할 때는 라벨을 `bot.molt.<profile>`로 교체하십시오.

## 감독 (systemd 사용자 유닛)

OpenClaw는 Linux/WSL2에서 기본적으로 **systemd 사용자 서비스**를 설치합니다. 단일 사용자 머신에는 사용자 서비스를 권장합니다(환경 단순, 사용자별 구성).
다중 사용자 또는 항상 실행되는 서버에는 **system 서비스**를 사용하십시오(linger 불필요, 공유 감독).

`openclaw gateway install`는 사용자 유닛을 작성합니다. `openclaw doctor`는 유닛을 감사하고
현재 권장 기본값과 일치하도록 업데이트할 수 있습니다.

`~/.config/systemd/user/openclaw-gateway[-<profile>].service` 생성:

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

linger 활성화(로그아웃/유휴 후에도 사용자 서비스 유지에 필요):

```
sudo loginctl enable-linger youruser
```

온보딩은 Linux/WSL2에서 이를 실행합니다(sudo를 요청할 수 있으며, `/var/lib/systemd/linger`를 작성).
그런 다음 서비스를 활성화하십시오:

```
systemctl --user enable --now openclaw-gateway[-<profile>].service
```

**대안(시스템 서비스)** — 항상 실행되거나 다중 사용자 서버의 경우, 사용자 유닛 대신 systemd **시스템** 유닛을 설치할 수 있습니다(linger 불필요).
`/etc/systemd/system/openclaw-gateway[-<profile>].service`를 생성하고(위 유닛을 복사하여
`WantedBy=multi-user.target`를 전환하고, `User=` + `WorkingDirectory=` 설정), 다음을 실행하십시오:

```
sudo systemctl daemon-reload
sudo systemctl enable --now openclaw-gateway[-<profile>].service
```

## Windows (WSL2)

Windows 설치는 **WSL2**를 사용하고 위의 Linux systemd 섹션을 따르십시오.

## 운영 점검

- 생존성: WS를 열고 `req:connect`를 전송 → `payload.type="hello-ok"`를 포함한 `res`를 기대합니다(스냅샷 포함).
- 준비 상태: `health` 호출 → `ok: true` 및 `linkChannel`에 연결된 채널을 기대합니다(해당 시).
- 디버그: `tick` 및 `presence` 이벤트를 구독하고, `status`에 연결/인증 경과 시간이 표시되는지 확인하십시오. presence 항목에는 Gateway 호스트와 연결된 클라이언트가 표시되어야 합니다.

## 안전 보장

- 기본적으로 호스트당 하나의 Gateway를 가정합니다. 여러 프로필을 실행하는 경우 포트/상태를 격리하고 올바른 인스턴스를 대상으로 하십시오.
- 직접 Baileys 연결로의 폴백은 없습니다. Gateway가 다운되면 전송은 즉시 실패합니다.
- 연결 첫 프레임이 아니거나 잘못된 JSON은 거부되며 소켓이 닫힙니다.
- 정상 종료: 닫기 전에 `shutdown` 이벤트를 발행합니다. 클라이언트는 종료 + 재연결을 처리해야 합니다.

## CLI 헬퍼

- `openclaw gateway health|status` — Gateway WS를 통해 상태/헬스를 요청합니다.
- `openclaw message send --target <num> --message "hi" [--media ...]` — Gateway를 통해 전송합니다(WhatsApp에 대해 멱등).
- `openclaw agent --message "hi" --to <num>` — 에이전트 턴을 실행합니다(기본적으로 최종 결과를 대기).
- `openclaw gateway call <method> --params '{"k":"v"}'` — 디버깅을 위한 원시 메서드 호출기.
- `openclaw gateway stop|restart` — 감독된 gateway 서비스(launchd/systemd)를 중지/재시작합니다.
- Gateway 헬퍼 하위 명령은 `--url`에서 실행 중인 gateway를 가정하며, 더 이상 자동으로 생성하지 않습니다.

## 마이그레이션 가이드

- `openclaw gateway` 및 레거시 TCP 제어 포트 사용을 중단하십시오.
- 필수 연결과 구조화된 presence를 사용하는 WS 프로토콜을 사용하도록 클라이언트를 업데이트하십시오.
