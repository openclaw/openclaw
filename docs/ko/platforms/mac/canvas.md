---
read_when:
    - macOS 캔버스 패널 구현
    - 시각적 작업 공간에 대한 에이전트 제어 추가
    - WKWebView 캔버스 로드 디버깅
summary: WKWebView + 사용자 정의 URL 구성표를 통해 포함된 에이전트 제어 캔버스 패널
title: 캔버스
x-i18n:
    generated_at: "2026-02-08T16:07:08Z"
    model: gtx
    provider: google-translate
    source_hash: e39caa21542e839d9f59ad0bf7ecefb379225ed7e8f00cd59131d188f193bec6
    source_path: platforms/mac/canvas.md
    workflow: 15
---

# 캔버스(macOS 앱)

macOS 앱에는 에이전트 제어 기능이 포함되어 있습니다. **캔버스 패널** 사용하여 `WKWebView`. 그것
HTML/CSS/JS, A2UI 및 소규모 대화형을 위한 경량의 시각적 작업 공간입니다.
UI 표면.

## 캔버스가 사는 곳

캔버스 상태는 응용 프로그램 지원 아래에 저장됩니다.

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

캔버스 패널은 다음을 통해 해당 파일을 제공합니다. **맞춤 URL 구성표**:

- `openclaw-canvas://<session>/<path>`

예:

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

그렇지 않은 경우 `index.html` 루트에 존재하면 앱에 다음이 표시됩니다. **내장된 스캐폴드 페이지**.

## 패널 동작

- 메뉴 표시줄(또는 마우스 커서) 근처에 고정된 테두리가 없고 크기 조정이 가능한 패널입니다.
- 세션당 크기/위치를 기억합니다.
- 로컬 캔버스 파일이 변경되면 자동으로 다시 로드됩니다.
- 한 번에 하나의 캔버스 패널만 표시됩니다(필요에 따라 세션이 전환됨).

캔버스는 설정 →에서 비활성화할 수 있습니다. **캔버스 허용**. 비활성화되면 캔버스
노드 명령 반환 `CANVAS_DISABLED`.

## 에이전트 API 표면

캔버스는 다음을 통해 노출됩니다. **게이트웨이 웹소켓**, 상담원은 다음을 수행할 수 있습니다.

- 패널 표시/숨기기
- 경로 또는 URL로 이동
- 자바스크립트 평가
- 스냅샷 이미지 캡처

CLI 예:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

참고:

- `canvas.navigate` 받아들인다 **로컬 캔버스 경로**, `http(s)` URL 및 `file://` URL.
- 합격하면 `"/"`, 캔버스는 로컬 비계를 표시하거나 `index.html`.

## 캔버스의 A2UI

A2UI는 게이트웨이 캔버스 호스트에 의해 호스팅되고 캔버스 패널 내부에 렌더링됩니다.
게이트웨이가 캔버스 호스트를 알리면 macOS 앱은 자동으로 다음으로 이동합니다.
처음 열 때 A2UI 호스트 페이지.

기본 A2UI 호스트 URL:

```
http://<gateway-host>:18793/__openclaw__/a2ui/
```

### A2UI 명령(v0.8)

캔버스는 현재 허용됩니다 **A2UI v0.8** 서버→클라이언트 메시지:

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface` (v0.9)은 지원되지 않습니다.

CLI 예:

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

빠른 연기:

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## 트리거 에이전트는 캔버스에서 실행됩니다.

캔버스는 딥 링크를 통해 새 에이전트 실행을 트리거할 수 있습니다.

- `openclaw://agent?...`

예(JS):

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

유효한 키가 제공되지 않으면 앱에서 확인 메시지를 표시합니다.

## 보안 참고 사항

- 캔버스 구성표는 디렉터리 탐색을 차단합니다. 파일은 세션 루트 아래에 있어야 합니다.
- 로컬 캔버스 콘텐츠는 사용자 정의 구성표를 사용합니다(루프백 서버가 필요하지 않음).
- 외부 `http(s)` URL은 명시적으로 탐색되는 경우에만 허용됩니다.
