---
summary: "브라우저 프로필, 탭, 작업, 확장 기능 릴레이를 위한 CLI 참조"
read_when:
  - `openclaw browser` 를 사용하고 일반적인 작업의 예시를 원할 때
  - 노드 호스트를 통해 다른 기계에서 실행 중인 브라우저를 제어하려고 할 때
  - Chrome 확장 기능 릴레이 (도구 모음 단추를 통해 연결/분리) 를 사용하려고 할 때
title: "browser"
---

# `openclaw browser`

OpenClaw 의 브라우저 제어 서버를 관리하고 브라우저 작업 (탭, 스냅샷, 스크린샷, 탐색, 클릭, 입력) 을 실행합니다.

관련 사항:

- 브라우저 도구 + API: [Browser tool](/tools/browser)
- Chrome 확장 릴레이: [Chrome extension](/tools/chrome-extension)

## 일반 플래그

- `--url <gatewayWsUrl>`: Gateway WebSocket URL (기본값: 구성).
- `--token <token>`: Gateway 토큰 (필요한 경우).
- `--timeout <ms>`: 요청 시간 제한 (ms).
- `--browser-profile <name>`: 브라우저 프로필 선택 (구성 기본값).
- `--json`: 머신 가능 출력 (지원하는 경우).

## 빠른 시작 (로컬)

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## 프로필

프로필은 명명된 브라우저 라우팅 구성입니다. 실제로는:

- `openclaw`: 전용 OpenClaw 관리 Chrome 인스턴스를 시작/연결합니다 (격리된 사용자 데이터 dir).
- `chrome`: Chrome 확장 릴레이를 통해 기존 Chrome 탭을 제어합니다.

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

특정 프로필 사용:

```bash
openclaw browser --browser-profile work tabs
```

## 탭

```bash
openclaw browser tabs
openclaw browser open https://docs.openclaw.ai
openclaw browser focus <targetId>
openclaw browser close <targetId>
```

## 스냅샷 / 스크린샷 / 작업

스냅샷:

```bash
openclaw browser snapshot
```

스크린샷:

```bash
openclaw browser screenshot
```

탐색/클릭/입력 (ref 기반 UI 자동화):

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Chrome 확장 릴레이 (도구 모음 단추를 통해 연결)

이 모드는 에이전트가 수동으로 연결한 기존 Chrome 탭을 제어할 수 있게 합니다 (자동 연결 안 함).

압축되지 않은 확장을 안정적인 경로에 설치합니다:

```bash
openclaw browser extension install
openclaw browser extension path
```

그런 다음 Chrome → `chrome://extensions` → "Developer mode" 활성화 → "Load unpacked" → 인쇄된 폴더 선택.

전체 가이드: [Chrome extension](/tools/chrome-extension)

## 원격 브라우저 제어 (노드 호스트 프록시)

Gateway 가 브라우저와 다른 기계에서 실행 중인 경우, Chrome/Brave/Edge/Chromium 이 있는 기계에서 **노드 호스트** 를 실행합니다. Gateway 는 브라우저 작업을 해당 노드로 프록시합니다 (별도 브라우저 제어 서버 필요 없음).

`gateway.nodes.browser.mode` 를 사용하여 자동 라우팅을 제어하고 `gateway.nodes.browser.node` 을 사용하여 여러 개가 연결된 경우 특정 노드를 고정합니다.

보안 + 원격 설정: [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)

---

x-i18n:
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/cli/browser.md
workflow: 15
