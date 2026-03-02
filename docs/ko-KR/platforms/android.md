---
summary: "Android 앱 (노드): 연결 실행 가이드 + Canvas/Chat/Camera"
read_when:
  - Android 노드를 페어링하거나 재연결할 때
  - Android Gateway 발견 또는 인증을 디버깅할 때
  - 클라이언트 간의 채팅 기록 패리티를 확인할 때
title: "Android 앱"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: platforms/android.md
  workflow: 15
---

# Android 앱 (노드)

## 지원 스냅샷

- 역할: 동반 노드 앱 (Android 는 Gateway 를 호스트하지 않음).
- Gateway 필수: 예 (macOS, Linux 또는 Windows via WSL2 에서 실행).
- 설치: [시작하기](/start/getting-started) + [페어링](/ko-KR/gateway/pairing).
- Gateway: [실행 가이드](/ko-KR/gateway) + [구성](/ko-KR/gateway/configuration).
  - 프로토콜: [Gateway 프로토콜](/ko-KR/gateway/protocol) (노드 + 제어 평면).

## 시스템 제어

시스템 제어 (launchd/systemd) 는 Gateway 호스트에 있습니다. [Gateway](/ko-KR/gateway) 참조.

## 연결 실행 가이드

Android 노드 앱 ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

Android 는 Gateway WebSocket (기본값 `ws://<host>:18789`) 에 직접 연결하고 Gateway 소유 페어링을 사용합니다.

### 사전 조건

- "마스터" 머신에서 Gateway 를 실행할 수 있습니다.
- Android 디바이스/에뮬레이터가 Gateway WebSocket 에 연결할 수 있습니다:
  - mDNS/NSD 가 있는 동일한 LAN, **또는**
  - Wide-Area Bonjour / Unicast DNS-SD 를 사용하는 동일한 Tailscale Tailnet (아래 참조), **또는**
  - 수동 Gateway 호스트/포트 (대체)
- Gateway 머신 (또는 SSH 를 통해) 에서 CLI (`openclaw`) 를 실행할 수 있습니다.

### 1) Gateway 시작

```bash
openclaw gateway --port 18789 --verbose
```

로그에서 다음과 같은 내용을 확인합니다:

- `listening on ws://0.0.0.0:18789`

Tailnet 전용 설정 (Vienna ⇄ London 권장) 의 경우 Gateway 를 Tailnet IP 에 바인드합니다:

- `~/.openclaw/openclaw.json` 의 Gateway 호스트에서 `gateway.bind: "tailnet"` 설정합니다.
- Gateway / macOS 메뉴 막대 앱을 재시작합니다.

### 2) 발견 확인 (선택적)

Gateway 머신에서:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

추가 디버깅 참고: [Bonjour](/ko-KR/gateway/bonjour).

#### Tailnet (Vienna ⇄ London) Unicast DNS-SD 를 통한 발견

Android NSD/mDNS 발견 은 네트워크를 넘을 수 없습니다. Android 노드 및 Gateway 가 다른 네트워크에 있지만 Tailscale 을 통해 연결된 경우 Wide-Area Bonjour / Unicast DNS-SD 를 대신 사용합니다:

1. Gateway 호스트에서 DNS-SD 영역 설정 (예제 `openclaw.internal.`) 및 `_openclaw-gw._tcp` 레코드 게시.
2. Tailscale split DNS 를 해당 DNS 서버를 가리키도록 선택한 도메인으로 구성합니다.

세부 사항 및 CoreDNS 예제 구성: [Bonjour](/ko-KR/gateway/bonjour).

### 3) Android 에서 연결

Android 앱에서:

- 앱은 **포그라운드 서비스** (지속적 알림) 를 통해 Gateway 연결을 유지합니다.
- **Settings** 열기.
- **Discovered Gateways** 에서 Gateway 를 선택하고 **Connect** 누릅니다.
- mDNS 가 차단된 경우 **Advanced → Manual Gateway** (호스트 + 포트) 및 **Connect (Manual)** 사용합니다.

첫 번째 성공적인 페어링 후 Android 는 시작 시 자동 재연결합니다:

- 수동 끝점 (활성화된 경우), 그 외
- 마지막 발견된 Gateway (최선의 노력).

### 4) 페어링 승인 (CLI)

Gateway 머신에서:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

페어링 세부 사항: [Gateway 페어링](/ko-KR/gateway/pairing).

### 5) 노드가 연결되었는지 확인

- 노드 상태를 통해:

  ```bash
  openclaw nodes status
  ```

- Gateway 를 통해:

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6) Chat + 기록

Android 노드의 Chat 시트는 Gateway 의 **기본 세션 키** (`main`) 를 사용하므로 기록 및 응답이 WebChat 및 다른 클라이언트와 공유됩니다:

- 기록: `chat.history`
- 전송: `chat.send`
- 푸시 업데이트 (최선의 노력): `chat.subscribe` → `event:"chat"`

### 7) Canvas + 카메라

#### Gateway Canvas 호스트 (웹 콘텐츠에 권장)

노드가 에이전트가 디스크에서 편집할 수 있는 실제 HTML/CSS/JS 를 표시하도록 하려면 노드를 Gateway Canvas 호스트 로 가리킵니다.

참고: 노드는 Gateway HTTP 서버에서 Canvas 를 로드합니다 (`gateway.port` 와 동일한 포트, 기본값 `18789`).

1. Gateway 호스트에서 `~/.openclaw/workspace/canvas/index.html` 만듭니다.

2. 노드를 로 탐색합니다 (LAN):

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18789/__openclaw__/canvas/"}'
```

Tailnet (선택적): 두 디바이스가 Tailscale 에 있으면 `.local` 대신 MagicDNS 이름 또는 Tailnet IP 사용 (예: `http://<gateway-magicdns>:18789/__openclaw__/canvas/`).

이 서버는 HTML 에 라이브 재로드 클라이언트를 주입하고 파일 변경 시 다시 로드합니다.
A2UI 호스트는 `http://<gateway-host>:18789/__openclaw__/a2ui/` 에 있습니다.

Canvas 명령 (포그라운드만):

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (기본 스캐폴드 로 반환하려면 `{"url":""}` 또는 `{"url":"/"}` 사용). `canvas.snapshot` 는 `{ format, base64 }` (기본값 `format="jpeg"`) 를 반환합니다.
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` 레거시 별칭)

카메라 명령 (포그라운드만; 권한 제어):

- `camera.snap` (jpg)
- `camera.clip` (mp4)

매개변수 및 CLI 헬퍼는 [카메라 노드](/ko-KR/nodes/camera) 참조.
