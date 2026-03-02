---
summary: "Chrome extension: let OpenClaw drive your existing Chrome tab"
read_when:
  - You want the agent to drive an existing Chrome tab (toolbar button)
  - You need remote Gateway + local browser automation via Tailscale
  - You want to understand the security implications of browser takeover
title: "Chrome Extension"
generated_at: "2026-03-02T00:00:00Z"
model: claude-opus-4-6
provider: pi
source_path: docs/tools/chrome-extension.md
workflow: 15
---

# Chrome extension (browser relay)

OpenClaw Chrome extension 은 agent 가 별도의 openclaw 관리 Chrome 프로필을 시작하는 대신 **existing Chrome tabs** (일반 Chrome 창) 을 제어할 수 있게 합니다.

Attach/detach 는 **single Chrome toolbar button** 을 통해 발생합니다.

## 무엇인가 (concept)

세 부분이 있습니다:

- **Browser control service** (Gateway 또는 node): agent/tool 이 호출하는 API (Gateway 를 통해)
- **Local relay server** (loopback CDP): control server 와 extension 사이의 bridge (`http://127.0.0.1:18792` 기본값)
- **Chrome MV3 extension**: `chrome.debugger` 를 사용하여 활성 탭에 연결하고 CDP 메시지를 relay 에 파이프합니다

OpenClaw 는 올바른 프로필을 선택하여 normal `browser` tool 표면을 통해 첨부된 탭을 제어합니다.

## Install / load (unpacked)

1. extension 을 안정적인 로컬 경로에 설치합니다:

```bash
openclaw browser extension install
```

2. 설치된 extension 디렉터리 경로를 인쇄합니다:

```bash
openclaw browser extension path
```

3. Chrome → `chrome://extensions`

- "Developer mode" 활성화
- "Load unpacked" → 위에 인쇄된 디렉터리 선택

4. extension 을 핀합니다.

## Updates (no build step)

Extension 은 OpenClaw 릴리스 (npm package) 내부에 정적 파일로 제공됩니다. 별도의 "build" 단계는 없습니다.

OpenClaw 업그레이드 후:

- `openclaw browser extension install` 을 다시 실행하여 OpenClaw 상태 디렉터리 아래에 설치된 파일을 새로 고칩니다.
- Chrome → `chrome://extensions` → extension 에서 "Reload" 를 클릭합니다.

## 사용하기 (gateway token 한 번 설정)

OpenClaw 는 `chrome` 이라는 내장 browser 프로필과 함께 제공되어 기본 포트의 extension relay 를 대상으로 합니다.

첫 번째 attach 전에, extension Options 를 열고 설정합니다:

- `Port` (기본값 `18792`)
- `Gateway token` (must match `gateway.auth.token` / `OPENCLAW_GATEWAY_TOKEN`)

사용:

- CLI: `openclaw browser --browser-profile chrome tabs`
- Agent tool: `browser` with `profile="chrome"`

다른 이름 또는 다른 relay port 를 원하면, 자신의 프로필을 만듭니다:

```bash
openclaw browser create-profile \
  --name my-chrome \
  --driver extension \
  --cdp-url http://127.0.0.1:18792 \
  --color "#00AA00"
```

### Custom Gateway ports

사용자 정의 gateway port 를 사용하는 경우, extension relay port 는 자동으로 파생됩니다:

**Extension Relay Port = Gateway Port + 3**

예: `gateway.port: 19001` 인 경우:

- Extension relay 포트: `19004` (gateway + 3)

extension Options 페이지에서 파생된 relay port 를 사용하도록 extension 을 구성합니다.

## Attach / detach (toolbar button)

- OpenClaw 가 제어하려는 탭을 엽니다.
- Extension 아이콘을 클릭합니다.
  - 배지는 첨부되었을 때 `ON` 을 표시합니다.
- 다시 클릭하여 분리합니다.

## OpenClaw 가 제어하는 탭은?

- "현재 보고 있는 탭" 을 자동으로 제어하지 **않습니다**.
- **only 명시적으로 첨부된 탭 (toolbar button 을 클릭하여)** 을 제어합니다.
- 전환 하려면: 다른 탭을 열고 거기서 extension 아이콘을 클릭합니다.

## Badge + common errors

- `ON`: 첨부됨; OpenClaw 가 해당 탭을 구동할 수 있습니다.
- `…`: local relay 에 연결하는 중.
- `!`: relay 에 연결할 수 없음/인증됨 (가장 일반적: relay server 가 실행되지 않음, 또는 gateway token 누락/잘못됨).

`!` 을 보면:

- Gateway 가 로컬에서 실행 중인지 확인 (기본 설정) 또는 Gateway 가 다른 곳에서 실행되는 경우 이 머신에서 node host 를 실행합니다.
- Extension Options 페이지를 열면; relay reachability + gateway-token auth 를 검증합니다.

## Remote Gateway (node host 사용)

### Local Gateway (Chrome 과 동일한 머신) — 일반적으로 **추가 단계 없음**

Gateway 가 Chrome 과 동일한 머신에서 실행 중인 경우, loopback 에서 browser control 서비스를 시작하고 relay server 를 자동 시작합니다. Extension 은 로컬 relay 와 통신합니다; CLI/tool calls 는 Gateway 로 이동합니다.

### Remote Gateway (Gateway 가 다른 곳에서 실행) — **node host 실행**

Gateway 가 다른 머신에서 실행 중인 경우, Chrome 을 실행하는 머신에서 node host 를 시작합니다.
Gateway 는 browser 작업을 해당 node 로 프록시합니다; extension + relay 은 browser 머신에 로컬로 유지됩니다.

여러 node 가 연결된 경우, `gateway.nodes.browser.node` 를 사용하거나 `gateway.nodes.browser.mode` 를 설정합니다.

## Sandboxing (tool containers)

Agent session 이 sandboxed 인 경우 (`agents.defaults.sandbox.mode != "off"`), `browser` tool 은 제한될 수 있습니다:

- 기본적으로 sandboxed sessions 은 종종 **sandbox browser** (`target="sandbox"`) 를 대상으로 하고, host Chrome 을 대상으로 하지 **않습니다**.
- Chrome extension relay takeover 는 **host** browser control server 제어가 필요합니다.

옵션:

- 가장 쉬움: **non-sandboxed** session/agent 에서 extension 을 사용합니다.
- 또는 sandboxed sessions 을 위해 host browser control 을 허용합니다:

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

그런 다음 tool 정책으로 거부되지 않도록 하고 필요한 경우 `target="host"` 로 `browser` 를 호출합니다.

디버깅: `openclaw sandbox explain`

## Remote access tips

- Gateway 와 node host 를 동일한 tailnet 에 유지합니다; LAN 또는 공개 인터넷에 relay 포트를 노출하지 않습니다.
- 의도적으로 node 를 pair 합니다; browser proxy routing 을 원하지 않으면 비활성화합니다 (`gateway.nodes.browser.mode="off"`).

## "extension path" 가 작동하는 방식

`openclaw browser extension path` 는 extension 파일을 포함하는 **installed** on-disk 디렉터리를 인쇄합니다.

CLI 는 의도적으로 `node_modules` 경로를 인쇄하지 **않습니다**. 항상 먼저 `openclaw browser extension install` 을 실행하여 extension 을 OpenClaw 상태 디렉터리 아래의 안정적인 위치로 복사합니다.

해당 설치 디렉터리를 이동하거나 삭제하면, Chrome 은 유효한 경로에서 다시 로드할 때까지 extension 을 손상된 것으로 표시합니다.

## Security implications (이것을 읽으십시오)

이것은 강력하고 위험합니다. 모델에 "browser 에 손을 댈 수 있음" 을 제공하는 것과 같이 취급하십시오.

- Extension 은 Chrome 의 debugger API (`chrome.debugger`) 를 사용합니다. 첨부되면 모델은 다음을 수행할 수 있습니다:
  - 해당 탭에서 클릭/입력/탐색
  - page 컨텐츠 읽기
  - 탭의 로그인된 session 이 액세스할 수 있는 모든 것에 액세스
- **This is not isolated** dedicated openclaw 관리 프로필처럼.
  - 일상 사용자 프로필/탭에 첨부하면, 해당 계정 상태에 대한 액세스를 부여합니다.

권장 사항:

- dedicated Chrome 프로필 (personal browsing 과 별도) 을 extension relay 사용을 위해 선호합니다.
- Gateway 와 모든 node hosts 를 tailnet 전용으로 유지합니다; Gateway auth + node pairing 에 의존합니다.
- relay 포트를 LAN 에 노출하지 않음 (`0.0.0.0`) 및 Funnel (public) 을 피합니다.
- Relay 는 non-extension origins 을 차단하고 `/cdp` 및 `/extension` 모두에 대해 gateway-token auth 가 필요합니다.

Related:

- Browser tool overview: [Browser](/tools/browser)
- Security audit: [Security](/gateway/security)
- Tailscale setup: [Tailscale](/gateway/tailscale)
