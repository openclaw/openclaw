---
summary: "Chrome extension: let OpenClaw drive your existing Chrome tab"
read_when:
  - You want the agent to drive an existing Chrome tab (toolbar button)
  - You need remote Gateway + local browser automation via Tailscale
  - You want to understand the security implications of browser takeover
title: "Chrome Extension"
x-i18n:
  source_hash: 3b77bdad7d3dab6adb76ff25b144412d6b54b915993b1c1f057f36dea149938b
---

# Chrome 확장 프로그램(브라우저 릴레이)

OpenClaw Chrome 확장 프로그램을 사용하면 에이전트가 별도의 openclaw 관리 Chrome 프로필을 실행하는 대신 **기존 Chrome 탭**(일반 Chrome 창)을 제어할 수 있습니다.

연결/분리는 **단일 Chrome 툴바 버튼**을 통해 이루어집니다.

##이란 무엇인가(콘셉트)

세 부분이 있습니다:

- **브라우저 제어 서비스**(게이트웨이 또는 노드): 에이전트/도구가 호출하는 API(게이트웨이를 통해)
- **로컬 릴레이 서버**(루프백 CDP): 제어 서버와 확장(기본적으로 `http://127.0.0.1:18792` 사이를 브리지)
- **Chrome MV3 확장**: `chrome.debugger`를 사용하여 활성 탭에 연결하고 CDP 메시지를 릴레이로 파이프합니다.

그런 다음 OpenClaw는 일반 `browser` 도구 표면을 통해 부착된 탭을 제어합니다(올바른 프로파일 선택).

## 설치/로드(압축해제)

1. 안정적인 로컬 경로에 확장 프로그램을 설치합니다.

```bash
openclaw browser extension install
```

2. 설치된 확장 디렉터리 경로를 인쇄합니다.

```bash
openclaw browser extension path
```

3. 크롬 → `chrome://extensions`

- "개발자 모드" 활성화
- “Load unpacked” → 위에 인쇄된 디렉토리 선택

4. 확장 프로그램을 고정합니다.

## 업데이트(빌드 단계 없음)

확장은 OpenClaw 릴리스(npm 패키지) 내에 정적 파일로 제공됩니다. 별도의 "빌드" 단계는 없습니다.

OpenClaw를 업그레이드한 후:

- `openclaw browser extension install`를 다시 실행하여 OpenClaw 상태 디렉터리에 설치된 파일을 새로 고칩니다.
- Chrome → `chrome://extensions` → 확장 프로그램에서 '새로고침'을 클릭하세요.

## 사용하세요(추가 구성 없음)

OpenClaw에는 기본 포트의 확장 릴레이를 대상으로 하는 `chrome`라는 브라우저 프로필이 내장되어 있습니다.

사용하세요:

- CLI: `openclaw browser --browser-profile chrome tabs`
- 에이전트 도구: `browser` 및 `profile="chrome"`

다른 이름이나 다른 릴레이 포트를 원하는 경우 자신만의 프로필을 만드세요.

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

## 부착/분리(툴바 버튼)

- OpenClaw를 제어하려는 탭을 엽니다.
- 확장 아이콘을 클릭하세요.
  - 뱃지 부착시 `ON`로 표시됩니다.
- 다시 클릭하면 분리됩니다.

## 어떤 탭을 제어하나요?

- "현재 보고 있는 탭"을 자동으로 제어하지 **않습니다**.
- 툴바 버튼을 클릭하여 **명시적으로 첨부한 탭만** 제어합니다.
- 전환하려면: 다른 탭을 열고 거기에 있는 확장 프로그램 아이콘을 클릭하세요.

## 배지 + 일반적인 오류

- `ON`: 첨부; OpenClaw는 해당 탭을 구동할 수 있습니다.
- `…` : 로컬 릴레이에 연결됩니다.
- `!`: 릴레이에 연결할 수 없습니다(가장 일반적: 브라우저 릴레이 서버가 이 컴퓨터에서 실행되고 있지 않습니다).

`!`가 표시되는 경우:

- 게이트웨이가 로컬에서 실행되고 있는지 확인하거나(기본 설정), 게이트웨이가 다른 곳에서 실행되는 경우 이 시스템에서 노드 호스트를 실행하십시오.
- 확장 옵션 페이지를 엽니다. 릴레이에 도달할 수 있는지 여부를 보여줍니다.

## 원격 게이트웨이(노드 호스트 사용)

### 로컬 게이트웨이(Chrome과 동일한 시스템) — 일반적으로 **추가 단계 없음**

게이트웨이가 Chrome과 동일한 시스템에서 실행되는 경우 루프백 시 브라우저 제어 서비스가 시작됩니다.
릴레이 서버를 자동 시작합니다. 확장 프로그램은 로컬 릴레이와 통신합니다. CLI/도구 호출은 게이트웨이로 이동합니다.

### 원격 게이트웨이(게이트웨이는 다른 곳에서 실행됨) — **노드 호스트 실행**

게이트웨이가 다른 시스템에서 실행되는 경우 Chrome을 실행하는 시스템에서 노드 호스트를 시작하십시오.
게이트웨이는 브라우저 작업을 해당 노드로 프록시합니다. 확장 + 릴레이는 브라우저 시스템에 로컬로 유지됩니다.

여러 노드가 연결되어 있는 경우 하나를 `gateway.nodes.browser.node`로 고정하거나 `gateway.nodes.browser.mode`를 설정하세요.

## 샌드박싱(도구 컨테이너)

에이전트 세션이 샌드박스 처리된 경우(`agents.defaults.sandbox.mode != "off"`) `browser` 도구가 제한될 수 있습니다.

- 기본적으로 샌드박스 세션은 호스트 Chrome이 아닌 **샌드박스 브라우저**(`target="sandbox"`)를 대상으로 하는 경우가 많습니다.
- Chrome 확장 릴레이 인계에는 **호스트** 브라우저 제어 서버 제어가 필요합니다.

옵션:

- 가장 쉬운 방법: **비샌드박스** 세션/에이전트의 확장 프로그램을 사용하세요.
- 또는 샌드박스 세션에 대해 호스트 브라우저 제어를 허용합니다.

```json5
{
  agents: {
    defaults: {
      sandbox: {
        browser: {
          allowHostControl: true,
        },
      },
    },
  },
}
```

그런 다음 도구 정책에 의해 도구가 거부되지 않았는지 확인하고 (필요한 경우) `target="host"`를 사용하여 `browser`를 호출합니다.

디버깅 중: `openclaw sandbox explain`

## 원격 액세스 팁

- 게이트웨이와 노드 호스트를 동일한 tailnet에 유지하십시오. 릴레이 포트를 LAN이나 공용 인터넷에 노출하지 마십시오.
- 의도적으로 노드를 쌍으로 연결합니다. 원격 제어를 원하지 않으면 브라우저 프록시 라우팅을 비활성화하십시오(`gateway.nodes.browser.mode="off"`).

## "확장 경로" 작동 방식

`openclaw browser extension path`는 확장 파일이 포함된 **설치된** 온디스크 디렉터리를 인쇄합니다.

CLI는 의도적으로 `node_modules` 경로를 인쇄하지 **않습니다**. 확장 프로그램을 OpenClaw 상태 디렉터리 아래의 안정적인 위치에 복사하려면 항상 `openclaw browser extension install`을 먼저 실행하세요.

해당 설치 디렉터리를 이동하거나 삭제하면 Chrome은 유효한 경로에서 다시 로드할 때까지 확장 프로그램을 손상된 것으로 표시합니다.

## 보안에 미치는 영향(읽기)

이것은 강력하고 위험합니다. 모델에 "브라우저를 대고" 있는 것처럼 처리하십시오.

- 확장 프로그램은 Chrome의 디버거 API(`chrome.debugger`)를 사용합니다. 연결되면 모델은 다음을 수행할 수 있습니다.
  - 해당 탭에서 클릭/입력/탐색
  - 페이지 내용 읽기
  - 탭의 로그인 세션이 액세스할 수 있는 모든 항목에 액세스합니다.
- **이것은 전용 openclaw 관리 프로필처럼 격리되지 않습니다**.
  - 일일 운전자 프로필/탭에 연결하면 해당 계정 상태에 대한 액세스 권한이 부여됩니다.

권장사항:

- 확장 릴레이 사용을 위해서는 전용 Chrome 프로필(개인 탐색과 별도로)을 선호합니다.
- 게이트웨이와 모든 노드 호스트를 tailnet 전용으로 유지합니다. 게이트웨이 인증 + 노드 페어링에 의존합니다.
- LAN(`0.0.0.0`)을 통해 릴레이 포트를 노출하지 말고 Funnel(공개)을 피하세요.
- 릴레이는 비확장 원본을 차단하고 CDP 클라이언트에 대한 내부 인증 토큰이 필요합니다.

관련 항목:

- 브라우저 도구 개요: [브라우저](/tools/browser)
- 보안 감사: [보안](/gateway/security)
- 테일스케일 설정 : [테일스케일](/gateway/tailscale)
