---
summary: "`openclaw browser`에 대한 CLI 참조 (프로필, 탭, 작업, 확장 프로그램 릴레이)"
read_when:
  - "`openclaw browser`를 사용하며 일반적인 작업에 대한 예제가 필요할 때"
  - 노드 호스트를 통해 다른 머신에서 실행 중인 브라우저를 제어하고자 할 때
  - Chrome 확장 프로그램 릴레이를 사용하고자 할 때 (툴바 버튼을 통한 연결/해제)
title: "browser"
---

# `openclaw browser`

OpenClaw 의 브라우저 제어 서버를 관리하고 브라우저 작업(탭, 스냅샷, 스크린샷, 탐색, 클릭, 타이핑)을 실행합니다.

관련 항목:

- 브라우저 도구 + API: [Browser tool](/tools/browser)
- Chrome 확장 프로그램 릴레이: [Chrome extension](/tools/chrome-extension)

## 공통 플래그

- `--url <gatewayWsUrl>`: Gateway WebSocket URL (기본값은 설정을 따릅니다).
- `--token <token>`: Gateway 토큰(필요한 경우).
- `--timeout <ms>`: 요청 타임아웃(ms).
- `--browser-profile <name>`: 브라우저 프로필 선택(기본값은 설정을 따릅니다).
- `--json`: 기계 판독 가능한 출력(지원되는 경우).

## 빠른 시작 (로컬)

```bash
openclaw browser --browser-profile chrome tabs
openclaw browser --browser-profile openclaw start
openclaw browser --browser-profile openclaw open https://example.com
openclaw browser --browser-profile openclaw snapshot
```

## 프로필

프로필은 이름이 지정된 브라우저 라우팅 설정입니다. 실제로는 다음과 같습니다:

- `openclaw`: OpenClaw 가 관리하는 전용 Chrome 인스턴스를 실행/연결합니다(격리된 사용자 데이터 디렉토리).
- `chrome`: Chrome 확장 프로그램 릴레이를 통해 기존 Chrome 탭을 제어합니다.

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

탐색/클릭/타이핑(참조 기반 UI 자동화):

```bash
openclaw browser navigate https://example.com
openclaw browser click <ref>
openclaw browser type <ref> "hello"
```

## Chrome 확장 프로그램 릴레이 (툴바 버튼으로 연결)

이 모드는 수동으로 연결한 기존 Chrome 탭을 에이전트가 제어하도록 합니다(자동 연결하지 않습니다).

압축 해제된 확장 프로그램을 안정적인 경로에 설치합니다:

```bash
openclaw browser extension install
openclaw browser extension path
```

그런 다음 Chrome → `chrome://extensions` → “Developer mode” 활성화 → “Load unpacked” → 출력된 폴더 선택.

전체 가이드: [Chrome extension](/tools/chrome-extension)

## 원격 브라우저 제어 (노드 호스트 프록시)

Gateway 가 브라우저와 다른 머신에서 실행되는 경우, Chrome/Brave/Edge/Chromium 이 설치된 머신에서 **노드 호스트**를 실행하십시오. Gateway 는 해당 노드로 브라우저 작업을 프록시합니다(별도의 브라우저 제어 서버는 필요하지 않습니다).

자동 라우팅을 제어하려면 `gateway.nodes.browser.mode` 를 사용하고, 여러 노드가 연결된 경우 특정 노드를 고정하려면 `gateway.nodes.browser.node` 를 사용하십시오.

보안 + 원격 설정: [Browser tool](/tools/browser), [Remote access](/gateway/remote), [Tailscale](/gateway/tailscale), [Security](/gateway/security)
