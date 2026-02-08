---
read_when:
    - iOS 노드 페어링 또는 다시 연결
    - 소스에서 iOS 앱 실행
    - 게이트웨이 검색 또는 캔버스 명령 디버깅
summary: 'iOS 노드 앱: 게이트웨이에 연결, 페어링, 캔버스 및 문제 해결'
title: iOS 앱
x-i18n:
    generated_at: "2026-02-08T16:00:38Z"
    model: gtx
    provider: google-translate
    source_hash: 692eebdc82e4bb8dc221bcbabf6a344a861a839fc377f1aeeb6eecaa4917a232
    source_path: platforms/ios.md
    workflow: 15
---

# iOS 앱(노드)

가용성: 내부 미리보기. iOS 앱은 아직 공개적으로 배포되지 않았습니다.

## 기능

- WebSocket(LAN 또는 tailnet)을 통해 게이트웨이에 연결합니다.
- 노드 기능 공개: 캔버스, 화면 스냅샷, 카메라 캡처, 위치, 대화 모드, 음성 깨우기.
- 수신 `node.invoke` 명령을 내리고 노드 상태 이벤트를 보고합니다.

## 요구사항

- 다른 장치(macOS, Linux 또는 WSL2를 통한 Windows)에서 실행되는 게이트웨이.
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

4. 연결 확인:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## 검색 경로

### 봉쥬르(LAN)

게이트웨이는 광고합니다 `_openclaw-gw._tcp` ~에 `local.`. iOS 앱은 이를 자동으로 나열합니다.

### 테일넷(교차 네트워크)

mDNS가 차단된 경우 유니캐스트 DNS-SD 영역을 사용하십시오(도메인 선택, 예: `openclaw.internal.`) 및 Tailscale 분할 DNS.
보다 [봉쥬르](/gateway/bonjour) CoreDNS 예의 경우.

### 수동 호스트/포트

설정에서 활성화 **수동 호스트** 게이트웨이 호스트 + 포트(기본값)를 입력합니다. `18789`).

## 캔버스 + A2UI

iOS 노드는 WKWebView 캔버스를 렌더링합니다. 사용 `node.invoke` 운전하려면:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

참고:

- 게이트웨이 캔버스 호스트는 `/__openclaw__/canvas/` 그리고 `/__openclaw__/a2ui/`.
- iOS 노드는 캔버스 호스트 URL이 공지될 때 연결 시 A2UI로 자동 탐색됩니다.
- 내장된 발판으로 돌아갑니다. `canvas.navigate` 그리고 `{"url":""}`.

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
- `A2UI_HOST_NOT_CONFIGURED`: 게이트웨이가 캔버스 호스트 URL을 광고하지 않았습니다. 확인하다 `canvasHost` ~에 [게이트웨이 구성](/gateway/configuration).
- 페어링 프롬프트가 나타나지 않습니다: 실행 `openclaw nodes pending` 수동으로 승인하세요.
- 재설치 후 재연결 실패: 키체인 페어링 토큰이 지워졌습니다. 노드를 다시 페어링하십시오.

## 관련 문서

- [편성](/gateway/pairing)
- [발견](/gateway/discovery)
- [봉쥬르](/gateway/bonjour)
