---
summary: "OpenClaw macOS 동반 앱 (메뉴 막대 + 게이트웨이 브로커)"
read_when:
  - macOS 앱 기능 구현
  - 게이트웨이 수명 주기 또는 macOS에서 노드 브리징 변경
title: "macOS App"
---

# OpenClaw macOS Companion (메뉴 막대 + 게이트웨이 브로커)

macOS 앱은 OpenClaw의 **메뉴 막대 동반 앱**입니다. 권한을 소유하고, 로컬에서 게이트웨이를 관리/연결(launchd 또는 수동)하며, 에이전트에게 노드로서 macOS 기능을 노출합니다.

## 기능

- 메뉴 막대에 네이티브 알림과 상태를 표시합니다.
- TCC 프롬프트(알림, 접근성, 화면 녹화, 마이크, 음성 인식, 자동화/AppleScript)를 소유합니다.
- 게이트웨이를 로컬 또는 원격으로 실행하거나 연결합니다.
- macOS 전용 도구(Canvas, Camera, Screen Recording, `system.run`을 노출합니다).
- **원격** 모드에서 로컬 노드 호스트 서비스를 시작하고, **로컬** 모드에서 중지합니다.
- UI 자동화를 위해 **PeekabooBridge**를 선택적으로 호스팅합니다.
- 요청 시 npm/pnpm을 통해 전역 CLI(`openclaw`)를 설치합니다(Gateway 런타임에는 bun 권장되지 않음).

## 로컬 vs 원격 모드

- **로컬**(기본값): 실행 중인 로컬 게이트웨이에 앱이 연결되고, 그렇지 않은 경우 `openclaw gateway install`을 통해 launchd 서비스를 활성화합니다.
- **원격**: 앱이 SSH/Tailscale을 통해 게이트웨이에 연결되며, 로컬 프로세스를 시작하지 않습니다.
  앱이 로컬 **노드 호스트 서비스**를 시작하여 원격 게이트웨이가 이 Mac에 도달할 수 있습니다.
  앱은 게이트웨이를 자식 프로세스로 스폰하지 않습니다.

## Launchd 제어

앱은 `bot.molt.gateway` 라벨의 사용자 별 LaunchAgent를 관리합니다(`--profile`/`OPENCLAW_PROFILE` 사용 시 `bot.molt.<profile>`; 이전 `com.openclaw.*`는 여전히 언로드됨).

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

명명된 프로필을 실행할 때 라벨을 `bot.molt.<profile>`로 교체하십시오.

LaunchAgent가 설치되어 있지 않으면, 앱에서 활성화하거나
`openclaw gateway install`을 실행합니다.

## 노드 기능 (mac)

macOS 앱은 노드로 자신을 나타냅니다. 일반적인 명령어:

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Camera: `camera.snap`, `camera.clip`
- Screen: `screen.record`
- System: `system.run`, `system.notify`

노드는 `permissions` 맵을 보고하여 에이전트가 허용할 수 있는 항목을 결정할 수 있습니다.

노드 서비스 + 앱 IPC:

- 헤드리스 노드 호스트 서비스가 실행 중일 때(원격 모드), 게이트웨이 WS에 노드로 연결됩니다.
- 로컬 Unix 소켓을 통해 macOS 앱(UI/TCC 컨텍스트)에서 `system.run`이 실행됩니다; 프롬프트 + 출력은 앱 내에 유지됩니다.

도표 (SCI):

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## 실행 승인 (system.run)

`system.run`은 macOS 앱에서 **실행 승인**으로 제어됩니다(설정 → 실행 승인).
보안 + 요청 + 허용 목록은 Mac의 로컬에 저장됩니다:

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

노트:

- `allowlist` 항목들은 해석된 바이너리 경로의 glob 패턴입니다.
- 프롬프트의 "항상 허용"을 선택하면 해당 명령어가 허용 목록에 추가됩니다.
- `system.run` 환경 오버라이드는 필터링되고 (`PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT`를 드롭) 앱의 환경과 병합됩니다.

## 심층 링크

앱은 로컬 작업을 위한 `openclaw://` URL 스키마를 등록합니다.

### `openclaw://agent`

게이트웨이 `agent` 요청을 트리거합니다.

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

쿼리 매개변수:

- `message` (필수)
- `sessionKey` (선택 사항)
- `thinking` (선택 사항)
- `deliver` / `to` / `channel` (선택 사항)
- `timeoutSeconds` (선택 사항)
- `key` (선택적 비감독 모드 키)

안전성:

- `key`가 없으면 앱은 확인을 요청합니다.
- `key`가 없으면 앱은 확인 프롬프트를 위해 짧은 메시지 제한을 강제하고 `deliver` / `to` / `channel`을 무시합니다.
- 유효한 `key`가 있으면 실행은 비감독 모드입니다(개인 자동화를 위해 의도됨).

## 온보딩 흐름 (일반적인)

1. **OpenClaw.app**을 설치하고 실행합니다.
2. 권한 체크리스트(TCC 프롬프트)를 완료합니다.
3. **로컬** 모드가 활성화되고 게이트웨이가 실행 중인지 확인합니다.
4. 터미널 접근을 원하시면 CLI를 설치합니다.

## 빌드 & 개발 워크플로우 (네이티브)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (또는 Xcode)
- 앱 패키지: `scripts/package-mac-app.sh`

## 게이트웨이 연결 디버그 (macOS CLI)

디버그 CLI를 사용하여 앱을 실행하지 않고도 macOS 앱이 사용하는 동일한 게이트웨이 WebSocket 핸드셰이크 및 검색 로직을 실행합니다.

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

연결 옵션:

- `--url <ws://host:port>`: 구성 무시
- `--mode <local|remote>`: 구성을 통해 확인 (기본값: 구성 또는 로컬)
- `--probe`: 새 건강 상태 프로브 강제
- `--timeout <ms>`: 요청 시간 초과 (기본값: `15000`)
- `--json`: 차등 출력을 위한 구조적 출력

검색 옵션:

- `--include-local`: "로컬"로 필터링될 게이트웨이를 포함
- `--timeout <ms>`: 전체 검색 창 (기본값: `2000`)
- `--json`: 차등 출력을 위한 구조적 출력

팁: Node CLI의 `dns-sd` 기반 검색과 macOS 앱의 검색 파이프라인(NWBrowser + tailnet DNS‑SD 폴백)이 다른지 확인하려면 `openclaw gateway discover --json`과 비교하십시오.

## 원격 연결 배관 (SSH 터널)

macOS 앱이 **원격** 모드로 실행될 때 로컬 UI 컴포넌트가 원격 게이트웨이와 로컬호스트와 같이 통신할 수 있도록 SSH 터널을 엽니다.

### 제어 터널 (게이트웨이 WebSocket 포트)

- **목적:** 상태 확인, 상태, 웹 채팅, 구성 및 기타 제어 평면 호출
- **로컬 포트:** 게이트웨이 포트 (기본값 `18789`), 항상 안정적
- **원격 포트:** 원격 호스트의 동일한 게이트웨이 포트
- **동작:** 임의의 로컬 포트 없음; 앱은 기존의 건강한 터널을 재사용하거나 필요 시 재시작합니다.
- **SSH 형식:** `ssh -N -L <local>:127.0.0.1:<remote>` BatchMode + ExitOnForwardFailure + keepalive 옵션 포함
- **IP 보고:** SSH 터널은 루프백을 사용하므로 게이트웨이는 노드 IP를 `127.0.0.1`로 봅니다. 실제 클라이언트 IP가 표시되기를 원한다면 **Direct (ws/wss)** 전송을 사용하십시오 ([macOS 원격 접속](/ko-KR/platforms/mac/remote) 참조).

설정 단계는 [macOS 원격 접속](/ko-KR/platforms/mac/remote)을 참조하십시오. 프로토콜 세부 사항은 [게이트웨이 프로토콜](/ko-KR/gateway/protocol)을 참조하십시오.

## 관련 문서

- [게이트웨이 런북](/ko-KR/gateway)
- [게이트웨이 (macOS)](/ko-KR/platforms/mac/bundled-gateway)
- [macOS 권한](/ko-KR/platforms/mac/permissions)
- [Canvas](/ko-KR/platforms/mac/canvas)