---
summary: "노드: 페어링, 기능, 권한, 캔버스/카메라/화면/시스템을 위한 CLI 도우미"
read_when:
  - iOS/Android 노드를 게이트웨이에 페어링할 때
  - 에이전트 컨텍스트로 노드 캔버스/카메라를 사용할 때
  - 새로운 노드 명령어나 CLI 도우미를 추가할 때
title: "노드"
---

# 노드

**노드**는 게이트웨이 **웹소켓** (운영자와 동일한 포트)에 `role: "node"`로 연결하고 `node.invoke`를 통해 명령어 인터페이스 (`canvas.*`, `camera.*`, `system.*` 등)를 노출하는 동반 장치 (macOS/iOS/Android/헤드리스)입니다. 프로토콜 세부사항: [게이트웨이 프로토콜](/ko-KR/gateway/protocol).

이전 전송 프로토콜: [브리지 프로토콜](/ko-KR/gateway/bridge-protocol) (TCP JSONL; 현재 노드에서는 사용 안 함/폐기).

macOS는 **노드 모드**로 실행할 수도 있습니다: 상태 표시줄 앱은 게이트웨이의 WS 서버에 연결하고 로컬 캔버스/카메라 명령어를 노드로서 노출합니다 (따라서 `openclaw nodes …`가 이 Mac에 대해 작동함).

노트:

- 노드는 **주변 장치**이며, 게이트웨이가 아닙니다. 게이트웨이 서비스는 실행하지 않습니다.
- Telegram/WhatsApp/등 메시지는 **게이트웨이**에 도착하며, 노드에 도착하지 않습니다.
- 문제 해결 안내서: [/nodes/troubleshooting](/ko-KR/nodes/troubleshooting)

## 페어링 + 상태

**WS 노드는 장치 페어링을 사용합니다.** 노드는 `connect` 중에 장치 아이덴티티를 제시하고, 게이트웨이는 `role: node`에 대한 장치 페어링 요청을 생성합니다. CLI (또는 UI)를 통해 승인합니다.

빠른 CLI:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

노트:

- `nodes status`는 장치 페어링 역할에 `node`가 포함되었을 때 노드를 **페어링된** 것으로 표시합니다.
- `node.pair.*` (CLI: `openclaw nodes pending/approve/reject`)는 게이트웨이 소유의 별도 노드 페어링 스토어입니다. WS `connect` 핸드셰이크를 **막지** 않습니다.

## 원격 노드 호스트 (system.run)

게이트웨이가 한 장치에서 실행되고 다른 장치에서 명령어를 실행하고자 할 때 **노드 호스트**를 사용합니다. 모델은 여전히 **게이트웨이**와 대화하며, 게이트웨이는 `host=node`가 선택되었을 때 `exec` 호출을 **노드 호스트**로 전달합니다.

### 어디에서 무엇이 실행되는가

- **게이트웨이 호스트**: 메시지를 받고, 모델을 실행하며, 도구 호출을 라우트합니다.
- **노드 호스트**: 노드 머신에서 `system.run`/`system.which`를 실행합니다.
- **승인**: `~/.openclaw/exec-approvals.json`를 통해 노드 호스트에서 적용됩니다.

### 노드 호스트 시작 (전면)

노드 머신에서:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### SSH 터널을 통한 원격 게이트웨이 (로컬 루프백 바인드)

만약 게이트웨이가 로컬 루프백에 바인드된다면 (`gateway.bind=loopback`, 로컬 모드에서 기본), 원격 노드 호스트는 직접 연결할 수 없습니다. SSH 터널을 생성하고 노드 호스트를 터널의 로컬 끝에 지시하십시오.

예제 (노드 호스트 -> 게이트웨이 호스트):

```bash
# 터미널 A (계속 실행): 로컬 18790을 게이트웨이 127.0.0.1:18789로 전달
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# 터미널 B: 게이트웨이 토큰을 내보내고 터널을 통해 연결
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

노트:

- 토큰은 게이트웨이 구성 (`~/.openclaw/openclaw.json`의 `gateway.auth.token`)에서 가져옵니다.
- `openclaw node run`은 인증을 위해 `OPENCLAW_GATEWAY_TOKEN`을 읽습니다.

### 노드 호스트 시작 (서비스)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### 페어링 + 이름 설정

게이트웨이 호스트에서:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

이름 설정 옵션:

- `openclaw node run` / `openclaw node install`에서 `--display-name` (노드의 `~/.openclaw/node.json`에 영구 저장).
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (게이트웨이 오버라이드).

### 명령어 허용 목록 지정

실행 승인은 **노드 호스트 당**입니다. 게이트웨이에서 허용 목록 항목을 추가하십시오.

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

승인은 `~/.openclaw/exec-approvals.json`의 노드 호스트에 있습니다.

### 노드에 실행 지점 설정

기본값 구성 (게이트웨이 설정):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

또는 세션 당:

```
/exec host=node security=allowlist node=<id-or-name>
```

한 번 설정되면, `host=node`가 있는 모든 `exec` 호출은 노드 호스트에서 실행됩니다 (노드 허용 목록/승인 대상임).

관련 문서:

- [노드 호스트 CLI](/ko-KR/cli/node)
- [실행 도구](/ko-KR/tools/exec)
- [실행 승인](/ko-KR/tools/exec-approvals)

## 명령어 호출

저수준 (원시 RPC):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

상위 레벨 도우미는 "에이전트에게 MEDIA 첨부 파일을 제공"하는 일반적인 작업 흐름을 위해 존재합니다.

## 스크린샷 (캔버스 스냅샷)

노드가 캔버스 (웹뷰)를 표시하고 있다면, `canvas.snapshot`는 `{ format, base64 }`를 반환합니다.

CLI 도우미 (임시 파일로 작성하고 `MEDIA:<경로>`를 출력):

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### 캔버스 제어

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

노트:

- `canvas present`는 URL이나 로컬 파일 경로 (`--target`)를 허용하며, 추가적으로 `--x/--y/--width/--height`를 사용하여 위치를 지정할 수 있습니다.
- `canvas eval`은 인라인 JS (`--js`)나 위치 인수를 허용합니다.

### A2UI (캔버스)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

노트:

- A2UI v0.8 JSONL만 지원되며 (v0.9/createSurface는 거부됨).

## 사진 + 비디오 (노드 카메라)

사진 (`jpg`):

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # 기본값: 양방향 (2 MEDIA 라인)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

비디오 클립 (`mp4`):

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

노트:

- `canvas.*`와 `camera.*`에 대해 노드는 **전면에** 있어야 합니다 (백그라운드 호출은 `NODE_BACKGROUND_UNAVAILABLE` 반환).
- 클립 길이는 현재 `<= 60s`로 제한되어 있습니다, 이는 기본적인 base64 페이로드의 크기를 제한하기 위한 것입니다.
- Android는 가능한 경우 `CAMERA`/`RECORD_AUDIO` 권한을 요청합니다; 거부된 권한은 `*_PERMISSION_REQUIRED`로 실패합니다.

## 화면 녹화 (노드)

노드는 `screen.record` (mp4)를 노출합니다. 예제:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

노트:

- `screen.record`는 노드 앱이 전면에 있어야 합니다.
- Android는 녹화 전에 시스템 화면 캡처 프롬프트를 표시합니다.
- 화면 녹화는 `<= 60s`로 제한됩니다.
- `--no-audio`는 마이크 캡처를 비활성화합니다 (iOS/Android에서 지원; macOS는 시스템 캡처 오디오 사용).
- 여러 화면이 있을 경우 `--screen <index>`를 사용하여 디스플레이를 선택하십시오.

## 위치 (노드)

노드는 설정에서 위치가 활성화되었을 때 `location.get`을 노출합니다.

CLI 도우미:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

노트:

- 위치는 **기본적으로 꺼져 있음**.
- "항상"은 시스템 권한이 필요합니다; 백그라운드 가져오기는 최선의 노력을 기울입니다.
- 응답에는 위도/경도, 정밀도 (미터), 타임스탬프가 포함됩니다.

## SMS (Android 노드)

Android 노드는 사용자가 **SMS** 권한을 부여하고 장치가 전화 기능을 지원하는 경우 `sms.send`를 노출할 수 있습니다.

저수준 호출:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

노트:

- 권한 프롬프트는 Android 장치에서 기능이 광고되기 전에 수락되어야 합니다.
- 전화 기능이 없는 Wi-Fi 전용 장치는 `sms.send`를 광고하지 않습니다.

## 시스템 명령어 (노드 호스트 / mac 노드)

macOS 노드는 `system.run`, `system.notify`, 및 `system.execApprovals.get/set`을 노출합니다.
헤드리스 노드 호스트는 `system.run`, `system.which`, 및 `system.execApprovals.get/set`을 노출합니다.

예제:

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

노트:

- `system.run`는 페이로드 내 표준 출력/표준 오류/종료 코드를 반환합니다.
- `system.notify`는 macOS 앱의 알림 권한 상태를 따릅니다.
- `system.run`은 `--cwd`, `--env KEY=VAL`, `--command-timeout`, 및 `--needs-screen-recording`을 지원합니다.
- `system.notify`는 `--priority <passive|active|timeSensitive>`와 `--delivery <system|overlay|auto>`를 지원합니다.
- 노드 호스트는 `PATH` 오버라이드를 무시합니다. 추가 PATH 항목이 필요한 경우, 노드 호스트 서비스 환경을 설정하거나 표준 위치에 도구를 설치하십시오. `--env`를 통해 `PATH`를 전달하지 마십시오.
- macOS 노드 모드에서 `system.run`은 macOS 앱의 실행 승인 (설정 → 실행 승인)에 의해 게이트됩니다. 묻기/허용 목록/전체는 헤드리스 노드 호스트와 동일하게 작동합니다; 거부된 프롬프트는 `SYSTEM_RUN_DENIED` 반환.
- 헤드리스 노드 호스트에서는 `system.run`이 실행 승인 (`~/.openclaw/exec-approvals.json`)에 의해 게이트됩니다.

## 실행 노드 바인딩

여러 노드가 사용 가능한 경우, 특정 노드에 실행을 바인딩할 수 있습니다. 이는 `exec host=node`의 기본 노드를 설정하며 에이전트 별로 덮어쓸 수 있습니다.

글로벌 기본값:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

에이전트 별 오버라이드:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

아무 노드나 허용하는 것으로 설정 해제:

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## 권한 맵

노드는 `node.list` / `node.describe`에 권한 이름(e.g., `screenRecording`, `accessibility`)으로 키가 설정된 `permissions` 맵을 포함할 수 있으며, 부울 값(`true` = 허용됨)을 가집니다.

## 헤드리스 노드 호스트 (크로스 플랫폼)

OpenClaw는 게이트웨이 웹소켓에 연결하고 `system.run` / `system.which`를 노출하는 **헤드리스 노드 호스트** (UI 없음)를 실행할 수 있습니다. 이는 Linux/Windows에서 유용하거나 서버와 함께 최소한의 노드를 실행하기 위해 유용합니다.

시작 방법:

```bash
openclaw node run --host <gateway-host> --port 18789
```

노트:

- 여전히 페어링이 필요합니다 (게이트웨이는 노드 승인 프롬프트를 표시할 것입니다).
- 노드 호스트는 `~/.openclaw/node.json`에 노드 ID, 토큰, 표시 이름, 게이트웨이 연결 정보를 저장합니다.
- 실행 승인은 `~/.openclaw/exec-approvals.json`를 통해 로컬에서 적용됩니다
  (참조 [실행 승인](/ko-KR/tools/exec-approvals)).
- macOS에서 헤드리스 노드 호스트는 동반 앱 실행 호스트가 도달 가능한 경우 이를 선호하며, 앱이 사용 불가능할 땐 로컬 실행으로 대체합니다. `OPENCLAW_NODE_EXEC_HOST=app`을 설정하여 앱 필요를 지정하거나, `OPENCLAW_NODE_EXEC_FALLBACK=0`으로 대체 기능을 비활성화하십시오.
- 게이트웨이 WS가 TLS를 사용하는 경우 `--tls` / `--tls-fingerprint`를 추가하십시오.

## Mac 노드 모드

- macOS 상태 표시줄 앱은 노드로서 게이트웨이 WS 서버에 연결하며 (따라서 `openclaw nodes …`가 이 Mac에 대해 작동함).
- 원격 모드에서는 앱이 게이트웨이 포트에 대해 SSH 터널을 열고 `localhost`에 연결합니다.