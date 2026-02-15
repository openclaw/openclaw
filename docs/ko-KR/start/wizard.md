---
summary: "CLI onboarding wizard: guided setup for gateway, workspace, channels, and skills"
read_when:
  - Running or configuring the onboarding wizard
  - Setting up a new machine
title: "Onboarding Wizard (CLI)"
sidebarTitle: "Onboarding: CLI"
x-i18n:
  source_hash: 381ed1422a371c4b7484612166505c18564c6f869d155c32966d998aa3b5942f
---

# 온보딩 마법사(CLI)

온보딩 마법사는 macOS에서 OpenClaw를 설정하는 **권장** 방법입니다.
Linux 또는 Windows(WSL2 사용, 적극 권장)
로컬 게이트웨이 또는 원격 게이트웨이 연결과 채널, 기술을 구성합니다.
하나의 안내식 흐름으로 작업공간 기본값을 지정합니다.

```bash
openclaw onboard
```

<Info>
가장 빠른 첫 번째 채팅: 제어 UI를 엽니다(채널 설정이 필요하지 않음). 실행
`openclaw dashboard` 브라우저에서 채팅하세요. 문서: [대시보드](/web/dashboard).
</Info>

나중에 재구성하려면:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json`는 비대화형 모드를 의미하지 않습니다. 스크립트의 경우 `--non-interactive`를 사용하세요.
</Note>

<Tip>
권장 사항: 에이전트가 `web_search`를 사용할 수 있도록 Brave Search API 키를 설정하세요.
(`web_fetch`는 키 없이 작동합니다.) 가장 쉬운 경로: `openclaw configure --section web`
`tools.web.search.apiKey`를 저장합니다. 문서: [웹 도구](/tools/web).
</Tip>

## 빠른 시작과 고급 비교

마법사는 **빠른 시작**(기본값)과 **고급**(모든 권한)으로 시작됩니다.

<Tabs>
  <Tab title="QuickStart (defaults)">
    - 로컬 게이트웨이(루프백)
    - 작업공간 기본값(또는 기존 작업공간)
    - 게이트웨이 포트 **18789**
    - 게이트웨이 인증 **토큰**(루프백 시에도 자동 생성)
    - 테일스케일 노출 **해제**
    - Telegram + WhatsApp DM은 기본적으로 **허용 목록**으로 설정됩니다(전화번호를 묻는 메시지가 표시됩니다).
  </Tab>
  <Tab title="Advanced (full control)">
    - 모든 단계(모드, 워크스페이스, 게이트웨이, 채널, 데몬, 스킬)를 노출합니다.
  </Tab>
</Tabs>

## 마법사가 구성하는 것

**로컬 모드(기본값)**에서는 다음 단계를 안내합니다.

1. **모델/인증** — Anthropic API 키(권장), OpenAI 또는 맞춤형 공급자
   (OpenAI 호환, Anthropic 호환 또는 알 수 없음 자동 감지). 기본 모델을 선택하세요.
2. **작업 공간** — 에이전트 파일의 위치(기본값 `~/.openclaw/workspace`). 부트스트랩 파일을 시드합니다.
3. **게이트웨이** — 포트, 바인딩 주소, 인증 모드, Tailscale 노출.
4. **채널** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles 또는 iMessage.
5. **데몬** — LaunchAgent(macOS) 또는 systemd 사용자 유닛(Linux/WSL2)을 설치합니다.
6. **상태 확인** — 게이트웨이를 시작하고 실행 중인지 확인합니다.
7. **기술** — 권장 기술과 선택적 종속성을 설치합니다.

<Note>
명시적으로 **재설정**을 선택하거나 `--reset`을 전달하지 않는 한 마법사를 다시 실행해도 아무것도 초기화되지 않습니다.
구성이 유효하지 않거나 레거시 키를 포함하는 경우 마법사는 먼저 `openclaw doctor`를 실행하라는 메시지를 표시합니다.
</Note>

**원격 모드**는 로컬 클라이언트가 다른 곳의 게이트웨이에 연결하도록만 구성합니다.
원격 호스트에 아무것도 설치하거나 변경하지 **않습니다**.

## 다른 상담원 추가

`openclaw agents add <name>`를 사용하여 자체 작업공간이 있는 별도의 에이전트를 생성하고,
세션 및 인증 프로필. `--workspace` 없이 실행하면 마법사가 시작됩니다.

설정 내용:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

참고:

- 기본 작업공간은 `~/.openclaw/workspace-<agentId>`를 따릅니다.
- `bindings`를 추가하여 인바운드 메시지를 라우팅합니다(마법사가 이를 수행할 수 있음).
- 비대화형 플래그: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## 전체 참조

자세한 단계별 분석, 비대화형 스크립팅, 신호 설정,
RPC API 및 마법사가 작성하는 구성 필드의 전체 목록은 다음을 참조하세요.
[마법사 참조](/reference/wizard).

## 관련 문서

- CLI 명령 참조: [`openclaw onboard`](/cli/onboard)
- 온보딩 개요: [온보딩 개요](/start/onboarding-overview)
- macOS 앱 온보딩: [온보딩](/start/onboarding)
- 에이전트 첫 실행 의식: [에이전트 부트스트래핑](/start/bootstrapping)
