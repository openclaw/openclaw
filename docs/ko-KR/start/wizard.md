---
read_when:
  - 온보딩 위저드를 실행하거나 구성할 때
  - 새 머신을 설정할 때
sidebarTitle: Wizard (CLI)
summary: CLI 온보딩 위저드: Gateway, 워크스페이스, 채널, Skills의 가이드 설정
title: 온보딩 위저드 (CLI)
x-i18n:
  source_path: start/wizard.md
---

# 온보딩 위저드 (CLI)

온보딩 위저드는 macOS, Linux, Windows(WSL2 경유, 강력 권장)에서 OpenClaw를 설정하는 **권장** 방법입니다.
로컬 Gateway 또는 원격 Gateway 연결과 함께 채널, Skills, 워크스페이스 기본값을 하나의 가이드 흐름에서 구성합니다.

```bash
openclaw onboard
```

<Info>
가장 빠른 첫 채팅: Control UI를 엽니다(채널 설정 불필요). `openclaw dashboard`를 실행하고 브라우저에서 채팅하세요. 문서: [Dashboard](/web/dashboard).
</Info>

나중에 재구성하려면:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json`은 비대화식 모드를 의미하지 않습니다. 스크립트에서는 `--non-interactive`를 사용하세요.
</Note>

<Tip>
권장: 에이전트가 `web_search`를 사용할 수 있도록 Brave Search API 키를 설정하세요(`web_fetch`는 키 없이 동작합니다). 가장 쉬운 방법: `openclaw configure --section web`을 실행하면 `tools.web.search.apiKey`가 저장됩니다. 문서: [웹 도구](/tools/web).
</Tip>

## 빠른 시작 vs 고급 설정

위저드는 **빠른 시작**(기본값) 또는 **고급 설정**(전체 제어) 중 하나를 선택하여 시작합니다.

<Tabs>
  <Tab title="빠른 시작 (기본값)">
    - loopback 상의 로컬 Gateway
    - 기본 워크스페이스(또는 기존 워크스페이스)
    - Gateway 포트 **18789**
    - Gateway 인증 **토큰** (loopback에서도 자동 생성)
    - Tailscale 노출 **끄기**
    - Telegram 및 WhatsApp DM은 기본적으로 **허용 목록** (전화번호 입력을 요청받을 수 있음)
  </Tab>
  <Tab title="고급 설정 (전체 제어)">
    - 모든 단계를 노출합니다 (모드, 워크스페이스, Gateway, 채널, 데몬, Skills).
  </Tab>
</Tabs>

## 위저드가 구성하는 것

**로컬 모드 (기본값)** 에서는 다음 단계를 안내합니다:

1. **모델/인증** — Anthropic API 키(권장), OpenAI, 또는 커스텀 프로바이더(OpenAI 호환, Anthropic 호환, 또는 Unknown 자동 감지). 기본 모델을 선택합니다.
2. **워크스페이스** — 에이전트 파일 위치(기본값 `~/.openclaw/workspace`). 부트스트랩 파일을 시드합니다.
3. **Gateway** — 포트, 바인드 주소, 인증 모드, Tailscale 노출.
4. **채널** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles, 또는 iMessage.
5. **데몬** — LaunchAgent(macOS) 또는 systemd 사용자 유닛(Linux/WSL2)을 설치합니다.
6. **상태 확인** — Gateway를 시작하고 실행 중인지 확인합니다.
7. **Skills** — 권장 Skills과 선택적 의존성을 설치합니다.

<Note>
위저드를 다시 실행해도 **초기화**(또는 `--reset` 전달)를 명시적으로 선택하지 않는 한 기존 설정을 지우지 않습니다.
설정이 유효하지 않거나 레거시 키가 포함된 경우, 위저드가 먼저 `openclaw doctor`를 실행하도록 요청합니다.
</Note>

**원격 모드**는 로컬 클라이언트가 다른 곳의 Gateway에 연결하도록만 구성합니다.
원격 호스트에 아무것도 설치하거나 변경하지 않습니다.

## 에이전트 추가

`openclaw agents add <name>`을 사용하여 자체 워크스페이스, 세션, 인증 프로필을 가진 별도의 에이전트를 만듭니다. `--workspace` 없이 실행하면 위저드가 시작됩니다.

설정 항목:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

참고:

- 기본 워크스페이스는 `~/.openclaw/workspace-<agentId>` 패턴을 따릅니다.
- `bindings`를 추가하여 인바운드 메시지를 라우팅합니다(위저드로 가능).
- 비대화식 플래그: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## 전체 참조

단계별 상세 분석, 비대화식 스크립팅, Signal 설정, RPC API, 위저드가 작성하는 설정 필드의 전체 목록은 [위저드 참조](/reference/wizard)를 참조하세요.

## 관련 문서

- CLI 명령 참조: [`openclaw onboard`](/cli/onboard)
- 온보딩 개요: [온보딩 개요](/start/onboarding-overview)
- macOS 앱 온보딩: [온보딩](/start/onboarding)
- 에이전트 첫 실행 절차: [에이전트 부트스트래핑](/start/bootstrapping)
