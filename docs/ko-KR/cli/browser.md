---
summary: "CLI reference for `openclaw browser` (profiles, tabs, actions, extension relay)"
read_when:
  - You use `openclaw browser` and want examples for common tasks
  - You want to control a browser running on another machine via a node host
  - You want to use the Chrome extension relay (attach/detach via toolbar button)
title: "browser"
x-i18n:
  source_hash: af35adfd68726fd519c704d046451effd330458c2b8305e713137fb07b2571fd
---

# `openclaw browser`

OpenClaw의 브라우저 제어 서버를 관리하고 브라우저 작업(탭, 스냅샷, 스크린샷, 탐색, 클릭, 입력)을 실행합니다.

관련 항목:

- 브라우저 도구 + API: [브라우저 도구](/tools/browser)
- 크롬 확장 릴레이 : [크롬 확장](/tools/chrome-extension)

## 공통 플래그

- `--url <gatewayWsUrl>`: 게이트웨이 WebSocket URL(기본값은 config)입니다.
- `--token <token>`: 게이트웨이 토큰(필요한 경우).
- `--timeout <ms>`: 요청 시간 초과(ms)입니다.
- `--browser-profile <name>`: 브라우저 프로필을 선택합니다(기본값은 구성에서).
- `--json`: 기계 판독 가능 출력(지원되는 경우).

## 빠른 시작(로컬)

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## 프로필

프로필의 이름은 브라우저 라우팅 구성입니다. 실제로:

- `openclaw`: 전용 OpenClaw 관리 Chrome 인스턴스를 시작/연결합니다(격리된 사용자 데이터 디렉터리).
- `chrome`: Chrome 확장 릴레이를 통해 기존 Chrome 탭을 제어합니다.

```bash
openclaw browser profiles
openclaw browser create-profile --name work --color "#FF5A36"
openclaw browser delete-profile --name work
```

특정 프로필을 사용합니다.

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

## 스냅샷/스크린샷/작업

스냅샷:

```bash
openclaw browser snapshot
```

스크린샷:

```bash
openclaw browser screenshot
```

탐색/클릭/입력(참조 기반 UI 자동화):

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Chrome 확장 릴레이(툴바 버튼을 통해 연결)

이 모드를 사용하면 에이전트는 사용자가 수동으로 연결한 기존 Chrome 탭을 제어할 수 있습니다(자동 연결되지 않음).

압축을 푼 확장 프로그램을 안정적인 경로에 설치합니다.

```bash
openclaw browser extension install
openclaw browser extension path
```

그런 다음 Chrome → `chrome://extensions` → '개발자 모드' 활성화 → '압축해제된 항목 로드' → 인쇄된 폴더를 선택합니다.

전체 가이드: [Chrome 확장 프로그램](/tools/chrome-extension)

## 원격 브라우저 제어(노드 호스트 프록시)

게이트웨이가 브라우저와 다른 시스템에서 실행되는 경우 Chrome/Brave/Edge/Chromium이 있는 시스템에서 **노드 호스트**를 실행하세요. 게이트웨이는 브라우저 작업을 해당 노드로 프록시합니다(별도의 브라우저 제어 서버가 필요하지 않음).

`gateway.nodes.browser.mode`를 사용하여 자동 라우팅을 제어하고 `gateway.nodes.browser.node`를 사용하여 여러 노드가 연결된 경우 특정 노드를 고정합니다.

보안 + 원격 설정: [브라우저 도구](/tools/browser), [원격 액세스](/gateway/remote), [Tailscale](/gateway/tailscale), [보안](/gateway/security)
