---
summary: "Android 앱 (노드): 연결 런북 + Canvas/Chat/Camera"
read_when:
  - Android 노드 페어링 또는 재연결 시
  - Android Gateway(게이트웨이) 디바이스 검색 또는 인증 디버깅 시
  - 클라이언트 간 채팅 기록 일치 여부 검증 시
title: "Android 앱"
---

# Android 앱 (노드)

## 지원 스냅샷

- 역할: 컴패니언 노드 앱 (Android 는 Gateway(게이트웨이)를 호스팅하지 않습니다).
- Gateway 필요 여부: 예 (macOS, Linux, 또는 WSL2 를 통한 Windows 에서 실행).
- 설치: [시작하기](/start/getting-started) + [페어링](/gateway/pairing).
- Gateway: [Runbook](/gateway) + [구성](/gateway/configuration).
  - 프로토콜: [Gateway 프로토콜](/gateway/protocol) (노드 + 컨트롤 플레인).

## 시스템 제어

시스템 제어 (launchd/systemd) 는 Gateway 호스트에 있습니다. [Gateway](/gateway)를 참조하십시오.

## 연결 Runbook

Android 노드 앱 ⇄ (mDNS/NSD + WebSocket) ⇄ **Gateway**

Android 는 Gateway WebSocket (기본값 `ws://<host>:18789`) 에 직접 연결하며, Gateway 가 소유한 페어링을 사용합니다.

### 사전 요구 사항

- “마스터” 머신에서 Gateway 를 실행할 수 있어야 합니다.
- Android 기기/에뮬레이터가 gateway WebSocket 에 도달할 수 있어야 합니다:
  - mDNS/NSD 를 사용하는 동일 LAN, **또는**
  - Wide-Area Bonjour / 유니캐스트 DNS-SD 를 사용하는 동일 Tailscale tailnet (아래 참조), **또는**
  - 수동 gateway 호스트/포트 (대체 수단)
- gateway 머신에서 (또는 SSH 를 통해) CLI (`openclaw`) 를 실행할 수 있어야 합니다.

### 1. Gateway 시작

```bash
openclaw gateway --port 18789 --verbose
```

로그에서 다음과 유사한 항목이 보이는지 확인하십시오:

- `listening on ws://0.0.0.0:18789`

tailnet 전용 구성 (Vienna ⇄ London 에 권장) 의 경우, gateway 를 tailnet IP 에 바인딩하십시오:

- gateway 호스트의 `~/.openclaw/openclaw.json` 에서 `gateway.bind: "tailnet"` 를 설정하십시오.
- Gateway / macOS 메뉴바 앱을 재시작하십시오.

### 2. 디바이스 검색 확인 (선택 사항)

gateway 머신에서:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

추가 디버깅 노트: [Bonjour](/gateway/bonjour).

#### 유니캐스트 DNS-SD 를 통한 Tailnet (Vienna ⇄ London) 디바이스 검색

Android NSD/mDNS 디바이스 검색은 네트워크를 넘지 않습니다. Android 노드와 gateway 가 서로 다른 네트워크에 있지만 Tailscale 로 연결되어 있다면, Wide-Area Bonjour / 유니캐스트 DNS-SD 를 대신 사용하십시오:

1. gateway 호스트에 DNS-SD 존 (예: `openclaw.internal.`) 을 설정하고 `_openclaw-gw._tcp` 레코드를 게시하십시오.
2. 선택한 도메인을 해당 DNS 서버로 가리키도록 Tailscale 분할 DNS 를 구성하십시오.

자세한 내용과 CoreDNS 구성 예시는 [Bonjour](/gateway/bonjour)를 참조하십시오.

### 3. Android 에서 연결

Android 앱에서:

- 앱은 **포그라운드 서비스** (영구 알림) 를 통해 gateway 연결을 유지합니다.
- **Settings** 를 엽니다.
- **Discovered Gateways** 아래에서 gateway 를 선택하고 **Connect** 를 누르십시오.
- mDNS 가 차단된 경우 **Advanced → Manual Gateway** (호스트 + 포트) 를 사용하고 **Connect (Manual)** 을 누르십시오.

첫 페어링이 성공하면 Android 는 앱 실행 시 자동으로 재연결합니다:

- 수동 엔드포인트 (활성화된 경우), 또는
- 마지막으로 검색된 gateway (최선의 노력 방식).

### 4. 페어링 승인 (CLI)

gateway 머신에서:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

페어링 세부 사항: [Gateway 페어링](/gateway/pairing).

### 5. 노드 연결 확인

- 노드 상태를 통해:

  ```bash
  openclaw nodes status
  ```

- Gateway 를 통해:

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6. 채팅 + 기록

Android 노드의 Chat 시트는 gateway 의 **기본 세션 키** (`main`) 를 사용하므로, WebChat 및 기타 클라이언트와 기록과 응답이 공유됩니다:

- 기록: `chat.history`
- 전송: `chat.send`
- 푸시 업데이트 (최선의 노력): `chat.subscribe` → `event:"chat"`

### 7. Canvas + 카메라

#### Gateway Canvas Host (웹 콘텐츠용 권장)

에이전트가 디스크에서 편집할 수 있는 실제 HTML/CSS/JS 를 노드에 표시하려면, 노드를 Gateway canvas host 로 지정하십시오.

참고: 노드는 `canvasHost.port` (기본값 `18793`) 에 있는 독립형 canvas host 를 사용합니다.

1. gateway 호스트에 `~/.openclaw/workspace/canvas/index.html` 를 생성하십시오.

2. 노드를 해당 주소로 이동시키십시오 (LAN):

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'
```

Tailnet (선택 사항): 두 기기가 모두 Tailscale 에 있다면 `.local` 대신 MagicDNS 이름 또는 tailnet IP 를 사용하십시오. 예: `http://<gateway-magicdns>:18793/__openclaw__/canvas/`.

이 서버는 HTML 에 라이브 리로드 클라이언트를 주입하고 파일 변경 시 다시 로드합니다.
A2UI 호스트는 `http://<gateway-host>:18793/__openclaw__/a2ui/` 에 있습니다.

Canvas 명령 (포그라운드 전용):

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (기본 스캐폴드로 돌아가려면 `{"url":""}` 또는 `{"url":"/"}` 를 사용하십시오). `canvas.snapshot` 는 `{ format, base64 }` (기본값 `format="jpeg"`) 를 반환합니다.
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` 레거시 별칭)

카메라 명령 (포그라운드 전용; 권한 필요):

- `camera.snap` (jpg)
- `camera.clip` (mp4)

매개변수와 CLI 헬퍼는 [Camera 노드](/nodes/camera)를 참조하십시오.
