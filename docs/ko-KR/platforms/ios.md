---
summary: "iOS 노드 앱: Gateway 연결, 페어링, Canvas 및 문제 해결"
read_when:
  - iOS 노드를 페어링하거나 재연결할 때
  - 소스에서 iOS 앱을 실행할 때
  - Gateway 발견 또는 Canvas 명령을 디버깅할 때
title: "iOS 앱"
x-i18n:
  generated_at: "2026-03-02T00:00:00Z"
  model: claude-opus-4-6
  provider: pi
  source_path: platforms/ios.md
  workflow: 15
---

# iOS 앱 (노드)

가용성: 내부 미리 보기. iOS 앱은 아직 공개적으로 배포되지 않습니다.

## 하는 일

- WebSocket 을 통해 Gateway 에 연결합니다 (LAN 또는 Tailnet).
- 노드 기능을 노출합니다: Canvas, 화면 스냅샷, 카메라 캡처, 위치, Talk 모드, Voice wake.
- `node.invoke` 명령을 수신하고 노드 상태 이벤트를 보고합니다.

## 요구 사항

- 다른 디바이스 (macOS, Linux 또는 Windows via WSL2) 에서 실행 중인 Gateway.
- 네트워크 경로:
  - Bonjour 를 통한 동일한 LAN, **또는**
  - Unicast DNS-SD 를 통한 Tailnet (예제 도메인: `openclaw.internal.`), **또는**
  - 수동 호스트/포트 (대체).

## 빠른 시작 (페어링 + 연결)

1. Gateway 를 시작합니다:

```bash
openclaw gateway --port 18789
```

2. iOS 앱에서 Settings 를 열고 발견된 Gateway를 선택하거나 (Manual Host 를 활성화하고 호스트/포트 입력).

3. Gateway 호스트에서 페어링 요청을 승인합니다:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. 연결 확인:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## 발견 경로

### Bonjour (LAN)

Gateway 는 `local.` 에서 `_openclaw-gw._tcp` 를 광고합니다. iOS 앱은 이를 자동으로 나열합니다.

### Tailnet (크로스 네트워크)

mDNS 가 차단되면 Unicast DNS-SD 영역 (도메인 선택; 예제: `openclaw.internal.`) 및 Tailscale split DNS 를 사용합니다.
CoreDNS 예제는 [Bonjour](/ko-KR/gateway/bonjour) 를 참조하세요.

### 수동 호스트/포트

Settings 에서 **Manual Host** 를 활성화하고 Gateway 호스트 + 포트 (기본값 `18789`) 를 입력합니다.

## Canvas + A2UI

iOS 노드는 WKWebView Canvas 를 렌더링합니다. `node.invoke` 를 사용하여 이를 구동합니다:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18789/__openclaw__/canvas/"}'
```

참고:

- Gateway Canvas 호스트는 `/__openclaw__/canvas/` 및 `/__openclaw__/a2ui/` 제공합니다.
- Gateway HTTP 서버에서 제공합니다 (`gateway.port` 와 동일한 포트, 기본값 `18789`).
- iOS 노드는 Canvas 호스트 URL 이 광고될 때 연결 시 A2UI 로 자동 탐색합니다.
- `canvas.navigate` 및 `{"url":""}` 로 빌트인 스캐폴드 로 돌아갑니다.

### Canvas eval / snapshot

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## Voice wake + Talk 모드

- Voice wake 및 Talk 모드는 Settings 에서 사용 가능합니다.
- iOS 는 백그라운드 오디오를 일시 중지할 수 있습니다; 앱이 활성화되지 않았을 때 Voice 기능을 최선의 노력으로 취급합니다.

## 일반적인 오류

- `NODE_BACKGROUND_UNAVAILABLE`: iOS 앱을 포그라운드 로 가져옵니다 (Canvas/카메라/화면 명령에는 필수).
- `A2UI_HOST_NOT_CONFIGURED`: Gateway 가 Canvas 호스트 URL 을 광고하지 않았습니다; [Gateway 구성](/ko-KR/gateway/configuration) 에서 `canvasHost` 확인.
- 페어링 프롬프트가 나타나지 않음: `openclaw nodes pending` 실행 후 수동으로 승인합니다.
- 재설치 후 재연결 실패: Keychain 페어링 토큰이 지워졌습니다; 노드를 다시 페어링합니다.

## 관련 문서

- [페어링](/ko-KR/gateway/pairing)
- [발견](/ko-KR/gateway/discovery)
- [Bonjour](/ko-KR/gateway/bonjour)
