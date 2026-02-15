---
summary: "Nodes: pairing, capabilities, permissions, and CLI helpers for canvas/camera/screen/system"
read_when:
  - Pairing iOS/Android nodes to a gateway
  - Using node canvas/camera for agent context
  - Adding new node commands or CLI helpers
title: "Nodes"
x-i18n:
  source_hash: ba259b5c384b93298638872672653f6b9fcba16d224ac77919a624b118f81ded
---

# 노드

**노드**는 `role: "node"`를 사용하여 게이트웨이 **WebSocket**(운영자와 동일한 포트)에 연결하고 다음을 통해 명령 표면(예: `canvas.*`, `camera.*`, `system.*`)을 노출하는 동반 장치(macOS/iOS/Android/헤드리스)입니다. `node.invoke`. 프로토콜 세부정보: [게이트웨이 프로토콜](/gateway/protocol).

레거시 전송: [브리지 프로토콜](/gateway/bridge-protocol) (TCP JSONL, 현재 노드에서는 더 이상 사용되지 않음/제거됨).

macOS는 **노드 모드**에서도 실행할 수 있습니다. 메뉴 표시줄 앱은 게이트웨이의 WS 서버에 연결하고 로컬 캔버스/카메라 명령을 노드로 노출합니다(그래서 `openclaw nodes …`는 이 Mac에서 작동합니다).

참고:

- 노드는 게이트웨이가 아닌 **주변 장치**입니다. 게이트웨이 서비스를 실행하지 않습니다.
- 텔레그램/WhatsApp/등. 메시지는 노드가 아닌 **게이트웨이**에 도착합니다.
- 문제 해결 런북: [/nodes/troubleshooting](/nodes/troubleshooting)

## 페어링 + 상태

**WS 노드는 장치 페어링을 사용합니다.** 노드는 `connect` 동안 장치 ID를 나타냅니다. 게이트웨이
`role: node`에 대한 장치 페어링 요청을 생성합니다. 장치 CLI(또는 UI)를 통해 승인합니다.

빠른 CLI:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

참고:

- `nodes status`는 장치 페어링 역할에 `node`가 포함된 경우 노드를 **페어링됨**으로 표시합니다.
- `node.pair.*` (CLI: `openclaw nodes pending/approve/reject`)는 별도의 게이트웨이 소유입니다.
  노드 페어링 저장소; WS `connect` 핸드셰이크를 게이트하지 **않습니다**.

## 원격 노드 호스트(system.run)

게이트웨이가 한 시스템에서 실행되고 명령이 필요한 경우 **노드 호스트**를 사용하세요.
다른 것을 실행합니다. 모델은 여전히 ​​**게이트웨이**와 통신합니다. 관문
`exec` 호출을 **노드 호스트**로 전달합니다. `host=node`이 선택되었습니다.

### 무엇이 실행되는 곳

- **게이트웨이 호스트**: 메시지 수신, 모델 실행, 도구 호출 라우팅.
- **노드 호스트**: 노드 머신에서 `system.run`/`system.which`를 실행합니다.
- **승인**: `~/.openclaw/exec-approvals.json`를 통해 노드 호스트에 적용됩니다.

### 노드 호스트 시작(포그라운드)

노드 머신에서:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### SSH 터널을 통한 원격 게이트웨이(루프백 바인딩)

게이트웨이가 루프백(`gateway.bind=loopback`, 로컬 모드의 기본값)에 바인딩된 경우,
원격 노드 호스트는 직접 연결할 수 없습니다. SSH 터널을 생성하고
터널의 로컬 끝에 있는 노드 호스트.

예(노드 호스트 -> 게이트웨이 호스트):

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

참고:

- 토큰은 게이트웨이 구성의 `gateway.auth.token`입니다(게이트웨이 호스트의 `~/.openclaw/openclaw.json`).
- `openclaw node run`는 인증을 위해 `OPENCLAW_GATEWAY_TOKEN`를 읽습니다.

### 노드 호스트(서비스) 시작

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### 쌍 + 이름

게이트웨이 호스트에서:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

이름 지정 옵션:

- `--display-name` on `openclaw node run` / `openclaw node install` (노드의 `~/.openclaw/node.json`에 유지됩니다.)
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (게이트웨이 재정의).

### 명령을 허용 목록에 추가하세요.

Exec 승인은 **노드 호스트별로** 이루어집니다. 게이트웨이에서 허용 목록 항목을 추가합니다.

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

승인은 `~/.openclaw/exec-approvals.json`의 노드 호스트에 적용됩니다.

### 노드에서 포인트 실행

기본값 구성(게이트웨이 구성):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

또는 세션당:

```
/exec host=node security=allowlist node=<id-or-name>
```

일단 설정되면 `host=node`를 사용한 모든 `exec` 호출은 노드 호스트에서 실행됩니다(다음에 따라 다름).
노드 허용 목록/승인).

관련된:

- [노드 호스트 CLI](/cli/node)
- [실행 도구](/tools/exec)
- [실행 승인](/tools/exec-approvals)

## 명령 호출

낮은 수준(원시 RPC):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

일반적인 "상담원에게 미디어 첨부 파일 제공" 워크플로를 위한 더 높은 수준의 도우미가 존재합니다.

## 스크린샷(캔버스 스냅샷)

노드가 캔버스(WebView)를 표시하는 경우 `canvas.snapshot`는 `{ format, base64 }`를 반환합니다.

CLI 도우미(임시 파일에 쓰고 `MEDIA:<path>` 인쇄):

```bash
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format png
openclaw nodes canvas snapshot --node <idOrNameOrIp> --format jpg --max-width 1200 --quality 0.9
```

### 캔버스 컨트롤

```bash
openclaw nodes canvas present --node <idOrNameOrIp> --target https://example.com
openclaw nodes canvas hide --node <idOrNameOrIp>
openclaw nodes canvas navigate https://example.com --node <idOrNameOrIp>
openclaw nodes canvas eval --node <idOrNameOrIp> --js "document.title"
```

참고:

- `canvas present`는 URL 또는 로컬 파일 경로(`--target`)와 위치 지정을 위한 선택 사항인 `--x/--y/--width/--height`를 허용합니다.
- `canvas eval`는 인라인 JS(`--js`) 또는 위치 인수를 허용합니다.

### A2UI(캔버스)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

참고:

- A2UI v0.8 JSONL만 지원됩니다(v0.9/createSurface는 거부됨).

## 사진 + 동영상(노드 카메라)

사진(`jpg`):

```bash
openclaw nodes camera list --node <idOrNameOrIp>
openclaw nodes camera snap --node <idOrNameOrIp>            # default: both facings (2 MEDIA lines)
openclaw nodes camera snap --node <idOrNameOrIp> --facing front
```

비디오 클립(`mp4`):

```bash
openclaw nodes camera clip --node <idOrNameOrIp> --duration 10s
openclaw nodes camera clip --node <idOrNameOrIp> --duration 3000 --no-audio
```

참고:

- 노드는 `canvas.*` 및 `camera.*`에 대해 **포그라운드**되어야 합니다(백그라운드 호출은 `NODE_BACKGROUND_UNAVAILABLE`를 반환합니다).
- 너무 큰 base64 페이로드를 방지하기 위해 클립 길이가 고정됩니다(현재 `<= 60s`).
- Android는 가능한 경우 `CAMERA`/`RECORD_AUDIO` 권한을 묻는 메시지를 표시합니다. 거부된 권한은 `*_PERMISSION_REQUIRED`로 인해 실패합니다.

## 화면 녹화(노드)

노드는 `screen.record`(mp4)를 노출합니다. 예:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

참고:

- `screen.record` 노드 앱이 포그라운드에 있어야 합니다.
- Android는 녹음하기 전에 시스템 화면 캡처 프롬프트를 표시합니다.
- 화면 녹화는 `<= 60s`로 고정됩니다.
- `--no-audio`는 마이크 캡처를 비활성화합니다(iOS/Android에서 지원됨, macOS는 시스템 캡처 오디오를 사용함).
- 여러 화면을 사용할 수 있는 경우 `--screen <index>`를 사용하여 디스플레이를 선택합니다.

## 위치(노드)

설정에서 위치가 활성화되면 노드는 `location.get`를 노출합니다.

CLI 도우미:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

참고:

- 위치는 **기본적으로 꺼져 있습니다**.
- "항상"에는 시스템 권한이 필요합니다. 백그라운드 가져오기는 최선의 노력을 다합니다.
- 응답에는 위도/경도, 정확도(미터) 및 타임스탬프가 포함됩니다.

## SMS(안드로이드 노드)

Android 노드는 사용자가 **SMS** 권한을 부여하고 기기가 전화 통신을 지원할 때 `sms.send`를 노출할 수 있습니다.

낮은 수준 호출:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

참고:

- 기능이 광고되기 전에 Android 기기에서 권한 프롬프트를 수락해야 합니다.
- 전화 연결이 없는 Wi-Fi 전용 장치는 `sms.send`을 광고하지 않습니다.

## 시스템 명령(노드 호스트/mac 노드)

macOS 노드는 `system.run`, `system.notify` 및 `system.execApprovals.get/set`를 노출합니다.
헤드리스 노드 호스트는 `system.run`, `system.which` 및 `system.execApprovals.get/set`를 노출합니다.

예:

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

참고:

- `system.run`는 페이로드의 stdout/stderr/종료 코드를 반환합니다.
- `system.notify`는 macOS 앱의 알림 권한 상태를 존중합니다.
- `system.run`는 `--cwd`, `--env KEY=VAL`, `--command-timeout`, `--needs-screen-recording`를 지원합니다.
- `system.notify`는 `--priority <passive|active|timeSensitive>` 및 `--delivery <system|overlay|auto>`를 지원합니다.
- macOS 노드는 `PATH` 재정의를 삭제합니다. 헤드리스 노드 호스트는 노드 호스트 PATH 앞에 추가되는 경우에만 `PATH`를 허용합니다.
- macOS 노드 모드에서 `system.run`는 macOS 앱의 exec 승인(설정 → Exec 승인)에 의해 제어됩니다.
  Ask/allowlist/full은 헤드리스 노드 호스트와 동일하게 작동합니다. 거부된 프롬프트는 `SYSTEM_RUN_DENIED`를 반환합니다.
- 헤드리스 노드 호스트에서 `system.run`는 실행 승인(`~/.openclaw/exec-approvals.json`)에 의해 제어됩니다.

## Exec 노드 바인딩

여러 노드를 사용할 수 있는 경우 exec를 특정 노드에 바인딩할 수 있습니다.
이는 `exec host=node`에 대한 기본 노드를 설정합니다(에이전트별로 재정의될 수 있음).

전역 기본값:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

에이전트별 재정의:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

모든 노드를 허용하려면 설정을 해제하세요.

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## 권한 맵

노드는 `node.list` / `node.describe`에 `permissions` 맵을 포함할 수 있으며, 권한 이름(예: `screenRecording`, `accessibility`)과 부울 값(`true` = 부여됨)으로 입력됩니다.

## 헤드리스 노드 호스트(크로스 플랫폼)

OpenClaw는 게이트웨이에 연결되는 **헤드리스 노드 호스트**(UI 없음)를 실행할 수 있습니다.
WebSocket을 사용하고 `system.run` / `system.which`를 노출합니다. 이는 Linux/Windows에서 유용합니다.
또는 서버와 함께 최소 노드를 실행하는 경우.

시작하세요:

```bash
openclaw node run --host <gateway-host> --port 18789
```

참고:

- 페어링이 여전히 필요합니다(게이트웨이에 노드 승인 메시지가 표시됩니다).
- 노드 호스트는 자신의 노드 ID, 토큰, 표시 이름, 게이트웨이 연결 정보를 `~/.openclaw/node.json`에 저장합니다.
- Exec 승인은 `~/.openclaw/exec-approvals.json`을 통해 로컬로 시행됩니다.
  ([실행 승인](/tools/exec-approvals) 참조).
- macOS에서 헤드리스 노드 호스트는 연결 가능하고 실패할 때 동반 앱 실행 호스트를 선호합니다.
  앱을 사용할 수 없으면 로컬 실행으로 돌아갑니다. `OPENCLAW_NODE_EXEC_HOST=app`를 설정하여 요구합니다.
  대체를 비활성화하려면 앱을 사용하거나 `OPENCLAW_NODE_EXEC_FALLBACK=0`를 선택하세요.
- Gateway WS가 TLS를 사용하는 경우 `--tls` / `--tls-fingerprint`를 추가합니다.

## Mac 노드 모드

- macOS 메뉴 표시줄 앱은 게이트웨이 WS 서버에 노드로 연결됩니다(따라서 `openclaw nodes …`는 이 Mac에서 작동합니다).
- 원격 모드에서 앱은 게이트웨이 포트에 대한 SSH 터널을 열고 `localhost`에 연결합니다.
