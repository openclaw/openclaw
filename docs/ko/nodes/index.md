---
summary: "노드: 캔버스/카메라/화면/시스템을 위한 페어링, 기능, 권한 및 CLI 헬퍼"
read_when:
  - iOS/Android 노드를 Gateway에 페어링할 때
  - 에이전트 컨텍스트를 위해 노드 캔버스/카메라를 사용할 때
  - 새로운 노드 명령 또는 CLI 헬퍼를 추가할 때
title: "노드"
---

# 노드

**노드(node)** 는 Gateway **WebSocket**(오퍼레이터와 동일한 포트)에 `role: "node"` 로 연결되는 컴패니언 디바이스(macOS/iOS/Android/헤드리스)이며, `node.invoke` 를 통해 `canvas.*`, `camera.*`, `system.*` 와 같은 명령 표면을 노출합니다. 프로토콜 세부 정보: [Gateway protocol](/gateway/protocol).

레거시 전송: [Bridge protocol](/gateway/bridge-protocol) (TCP JSONL; 사용 중단/현재 노드에서는 제거됨).

macOS 는 **노드 모드**로도 실행할 수 있습니다. 메뉴바 앱이 Gateway의 WS 서버에 연결되어 로컬 캔버스/카메라 명령을 노드로 노출합니다(따라서 `openclaw nodes …` 가 이 Mac에 대해 동작합니다).

참고:

- 노드는 **주변기기**이며, 게이트웨이가 아닙니다. 게이트웨이 서비스를 실행하지 않습니다.
- Telegram/WhatsApp 등의 메시지는 노드가 아니라 **게이트웨이**에 도착합니다.
- 문제 해결 런북: [/nodes/troubleshooting](/nodes/troubleshooting)

## 페어링 + 상태

**WS 노드는 디바이스 페어링을 사용합니다.** 노드는 `connect` 동안 디바이스 식별자를 제시하며, Gateway는 `role: node` 를 위한 디바이스 페어링 요청을 생성합니다. 디바이스의 CLI(또는 UI)에서 승인합니다.

빠른 CLI:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

참고:

- `nodes status` 는 디바이스 페어링 역할에 `node` 가 포함되면 노드를 **페어링됨** 으로 표시합니다.
- `node.pair.*` (CLI: `openclaw nodes pending/approve/reject`) 는 별도의 게이트웨이 소유 노드 페어링 저장소이며, WS `connect` 핸드셰이크를 **차단하지 않습니다**.

## 원격 노드 호스트 (system.run)

Gateway가 한 머신에서 실행되고 명령을 다른 머신에서 실행하려는 경우 **노드 호스트** 를 사용합니다. 모델은 여전히 **게이트웨이** 와 통신하며, `host=node` 이 선택되면 게이트웨이가 `exec` 호출을 **노드 호스트** 로 전달합니다.

### 어디서 무엇이 실행되나요

- **Gateway 호스트**: 메시지를 수신하고, 모델을 실행하며, 도구 호출을 라우팅합니다.
- **노드 호스트**: 노드 머신에서 `system.run`/`system.which` 를 실행합니다.
- **승인**: `~/.openclaw/exec-approvals.json` 를 통해 노드 호스트에서 강제됩니다.

### 노드 호스트 시작 (포그라운드)

노드 머신에서:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### SSH 터널을 통한 원격 게이트웨이 (loopback 바인드)

Gateway가 loopback(`gateway.bind=loopback`, 로컬 모드 기본값)에 바인드되면 원격 노드 호스트는 직접 연결할 수 없습니다. SSH 터널을 생성하고 노드 호스트가 터널의 로컬 끝을 가리키도록 설정하십시오.

예시 (노드 호스트 -> 게이트웨이 호스트):

```bash
# Terminal A (keep running): forward local 18790 -> gateway 127.0.0.1:18789
ssh -N -L 18790:127.0.0.1:18789 user@gateway-host

# Terminal B: export the gateway token and connect through the tunnel
export OPENCLAW_GATEWAY_TOKEN="<gateway-token>"
openclaw node run --host 127.0.0.1 --port 18790 --display-name "Build Node"
```

참고:

- 토큰은 게이트웨이 설정의 `gateway.auth.token` 입니다(게이트웨이 호스트의 `~/.openclaw/openclaw.json`).
- `openclaw node run` 는 인증을 위해 `OPENCLAW_GATEWAY_TOKEN` 를 읽습니다.

### 노드 호스트 시작 (서비스)

```bash
openclaw node install --host <gateway-host> --port 18789 --display-name "Build Node"
openclaw node restart
```

### 페어링 + 이름 지정

게이트웨이 호스트에서:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes list
```

이름 지정 옵션:

- `openclaw node run` / `openclaw node install` 의 `--display-name` (노드의 `~/.openclaw/node.json` 에 영구 저장).
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (게이트웨이 오버라이드).

### 명령 허용 목록 추가

Exec 승인은 **노드 호스트별** 입니다. 게이트웨이에서 허용 목록 항목을 추가하십시오:

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

승인 정보는 노드 호스트의 `~/.openclaw/exec-approvals.json` 에 저장됩니다.

### exec 를 노드로 지정

기본값 구성 (게이트웨이 설정):

```bash
openclaw config set tools.exec.host node
openclaw config set tools.exec.security allowlist
openclaw config set tools.exec.node "<id-or-name>"
```

또는 세션별로:

```
/exec host=node security=allowlist node=<id-or-name>
```

설정되면 `host=node` 를 포함한 모든 `exec` 호출은 노드 호스트에서 실행됩니다(노드 허용 목록/승인에 따름).

관련 항목:

- [Node host CLI](/cli/node)
- [Exec tool](/tools/exec)
- [Exec approvals](/tools/exec-approvals)

## 명령 호출

저수준(원시 RPC):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

일반적인 “에이전트에 MEDIA 첨부 제공” 워크플로를 위한 고수준 헬퍼도 제공됩니다.

## 스크린샷 (캔버스 스냅샷)

노드가 Canvas(WebView)를 표시 중이면 `canvas.snapshot` 가 `{ format, base64 }` 를 반환합니다.

CLI 헬퍼(임시 파일에 쓰고 `MEDIA:<path>` 를 출력):

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

참고:

- `canvas present` 는 URL 또는 로컬 파일 경로(`--target`)를 허용하며, 위치 지정을 위한 선택적 `--x/--y/--width/--height` 를 지원합니다.
- `canvas eval` 는 인라인 JS(`--js`) 또는 위치 인수를 허용합니다.

### A2UI (Canvas)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

참고:

- A2UI v0.8 JSONL 만 지원됩니다(v0.9/createSurface 는 거부됨).

## 사진 + 비디오 (노드 카메라)

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

- `canvas.*` 및 `camera.*` 를 위해 노드는 **포그라운드** 여야 합니다(백그라운드 호출은 `NODE_BACKGROUND_UNAVAILABLE` 를 반환).
- 클립 길이는 과도한 base64 페이로드를 방지하기 위해 제한됩니다(현재 `<= 60s`).
- Android 는 가능한 경우 `CAMERA`/`RECORD_AUDIO` 권한을 요청하며, 거부된 권한은 `*_PERMISSION_REQUIRED` 로 실패합니다.

## 화면 녹화 (노드)

노드는 `screen.record` (mp4)를 노출합니다. 예시:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

참고:

- `screen.record` 는 노드 앱이 포그라운드여야 합니다.
- Android 는 녹화 전에 시스템 화면 캡처 프롬프트를 표시합니다.
- 화면 녹화는 `<= 60s` 로 제한됩니다.
- `--no-audio` 는 마이크 캡처를 비활성화합니다(iOS/Android 지원; macOS 는 시스템 캡처 오디오 사용).
- 여러 화면이 있는 경우 `--screen <index>` 를 사용해 디스플레이를 선택하십시오.

## 위치 (노드)

설정에서 위치가 활성화되면 노드는 `location.get` 를 노출합니다.

CLI 헬퍼:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

참고:

- 위치는 **기본적으로 꺼져 있음** 입니다.
- “항상” 은 시스템 권한이 필요하며, 백그라운드 가져오기는 최선 노력 방식입니다.
- 응답에는 위도/경도, 정확도(미터), 타임스탬프가 포함됩니다.

## SMS (Android 노드)

Android 노드는 사용자가 **SMS** 권한을 부여하고 디바이스가 전화 기능을 지원할 때 `sms.send` 를 노출할 수 있습니다.

저수준 호출:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

참고:

- 기능이 광고되기 전에 Android 디바이스에서 권한 프롬프트를 수락해야 합니다.
- 전화 기능이 없는 Wi‑Fi 전용 디바이스는 `sms.send` 를 광고하지 않습니다.

## 시스템 명령 (노드 호스트 / Mac 노드)

macOS 노드는 `system.run`, `system.notify`, `system.execApprovals.get/set` 를 노출합니다.
헤드리스 노드 호스트는 `system.run`, `system.which`, `system.execApprovals.get/set` 를 노출합니다.

예시:

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

참고:

- `system.run` 는 페이로드에 stdout/stderr/종료 코드를 반환합니다.
- `system.notify` 는 macOS 앱의 알림 권한 상태를 준수합니다.
- `system.run` 는 `--cwd`, `--env KEY=VAL`, `--command-timeout`, `--needs-screen-recording` 를 지원합니다.
- `system.notify` 는 `--priority <passive|active|timeSensitive>` 및 `--delivery <system|overlay|auto>` 를 지원합니다.
- macOS 노드는 `PATH` 오버라이드를 무시합니다. 헤드리스 노드 호스트는 노드 호스트 PATH 를 앞에 붙일 때에만 `PATH` 를 허용합니다.
- macOS 노드 모드에서 `system.run` 는 macOS 앱의 exec 승인(Settings → Exec approvals)에 의해 제어됩니다.
  Ask/allowlist/full 은 헤드리스 노드 호스트와 동일하게 동작하며, 거부된 프롬프트는 `SYSTEM_RUN_DENIED` 를 반환합니다.
- 헤드리스 노드 호스트에서 `system.run` 는 exec 승인(`~/.openclaw/exec-approvals.json`)에 의해 제어됩니다.

## Exec 노드 바인딩

여러 노드를 사용할 수 있는 경우 exec 를 특정 노드에 바인딩할 수 있습니다.
이는 `exec host=node` 의 기본 노드를 설정합니다(에이전트별로 재정의 가능).

전역 기본값:

```bash
openclaw config set tools.exec.node "node-id-or-name"
```

에이전트별 오버라이드:

```bash
openclaw config get agents.list
openclaw config set agents.list[0].tools.exec.node "node-id-or-name"
```

모든 노드를 허용하려면 해제:

```bash
openclaw config unset tools.exec.node
openclaw config unset agents.list[0].tools.exec.node
```

## 권한 맵

노드는 `node.list` / `node.describe` 에서 권한 이름(예: `screenRecording`, `accessibility`)을 키로 하고 불리언 값(`true` = 허용됨)을 갖는 `permissions` 맵을 포함할 수 있습니다.

## 헤드리스 노드 호스트 (크로스 플랫폼)

OpenClaw 는 UI 없이 Gateway WebSocket 에 연결되어 `system.run` / `system.which` 를 노출하는 **헤드리스 노드 호스트** 를 실행할 수 있습니다. 이는 Linux/Windows 에서 유용하거나 서버 옆에 최소한의 노드를 실행할 때 유용합니다.

시작:

```bash
openclaw node run --host <gateway-host> --port 18789
```

참고:

- 페어링은 여전히 필요합니다(Gateway 에서 노드 승인 프롬프트가 표시됨).
- 노드 호스트는 노드 id, 토큰, 표시 이름, 게이트웨이 연결 정보를 `~/.openclaw/node.json` 에 저장합니다.
- Exec 승인은 `~/.openclaw/exec-approvals.json` 를 통해 로컬에서 강제됩니다
  ([Exec approvals](/tools/exec-approvals) 참조).
- macOS 에서 헤드리스 노드 호스트는 연결 가능할 때 컴패니언 앱 exec 호스트를 선호하며,
  앱을 사용할 수 없으면 로컬 실행으로 폴백합니다. 앱을 필수로 하려면 `OPENCLAW_NODE_EXEC_HOST=app` 를 설정하고,
  폴백을 비활성화하려면 `OPENCLAW_NODE_EXEC_FALLBACK=0` 를 설정하십시오.
- Gateway WS 가 TLS 를 사용하는 경우 `--tls` / `--tls-fingerprint` 를 추가하십시오.

## Mac 노드 모드

- macOS 메뉴바 앱은 Gateway WS 서버에 노드로 연결됩니다(따라서 `openclaw nodes …` 가 이 Mac에 대해 동작).
- 원격 모드에서 앱은 Gateway 포트를 위한 SSH 터널을 열고 `localhost` 에 연결합니다.
