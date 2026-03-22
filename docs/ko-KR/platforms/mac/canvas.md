---
summary: "WKWebView + 커스텀 URL 스킴을 통해 내장된 에이전트 제어 Canvas 패널"
read_when:
  - macOS Canvas 패널을 구현할 때
  - 시각적 작업 공간에 에이전트 컨트롤을 추가할 때
  - WKWebView Canvas 로드를 디버깅할 때
title: "Canvas"
x-i18n:
  source_path: docs/platforms/mac/canvas.md
---

# Canvas (macOS 앱)

macOS 앱은 `WKWebView` 를 사용하여 에이전트가 제어하는 **Canvas 패널**을 내장합니다.
HTML/CSS/JS, A2UI, 소규모 인터랙티브 UI 서피스를 위한 경량 시각적 작업 공간입니다.

## Canvas 위치

Canvas 상태는 Application Support 아래에 저장됩니다:

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

Canvas 패널은 **커스텀 URL 스킴**을 통해 이 파일들을 서빙합니다:

- `openclaw-canvas://<session>/<path>`

예시:

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

루트에 `index.html` 이 없으면, 앱은 **내장 스캐폴드 페이지**를 표시합니다.

## 패널 동작

- 메뉴 바 (또는 마우스 커서) 근처에 고정된 테두리 없는 크기 조절 가능한 패널.
- 세션별로 크기/위치를 기억합니다.
- 로컬 Canvas 파일이 변경되면 자동 리로드합니다.
- 한 번에 하나의 Canvas 패널만 표시됩니다 (필요에 따라 세션이 전환됩니다).

설정 → **Canvas 허용** 에서 Canvas 를 비활성화할 수 있습니다. 비활성화되면 Canvas
노드 명령이 `CANVAS_DISABLED` 를 반환합니다.

## 에이전트 API 인터페이스

Canvas 는 **Gateway WebSocket** 을 통해 노출되어, 에이전트가 다음을 수행할 수 있습니다:

- 패널 표시/숨기기
- 경로 또는 URL 로 내비게이트
- JavaScript 실행
- 스냅샷 이미지 캡처

CLI 예시:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

참고:

- `canvas.navigate` 는 **로컬 Canvas 경로**, `http(s)` URL, `file://` URL 을 수용합니다.
- `"/"` 를 전달하면 Canvas 가 로컬 스캐폴드 또는 `index.html` 을 표시합니다.

## Canvas 에서의 A2UI

A2UI 는 Gateway Canvas 호스트에 의해 호스팅되며 Canvas 패널 내에서 렌더링됩니다.
Gateway 가 Canvas 호스트를 광고하면, macOS 앱이 첫 열기 시 A2UI 호스트 페이지로
자동 내비게이트합니다.

기본 A2UI 호스트 URL:

```
http://<gateway-host>:18789/__openclaw__/a2ui/
```

### A2UI 명령 (v0.8)

Canvas 는 현재 **A2UI v0.8** 서버→클라이언트 메시지를 수용합니다:

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface` (v0.9) 는 지원되지 않습니다.

CLI 예시:

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

빠른 스모크:

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## Canvas 에서 에이전트 실행 트리거

Canvas 는 딥 링크를 통해 새 에이전트 실행을 트리거할 수 있습니다:

- `openclaw://agent?...`

예시 (JS):

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

유효한 키가 제공되지 않으면 앱이 확인을 요청합니다.

## 보안 참고

- Canvas 스킴은 디렉토리 순회를 차단합니다; 파일은 세션 루트 아래에 있어야 합니다.
- 로컬 Canvas 콘텐츠는 커스텀 스킴을 사용합니다 (루프백 서버 불필요).
- 외부 `http(s)` URL 은 명시적으로 내비게이트할 때만 허용됩니다.
