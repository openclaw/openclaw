---
summary: "iOS node app: connect to the Gateway, pairing, canvas, and troubleshooting"
read_when:
  - Pairing or reconnecting the iOS node
  - Running the iOS app from source
  - Debugging gateway discovery or canvas commands
title: "iOS App"
x-i18n:
  source_hash: 692eebdc82e4bb8dc221bcbabf6a344a861a839fc377f1aeeb6eecaa4917a232
---

# iOS 앱(노드)

가용성: 내부 미리보기. iOS 앱은 아직 공개적으로 배포되지 않았습니다.

## 기능

- WebSocket(LAN 또는 tailnet)을 통해 게이트웨이에 연결합니다.
- 노드 기능 공개: 캔버스, 화면 스냅샷, 카메라 캡처, 위치, 대화 모드, 음성 깨우기.
- `node.invoke` 명령을 수신하고 노드 상태 이벤트를 보고합니다.

## 요구사항

- 다른 장치(WSL2를 통한 macOS, Linux 또는 Windows)에서 실행되는 게이트웨이.
- 네트워크 경로:
  - Bonjour를 통한 동일한 LAN, **또는**
  - 유니캐스트 DNS-SD를 통한 테일넷(도메인 예: `openclaw.internal.`), **또는**
  - 수동 호스트/포트(대체).

## 빠른 시작(페어링 + 연결)

1. 게이트웨이를 시작합니다.

```bash
openclaw gateway --port 18789
```

2. iOS 앱에서 설정을 열고 검색된 게이트웨이를 선택합니다(또는 수동 호스트를 활성화하고 호스트/포트를 입력합니다).

3. 게이트웨이 호스트에서 페어링 요청을 승인합니다.

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. 연결을 확인합니다.

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## 검색 경로

### 봉쥬르(LAN)

게이트웨이는 `local.`에 `_openclaw-gw._tcp`를 광고합니다. iOS 앱은 이를 자동으로 나열합니다.

### Tailnet(교차 네트워크)

mDNS가 차단된 경우 유니캐스트 DNS-SD 영역(도메인 선택, 예: `openclaw.internal.`) 및 Tailscale 분할 DNS를 사용합니다.
CoreDNS 예제는 [Bonjour](/gateway/bonjour)를 참조하세요.

### 수동 호스트/포트

설정에서 **수동 호스트**를 활성화하고 게이트웨이 호스트 + 포트(기본값 `18789`)를 입력합니다.

## 캔버스 + A2UI

iOS 노드는 WKWebView 캔버스를 렌더링합니다. `node.invoke`를 사용하여 운전하세요.

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

참고:

- 게이트웨이 캔버스 호스트는 `/__openclaw__/canvas/` 및 `/__openclaw__/a2ui/`를 서비스합니다.
- iOS 노드는 캔버스 호스트 URL이 광고될 때 연결 시 A2UI로 자동 탐색됩니다.
- `canvas.navigate`와 `{"url":""}`를 사용하여 내장된 발판으로 돌아갑니다.

### 캔버스 평가/스냅샷

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## 음성 깨우기 + 대화 모드

- 설정에서 음성 깨우기 및 대화 모드를 사용할 수 있습니다.
- iOS는 배경 오디오를 일시 중단할 수 있습니다. 앱이 활성화되지 않은 경우 음성 기능을 최선의 노력으로 처리합니다.

## 일반적인 오류

- `NODE_BACKGROUND_UNAVAILABLE`: iOS 앱을 포그라운드로 가져옵니다(캔버스/카메라/화면 명령이 필요함).
- `A2UI_HOST_NOT_CONFIGURED`: 게이트웨이가 캔버스 호스트 URL을 광고하지 않았습니다. [게이트웨이 구성](/gateway/configuration)에서 `canvasHost`를 확인하세요.
- 페어링 메시지가 절대 나타나지 않습니다. `openclaw nodes pending`를 실행하고 수동으로 승인하세요.
- 재설치 후 재연결 실패: 키체인 페어링 토큰이 지워졌습니다. 노드를 다시 페어링하십시오.

## 관련 문서

- [페어링](/gateway/pairing)
- [발견](/gateway/discovery)
- [안녕하세요](/gateway/bonjour)
