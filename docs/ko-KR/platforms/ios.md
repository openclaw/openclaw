---
summary: "iOS 노드 앱: Gateway 연결, 페어링, Canvas, 문제 해결"
read_when:
  - iOS 노드를 페어링하거나 재연결할 때
  - iOS 앱을 소스에서 실행할 때
  - Gateway 검색 또는 Canvas 명령을 디버깅할 때
title: "iOS 앱"
x-i18n:
  source_path: docs/platforms/ios.md
---

# iOS 앱 (노드)

가용성: 내부 프리뷰. iOS 앱은 아직 공개 배포되지 않았습니다.

## 주요 기능

- WebSocket 을 통해 Gateway 에 연결합니다 (LAN 또는 tailnet).
- 노드 기능을 노출합니다: Canvas, 화면 스냅샷, 카메라 캡처, 위치, 토크 모드, 음성 웨이크.
- `node.invoke` 명령을 수신하고 노드 상태 이벤트를 보고합니다.

## 요구 사항

- 다른 기기에서 실행 중인 Gateway (macOS, Linux, 또는 Windows via WSL2).
- 네트워크 경로:
  - Bonjour 를 통한 동일 LAN, **또는**
  - 유니캐스트 DNS-SD 를 통한 Tailnet (예시 도메인: `openclaw.internal.`), **또는**
  - 수동 호스트/포트 (폴백).

## 빠른 시작 (페어링 + 연결)

1. Gateway 를 시작합니다:

```bash
openclaw gateway --port 18789
```

2. iOS 앱에서 설정을 열고 검색된 Gateway 를 선택합니다 (또는 수동 호스트를 활성화하고 호스트/포트를 입력합니다).

3. Gateway 호스트에서 페어링 요청을 승인합니다:

```bash
openclaw devices list
openclaw devices approve <requestId>
```

앱이 변경된 인증 세부 정보 (역할/범위/공개 키) 로 페어링을 재시도하면,
이전 대기 요청은 대체되고 새로운 `requestId` 가 생성됩니다.
승인 전에 `openclaw devices list` 를 다시 실행하세요.

4. 연결을 확인합니다:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## 공식 빌드를 위한 릴레이 기반 푸시

공식 배포된 iOS 빌드는 원시 APNs 토큰을 Gateway 에 게시하는 대신
외부 푸시 릴레이를 사용합니다.

Gateway 측 요구 사항:

```json5
{
  gateway: {
    push: {
      apns: {
        relay: {
          baseUrl: "https://relay.example.com",
        },
      },
    },
  },
}
```

흐름 작동 방식:

- iOS 앱은 App Attest 와 앱 영수증을 사용하여 릴레이에 등록합니다.
- 릴레이는 불투명한 릴레이 핸들과 등록 범위의 전송 권한을 반환합니다.
- iOS 앱은 페어링된 Gateway 아이덴티티를 가져와 릴레이 등록에 포함하여, 릴레이 기반 등록이 해당 특정 Gateway 에 위임됩니다.
- 앱은 릴레이 기반 등록을 `push.apns.register` 로 페어링된 Gateway 에 전달합니다.
- Gateway 는 저장된 릴레이 핸들을 `push.test`, 백그라운드 웨이크, 웨이크 넛지에 사용합니다.
- Gateway 릴레이 베이스 URL 은 공식/TestFlight iOS 빌드에 내장된 릴레이 URL 과 일치해야 합니다.
- 앱이 나중에 다른 Gateway 또는 다른 릴레이 베이스 URL 의 빌드에 연결하면, 이전 바인딩을 재사용하는 대신 릴레이 등록을 새로 고칩니다.

이 경로에서 Gateway 가 **필요로 하지 않는** 것:

- 배포 전체 릴레이 토큰이 필요 없습니다.
- 공식/TestFlight 릴레이 기반 전송을 위한 직접 APNs 키가 필요 없습니다.

예상되는 운영자 흐름:

1. 공식/TestFlight iOS 빌드를 설치합니다.
2. Gateway 에 `gateway.push.apns.relay.baseUrl` 을 설정합니다.
3. 앱을 Gateway 에 페어링하고 연결이 완료될 때까지 기다립니다.
4. 앱은 APNs 토큰이 있고 운영자 세션이 연결되었으며 릴레이 등록이 성공한 후 자동으로 `push.apns.register` 를 게시합니다.
5. 그 이후로 `push.test`, 재연결 웨이크, 웨이크 넛지가 저장된 릴레이 기반 등록을 사용할 수 있습니다.

호환성 참고:

- `OPENCLAW_APNS_RELAY_BASE_URL` 은 Gateway 의 임시 환경 오버라이드로 여전히 작동합니다.

## 인증 및 신뢰 흐름

릴레이는 직접 APNs-on-Gateway 가 공식 iOS 빌드에 제공할 수 없는 두 가지 제약을
강제하기 위해 존재합니다:

- Apple 을 통해 배포된 정품 OpenClaw iOS 빌드만 호스팅된 릴레이를 사용할 수 있습니다.
- Gateway 는 해당 특정 Gateway 에 페어링된 iOS 기기에 대해서만 릴레이 기반 푸시를 보낼 수 있습니다.

단계별:

1. `iOS 앱 -> Gateway`
   - 앱은 먼저 일반 Gateway 인증 흐름을 통해 Gateway 와 페어링합니다.
   - 이를 통해 앱은 인증된 노드 세션과 인증된 운영자 세션을 얻습니다.
   - 운영자 세션은 `gateway.identity.get` 을 호출하는 데 사용됩니다.

2. `iOS 앱 -> 릴레이`
   - 앱은 HTTPS 를 통해 릴레이 등록 엔드포인트를 호출합니다.
   - 등록에는 App Attest 증명과 앱 영수증이 포함됩니다.
   - 릴레이는 번들 ID, App Attest 증명, Apple 영수증을 검증하고, 공식/프로덕션 배포 경로를 요구합니다.
   - 이것이 로컬 Xcode/개발 빌드가 호스팅된 릴레이를 사용하지 못하게 차단하는 것입니다. 로컬 빌드는 서명될 수 있지만, 릴레이가 기대하는 공식 Apple 배포 증명을 만족하지 않습니다.

3. `Gateway 아이덴티티 위임`
   - 릴레이 등록 전에, 앱은 `gateway.identity.get` 에서 페어링된 Gateway 아이덴티티를 가져옵니다.
   - 앱은 릴레이 등록 페이로드에 해당 Gateway 아이덴티티를 포함합니다.
   - 릴레이는 해당 Gateway 아이덴티티에 위임된 릴레이 핸들과 등록 범위의 전송 권한을 반환합니다.

4. `Gateway -> 릴레이`
   - Gateway 는 `push.apns.register` 에서 릴레이 핸들과 전송 권한을 저장합니다.
   - `push.test`, 재연결 웨이크, 웨이크 넛지 시, Gateway 는 자체 기기 아이덴티티로 전송 요청에 서명합니다.
   - 릴레이는 저장된 전송 권한과 등록에서의 위임된 Gateway 아이덴티티에 대해 Gateway 서명을 모두 검증합니다.
   - 다른 Gateway 는 핸들을 어떻게든 얻더라도 저장된 등록을 재사용할 수 없습니다.

5. `릴레이 -> APNs`
   - 릴레이는 프로덕션 APNs 자격 증명과 공식 빌드용 원시 APNs 토큰을 소유합니다.
   - Gateway 는 릴레이 기반 공식 빌드에 대해 원시 APNs 토큰을 절대 저장하지 않습니다.
   - 릴레이는 페어링된 Gateway 를 대신하여 최종 푸시를 APNs 에 보냅니다.

이 설계가 만들어진 이유:

- 프로덕션 APNs 자격 증명을 사용자 Gateway 에서 제외하기 위해.
- Gateway 에 원시 공식 빌드 APNs 토큰 저장을 피하기 위해.
- 호스팅된 릴레이 사용을 공식/TestFlight OpenClaw 빌드에만 허용하기 위해.
- 한 Gateway 가 다른 Gateway 소유의 iOS 기기에 웨이크 푸시를 보내는 것을 방지하기 위해.

로컬/수동 빌드는 직접 APNs 를 계속 사용합니다. 릴레이 없이 이러한 빌드를 테스트하는 경우,
Gateway 에 여전히 직접 APNs 자격 증명이 필요합니다:

```bash
export OPENCLAW_APNS_TEAM_ID="TEAMID"
export OPENCLAW_APNS_KEY_ID="KEYID"
export OPENCLAW_APNS_PRIVATE_KEY_P8="$(cat /path/to/AuthKey_KEYID.p8)"
```

## 검색 경로

### Bonjour (LAN)

Gateway 는 `local.` 에서 `_openclaw-gw._tcp` 를 광고합니다. iOS 앱은 이를 자동으로 나열합니다.

### Tailnet (네트워크 간)

mDNS 가 차단되면, 유니캐스트 DNS-SD 영역 (도메인 선택; 예: `openclaw.internal.`) 과 Tailscale 분할 DNS 를 사용하세요.
CoreDNS 예시는 [Bonjour](/gateway/bonjour) 를 참조하세요.

### 수동 호스트/포트

설정에서 **수동 호스트** 를 활성화하고 Gateway 호스트 + 포트 (기본값 `18789`) 를 입력합니다.

## Canvas + A2UI

iOS 노드는 WKWebView Canvas 를 렌더링합니다. `node.invoke` 를 사용하여 조작합니다:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18789/__openclaw__/canvas/"}'
```

참고:

- Gateway Canvas 호스트는 `/__openclaw__/canvas/` 와 `/__openclaw__/a2ui/` 를 서빙합니다.
- Gateway HTTP 서버 (`gateway.port` 와 동일한 포트, 기본값 `18789`) 에서 제공됩니다.
- iOS 노드는 Canvas 호스트 URL 이 광고될 때 연결 시 A2UI 로 자동 내비게이트합니다.
- `canvas.navigate` 와 `{"url":""}` 로 내장 스캐폴드로 돌아갑니다.

### Canvas eval / snapshot

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## 음성 웨이크 + 토크 모드

- 음성 웨이크와 토크 모드는 설정에서 사용할 수 있습니다.
- iOS 는 백그라운드 오디오를 일시 중단할 수 있습니다; 앱이 활성 상태가 아닐 때는 음성 기능을 최선의 노력으로 취급하세요.

## 일반적인 오류

- `NODE_BACKGROUND_UNAVAILABLE`: iOS 앱을 포그라운드로 가져오세요 (Canvas/카메라/화면 명령에 필요합니다).
- `A2UI_HOST_NOT_CONFIGURED`: Gateway 가 Canvas 호스트 URL 을 광고하지 않았습니다; [Gateway 설정](/gateway/configuration) 에서 `canvasHost` 를 확인하세요.
- 페어링 프롬프트가 나타나지 않음: `openclaw devices list` 를 실행하고 수동으로 승인하세요.
- 재설치 후 재연결 실패: 키체인 페어링 토큰이 지워졌습니다; 노드를 다시 페어링하세요.

## 관련 문서

- [페어링](/channels/pairing)
- [검색](/gateway/discovery)
- [Bonjour](/gateway/bonjour)
