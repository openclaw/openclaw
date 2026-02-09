---
summary: "OpenClaw macOS 컴패니언 앱 (메뉴 바 + 게이트웨이 브로커)"
read_when:
  - macOS 앱 기능을 구현할 때
  - macOS 에서 게이트웨이 라이프사이클 또는 노드 브리징을 변경할 때
title: "macOS 앱"
---

# OpenClaw macOS 컴패니언 (메뉴 바 + 게이트웨이 브로커)

macOS 앱은 OpenClaw 를 위한 **메뉴 바 컴패니언**입니다. 권한을 소유하고,
로컬에서 Gateway(게이트웨이) 를 관리/연결하며 (launchd 또는 수동),
macOS 기능을 노드로서 에이전트에 노출합니다.

## What it does

- 메뉴 바에 네이티브 알림과 상태를 표시합니다.
- TCC 프롬프트(알림, 접근성, 화면 녹화, 마이크,
  음성 인식, 자동화/AppleScript) 를 소유합니다.
- Gateway(게이트웨이) 를 실행하거나 연결합니다(로컬 또는 원격).
- macOS 전용 도구(Canvas, Camera, Screen Recording, `system.run`) 를 노출합니다.
- **원격** 모드에서는 로컬 노드 호스트 서비스를 시작(launchd) 하고, **로컬** 모드에서는 중지합니다.
- 선택적으로 UI 자동화를 위한 **PeekabooBridge** 를 호스팅합니다.
- 요청 시 npm/pnpm 을 통해 전역 CLI(`openclaw`) 를 설치합니다(Gateway 런타임에는 bun 을 권장하지 않습니다).

## 로컬 모드 vs 원격 모드

- **로컬**(기본값): 앱은 실행 중인 로컬 Gateway(게이트웨이) 가 있으면 연결하고,
  없으면 `openclaw gateway install` 를 통해 launchd 서비스를 활성화합니다.
- **원격**: 앱은 SSH/Tailscale 을 통해 Gateway(게이트웨이) 에 연결하며 로컬 프로세스를 시작하지 않습니다.
  앱은 원격 Gateway(게이트웨이) 가 이 Mac 에 접근할 수 있도록 로컬 **노드 호스트 서비스**를 시작합니다.
  앱은 Gateway(게이트웨이) 를 자식 프로세스로 생성하지 않습니다.

## Launchd 제어

앱은 사용자별 LaunchAgent 를 관리하며 레이블은 `bot.molt.gateway` 입니다
(`--profile`/`OPENCLAW_PROFILE` 를 사용할 때는 `bot.molt.<profile>`; 레거시 `com.openclaw.*` 도 여전히 언로드합니다).

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

명명된 프로필을 실행할 때는 레이블을 `bot.molt.<profile>` 로 교체하십시오.

LaunchAgent 가 설치되어 있지 않다면 앱에서 활성화하거나
`openclaw gateway install` 를 실행하십시오.

## 노드 기능(mac)

macOS 앱은 노드로서 자신을 제공합니다. 일반적인 명령은 다음과 같습니다.

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Camera: `camera.snap`, `camera.clip`
- Screen: `screen.record`
- System: `system.run`, `system.notify`

노드는 에이전트가 허용 여부를 판단할 수 있도록 `permissions` 맵을 보고합니다.

노드 서비스 + 앱 IPC:

- 헤드리스 노드 호스트 서비스가 실행 중일 때(원격 모드), Gateway(게이트웨이) WS 에 노드로 연결합니다.
- `system.run` 는 로컬 Unix 소켓을 통해 macOS 앱(UI/TCC 컨텍스트) 에서 실행되며, 프롬프트와 출력은 앱 내에 유지됩니다.

다이어그램(SCI):

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## Exec 승인(system.run)

`system.run` 는 macOS 앱의 **Exec 승인**(설정 → Exec 승인) 으로 제어됩니다.
보안 + 확인 + 허용 목록은 다음 위치의 Mac 로컬에 저장됩니다.

```
~/.openclaw/exec-approvals.json
```

예시:

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

참고 사항:

- `allowlist` 항목은 해석된 바이너리 경로에 대한 glob 패턴입니다.
- 프롬프트에서 “항상 허용”을 선택하면 해당 명령이 허용 목록에 추가됩니다.
- `system.run` 환경 변수 오버라이드는 필터링됩니다(`PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT` 는 제거) 이후 앱의 환경과 병합됩니다.

## 딥 링크

앱은 로컬 동작을 위해 `openclaw://` URL 스킴을 등록합니다.

### `openclaw://agent`

Gateway(게이트웨이) `agent` 요청을 트리거합니다.

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

쿼리 매개변수:

- `message` (필수)
- `sessionKey` (선택)
- `thinking` (선택)
- `deliver` / `to` / `channel` (선택)
- `timeoutSeconds` (선택)
- `key` (무인 모드 키, 선택)

안전성:

- `key` 가 없으면 앱이 확인을 요청합니다.
- 유효한 `key` 가 있으면 실행은 무인으로 처리됩니다(개인 자동화를 의도).

## 온보딩 흐름(일반)

1. **OpenClaw.app** 을 설치하고 실행합니다.
2. 권한 체크리스트(TCC 프롬프트) 를 완료합니다.
3. **로컬** 모드가 활성화되어 있고 Gateway(게이트웨이) 가 실행 중인지 확인합니다.
4. 터미널 접근이 필요하면 CLI 를 설치합니다.

## 빌드 및 개발 워크플로(네이티브)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (또는 Xcode)
- 앱 패키징: `scripts/package-mac-app.sh`

## Gateway(게이트웨이) 연결 디버그(macOS CLI)

앱을 실행하지 않고도 macOS 앱이 사용하는 것과 동일한 Gateway(게이트웨이) WebSocket 핸드셰이크 및
디바이스 검색 로직을 검증하려면 디버그 CLI 를 사용하십시오.

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

연결 옵션:

- `--url <ws://host:port>`: 설정 오버라이드
- `--mode <local|remote>`: 설정에서 해석(기본값: 설정 또는 로컬)
- `--probe`: 새로운 헬스 프로브를 강제
- `--timeout <ms>`: 요청 타임아웃(기본값: `15000`)
- `--json`: 비교를 위한 구조화된 출력

디바이스 검색 옵션:

- `--include-local`: “로컬”로 필터링될 게이트웨이를 포함
- `--timeout <ms>`: 전체 디바이스 검색 윈도우(기본값: `2000`)
- `--json`: 비교를 위한 구조화된 출력

팁: macOS 앱의 디바이스 검색 파이프라인(NWBrowser + tailnet DNS‑SD 폴백) 이
Node CLI 의 `dns-sd` 기반 디바이스 검색과 다른지 확인하려면 `openclaw gateway discover --json` 와 비교하십시오.

## 원격 연결 배관(SSH 터널)

macOS 앱이 **원격** 모드로 실행될 때, 로컬 UI 구성 요소가 원격 Gateway(게이트웨이) 와
localhost 에 있는 것처럼 통신할 수 있도록 SSH 터널을 엽니다.

### 제어 터널(Gateway WebSocket 포트)

- **목적:** 헬스 체크, 상태, Web Chat, 설정 및 기타 제어 플레인 호출.
- **로컬 포트:** Gateway(게이트웨이) 포트(기본값 `18789`), 항상 고정.
- **원격 포트:** 원격 호스트의 동일한 Gateway(게이트웨이) 포트.
- **동작:** 임의의 로컬 포트를 사용하지 않으며, 기존의 정상 터널을 재사용하거나 필요 시 재시작합니다.
- **SSH 형태:** BatchMode +
  ExitOnForwardFailure + keepalive 옵션을 사용하는 `ssh -N -L <local>:127.0.0.1:<remote>`.
- **IP 보고:** SSH 터널은 loopback 을 사용하므로, 게이트웨이는 노드 IP 를 `127.0.0.1` 로 인식합니다. 실제 클라이언트 IP 가 표시되도록 하려면 **Direct (ws/wss)** 전송을 사용하십시오([macOS 원격 액세스](/platforms/mac/remote) 참조).

설정 단계는 [macOS 원격 액세스](/platforms/mac/remote) 를, 프로토콜 세부 사항은 [Gateway 프로토콜](/gateway/protocol) 을 참고하십시오. 39. 프로토콜 세부 정보는 [Gateway protocol](/gateway/protocol)을 참조하세요.

## 관련 문서

- [Gateway 런북](/gateway)
- [Gateway(macOS)](/platforms/mac/bundled-gateway)
- [macOS 권한](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
