---
summary: "Android app (node): connection runbook + Canvas/Chat/Camera"
read_when:
  - Pairing or reconnecting the Android node
  - Debugging Android gateway discovery or auth
  - Verifying chat history parity across clients
title: "Android App"
x-i18n:
  source_hash: 0f6aacdb2bc50354748372a6c647355221f04f3e3dc4d374aa19978d42c39b4e
---

# 안드로이드 앱(노드)

## 지원 스냅샷

- 역할: 컴패니언 노드 앱(Android는 게이트웨이를 호스팅하지 않음)
- 게이트웨이 필요: 예(WSL2를 통해 macOS, Linux 또는 Windows에서 실행)
- 설치: [시작하기](/start/getting-started) + [페어링](/gateway/pairing).
- 게이트웨이: [런북](/gateway) + [구성](/gateway/configuration).
  - 프로토콜: [게이트웨이 프로토콜](/gateway/protocol) (노드 + 제어 평면).

## 시스템 제어

시스템 제어(launchd/systemd)는 게이트웨이 호스트에 있습니다. [게이트웨이](/gateway)를 참조하세요.

## 연결 런북

Android 노드 앱 ⇄ (mDNS/NSD + WebSocket) ⇄ **게이트웨이**

Android는 Gateway WebSocket(기본값 `ws://<host>:18789`)에 직접 연결하고 게이트웨이 소유 페어링을 사용합니다.

### 전제 조건

- "마스터" 머신에서 게이트웨이를 실행할 수 있습니다.
- Android 장치/에뮬레이터는 게이트웨이 WebSocket에 연결할 수 있습니다.
  - mDNS/NSD와 동일한 LAN, **또는**
  - Wide-Area Bonjour/유니캐스트 DNS-SD(아래 참조)를 사용하는 동일한 Tailscale tailnet, **또는**
  - 수동 게이트웨이 호스트/포트(대체)
- 게이트웨이 머신에서(또는 SSH를 통해) CLI(`openclaw`)를 실행할 수 있습니다.

### 1) 게이트웨이 시작

```bash
openclaw gateway --port 18789 --verbose
```

로그에서 다음과 같은 내용이 표시되는지 확인하세요.

- `listening on ws://0.0.0.0:18789`

tailnet 전용 설정의 경우(Vienna ⇄ London에 권장) 게이트웨이를 tailnet IP에 바인딩합니다.

- 게이트웨이 호스트의 `~/.openclaw/openclaw.json`에 `gateway.bind: "tailnet"`를 설정합니다.
- 게이트웨이/macOS 메뉴바 앱을 다시 시작하세요.

### 2) 검색 확인(선택사항)

게이트웨이 머신에서:

```bash
dns-sd -B _openclaw-gw._tcp local.
```

추가 디버깅 참고 사항: [Bonjour](/gateway/bonjour).

#### 유니캐스트 DNS-SD를 통한 Tailnet(비엔나 ⇄ 런던) 검색

Android NSD/mDNS 검색은 네트워크를 통과하지 않습니다. Android 노드와 게이트웨이가 다른 네트워크에 있지만 Tailscale을 통해 연결된 경우 대신 Wide-Area Bonjour/유니캐스트 DNS-SD를 사용하십시오.

1. 게이트웨이 호스트에 DNS-SD 영역(예: `openclaw.internal.`)을 설정하고 `_openclaw-gw._tcp` 레코드를 게시합니다.
2. 해당 DNS 서버를 가리키는 선택한 도메인에 대해 Tailscale 분할 DNS를 구성합니다.

세부 정보 및 CoreDNS 구성 예시: [Bonjour](/gateway/bonjour).

### 3) 안드로이드에서 연결

Android 앱에서:

- 앱은 **포그라운드 서비스**(지속적인 알림)를 통해 게이트웨이 연결을 유지합니다.
- **설정**을 엽니다.
- **검색된 게이트웨이**에서 게이트웨이를 선택하고 **연결**을 누르세요.
- mDNS가 차단된 경우 **고급 → 수동 게이트웨이**(호스트+포트) 및 **연결(수동)**을 이용하세요.

첫 번째 성공적인 페어링 후 Android는 실행 시 자동으로 다시 연결됩니다.

- 수동 엔드포인트(활성화된 경우), 그렇지 않은 경우
- 마지막으로 검색된 게이트웨이(최선의 노력)입니다.

### 4) 페어링 승인(CLI)

게이트웨이 머신에서:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

페어링 세부정보: [게이트웨이 페어링](/gateway/pairing).

### 5) 노드가 연결되었는지 확인합니다.

- 노드 상태를 통해:

  ```bash
  openclaw nodes status
  ```

- 게이트웨이를 통해:

  ```bash
  openclaw gateway call node.list --params "{}"
  ```

### 6) 채팅 + 기록

Android 노드의 채팅 시트는 게이트웨이의 **기본 세션 키**(`main`)를 사용하므로 기록과 응답이 WebChat 및 다른 클라이언트와 공유됩니다.

- 역사: `chat.history`
- 보내기: `chat.send`
- 푸시 업데이트(최선의 노력): `chat.subscribe` → `event:"chat"`

### 7) 캔버스 + 카메라

#### 게이트웨이 캔버스 호스트(웹 콘텐츠에 권장)

에이전트가 디스크에서 편집할 수 있는 실제 HTML/CSS/JS를 노드에 표시하려면 게이트웨이 캔버스 호스트에서 노드를 가리킵니다.

참고: 노드는 `canvasHost.port`(기본값 `18793`)에서 독립형 캔버스 호스트를 사용합니다.

1. 게이트웨이 호스트에 `~/.openclaw/workspace/canvas/index.html`를 생성합니다.

2. 노드를 해당 노드(LAN)로 이동합니다.

```bash
openclaw nodes invoke --node "<Android Node>" --command canvas.navigate --params '{"url":"http://<gateway-hostname>.local:18793/__openclaw__/canvas/"}'
```

Tailnet(선택 사항): 두 장치가 모두 Tailscale에 있는 경우 `.local` 대신 MagicDNS 이름이나 tailnet IP를 사용합니다. `http://<gateway-magicdns>:18793/__openclaw__/canvas/`.

이 서버는 라이브 다시 로드 클라이언트를 HTML에 삽입하고 파일 변경 시 다시 로드합니다.
A2UI 호스트는 `http://<gateway-host>:18793/__openclaw__/a2ui/`에 거주합니다.

캔버스 명령(포그라운드에만 해당):

- `canvas.eval`, `canvas.snapshot`, `canvas.navigate` (기본 비계로 돌아가려면 `{"url":""}` 또는 `{"url":"/"}`를 사용하십시오.) `canvas.snapshot`는 `{ format, base64 }`를 반환합니다(기본값 `format="jpeg"`).
- A2UI: `canvas.a2ui.push`, `canvas.a2ui.reset` (`canvas.a2ui.pushJSONL` 기존 별칭)

카메라 명령(전경 전용, 권한 제한):

- `camera.snap` (jpg)
- `camera.clip` (mp4)

매개변수 및 CLI 도우미는 [카메라 노드](/nodes/camera)를 참조하세요.
