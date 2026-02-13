---
read_when:
  - 온보딩 Wizard를 실행/설정할 때
  - 새 머신을 셋업할 때
sidebarTitle: Wizard (CLI)
summary: CLI 온보딩 Wizard로 gateway, workspace, channels, skills를 대화형으로 설정합니다.
title: 온보딩 Wizard (CLI)
---

# 온보딩 Wizard (CLI)

CLI 온보딩 Wizard는 macOS, Linux, Windows(WSL2)에서 OpenClaw를 설정하는 권장 경로입니다. 로컬 Gateway 또는 원격 Gateway 연결과 함께 워크스페이스 기본값, 채널, Skills까지 한 번에 구성할 수 있습니다.

```bash
openclaw onboard
```

<Info>
가장 빠른 첫 채팅 방법: Control UI를 엽니다 (채널 설정 불필요). `openclaw dashboard`를 실행해 브라우저에서 채팅하세요.
문서: [Dashboard](/web/dashboard)
</Info>

## QuickStart vs Advanced

Wizard는 **QuickStart**(기본값) 또는 **Advanced**(전체 제어) 중 하나를 먼저 선택합니다.

<Tabs>
  <Tab title="QuickStart (기본값)">
    - 로컬 Gateway (loopback)
    - 기본 워크스페이스(또는 기존 워크스페이스)
    - Gateway 포트 `18789`
    - Gateway 인증 Token 자동 생성 (loopback에서도 생성)
    - Tailscale 공개 비활성화
    - Telegram/WhatsApp DM은 기본 allowlist (전화번호 입력 프롬프트가 나타날 수 있음)
  </Tab>
  <Tab title="Advanced (전체 제어)">
    - 모드, 워크스페이스, Gateway, 채널, 데몬, Skills까지 모든 단계를 노출합니다.
  </Tab>
</Tabs>

## CLI 온보딩 상세

<Columns>
  <Card title="CLI 레퍼런스" href="/start/wizard-cli-reference">
    로컬/원격 플로우, 인증과 모델 매트릭스, 설정 출력, Wizard RPC, signal-cli 동작을 포함한 전체 가이드.
  </Card>
  <Card title="자동화와 스크립트" href="/start/wizard-cli-automation">
    비대화형 온보딩 레시피와 자동화된 `agents add` 예시.
  </Card>
</Columns>

## 자주 쓰는 후속 명령

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json`은 비대화형 모드를 의미하지 않습니다. 스크립트에서는 `--non-interactive`를 사용하세요.
</Note>

<Tip>
권장: 에이전트가 `web_search`를 사용할 수 있도록 Brave Search API 키를 설정하세요 (`web_fetch`는 키 없이 동작). 가장 쉬운 경로: `openclaw configure --section web`를 실행하면 `tools.web.search.apiKey`가 저장됩니다.
문서: [Web tools](/tools/web)
</Tip>

## 관련 문서

- CLI 명령 레퍼런스: [`openclaw onboard`](/cli/onboard)
- macOS 앱 온보딩: [온보딩](/start/onboarding)
- 에이전트 첫 실행 절차: [Agent Bootstrapping](/start/bootstrapping)
