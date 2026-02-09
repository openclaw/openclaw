---
summary: "iOS 노드 앱: Gateway 연결, 페어링, 캔버스 및 문제 해결"
read_when:
  - iOS 노드 페어링 또는 재연결
  - 소스에서 iOS 앱 실행
  - Gateway 디바이스 검색 또는 캔버스 명령 디버깅
title: "iOS 앱"
---

# iOS 앱 (Node)

가용성: 내부 프리뷰. iOS 앱은 아직 공개 배포되지 않았습니다.

## What it does

- WebSocket 을 통해 Gateway(게이트웨이)에 연결합니다 (LAN 또는 tailnet).
- 노드 기능을 노출합니다: Canvas, 화면 스냅샷, 카메라 캡처, 위치, 대화 모드, 음성 깨우기.
- `node.invoke` 명령을 수신하고 노드 상태 이벤트를 보고합니다.

## 요구 사항

- 다른 장치에서 실행 중인 Gateway(게이트웨이) (macOS, Linux, 또는 WSL2 를 통한 Windows).
- 네트워크 경로:
  - Bonjour 를 통한 동일 LAN, **또는**
  - 유니캐스트 DNS-SD 를 통한 Tailnet (예시 도메인: `openclaw.internal.`), **또는**
  - 수동 호스트/포트 (대체 수단).

## 빠른 시작 (페어링 + 연결)

1. Gateway(게이트웨이)를 시작합니다:

```bash
openclaw gateway --port 18789
```

2. iOS 앱에서 설정을 열고 검색된 Gateway(게이트웨이)를 선택합니다 (또는 수동 호스트를 활성화하고 호스트/포트를 입력합니다).

3. Gateway(게이트웨이) 호스트에서 페어링 요청을 승인합니다:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. 연결을 확인합니다:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## 디바이스 검색 경로

### Bonjour (LAN)

Gateway(게이트웨이)는 `local.` 에서 `_openclaw-gw._tcp` 를 광고합니다. iOS 앱은 이를 자동으로 나열합니다.

### Tailnet (교차 네트워크)

mDNS 가 차단된 경우, 유니캐스트 DNS-SD 존을 사용하십시오 (도메인을 선택합니다; 예시: `openclaw.internal.`) 그리고 Tailscale 분할 DNS 를 구성합니다.
CoreDNS 예시는 [Bonjour](/gateway/bonjour)를 참고하십시오.

### 수동 호스트/포트

설정에서 **수동 호스트**를 활성화하고 Gateway(게이트웨이) 호스트 + 포트를 입력합니다 (기본값 `18789`).

## Canvas + A2UI

iOS 노드는 WKWebView 캔버스를 렌더링합니다. 이를 제어하려면 `node.invoke` 를 사용하십시오:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

참고 사항:

- Gateway(게이트웨이) 캔버스 호스트는 `/__openclaw__/canvas/` 및 `/__openclaw__/a2ui/` 를 제공합니다.
- iOS 노드는 캔버스 호스트 URL 이 광고되면 연결 시 A2UI 로 자동 이동합니다.
- `canvas.navigate` 및 `{"url":""}` 으로 기본 제공 스캐폴드로 돌아갑니다.

### Canvas eval / 스냅샷

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## 음성 깨우기 + 대화 모드

- 음성 깨우기와 대화 모드는 설정에서 사용할 수 있습니다.
- iOS 는 백그라운드 오디오를 중단할 수 있습니다; 앱이 활성화되지 않은 경우 음성 기능은 최선의 노력 수준으로 처리하십시오.

## 일반적인 오류

- `NODE_BACKGROUND_UNAVAILABLE`: iOS 앱을 전면으로 가져오십시오 (캔버스/카메라/화면 명령에는 전면 실행이 필요합니다).
- `A2UI_HOST_NOT_CONFIGURED`: Gateway(게이트웨이)가 캔버스 호스트 URL 을 광고하지 않았습니다; [Gateway 구성](/gateway/configuration)에서 `canvasHost` 를 확인하십시오.
- 페어링 프롬프트가 표시되지 않음: `openclaw nodes pending` 를 실행하고 수동으로 승인하십시오.
- 재설치 후 재연결 실패: 키체인 페어링 토큰이 초기화되었습니다; 노드를 다시 페어링하십시오.

## 관련 문서

- [페어링](/gateway/pairing)
- [디바이스 검색](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
