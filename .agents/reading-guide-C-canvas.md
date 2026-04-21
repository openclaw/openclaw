# Reading Guide C: Live Canvas / A2UI

agent가 조종하는 시각 워크스페이스 파이프라인을 한 세션에 조감하는 지도.
walkthrough가 아니라 MAP이다 — 각 파일을 열고, 훑고, 질문을 붙잡고, 넘어간다.
목표: TS 호스트가 끝나고 네이티브 클라이언트가 시작되는 선을 알아내는 것.

가장 큰 획으로 본 파이프라인:

```
agent 출력 → src/canvas-host/ (TS 호스트, HTTP + WS + 커스텀 scheme 자산)
           → apps/macos/ 또는 apps/ios/ 안의 WKWebView (네이티브 셸)
           → 웹뷰 안에서 A2UI 번들(src/canvas-host/a2ui/)이 렌더
```

## Stop 1 — 컨셉 문서

- `docs/platforms/mac/canvas.md`
- 역할: macOS에서 Canvas/A2UI가 무엇인지의 단일 출처.
- 한 줄 takeaway: agent가 제어하는 패널이 `WKWebView`에 호스트되고, 커스텀 `openclaw-canvas://` URL scheme이 Application Support 아래 세션별 디렉토리에서 제공한다.
- 여기서 확인할 질문:
  - 어떤 URL이 디스크의 어떤 레이아웃에 매핑되나?
  - TS 호스트가 서빙하는 것과 네이티브 scheme 핸들러가 서빙하는 것의 구분은?
  - A2UI는 여러 콘텐츠 타입 중 하나일 뿐 — 언제 이야기에 등장하나?

## Stop 2 — 생성된 A2UI 번들 영역

- `src/canvas-host/a2ui/`
- 역할: 웹뷰에 로드되는, 미리 빌드된 A2UI 렌더러.
- 존재하는 파일: `a2ui.bundle.js`, `index.html`, `.bundle.hash` (생성물. AGENTS.md: `pnpm canvas:a2ui:bundle`로 생산, 별도 커밋).
- 여기서 확인할 질문:
  - 이 디렉토리 전체를 빌드 산출물로 취급하고, 번들 자체는 읽지 말 것.
  - `index.html`이 웹뷰가 실제로 로드하는 진입점임을 기억.
  - 해시 게이트는 CI가 drift를 감지하도록 존재한다는 점만 의식.

## Stop 3 — 호스트 파이프라인

- `src/canvas-host/server.ts` — HTTP + WebSocket 서버 (`/__openclaw__/a2ui`, `/__openclaw__/canvas`, `/__openclaw__/ws`). agent↔클라이언트의 주 seam.
- `src/canvas-host/a2ui.ts` — A2UI 번들 루트를 해석·서빙. `A2UI_PATH` / `CANVAS_HOST_PATH` / `CANVAS_WS_PATH` 상수의 소유자.
- `src/canvas-host/file-resolver.ts` — 세션 루트 아래에서의 안전한 경로 해석. 서빙되는 파일의 샌드박스 경계.
- 여기서 확인할 질문:
  - 어떤 경로 prefix가 HTTP이고, 어떤 게 WS로 업그레이드되나?
  - 세션별 루트는 어디서 유도되고, 누가 거기에 쓰나?
  - 세션이 자기 디렉토리를 탈출하는 걸 막는 건 뭔가?

## Stop 4 — macOS 네이티브 수신기

- `apps/macos/Sources/OpenClaw/CanvasWindowController.swift`와 형제들 (`CanvasManager.swift`, `CanvasScheme.swift`, `CanvasSchemeHandler.swift`, `CanvasFileWatcher.swift`, `CanvasA2UIActionMessageHandler.swift`, `CanvasWindow.swift`, `CanvasChromeContainerView.swift`).
- 역할: `WKWebView`를 호스트하고, 커스텀 URL scheme을 해석하고, A2UI 액션을 앱으로 되돌리는 네이티브 셸.
- 플랫폼 방침: 루트 AGENTS.md 대로 SwiftUI + Observation (`@Observable`, `@Bindable`); 새 `ObservableObject` 금지.
- 여기서 확인할 질문 (파일명만. 구현은 읽지 말 것):
  - 커스텀 scheme을 소유하는 파일과 윈도우 수명주기를 소유하는 파일은 각각 어느 것?
  - A2UI→Swift 메시지 브리지로 보이는 파일은?
  - 파일 감시(agent가 쓴 자산의 핫 리로드)는 어디에 끼나?

## Stop 5 — iOS 네이티브 수신기

- `apps/ios/Sources/RootCanvas.swift` — 최상위 canvas 서피스.
- `apps/ios/Sources/Model/NodeAppModel+Canvas.swift` — 공용 app model에 canvas 형태로 붙은 extension.
- 원래 투어 대비 정정: iOS에는 `*A2UI*` 파일명이 없다. canvas 서피스는 존재하지만 macOS에 있는 A2UI-specific glue에 대응하는 iOS 파일은 없다.
- 여기서 확인할 질문:
  - iOS는 first-class A2UI 클라이언트인가, 아니면 더 얇은 canvas 뷰어인가?
  - `NodeAppModel+Canvas`는 나머지 app model과 어떻게 조립되나?
  - 만약 A2UI 액션 핸들러를 추가한다면 어디에 놓아야 하나?

## 읽으면서 따로 모아둘 3개 질문

1. TS ↔ 네이티브 경계를 넘나드는 것 중 **타입이 있는 데이터**와 **직렬화된 blob**(WS 프레임, 파일 쓰기, scheme 응답)의 구분은?
2. 세션 디렉토리의 수명주기는 누가 소유하나 — TS 호스트, 네이티브 앱, agent 중? 그리고 언제 GC되나?
3. A2UI 번들은 네이티브 쪽과의 버전된 계약으로 간주되는가? `.bundle.hash`가 drift하면 어디서 시끄럽게 실패해야 하나?
