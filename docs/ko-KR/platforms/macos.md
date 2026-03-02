---
summary: "OpenClaw macOS 동반 앱 (메뉴 막대 + Gateway 브로커)"
read_when:
  - macOS 앱 기능을 구현할 때
  - macOS 에서 Gateway 라이프사이클 또는 노드 브릿징을 변경할 때
title: "macOS 앱"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: platforms/macos.md
  workflow: 15
---

# OpenClaw macOS 동반 (메뉴 막대 + Gateway 브로커)

macOS 앱은 OpenClaw 의 **메뉴 막대 동반입니다**. 권한을 소유하고, 로컬 (launchd 또는 수동) 으로 Gateway 를 관리/연결하며, macOS 기능을 노드로 에이전트에 노출합니다.

## 하는 일

- 메뉴 막대에서 기본 알림 및 상태를 표시합니다.
- TCC 프롬프트를 소유합니다 (알림, 접근성, 화면 기록, 마이크, 음성 인식, 자동화/AppleScript).
- Gateway 를 실행하거나 연결합니다 (로컬 또는 원격).
- macOS 전용 도구를 노출합니다 (Canvas, Camera, Screen Recording, `system.run`).
- 로컬 모드에서 로컬 노드 호스트 서비스를 시작하고 원격 모드에서 중지합니다.
- 선택적으로 **PeekabooBridge** 를 호스트합니다 (UI 자동화의 경우).
- 요청 시 전역 CLI (`openclaw`) 를 npm/pnpm 을 통해 설치합니다 (Bun 은 Gateway 런타임에 권장되지 않음).

## 로컬 대 원격 모드

- **로컬** (기본값): 앱이 실행 중인 로컬 Gateway 에 연결합니다 (있을 경우);
  그 외에 launchd 서비스를 `openclaw gateway install` 로 활성화합니다.
- **원격**: 앱이 SSH/Tailscale 을 통해 원격 Gateway 에 연결하고 로컬 프로세스를 시작하지 않습니다.
  앱이 로컬 **노드 호스트 서비스** 를 시작하므로 원격 Gateway 가 이 Mac 에 연결할 수 있습니다.
  앱이 Gateway 를 자식 프로세스로 생성하지 않습니다.

## Launchd 제어

앱은 `ai.openclaw.gateway` 레이블이 있는 사용자 LaunchAgent 를 관리합니다.
(명명된 프로필을 사용할 때 `ai.openclaw.<profile>` 레이블; 레거시 `com.openclaw.*` 는 여전히 언로드됨).

```bash
launchctl kickstart -k gui/$UID/ai.openclaw.gateway
launchctl bootout gui/$UID/ai.openclaw.gateway
```

명명된 프로필을 실행할 때 레이블을 `ai.openclaw.<profile>` 으로 바꿉니다.

LaunchAgent 가 설치되지 않으면 앱에서 활성화하거나 `openclaw gateway install` 을 실행합니다.

## 노드 기능 (Mac)

macOS 앱이 자신을 노드로 제시합니다. 일반적인 명령:

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- Camera: `camera.snap`, `camera.clip`
- Screen: `screen.record`
- System: `system.run`, `system.notify`

노드는 `permissions` 맵을 보고하여 에이전트가 무엇이 허용되는지 결정할 수 있습니다.

노드 서비스 + 앱 IPC:

- 헤드리스 노드 호스트 서비스가 실행 중일 때 (원격 모드), 노드로서 Gateway WS 에 연결합니다.
- `system.run` 로컬 Unix 소켓을 통해 macOS 앱 (UI/TCC 컨텍스트) 에서 실행됩니다; 프롬프트 + 출력이 앱에 머물러 있습니다.

다이어그램 (SCI):

```
Gateway -> 노드 서비스 (WS)
                 |  IPC (UDS + 토큰 + HMAC + TTL)
                 v
             Mac 앱 (UI + TCC + system.run)
```

## Exec 승인 (system.run)

`system.run` 은 macOS 앱의 **Exec 승인** (설정 → Exec 승인) 으로 제어됩니다.
보안 + 요청 + 허용 목록은 Mac 에서 로컬로 저장됩니다:

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

- `allowlist` 항목은 확인된 바이너리 경로에 대한 Glob 패턴입니다.
- 쉘 제어 또는 확장 구문 (`&&`, `||`, `;`, `|`, `` ` ``, `$`, `<`, `>`, `(`, `)`) 을 포함하는 원시 쉘 명령 텍스트는 허용 목록 미스로 처리되고 명시적 승인 (또는 쉘 바이너리 허용 목록) 이 필요합니다.
- 프롬프트에서 "항상 허용" 을 선택하면 해당 명령이 허용 목록에 추가됩니다.
- `system.run` 환경 오버라이드는 필터링되고 (`PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT`, `SHELLOPTS`, `PS4` 삭제) 앱의 환경과 병합됩니다.
- 쉘 래퍼 (`bash|sh|zsh ... -c/-lc`) 의 경우 요청 범위 환경 오버라이드는 작은 명시적 허용 목록 (`TERM`, `LANG`, `LC_*`, `COLORTERM`, `NO_COLOR`, `FORCE_COLOR`) 로 축소됩니다.
- 허용 목록 모드의 항상 허용 결정의 경우 알려진 디스패치 래퍼 (`env`, `nice`, `nohup`, `stdbuf`, `timeout`) 는 래퍼 경로 대신 내부 실행 가능 경로를 유지합니다. 언래핑이 안전하지 않으면 허용 목록 항목이 자동으로 유지되지 않습니다.

## 깊은 링크

앱은 로컬 작업을 위해 `openclaw://` URL 스키마를 등록합니다.

### `openclaw://agent`

Gateway `agent` 요청을 트리거합니다.

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

쿼리 매개변수:

- `message` (필수)
- `sessionKey` (선택적)
- `thinking` (선택적)
- `deliver` / `to` / `channel` (선택적)
- `timeoutSeconds` (선택적)
- `key` (선택적 무인 모드 키)

안전:

- `key` 없으면 앱이 확인을 지시합니다.
- `key` 없으면 앱이 확인 프롬프트에 대해 짧은 메시지 제한을 적용하고 `deliver` / `to` / `channel` 을 무시합니다.
- 유효한 `key` 가 있으면 실행이 무인 (개인 자동화 용도).

## 온보딩 흐름 (일반)

1. **OpenClaw.app** 을 설치하고 실행합니다.
2. 권한 체크리스트 (TCC 프롬프트) 를 완료합니다.
3. **로컬** 모드가 활성화되고 Gateway 가 실행 중인지 확인합니다.
4. 터미널 액세스를 원하면 CLI 를 설치합니다.

## 상태 디렉토리 배치 (macOS)

OpenClaw 상태 디렉토리를 iCloud 또는 기타 클라우드 동기화 폴더에 배치하지 마세요.
동기화 지원 경로는 레이턴시를 추가하고 때때로 세션 및 자격 증명에 대한 파일 잠금/동기화 경쟁을 유발할 수 있습니다.

로컬 비동기화 상태 경로 선호:

```bash
OPENCLAW_STATE_DIR=~/.openclaw
```

`openclaw doctor` 가 상태를 다음에서 감지하면:

- `~/Library/Mobile Documents/com~apple~CloudDocs/...`
- `~/Library/CloudStorage/...`

로컬 경로로 돌아갈 것을 경고하고 권장합니다.

## 빌드 & 개발 워크플로우 (네이티브)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (또는 Xcode)
- 앱 패키지: `scripts/package-mac-app.sh`

## Gateway 연결성 디버그 (macOS CLI)

macOS 앱이 사용하는 동일한 Gateway WebSocket 핸드셰이크 및 발견 논리를 실행하는 디버그 CLI 를 사용하여 앱을 실행하지 않습니다.

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

연결 옵션:

- `--url <ws://host:port>`: 구성 오버라이드
- `--mode <local|remote>`: 구성에서 확인 (기본값: 구성 또는 로컬)
- `--probe`: 신선한 상태 탐색 강제
- `--timeout <ms>`: 요청 시간 초과 (기본값: `15000`)
- `--json`: 디핑을 위한 구조화된 출력

발견 옵션:

- `--include-local`: "로컬" 로 필터링되는 Gateway 포함
- `--timeout <ms>`: 전체 발견 창 (기본값: `2000`)
- `--json`: 디핑을 위한 구조화된 출력

팁: `openclaw gateway discover --json` 와 비교하여 macOS 앱의 발견 파이프라인 (NWBrowser + Tailnet DNS-SD 대체) 이 Node CLI 의 `dns-sd` 기반 발견과 다른지 확인합니다.

## 원격 연결 배선 (SSH 터널)

macOS 앱이 **원격** 모드에서 실행되면 로컬 UI 구성 요소가 로컬호스트 에 있는 것처럼 원격 Gateway 와 통신할 수 있도록 SSH 터널을 엽니다.

### 제어 터널 (Gateway WebSocket 포트)

- **목적:** 건강 확인, 상태, Web Chat, 구성 및 기타 제어 평면 호출.
- **로컬 포트:** Gateway 포트 (기본값 `18789`), 항상 안정적.
- **원격 포트:** 원격 호스트의 동일한 Gateway 포트.
- **동작:** 임의 로컬 포트 없음; 앱이 기존 건강한 터널을 재사용하거나 필요한 경우 재시작합니다.
- **SSH 모양:** `ssh -N -L <local>:127.0.0.1:<remote>` BatchMode + ExitOnForwardFailure + keepalive 옵션 포함.
- **IP 보고:** SSH 터널이 로컬호스트를 사용하므로 Gateway 는 노드 IP 를 `127.0.0.1` 으로 표시합니다. 실제 클라이언트 IP 를 표시하려면 **Direct (ws/wss)** 전송을 사용하세요 ([macOS 원격 액세스](/ko-KR/platforms/mac/remote) 참조).

설정 단계는 [macOS 원격 액세스](/ko-KR/platforms/mac/remote) 를 참조하세요. 프로토콜 세부 사항은 [Gateway 프로토콜](/ko-KR/gateway/protocol) 을 참조하세요.

## 관련 문서

- [Gateway 실행 가이드](/ko-KR/gateway)
- [Gateway (macOS)](/ko-KR/platforms/mac/bundled-gateway)
- [macOS 권한](/ko-KR/platforms/mac/permissions)
- [Canvas](/ko-KR/platforms/mac/canvas)
