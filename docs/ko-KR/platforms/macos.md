---
summary: "OpenClaw macOS 동반 앱 (메뉴 바 + Gateway 브로커)"
read_when:
  - macOS 앱 기능을 구현할 때
  - macOS 에서 Gateway 라이프사이클 또는 노드 브릿징을 변경할 때
title: "macOS 앱"
x-i18n:
  source_path: docs/platforms/macos.md
---

# OpenClaw macOS 동반 앱 (메뉴 바 + Gateway 브로커)

macOS 앱은 OpenClaw 의 **메뉴 바 동반 앱**입니다. 권한을 관리하고,
Gateway 를 로컬에서 관리/연결하며 (launchd 또는 수동), macOS
기능을 에이전트에 노드로 노출합니다.

## 주요 기능

- 메뉴 바에 네이티브 알림 및 상태를 표시합니다.
- TCC 프롬프트를 관리합니다 (알림, 접근성, 화면 녹화, 마이크,
  음성 인식, 자동화/AppleScript).
- Gateway 에 연결하거나 실행합니다 (로컬 또는 원격).
- macOS 전용 도구를 노출합니다 (Canvas, 카메라, 화면 녹화, `system.run`).
- **원격** 모드에서 로컬 노드 호스트 서비스를 시작하고 (launchd), **로컬** 모드에서는 중지합니다.
- 선택적으로 UI 자동화를 위한 **PeekabooBridge** 를 호스팅합니다.
- 요청 시 npm/pnpm 을 통해 글로벌 CLI (`openclaw`) 를 설치합니다 (bun 은 Gateway 런타임에 권장되지 않습니다).

## 로컬 vs 원격 모드

- **로컬** (기본값): 앱은 실행 중인 로컬 Gateway 가 있으면 연결합니다;
  없으면 `openclaw gateway install` 을 통해 launchd 서비스를 활성화합니다.
- **원격**: 앱은 SSH/Tailscale 을 통해 Gateway 에 연결하며 로컬
  프로세스를 시작하지 않습니다.
  앱은 원격 Gateway 가 이 Mac 에 접근할 수 있도록 로컬 **노드 호스트 서비스**를 시작합니다.
  앱은 Gateway 를 자식 프로세스로 생성하지 않습니다.

## Launchd 제어

앱은 `ai.openclaw.gateway` 레이블의 사용자별 LaunchAgent 를 관리합니다
(`--profile`/`OPENCLAW_PROFILE` 사용 시 `ai.openclaw.<profile>`; 레거시 `com.openclaw.*` 도 여전히 언로드됩니다).

```bash
launchctl kickstart -k gui/$UID/ai.openclaw.gateway
launchctl bootout gui/$UID/ai.openclaw.gateway
```

명명된 프로파일을 실행할 때는 레이블을 `ai.openclaw.<profile>` 로 교체하세요.

LaunchAgent 가 설치되지 않은 경우, 앱에서 활성화하거나
`openclaw gateway install` 을 실행하세요.

## 노드 기능 (mac)

macOS 앱은 자체를 노드로 제공합니다. 주요 명령어:

- Canvas: `canvas.present`, `canvas.navigate`, `canvas.eval`, `canvas.snapshot`, `canvas.a2ui.*`
- 카메라: `camera.snap`, `camera.clip`
- 화면: `screen.record`
- 시스템: `system.run`, `system.notify`

노드는 `permissions` 맵을 보고하여 에이전트가 허용 여부를 결정할 수 있습니다.

노드 서비스 + 앱 IPC:

- 헤드리스 노드 호스트 서비스가 실행 중일 때 (원격 모드), Gateway WS 에 노드로 연결합니다.
- `system.run` 은 macOS 앱 (UI/TCC 컨텍스트) 에서 로컬 Unix 소켓을 통해 실행됩니다; 프롬프트 + 출력은 앱 내에 유지됩니다.

다이어그램 (SCI):

```
Gateway -> Node Service (WS)
                 |  IPC (UDS + token + HMAC + TTL)
                 v
             Mac App (UI + TCC + system.run)
```

## 실행 승인 (system.run)

`system.run` 은 macOS 앱의 **실행 승인** (설정 → 실행 승인) 으로 제어됩니다.
보안 + 확인 + 허용 목록은 Mac 에 로컬로 저장됩니다:

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

참고:

- `allowlist` 항목은 해석된 바이너리 경로에 대한 glob 패턴입니다.
- 셸 제어 또는 확장 구문 (`&&`, `||`, `;`, `|`, `` ` ``, `$`, `<`, `>`, `(`, `)`) 을 포함하는 원시 셸 명령 텍스트는 허용 목록 미스로 처리되며 명시적 승인 (또는 셸 바이너리를 허용 목록에 추가) 이 필요합니다.
- 프롬프트에서 "항상 허용" 을 선택하면 해당 명령이 허용 목록에 추가됩니다.
- `system.run` 환경 오버라이드는 필터링되며 (`PATH`, `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PYTHON*`, `PERL*`, `RUBYOPT`, `SHELLOPTS`, `PS4` 제거) 그 다음 앱의 환경과 병합됩니다.
- 셸 래퍼 (`bash|sh|zsh ... -c/-lc`) 의 경우, 요청 범위 환경 오버라이드는 작은 명시적 허용 목록 (`TERM`, `LANG`, `LC_*`, `COLORTERM`, `NO_COLOR`, `FORCE_COLOR`) 으로 축소됩니다.
- 허용 목록 모드에서 항상-허용 결정 시, 알려진 디스패치 래퍼 (`env`, `nice`, `nohup`, `stdbuf`, `timeout`) 는 래퍼 경로 대신 내부 실행 파일 경로를 유지합니다. 언래핑이 안전하지 않으면 허용 목록 항목이 자동으로 저장되지 않습니다.

## 딥 링크

앱은 로컬 작업을 위해 `openclaw://` URL 스킴을 등록합니다.

### `openclaw://agent`

Gateway `agent` 요청을 트리거합니다.

```bash
open 'openclaw://agent?message=Hello%20from%20deep%20link'
```

쿼리 파라미터:

- `message` (필수)
- `sessionKey` (선택)
- `thinking` (선택)
- `deliver` / `to` / `channel` (선택)
- `timeoutSeconds` (선택)
- `key` (선택, 무인 모드 키)

보안:

- `key` 없이는 앱이 확인을 요청합니다.
- `key` 없이는 앱이 확인 프롬프트에 대한 짧은 메시지 제한을 적용하고 `deliver` / `to` / `channel` 을 무시합니다.
- 유효한 `key` 가 있으면 실행은 무인으로 진행됩니다 (개인 자동화용).

## 온보딩 흐름 (일반적인)

1. **OpenClaw.app** 을 설치하고 실행합니다.
2. 권한 체크리스트를 완료합니다 (TCC 프롬프트).
3. **로컬** 모드가 활성화되어 있고 Gateway 가 실행 중인지 확인합니다.
4. 터미널 접근이 필요하면 CLI 를 설치합니다.

## 상태 디렉토리 배치 (macOS)

OpenClaw 상태 디렉토리를 iCloud 또는 기타 클라우드 동기화 폴더에 배치하지 마세요.
동기화 지원 경로는 세션 및 자격 증명에 대해 지연을 추가하고 때때로
파일 잠금/동기화 경쟁을 유발할 수 있습니다.

다음과 같은 로컬 비동기화 상태 경로를 권장합니다:

```bash
OPENCLAW_STATE_DIR=~/.openclaw
```

`openclaw doctor` 가 다음 경로에서 상태를 감지하면:

- `~/Library/Mobile Documents/com~apple~CloudDocs/...`
- `~/Library/CloudStorage/...`

경고를 표시하고 로컬 경로로 이동할 것을 권장합니다.

## 빌드 및 개발 워크플로 (네이티브)

- `cd apps/macos && swift build`
- `swift run OpenClaw` (또는 Xcode)
- 앱 패키징: `scripts/package-mac-app.sh`

## Gateway 연결 디버그 (macOS CLI)

디버그 CLI 를 사용하여 macOS 앱이 사용하는 것과 동일한 Gateway WebSocket 핸드셰이크 및 검색
로직을 앱을 실행하지 않고 테스트할 수 있습니다.

```bash
cd apps/macos
swift run openclaw-mac connect --json
swift run openclaw-mac discover --timeout 3000 --json
```

연결 옵션:

- `--url <ws://host:port>`: 설정 오버라이드
- `--mode <local|remote>`: 설정에서 해석 (기본값: 설정 또는 로컬)
- `--probe`: 새로운 상태 프로브 강제
- `--timeout <ms>`: 요청 타임아웃 (기본값: `15000`)
- `--json`: 비교를 위한 구조화된 출력

검색 옵션:

- `--include-local`: "로컬" 로 필터링될 Gateway 포함
- `--timeout <ms>`: 전체 검색 창 (기본값: `2000`)
- `--json`: 비교를 위한 구조화된 출력

팁: `openclaw gateway discover --json` 과 비교하여
macOS 앱의 검색 파이프라인 (NWBrowser + tailnet DNS-SD 폴백) 이
Node CLI 의 `dns-sd` 기반 검색과 다른지 확인하세요.

## 원격 연결 구조 (SSH 터널)

macOS 앱이 **원격** 모드에서 실행될 때, SSH 터널을 열어 로컬 UI
컴포넌트가 원격 Gateway 와 마치 localhost 에 있는 것처럼 통신할 수 있게 합니다.

### 제어 터널 (Gateway WebSocket 포트)

- **용도:** 상태 확인, 상태, WebChat, 설정 및 기타 제어 플레인 호출.
- **로컬 포트:** Gateway 포트 (기본값 `18789`), 항상 안정적.
- **원격 포트:** 원격 호스트의 동일한 Gateway 포트.
- **동작:** 임의의 로컬 포트 없음; 앱은 기존의 정상 터널을 재사용하거나
  필요시 재시작합니다.
- **SSH 형태:** `ssh -N -L <local>:127.0.0.1:<remote>` 에 BatchMode +
  ExitOnForwardFailure + keepalive 옵션.
- **IP 보고:** SSH 터널은 루프백을 사용하므로, Gateway 는 노드
  IP 를 `127.0.0.1` 로 인식합니다. 실제 클라이언트
  IP 가 표시되길 원하면 **Direct (ws/wss)** 전송을 사용하세요 ([macOS 원격 접근](/platforms/mac/remote) 참조).

설정 단계는 [macOS 원격 접근](/platforms/mac/remote) 을 참조하세요. 프로토콜
세부 정보는 [Gateway 프로토콜](/gateway/protocol) 을 참조하세요.

## 관련 문서

- [Gateway 운영 가이드](/gateway)
- [Gateway (macOS)](/platforms/mac/bundled-gateway)
- [macOS 권한](/platforms/mac/permissions)
- [Canvas](/platforms/mac/canvas)
