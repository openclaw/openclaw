---
summary: "Android 앱 (노드): 연결 가이드 + 연결/채팅/음성/Canvas 명령 인터페이스"
read_when:
  - Android 노드를 페어링하거나 재연결할 때
  - Android Gateway 검색 또는 인증을 디버깅할 때
  - 클라이언트 간 채팅 기록 동등성을 확인할 때
title: "Android 앱"
x-i18n:
  source_path: docs/platforms/android.md
---

# Android 앱 (노드)

> **참고:** Android 앱은 아직 공개 출시되지 않았습니다. 소스 코드는 [OpenClaw 저장소](https://github.com/openclaw/openclaw) 의 `apps/android` 에서 확인할 수 있습니다. Java 17 과 Android SDK 를 사용하여 직접 빌드할 수 있습니다 (`./gradlew :app:assemblePlayDebug`). 빌드 지침은 [apps/android/README.md](https://github.com/openclaw/openclaw/blob/main/apps/android/README.md) 를 참조하세요.

## 지원 현황

- 역할: 동반 노드 앱 (Android 는 Gateway 를 호스팅하지 않습니다).
- Gateway 필요: 예 (macOS, Linux, 또는 Windows via WSL2 에서 실행).
- 설치: [시작하기](/start/getting-started) + [페어링](/channels/pairing).
- Gateway: [운영 가이드](/gateway) + [설정](/gateway/configuration).
  - 프로토콜: [Gateway 프로토콜](/gateway/protocol) (노드 + 제어 플레인).

## 시스템 제어

시스템 제어 (launchd/systemd) 는 Gateway 호스트에 있습니다. [Gateway](/gateway) 를 참조하세요.

## 연결 가이드

Android 노드 앱 ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

Android 는 Gateway WebSocket (기본값 `ws://<host>:18789`) 에 직접 연결하고 기기 페어링 (`role: node`) 을 사용합니다.

### 사전 요구 사항

- "마스터" 머신에서 Gateway 를 실행할 수 있어야 합니다.
- Android 기기/에뮬레이터가 Gateway WebSocket 에 접근할 수 있어야 합니다:
  - mDNS/NSD 가 있는 동일 LAN, **또는**
  - Wide-Area Bonjour / 유니캐스트 DNS-SD 를 사용하는 동일 Tailscale tailnet (아래 참조), **또는**
  - 수동 Gateway 호스트/포트 (폴백)
- Gateway 머신에서 CLI (`openclaw`) 를 실행할 수 있어야 합니다 (또는 SSH 를 통해).

### 1) Gateway 시작

```bash
openclaw gateway --port 18789 --verbose
```

로그에서 다음과 같은 내용을 확인하세요:

- `listening on ws://0.0.0.0:18789`

tailnet 전용 설정의 경우 (Vienna ⇄ London 에 권장), Gateway 를 tailnet IP 에 바인딩하세요:

- Gateway 호스트의 `~/.openclaw/openclaw.json` 에서 `gateway.bind: "tailnet"` 을 설정합니다.
- Gateway / macOS 메뉴 바 앱을 재시작합니다.

### 2) 검색 확인 (선택 사항)

Gateway 머신에서:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

추가 디버깅 정보: [Bonjour](/gateway/bonjour).

#### Tailnet (Vienna ⇄ London) 유니캐스트 DNS-SD 를 통한 검색

Android NSD/mDNS 검색은 네트워크를 넘어가지 않습니다. Android 노드와 Gateway 가 다른 네트워크에 있지만 Tailscale 로 연결되어 있다면, Wide-Area Bonjour / 유니캐스트 DNS-SD 를 대신 사용하세요:

1. Gateway 호스트에서 DNS-SD 영역 (예: `openclaw.internal.`) 을 설정하고 `_openclaw-gw._tcp` 레코드를 게시합니다.
2. 선택한 도메인을 해당 DNS 서버에 가리키도록 Tailscale 분할 DNS 를 구성합니다.

세부 정보 및 CoreDNS 설정 예시: [Bonjour](/gateway/bonjour).

### 3) Android 에서 연결

Android 앱에서:

- 앱은 **포그라운드 서비스** (영구 알림) 를 통해 Gateway 연결을 유지합니다.
- **연결** 탭을 엽니다.
- **설정 코드** 또는 **수동** 모드를 사용합니다.
- 검색이 차단되면, **고급 제어** 에서 수동 호스트/포트 (및 필요시 TLS/토큰/비밀번호) 를 사용합니다.

첫 번째 성공적인 페어링 후, Android 는 실행 시 자동으로 재연결합니다:

- 수동 엔드포인트 (활성화된 경우), 그렇지 않으면
- 마지막으로 검색된 Gateway (최선의 노력).

### 4) 페어링 승인 (CLI)

Gateway 머신에서:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

페어링 세부 정보: [페어링](/channels/pairing).

### 5) 노드 연결 확인

- 노드 상태를 통해:

  ```bash
  openclaw nodes status
  ```

- Gateway 를 통해:

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6) 채팅 + 기록

Android 채팅 탭은 세션 선택을 지원합니다 (기본값 `main`, 그리고 기타 기존 세션):

- 기록: `chat.history`
- 전송: `chat.send`
- 푸시 업데이트 (최선의 노력): `chat.subscribe` → `event:"chat"`

### 7) Canvas + 카메라

#### Gateway Canvas 호스트 (웹 콘텐츠에 권장)

에이전트가 디스크에서 편집할 수 있는 실제 HTML/CSS/JS 를 노드에 표시하려면, 노드를 Gateway Canvas 호스트에 연결하세요.

참고: 노드는 Gateway HTTP 서버 (`gateway.port` 와 동일한 포트, 기본값 `18789`) 에서 Canvas 를 로드합니다.

1. Gateway 호스트에 `~/.openclaw/workspace/canvas/index.html` 을 생성합니다.

2. 노드를 해당 주소로 내비게이트합니다 (LAN):

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18789/__openclaw__/canvas/"}'
```

Tailnet (선택 사항): 두 기기가 모두 Tailscale 에 있다면, `.local` 대신 MagicDNS 이름 또는 tailnet IP 를 사용하세요. 예: `http://<gateway-magicdns>:18789/__openclaw__/canvas/`.

이 서버는 HTML 에 라이브 리로드 클라이언트를 주입하고 파일 변경 시 다시 로드합니다.
A2UI 호스트는 `http://<gateway-host>:18789/__openclaw__/a2ui/` 에 있습니다.

Canvas 명령 (포그라운드에서만):

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (기본 스캐폴드로 돌아가려면 `{"url":""}` 또는 `{"url":"/"}` 사용). `canvas.snapshot` 은 `{ format, base64 }` 를 반환합니다 (기본값 `format="jpeg"`).
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` 레거시 별칭)

카메라 명령 (포그라운드에서만; 권한 필요):

- `camera.snap` (jpg)
- `camera.clip` (mp4)

파라미터 및 CLI 헬퍼는 [카메라 노드](/nodes/camera) 를 참조하세요.

### 8) 음성 + 확장된 Android 명령 인터페이스

- 음성: Android 는 음성 탭에서 단일 마이크 온/오프 흐름을 사용하며, 트랜스크립트 캡처 및 TTS 재생 (ElevenLabs 가 설정된 경우, 시스템 TTS 폴백) 을 제공합니다. 앱이 포그라운드를 벗어나면 음성이 중지됩니다.
- 음성 웨이크/토크 모드 토글은 현재 Android UX/런타임에서 제거되었습니다.
- 추가 Android 명령군 (기기 + 권한에 따라 가용성이 다름):
  - `device.status`, `device.info`, `device.permissions`, `device.health`
  - `notifications.list`, `notifications.actions`
  - `photos.latest`
  - `contacts.search`, `contacts.add`
  - `calendar.events`, `calendar.add`
  - `callLog.search`
  - `sms.search`
  - `motion.activity`, `motion.pedometer`
