---
summary: "에이전트 제어 Canvas 패널이 WKWebView + 사용자 정의 URL 스키마를 통해 임베딩됨"
read_when:
  - macOS Canvas 패널 구현하기
  - 시각 작업 공간을 위한 에이전트 제어 추가하기
  - WKWebView 캔버스 로드 디버깅하기
title: "Canvas"
---

# Canvas (macOS 앱)

macOS 앱은 `WKWebView`를 사용하여 에이전트 제어 **Canvas 패널**을 임베딩합니다. 이는 HTML/CSS/JS, A2UI 및 소형 인터랙티브 UI 표면을 위한 가벼운 시각화 작업 공간입니다.

## Canvas의 위치

Canvas 상태는 Application Support에 저장됩니다:

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

Canvas 패널은 **사용자 정의 URL 스키마**를 통해 이러한 파일을 제공합니다:

- `openclaw-canvas://<session>/<path>`

예시:

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

루트에 `index.html`이 없으면 앱은 **내장된 스캐폴드 페이지**를 표시합니다.

## 패널 동작

- 테두리가 없고 크기 조절이 가능한 패널로, 메뉴바(또는 마우스 커서) 근처에 고정됩니다.
- 세션별로 크기/위치를 기억합니다.
- 로컬 캔버스 파일이 변경되면 자동으로 재로드됩니다.
- 한 번에 하나의 Canvas 패널만 표시됩니다 (세션이 필요에 따라 전환됩니다).

Canvas는 설정에서 **Canvas 허용**을 통해 비활성화할 수 있습니다. 비활성화되면 캔버스 노드 명령은 `CANVAS_DISABLED`를 반환합니다.

## 에이전트 API 표면

Canvas는 **게이트웨이 WebSocket**을 통해 노출되므로 에이전트는 다음을 수행할 수 있습니다:

- 패널 표시/숨기기
- 경로나 URL로 이동
- JavaScript 평가
- 스냅샷 이미지 캡처

CLI 예제:

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

노트:

- `canvas.navigate`는 **로컬 캔버스 경로**, `http(s)` URL, `file://` URL을 허용합니다.
- 만약 `"/"`을 전달하면, Canvas가 로컬 스캐폴드 또는 `index.html`을 표시합니다.

## Canvas에서의 A2UI

A2UI는 게이트웨이 캔버스 호스트에 의해 호스팅되고 Canvas 패널 내에 렌더링됩니다. 게이트웨이가 Canvas 호스트를 광고할 때, macOS 앱은 처음 열 때 A2UI 호스트 페이지로 자동 이동합니다.

기본 A2UI 호스트 URL:

```
http://<gateway-host>:18789/__openclaw__/a2ui/
```

### A2UI 명령어 (v0.8)

Canvas는 현재 **A2UI v0.8** 서버→클라이언트 메시지를 허용합니다:

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface` (v0.9)는 지원되지 않습니다.

CLI 예제:

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

빠른 테스트:

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## Canvas에서의 에이전트 실행 트리거

Canvas는 딥 링크를 통해 새로운 에이전트 실행을 트리거할 수 있습니다:

- `openclaw://agent?...`

예시 (JavaScript):

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

유효한 키가 제공되지 않으면 앱은 확인을 요청합니다.

## 보안 주의사항

- Canvas 스키마는 디렉토리 트래버설을 차단합니다; 파일은 세션 루트 하위에 있어야 합니다.
- 로컬 Canvas 콘텐츠는 사용자 정의 스키마를 사용합니다 (로컬 루프백 서버가 필요하지 않습니다).
- 외부 `http(s)` URL은 명시적으로 이동할 때만 허용됩니다.
