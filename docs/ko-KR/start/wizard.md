---
summary: "CLI 온보딩 마법사: 게이트웨이, 워크스페이스, 채널 및 스킬에 대한 안내 설정"
read_when:
  - 온보딩 마법사 실행 또는 설정 중
  - 새 기계 설정 중
title: "온보딩 마법사 (CLI)"
sidebarTitle: "온보딩: CLI"
---

# 온보딩 마법사 (CLI)

온보딩 마법사는 macOS, Linux 또는 Windows (WSL2 통해; 강력히 권장)에서 OpenClaw를 설정하는 **권장** 방법입니다. 로컬 게이트웨이 또는 원격 게이트웨이 연결, 채널, 스킬 및 워크스페이스 기본값을 하나의 안내 흐름에서 설정합니다.

```bash
openclaw onboard
```

<Info>
가장 빠른 첫 번째 채팅: 제어 UI 열기 (채널 설정 불필요). `openclaw dashboard`를 실행하여 브라우저에서 채팅합니다. 문서: [대시보드](/ko-KR/web/dashboard).
</Info>

나중에 재설정을 위해:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json`은 비대화형 모드를 의미하지 않습니다. 스크립트를 위해 `--non-interactive`를 사용하십시오.
</Note>

<Tip>
권장 사항: Brave Search API 키를 설정하여 에이전트가 `web_search`를 사용할 수 있도록 하십시오 (`web_fetch`는 키 없이 작동합니다). 가장 쉬운 경로: `openclaw configure --section web`을 사용하여 `tools.web.search.apiKey`를 저장합니다. 문서: [웹 도구](/ko-KR/tools/web).
</Tip>

## 빠른 시작 대 고급

마법사는 **빠른 시작** (기본값)과 **고급** (전체 제어) 중에서 시작합니다.

<Tabs>
  <Tab title="빠른 시작 (기본값)">
    - 로컬 게이트웨이 (로컬 루프백)
    - 워크스페이스 기본값 (또는 기존 워크스페이스)
    - 게이트웨이 포트 **18789**
    - 게이트웨이 인증 **토큰** (로컬 루프백에서도 자동 생성됨)
    - Tailscale 노출 **Off**
    - Telegram + WhatsApp 다이렉트 메시지의 기본값은 **허용 목록** (전화번호를 입력해야 할 수 있습니다)
  </Tab>
  <Tab title="고급 (전체 제어)">
    - 모든 단계 노출 (모드, 워크스페이스, 게이트웨이, 채널, 데몬, 스킬).
  </Tab>
</Tabs>

## 마법사가 구성하는 것

**로컬 모드 (기본값)**는 다음 단계를 안내합니다:

1. **모델/인증** — Anthropic API 키 (권장), OpenAI, 또는 사용자 지정 제공자 (OpenAI 호환, Anthropic 호환, 또는 자동 감지). 기본 모델 선택.
2. **워크스페이스** — 에이전트 파일의 위치 (기본값 `~/.openclaw/workspace`). 부트스트랩 파일 씨딩.
3. **게이트웨이** — 포트, 바인드 주소, 인증 모드, Tailscale 노출.
4. **채널** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles 또는 iMessage.
5. **데몬** — LaunchAgent (macOS) 또는 systemd 사용자 단위 (Linux/WSL2)를 설치합니다.
6. **건강 점검** — 게이트웨이를 시작하고 실행 여부를 확인합니다.
7. **스킬** — 권장 스킬 및 선택적 종속성을 설치합니다.

<Note>
마법사를 다시 실행해도 **Reset**을 명시적으로 선택하지 않는 한 아무것도 삭제되지 않습니다 (또는 `--reset`을 전달하지 않은 경우).
구성이 잘못되었거나 레거시 키가 포함된 경우, 마법사는 먼저 `openclaw doctor`를 실행하도록 요청합니다.
</Note>

**원격 모드**는 로컬 클라이언트를 다른 위치에 있는 게이트웨이에 연결하도록만 구성합니다. 원격 호스트에서 설치하거나 변경하지 않습니다.

## 다른 에이전트 추가하기

자신의 워크스페이스, 세션 및 인증 프로파일을 가진 별도의 에이전트를 생성하려면 `openclaw agents add <name>`을 사용하세요. `--workspace` 없이 실행하면 마법사가 시작됩니다.

설정 항목:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

주의 사항:

- 기본 워크스페이스는 `~/.openclaw/workspace-<agentId>`를 따릅니다.
- 수신 메시지 경로 지정을 위한 `bindings` 추가 (마법사가 이를 수행할 수 있습니다).
- 비대화형 플래그: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## 전체 참조

단계별 세부 사항, 비대화형 스크립팅, Signal 설정, RPC API, 및 마법사가 작성하는 구성 필드의 전체 목록에 대한 자세한 내용은 [마법사 참조](/ko-KR/reference/wizard)를 참조하십시오.

## 관련 문서

- CLI 명령 참조: [`openclaw onboard`](/ko-KR/cli/onboard)
- 온보딩 개요: [온보딩 개요](/ko-KR/start/onboarding-overview)
- macOS 앱 온보딩: [온보딩](/ko-KR/start/onboarding)
- 에이전트 첫 실행 의식: [에이전트 부트스트래핑](/ko-KR/start/bootstrapping)