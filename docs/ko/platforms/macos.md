---
read_when:
    - macOS 앱 기능 구현
    - macOS에서 게이트웨이 수명 주기 또는 노드 브리징 변경
summary: OpenClaw macOS 동반 앱(메뉴 표시줄 + 게이트웨이 브로커)
title: macOS 앱
x-i18n:
    generated_at: "2026-02-08T16:00:52Z"
    model: gtx
    provider: google-translate
    source_hash: a5b1c02e5905e4cbc6c0688149cdb50a5bf7653e641947143e169ad948d1f057
    source_path: platforms/macos.md
    workflow: 15
---

# OpenClaw macOS Companion(메뉴 표시줄 + 게이트웨이 브로커)

macOS 앱은 **메뉴바 컴패니언** OpenClaw용. 권한을 소유하고 있습니다.
게이트웨이를 로컬로 관리/연결하고(launchd 또는 수동으로) macOS를 노출합니다.
에이전트에 노드로서의 기능을 제공합니다.

## 기능

- 메뉴 표시줄에 기본 알림 및 상태가 표시됩니다.
- TCC 프롬프트(알림, 접근성, 화면 녹화, 마이크,
  음성 인식, 자동화/AppleScript).
- 게이트웨이(로컬 또는 원격)를 실행하거나 연결합니다.
- macOS 전용 도구(캔버스, 카메라, 화면 녹화, `system.run`).
- 로컬 노드 호스트 서비스를 시작합니다. **원격** 모드(launchd)를 실행하고 중지합니다. **현지의** 방법.
- 선택적으로 호스트 **까꿍다리** UI 자동화를 위한 것입니다.
- 전역 CLI를 설치합니다(`openclaw`) 요청 시 npm/pnpm을 통해(게이트웨이 런타임에는 권장되지 않음)

## 로컬 대 원격 모드

- **현지의** (기본값): 앱이 실행 중인 로컬 게이트웨이(있는 경우)에 연결됩니다.
  그렇지 않으면 다음을 통해 시작된 서비스를 활성화합니다. `openclaw gateway install`.
- **원격**: 앱이 SSH/Tailscale을 통해 게이트웨이에 연결되고 시작되지 않습니다.
  로컬 프로세스.
  앱이 로컬을 시작합니다. **노드 호스트 서비스** 그러면 원격 게이트웨이가 이 Mac에 도달할 수 있습니다.
  앱은 게이트웨이를 하위 프로세스로 생성하지 않습니다.

## 출시된 제어

앱은 라벨이 붙은 사용자별 LaunchAgent를 관리합니다. `bot.molt.gateway`
(또는 `bot.molt.<profile>` 사용할 때 `--profile`/`OPENCLAW_PROFILE`; 유산 `com.openclaw.*` 여전히 언로드됩니다).

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

라벨을 다음으로 교체하세요. `bot.molt.<profile>` 명명된 프로필을 실행할 때.

LaunchAgent가 설치되어 있지 않은 경우 앱에서 활성화하거나 실행하세요.
`openclaw gateway install`.

## 노드 기능(mac)

macOS 앱은 자체적으로 노드로 표시됩니다. 일반적인 명령:

- 캔버스: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- 카메라: `camera.snap`, `camera.clip`
- 화면: `screen.record`
- 체계: `system.run`, `system.notify`

노드는 다음을 보고합니다. `permissions` 상담원이 무엇이 허용되는지 결정할 수 있도록 지도를 작성하세요.

노드 서비스 + 앱 IPC:

- 헤드리스 노드 호스트 서비스가 실행 중일 때(원격 모드) 게이트웨이 WS에 노드로 연결됩니다.
- `system.run` 로컬 Unix 소켓을 통해 macOS 앱(UI/TCC 컨텍스트)에서 실행됩니다. 프롬프트 + 출력은 앱 내에 유지됩니다.

다이어그램(SCI):

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## 임원 승인(system.run)

`system.run` 에 의해 제어됩니다 **임원 승인** macOS 앱에서(설정 → Exec 승인)
보안 + 질문 + 허용 목록은 Mac의 다음 위치에 로컬로 저장됩니다.

```
~/.openclaw/exec-approvals.json
```

예:

```json
{
  "version": 1,
  "defaults": {
    "security": "deny",
    "ask": "on-miss"
  },
  "agents": {
    "main": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [{ "pattern": "/opt/homebrew/bin/rg" }]
    }
  }
}
```

참고:

- `allowlist` 항목은 확인된 바이너리 경로에 대한 glob 패턴입니다.
- 프롬프트에서 “항상 허용”을 선택하면 해당 명령이 허용 목록에 추가됩니다.
- `system.run` 환경 재정의가 필터링됩니다(삭제 `PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT`) 그런 다음 앱 환경과 병합됩니다.

## 딥링크

앱이 다음을 등록합니다. `openclaw://` 로컬 작업을 위한 URL 구성표입니다.

### `openclaw://agent`

게이트웨이를 트리거합니다. `agent` 요구.

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

쿼리 매개변수:

- `message` (필수의)
- `sessionKey` (선택 과목)
- `thinking` (선택 과목)
- `deliver`/`to`/`channel` (선택 과목)
- `timeoutSeconds` (선택 과목)
- `key` (선택적 무인 모드 키)

안전:

- 없이 `key`, 앱에서 확인 메시지를 표시합니다.
- 유효한 `key`, 실행은 무인입니다(개인 자동화용).

## 온보딩 흐름(일반)

1. 설치 및 실행 **OpenClaw.app**.
2. 권한 체크리스트를 완료하십시오(TCC 프롬프트).
3. 보장하다 **현지의** 모드가 활성화되어 있고 게이트웨이가 실행 중입니다.
4. 터미널 액세스를 원할 경우 CLI를 설치하세요.

## 빌드 및 개발 워크플로(기본)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (또는 Xcode)
- 패키지 앱: `scripts/package-mac-app.sh`

## 게이트웨이 연결 디버그(macOS CLI)

디버그 CLI를 사용하여 동일한 Gateway WebSocket 핸드셰이크 및 검색을 실행합니다.
macOS 앱이 앱을 실행하지 않고 사용하는 논리입니다.

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

연결 옵션:

- `--url <ws://host:port>`: 구성 재정의
- `--mode <local|remote>`: 구성에서 확인(기본값: 구성 또는 로컬)
- `--probe`: 새로운 상태 프로브를 강제 실행합니다.
- `--timeout <ms>`: 요청 시간 초과(기본값: `15000`)
- `--json`: 비교를 위한 구조화된 출력

검색 옵션:

- `--include-local`: "로컬"로 필터링되는 게이트웨이를 포함합니다.
- `--timeout <ms>`: 전체 검색 창(기본값: `2000`)
- `--json`: 비교를 위한 구조화된 출력

팁: 비교 `openclaw gateway discover --json` 여부를 확인하기 위해
macOS 앱의 검색 파이프라인(NWBrowser + tailnet DNS-SD 대체)이 다음과 다릅니다.
노드 CLI `dns-sd` 기반 발견.

## 원격 연결 배관(SSH 터널)

macOS 앱이 실행될 때 **원격** 모드에서는 SSH 터널이 열리므로 로컬 UI
구성 요소는 마치 로컬 호스트에 있는 것처럼 원격 게이트웨이와 통신할 수 있습니다.

### 제어 터널(게이트웨이 WebSocket 포트)

- **목적:** 상태 확인, 상태, 웹 채팅, 구성 및 기타 제어 영역 호출.
- **로컬 포트:** 게이트웨이 포트(기본값 `18789`), 항상 안정적입니다.
- **원격 포트:** 원격 호스트의 동일한 게이트웨이 포트.
- **행동:** 임의의 로컬 포트가 없습니다. 앱이 기존의 정상 터널을 재사용합니다.
  또는 필요한 경우 다시 시작합니다.
- **SSH 모양:** `ssh -N -L <local>:127.0.0.1:<remote>` BatchMode + 사용
  ExitOnForwardFailure + keepalive 옵션.
- **IP 보고:** SSH 터널은 루프백을 사용하므로 게이트웨이는 노드를 볼 수 있습니다
  IP로 `127.0.0.1`. 사용 **직접(ws/wss)** 실제 고객을 원하는 경우 운송
  나타날 IP(참조 [macOS 원격 액세스](/platforms/mac/remote)).

설정 단계는 다음을 참조하세요. [macOS 원격 액세스](/platforms/mac/remote). 프로토콜의 경우
자세한 내용은 참조하세요 [게이트웨이 프로토콜](/gateway/protocol).

## 관련 문서

- [게이트웨이 런북](/gateway)
- [게이트웨이(macOS)](/platforms/mac/bundled-gateway)
- [macOS 권한](/platforms/mac/permissions)
- [캔버스](/platforms/mac/canvas)
