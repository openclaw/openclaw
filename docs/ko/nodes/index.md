---
read_when:
    - iOS/Android 노드를 게이트웨이에 페어링
    - 에이전트 컨텍스트에 노드 캔버스/카메라 사용
    - 새 노드 명령 또는 CLI 도우미 추가
summary: '노드: 캔버스/카메라/화면/시스템에 대한 페어링, 기능, 권한 및 CLI 도우미'
title: 노드
x-i18n:
    generated_at: "2026-02-08T15:58:16Z"
    model: gtx
    provider: google-translate
    source_hash: ba259b5c384b93298638872672653f6b9fcba16d224ac77919a624b118f81ded
    source_path: nodes/index.md
    workflow: 15
---

# 노드

에이 **마디** 게이트웨이에 연결하는 동반 장치(macOS/iOS/Android/헤드리스)입니다. **웹소켓** (운영자와 동일한 포트) `role: "node"` 명령 표면을 노출합니다(예: `canvas.*`, `camera.*`, `system.*`) 을 통해 `node.invoke`. 프로토콜 세부정보: [게이트웨이 프로토콜](/gateway/protocol).

레거시 전송: [브리지 프로토콜](/gateway/bridge-protocol) (TCP JSONL; 현재 노드에서는 더 이상 사용되지 않음/제거됨)

macOS는 다음에서도 실행할 수 있습니다. **노드 모드**: 메뉴바 앱은 게이트웨이의 WS 서버에 연결하고 로컬 캔버스/카메라 명령을 노드로 노출합니다. `openclaw nodes …` 이 Mac에서 작동합니다).

참고:

- 노드는 **주변기기**, 게이트웨이가 아닙니다. 게이트웨이 서비스를 실행하지 않습니다.
- 텔레그램/WhatsApp/등. 메시지가 **게이트웨이**, 노드에는 없습니다.
- 문제 해결 런북: [/노드/문제 해결](/nodes/troubleshooting)

## 페어링 + 상태

**WS 노드는 장치 페어링을 사용합니다.** 노드는 다음 동안 장치 ID를 제공합니다. `connect`; 게이트웨이
다음에 대한 장치 페어링 요청을 생성합니다. `role: node`. 장치 CLI(또는 UI)를 통해 승인합니다.

빠른 CLI:

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
```

참고:

- `nodes status` 노드를 다음과 같이 표시합니다. **짝을 이루는** 장치 페어링 역할에 다음이 포함된 경우 `node`.
- `node.pair.*` (CLI: `openclaw nodes pending/approve/reject`)은 별도의 게이트웨이 소유입니다.
  노드 페어링 저장소; 그렇죠 **~ 아니다** WS의 문을 열다 `connect` 악수.

## 원격 노드 호스트(system.run)

사용 **노드 호스트** 게이트웨이가 한 시스템에서 실행되고 명령을 원할 때
다른 것을 실행합니다. 모델은 여전히 ​​​​대화하고 있습니다. **게이트웨이**; 관문
앞으로 `exec` 에게 전화를 겁니다 **노드 호스트** 언제 `host=node` 선택되었습니다.

### 무엇이 어디에서 실행되는가

- **게이트웨이 호스트**: 메시지를 받고, 모델을 실행하고, 도구 호출을 라우팅합니다.
- **노드 호스트**: 실행 `system.run`/`system.which` 노드 머신에서.
- **승인**: 다음을 통해 노드 호스트에 적용됩니다. `~/.openclaw/exec-approvals.json`.

### 노드 호스트 시작(포그라운드)

노드 머신에서:

```bash
openclaw node run --host <gateway-host> --port 18789 --display-name "Build Node"
```

### SSH 터널을 통한 원격 게이트웨이(루프백 바인딩)

게이트웨이가 루프백(`gateway.bind=loopback`, 로컬 모드에서는 기본값),
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

- 토큰은 `gateway.auth.token` 게이트웨이 구성에서(`~/.openclaw/openclaw.json` 게이트웨이 호스트에서).
- `openclaw node run` 읽다 `OPENCLAW_GATEWAY_TOKEN` 인증을 위해.

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

- `--display-name` ~에 `openclaw node run`/`openclaw node install` (지속 `~/.openclaw/node.json` 노드에서).
- `openclaw nodes rename --node <id|name|ip> --name "Build Node"` (게이트웨이 재정의).

### 명령을 허용 목록에 추가하세요.

임원 승인은 다음과 같습니다. **노드 호스트당**. 게이트웨이에서 허용 목록 항목을 추가합니다.

```bash
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/uname"
openclaw approvals allowlist add --node <id|name|ip> "/usr/bin/sw_vers"
```

승인은 다음 노드 호스트에 적용됩니다. `~/.openclaw/exec-approvals.json`.

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

일단 설정되면 모든 `exec` 전화하다 `host=node` 노드 호스트에서 실행됩니다(다음에 따라 다름).
노드 허용 목록/승인).

관련된:

- [노드 호스트 CLI](/cli/node)
- [실행 도구](/tools/exec)
- [임원 승인](/tools/exec-approvals)

## 명령 호출

낮은 수준(원시 RPC):

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command canvas.eval --params '{"javaScript":"location.href"}'
```

일반적인 "상담원에게 미디어 첨부 파일 제공" 워크플로를 위한 더 높은 수준의 도우미가 존재합니다.

## 스크린샷(캔버스 스냅샷)

노드가 Canvas(WebView)를 표시하는 경우 `canvas.snapshot` 보고 `{ format, base64 }`.

CLI 도우미(임시 파일에 쓰고 인쇄 `MEDIA:<path>`):

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

- `canvas present` URL 또는 로컬 파일 경로를 허용합니다(`--target`) 및 선택사항 `--x/--y/--width/--height` 포지셔닝을 위해.
- `canvas eval` 인라인 JS를 허용합니다(`--js`) 또는 위치 인수입니다.

### A2UI(캔버스)

```bash
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --text "Hello"
openclaw nodes canvas a2ui push --node <idOrNameOrIp> --jsonl ./payload.jsonl
openclaw nodes canvas a2ui reset --node <idOrNameOrIp>
```

참고:

- A2UI v0.8 JSONL만 지원됩니다(v0.9/createSurface는 거부됨).

## 사진+동영상(노드 카메라)

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

- 노드는 다음과 같아야 합니다. **전경** ~을 위한 `canvas.*` 그리고 `camera.*` (백그라운드 호출이 반환됨 `NODE_BACKGROUND_UNAVAILABLE`).
- 클립 재생 시간이 고정되어 있습니다(현재 `<= 60s`) 너무 큰 Base64 페이로드를 방지합니다.
- Android에서 다음 메시지를 표시합니다. `CAMERA`/`RECORD_AUDIO` 가능한 경우 권한; 거부된 권한은 실패합니다. `*_PERMISSION_REQUIRED`.

## 화면 녹화(노드)

노드 노출 `screen.record` (MP4). 예:

```bash
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10
openclaw nodes screen record --node <idOrNameOrIp> --duration 10s --fps 10 --no-audio
```

참고:

- `screen.record` 노드 앱이 포그라운드에 있어야 합니다.
- Android는 녹음하기 전에 시스템 화면 캡처 프롬프트를 표시합니다.
- 화면 녹화는 다음에 고정됩니다. `<= 60s`.
- `--no-audio` 마이크 캡처를 비활성화합니다(iOS/Android에서 지원됨, macOS는 시스템 캡처 오디오를 사용함).
- 사용 `--screen <index>` 여러 화면을 사용할 수 있는 경우 디스플레이를 선택합니다.

## 위치(노드)

노드 노출 `location.get` 설정에서 위치가 활성화된 경우.

CLI 도우미:

```bash
openclaw nodes location get --node <idOrNameOrIp>
openclaw nodes location get --node <idOrNameOrIp> --accuracy precise --max-age 15000 --location-timeout 10000
```

참고:

- 위치는 **기본적으로 꺼짐**.
- "항상"에는 시스템 권한이 필요합니다. 백그라운드 가져오기는 최선의 노력을 다합니다.
- 응답에는 위도/경도, 정확도(미터) 및 타임스탬프가 포함됩니다.

## SMS(안드로이드 노드)

Android 노드는 노출될 수 있습니다. `sms.send` 사용자가 승인할 때 **SMS** 권한이 있고 장치가 전화 통신을 지원합니다.

낮은 수준 호출:

```bash
openclaw nodes invoke --node <idOrNameOrIp> --command sms.send --params '{"to":"+15555550123","message":"Hello from OpenClaw"}'
```

참고:

- 기능이 광고되기 전에 Android 장치에서 권한 프롬프트를 수락해야 합니다.
- 전화 통신 기능이 없는 Wi-Fi 전용 장치는 광고하지 않습니다. `sms.send`.

## 시스템 명령(노드 호스트/mac 노드)

macOS 노드가 노출됩니다. `system.run`, `system.notify`, 그리고 `system.execApprovals.get/set`.
헤드리스 노드 호스트가 노출됩니다. `system.run`, `system.which`, 그리고 `system.execApprovals.get/set`.

예:

```bash
openclaw nodes run --node <idOrNameOrIp> -- echo "Hello from mac node"
openclaw nodes notify --node <idOrNameOrIp> --title "Ping" --body "Gateway ready"
```

참고:

- `system.run` 페이로드에 stdout/stderr/exit 코드를 반환합니다.
- `system.notify` macOS 앱의 알림 권한 상태를 존중합니다.
- `system.run` 지원하다 `--cwd`, `--env KEY=VAL`, `--command-timeout`, 그리고 `--needs-screen-recording`.
- `system.notify` 지원하다 `--priority <passive|active|timeSensitive>` 그리고 `--delivery <system|overlay|auto>`.
- macOS 노드 드롭 `PATH` 재정의; 헤드리스 노드 호스트만 허용 `PATH` 노드 호스트 PATH 앞에 추가할 때.
- macOS 노드 모드에서는 `system.run` macOS 앱의 exec 승인(설정 → Exec 승인)에 따라 제어됩니다.
  Ask/allowlist/full은 헤드리스 노드 호스트와 동일하게 작동합니다. 거부된 프롬프트 반환 `SYSTEM_RUN_DENIED`.
- 헤드리스 노드 호스트에서 `system.run` 임원 승인에 의해 관리됩니다(`~/.openclaw/exec-approvals.json`).

## Exec 노드 바인딩

여러 노드를 사용할 수 있는 경우 exec를 특정 노드에 바인딩할 수 있습니다.
이는 기본 노드를 설정합니다. `exec host=node` (그리고 에이전트별로 재정의될 수 있습니다).

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

## 권한 지도

노드에는 다음이 포함될 수 있습니다. `permissions` 지도에 넣다 `node.list`/`node.describe`, 권한 이름으로 입력됨(예: `screenRecording`, `accessibility`) 부울 값 포함(`true` = 부여됨).

## 헤드리스 노드 호스트(교차 플랫폼)

OpenClaw는 다음을 실행할 수 있습니다. **헤드리스 노드 호스트** (UI 없음) 게이트웨이에 연결
WebSocket 및 노출 `system.run`/`system.which`. 이는 Linux/Windows에서 유용합니다.
또는 서버와 함께 최소 노드를 실행하는 경우.

시작하세요:

```bash
openclaw node run --host <gateway-host> --port 18789
```

참고:

- 페어링은 여전히 ​​필요합니다(게이트웨이에 노드 승인 메시지가 표시됨).
- 노드 호스트는 노드 ID, 토큰, 표시 이름 및 게이트웨이 연결 정보를 저장합니다. `~/.openclaw/node.json`.
- Exec 승인은 다음을 통해 로컬로 시행됩니다. `~/.openclaw/exec-approvals.json`
  (보다 [임원 승인](/tools/exec-approvals)).
- macOS에서 헤드리스 노드 호스트는 연결 가능하고 실패할 때 동반 앱 실행 호스트를 선호합니다.
  앱을 사용할 수 없으면 로컬 실행으로 돌아갑니다. 세트 `OPENCLAW_NODE_EXEC_HOST=app` 요구하다
  앱이나 `OPENCLAW_NODE_EXEC_FALLBACK=0` 대체를 비활성화합니다.
- 추가하다 `--tls`/`--tls-fingerprint` 게이트웨이 WS가 TLS를 사용하는 경우.

## Mac 노드 모드

- macOS 메뉴바 앱은 게이트웨이 WS 서버에 노드로 연결됩니다(따라서 `openclaw nodes …` 이 Mac에서 작동합니다).
- 원격 모드에서 앱은 게이트웨이 포트에 대한 SSH 터널을 열고 다음에 연결합니다. `localhost`.
