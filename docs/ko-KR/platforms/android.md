---
summary: "Android 앱 (노드): 연결 런북 + 캔버스/채팅/카메라"
read_when:
  - Android 노드의 페어링 또는 재연결
  - Android 게이트웨이 검색 또는 인증 디버깅
  - 클라이언트 간 채팅 기록 일치 검증
title: "Android 앱"
---

# Android 앱 (노드)

## 지원 스냅샷

- 역할: 동반 노드 앱 (Android는 게이트웨이를 호스팅하지 않습니다).
- 게이트웨이 필요: 예 (macOS, Linux, 또는 WSL2를 통해 Windows에서 실행).
- 설치: [시작하기](/ko-KR/start/getting-started) + [페어링](/ko-KR/gateway/pairing).
- 게이트웨이: [런북](/ko-KR/gateway) + [설정](/ko-KR/gateway/configuration).
  - 프로토콜: [게이트웨이 프로토콜](/ko-KR/gateway/protocol) (노드 + 제어 플레인).

## 시스템 제어

시스템 제어 (launchd/systemd)는 게이트웨이 호스트에 위치합니다. [게이트웨이](/ko-KR/gateway)를 참조하세요.

## 연결 런북

Android 노드 앱 ⇄ (mDNS/NSD + WebSocket) ⇄ **게이트웨이**

Android는 게이트웨이 WebSocket(기본 `ws://<host>:18789`)에 직접 연결하고 게이트웨이 소유의 페어링을 사용합니다.

### 사전 준비 

- "마스터" 기기에서 게이트웨이를 실행할 수 있습니다.
- Android 장치/에뮬레이터가 게이트웨이 WebSocket에 도달할 수 있습니다:
  - mDNS/NSD와 동일한 LAN, **또는**
  - 광역 Bonjour / 유니캐스트 DNS-SD를 사용한 동일한 Tailscale 테일넷, **또는**
  - 수동 게이트웨이 호스트/포트(대체 가능)
- 게이트웨이 기기에서 CLI (`openclaw`)를 실행할 수 있습니다 (또는 SSH를 통해).

### 1) 게이트웨이 시작

```bash
openclaw gateway --port 18789 --verbose
```

로그에서 다음과 같은 내용을 확인합니다:

- `listening on ws://0.0.0.0:18789`

테일넷 전용 설정 (비엔나 ⇄ 런던 추천)에서는 게이트웨이를 테일넷 IP에 바인딩합니다:

- `~/.openclaw/openclaw.json`의 게이트웨이 호스트에 `gateway.bind: "tailnet"`을 설정합니다.
- 게이트웨이 / macOS 메뉴바 앱을 다시 시작합니다.

### 2) 검색 확인 (선택 사항)

게이트웨이 기기에서:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

더 많은 디버깅 참고 사항: [Bonjour](/ko-KR/gateway/bonjour).

#### 유니캐스트 DNS-SD를 통한 테일넷 (비엔나 ⇄ 런던) 검색

Android NSD/mDNS 검색은 네트워크를 넘나들지 않습니다. 귀하의 Android 노드와 게이트웨이가 다른 네트워크에 있지만 Tailscale을 통해 연결된 경우, 광역 Bonjour / 유니캐스트 DNS-SD를 대신 사용하세요:

1. 게이트웨이 호스트에서 DNS-SD 존(예: `openclaw.internal.`)을 설정하고 `_openclaw-gw._tcp` 레코드를 게시합니다.
2. 해당 DNS 서버를 가리키는 조정된 도메인에 대한 Tailscale 스플릿 DNS를 설정합니다.

자세한 사항 및 예제 CoreDNS 설정: [Bonjour](/ko-KR/gateway/bonjour).

### 3) Android에서 연결

Android 앱에서:

- 앱은 **포그라운드 서비스**(지속적인 알림)를 통해 게이트웨이 연결을 유지합니다.
- **설정**을 엽니다.
- **발견된 게이트웨이** 아래에서 게이트웨이를 선택하고 **연결**을 누릅니다.
- mDNS가 차단된 경우에는 **고급 → 수동 게이트웨이**(호스트 + 포트)를 사용하고 **연결 (수동)**을 사용하세요.

첫 번째 성공적인 페어링 후, Android는 실행 시 자동으로 재연결합니다:

- 수동 엔드포인트(활성화된 경우), 그렇지 않으면
- 마지막으로 발견된 게이트웨이(최대한 노력).

### 4) 페어링 승인 (CLI)

게이트웨이 기기에서:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

페어링 세부정보: [게이트웨이 페어링](/ko-KR/gateway/pairing).

### 5) 노드 연결 확인

- 노드 상태를 통해:

  ```bash
  openclaw nodes status
  ```

- 게이트웨이를 통해:

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6) 채팅 + 기록

Android 노드의 채팅 시트는 게이트웨이의 **기본 세션 키**(`main`)를 사용하므로, 기록 및 답글이 WebChat 및 다른 클라이언트와 공유됩니다:

- 기록: `chat.history`
- 전송: `chat.send`
- 업데이트 푸시 (최대한 노력): `chat.subscribe` → `event:"chat"`

### 7) 캔버스 + 카메라

#### 게이트웨이 캔버스 호스트 (웹 콘텐츠에 추천)

노드가 에이전트가 디스크에서 편집할 수 있는 진짜 HTML/CSS/JS를 보여주기를 원한다면 노드를 게이트웨이 캔버스 호스트에 맞추세요.

참고: 노드들은 게이트웨이 HTTP 서버에서 캔버스를 로드합니다 (게이트웨이와 같은 포트, 기본 `18789`).

1. 게이트웨이 호스트에 `~/.openclaw/workspace/canvas/index.html`을 만듭니다.

2. 노드를 해당 위치로 이동합니다 (LAN):

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18789/__openclaw__/canvas/"}'
```

테일넷 (선택 사항): 두 장치가 모두 Tailscale에 있는 경우 `.local` 대신 MagicDNS 이름이나 테일넷 IP를 사용합니다, 예: `http://<gateway-magicdns>:18789/__openclaw__/canvas/`.

이 서버는 HTML에 라이브 리로드 클라이언트를 삽입하고 파일 변경 시 다시 로드합니다.
A2UI 호스트는 `http://<gateway-host>:18789/__openclaw__/a2ui/`에 위치합니다.

캔버스 명령어 (포그라운드 전용):

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (기본 스캐폴드로 돌아가기 위해 `{"url":""}` 또는 `{"url":"/"}` 사용). `canvas.snapshot`은 `{format, base64}`를 반환합니다 (기본 `format="jpeg"`).
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` 레거시 별명)

카메라 명령어 (포그라운드 전용; 권한 제한):

- `camera.snap` (jpg)
- `camera.clip` (mp4)

매개변수 및 CLI 도우미에 대해 [카메라 노드](/ko-KR/nodes/camera)를 참조하세요.