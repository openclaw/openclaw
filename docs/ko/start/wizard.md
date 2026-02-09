---
summary: "CLI 온보딩 마법사: 게이트웨이, 워크스페이스, 채널, Skills 를 위한 가이드 설정"
read_when:
  - 온보딩 마법사를 실행하거나 구성할 때
  - 새 머신을 설정할 때
title: "온보딩 마법사 (CLI)"
sidebarTitle: "온보딩: CLI"
---

# 온보딩 마법사 (CLI)

온보딩 마법사는 macOS, Linux 또는 Windows(WSL2 경유; 강력 권장)에서 OpenClaw 를 설정하는 **권장** 방법입니다.
이 마법사는 로컬 Gateway 또는 원격 Gateway 연결과 함께 채널, Skills, 워크스페이스 기본값을 하나의 가이드 흐름으로 구성합니다.

```bash
openclaw onboard
```

<Info>
가장 빠른 첫 채팅: Control UI 를 여십시오(채널 설정 불필요). `openclaw dashboard` 를 실행하고 브라우저에서 채팅하십시오. 문서: [Dashboard](/web/dashboard).
</Info>

나중에 다시 구성하려면:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` 는 비대화형 모드를 의미하지 않습니다. 스크립트의 경우 `--non-interactive` 를 사용하십시오.
</Note>

<Tip>
권장 사항: 에이전트가 `web_search` 를 사용할 수 있도록 Brave Search API 키를 설정하십시오
(`web_fetch` 는 키 없이도 작동합니다). 가장 쉬운 경로: `openclaw configure --section web`
— 이는 `tools.web.search.apiKey` 를 저장합니다. 문서: [Web tools](/tools/web).
</Tip>

## 빠른 시작 vs 고급

마법사는 **빠른 시작**(기본값)과 **고급**(전체 제어) 중에서 시작합니다.

<Tabs>
  <Tab title="QuickStart (defaults)">
    - 로컬 게이트웨이(loopback)
    - 워크스페이스 기본값(또는 기존 워크스페이스)
    - Gateway 포트 **18789**
    - Gateway 인증 **Token**(loopback 에서도 자동 생성)
    - Tailscale 노출 **끔**
    - Telegram + WhatsApp 다이렉트 메시지는 기본적으로 **allowlist**(전화번호를 입력하라는 안내가 표시됩니다)
  </Tab>
  <Tab title="Advanced (full control)">
    - 모든 단계(모드, 워크스페이스, 게이트웨이, 채널, 데몬, Skills)를 노출합니다.
  </Tab>
</Tabs>

## 마법사가 구성하는 항목

**로컬 모드(기본값)** 는 다음 단계를 안내합니다:

1. **모델/인증** — Anthropic API 키(권장), OAuth, OpenAI 또는 기타 프로바이더. 기본 모델을 선택합니다.
2. **워크스페이스** — 에이전트 파일의 위치(기본값 `~/.openclaw/workspace`). 부트스트랩 파일을 시드합니다.
3. **Gateway** — 포트, 바인드 주소, 인증 모드, Tailscale 노출.
4. **채널** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles 또는 iMessage.
5. **데몬** — LaunchAgent(macOS) 또는 systemd 사용자 유닛(Linux/WSL2)을 설치합니다.
6. **상태 확인** — Gateway 를 시작하고 실행 중인지 확인합니다.
7. **Skills** — 권장 Skills 와 선택적 의존성을 설치합니다.

<Note>
마법사를 다시 실행해도 **Reset** 을 명시적으로 선택(또는 `--reset` 전달)하지 않는 한 아무 것도 삭제되지 않습니다.
구성이 유효하지 않거나 레거시 키가 포함되어 있으면, 먼저 `openclaw doctor` 를 실행하라는 안내가 표시됩니다.
</Note>

**원격 모드** 는 다른 위치의 Gateway 에 연결하도록 로컬 클라이언트만 구성합니다.
원격 호스트에는 아무 것도 설치하거나 변경하지 **않습니다**.

## 다른 에이전트 추가

`openclaw agents add <name>` 를 사용하여 자체 워크스페이스, 세션 및 인증 프로필을 가진 별도의 에이전트를 생성하십시오. `--workspace` 없이 실행하면 마법사가 시작됩니다.

설정되는 항목:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

참고 사항:

- 기본 워크스페이스는 `~/.openclaw/workspace-<agentId>` 를 따릅니다.
- 인바운드 메시지를 라우팅하려면 `bindings` 를 추가하십시오(마법사에서 수행할 수 있습니다).
- 비대화형 플래그: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## 전체 참조

자세한 단계별 설명, 비대화형 스크립팅, Signal 설정,
RPC API, 그리고 마법사가 작성하는 구성 필드의 전체 목록은
[Wizard Reference](/reference/wizard)를 참고하십시오.

## 관련 문서

- CLI 명령 참조: [`openclaw onboard`](/cli/onboard)
- macOS 앱 온보딩: [Onboarding](/start/onboarding)
- 에이전트 최초 실행 절차: [Agent Bootstrapping](/start/bootstrapping)
