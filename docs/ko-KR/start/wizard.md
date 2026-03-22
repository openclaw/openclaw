---
title: "온보딩 (CLI)"
summary: "CLI 온보딩: Gateway, 워크스페이스, 채널, Skills 의 가이드 설정"
sidebarTitle: "온보딩: CLI"
read_when:
  - CLI 온보딩을 실행하거나 설정할 때
  - 새 머신을 설정할 때
x-i18n:
  source_path: docs/start/wizard.md
---

# 온보딩 (CLI)

CLI 온보딩은 macOS, Linux 또는 Windows(WSL2 를 통해; 강력히 권장)에서 OpenClaw 를 설정하는 **권장** 방법입니다.
로컬 Gateway 또는 원격 Gateway 연결을 설정하고, 채널, Skills, 워크스페이스 기본값을 하나의 가이드 흐름으로 구성합니다.

```bash
openclaw onboard
```

<Info>
가장 빠른 첫 채팅: Control UI 를 여세요(채널 설정 불필요). `openclaw dashboard` 를 실행하고 브라우저에서 채팅하세요. 문서: [대시보드](/web/dashboard).
</Info>

나중에 다시 설정하려면:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` 은 비대화형 모드를 의미하지 않습니다. 스크립트에서는 `--non-interactive` 를 사용하세요.
</Note>

<Tip>
CLI 온보딩에는 웹 검색 단계가 포함되어 있어 프로바이더(Perplexity, Brave, Gemini, Grok 또는 Kimi)를 선택하고 API 키를 붙여넣으면 에이전트가 `web_search` 를 사용할 수 있습니다. 나중에 `openclaw configure --section web` 으로도 설정할 수 있습니다. 문서: [웹 도구](/tools/web).
</Tip>

## QuickStart vs Advanced

온보딩은 **QuickStart** (기본값) vs **Advanced** (완전한 제어)로 시작합니다.

<Tabs>
  <Tab title="QuickStart (기본값)">
    - 로컬 Gateway (루프백)
    - 워크스페이스 기본값 (또는 기존 워크스페이스)
    - Gateway 포트 **18789**
    - Gateway 인증 **토큰** (루프백에서도 자동 생성)
    - 새 로컬 설정의 도구 정책 기본값: `tools.profile: "coding"` (기존 명시적 프로필은 유지됨)
    - DM 격리 기본값: 로컬 온보딩은 미설정 시 `session.dmScope: "per-channel-peer"` 를 기록합니다. 상세: [CLI 설정 참조](/start/wizard-cli-reference#outputs-and-internals)
    - Tailscale 노출 **Off**
    - Telegram + WhatsApp DM 기본값은 **허용 목록** (전화번호 입력 안내)
  </Tab>
  <Tab title="Advanced (완전한 제어)">
    - 모든 단계를 노출합니다 (모드, 워크스페이스, Gateway, 채널, 데몬, Skills).
  </Tab>
</Tabs>

## 온보딩이 설정하는 것

**로컬 모드 (기본값)**는 다음 단계를 안내합니다:

1. **모델/인증** — 지원되는 모든 프로바이더/인증 흐름(API 키, OAuth 또는 setup-token)을 선택합니다. Custom Provider(OpenAI 호환, Anthropic 호환 또는 Unknown 자동 감지) 포함. 기본 모델을 선택합니다.
   보안 참고: 이 에이전트가 도구를 실행하거나 웹훅/훅 콘텐츠를 처리할 경우, 최신 세대의 가장 강력한 모델을 사용하고 도구 정책을 엄격하게 유지하세요. 약하거나 오래된 티어는 프롬프트 인젝션에 취약합니다.
   비대화형 실행의 경우, `--secret-input-mode ref` 는 인증 프로필에 평문 API 키 값 대신 환경 변수 참조를 저장합니다.
   비대화형 `ref` 모드에서는 프로바이더 환경 변수가 설정되어 있어야 합니다; 해당 환경 변수 없이 인라인 키 플래그를 전달하면 즉시 실패합니다.
   대화형 실행에서 시크릿 참조 모드를 선택하면 환경 변수 또는 구성된 프로바이더 참조(`file` 또는 `exec`)를 가리킬 수 있으며, 저장 전에 빠른 사전 검증이 수행됩니다.
2. **워크스페이스** — 에이전트 파일의 위치(기본값 `~/.openclaw/workspace`). 부트스트랩 파일을 시드합니다.
3. **Gateway** — 포트, 바인드 주소, 인증 모드, Tailscale 노출.
   대화형 토큰 모드에서는 기본 평문 토큰 저장 또는 SecretRef 사용을 선택합니다.
   비대화형 토큰 SecretRef 경로: `--gateway-token-ref-env <ENV_VAR>`.
4. **채널** — WhatsApp, Telegram, Discord, Google Chat, Mattermost, Signal, BlueBubbles 또는 iMessage.
5. **데몬** — LaunchAgent(macOS) 또는 systemd 사용자 유닛(Linux/WSL2)을 설치합니다.
   토큰 인증이 토큰을 필요로 하고 `gateway.auth.token` 이 SecretRef 관리인 경우, 데몬 설치가 검증하지만 해석된 토큰을 수퍼바이저 서비스 환경 메타데이터에 유지하지 않습니다.
   토큰 인증이 토큰을 필요로 하고 구성된 토큰 SecretRef 가 미해석된 경우, 실행 가능한 안내와 함께 데몬 설치가 차단됩니다.
   `gateway.auth.token` 과 `gateway.auth.password` 가 모두 구성되어 있고 `gateway.auth.mode` 가 미설정인 경우, 모드가 명시적으로 설정될 때까지 데몬 설치가 차단됩니다.
6. **상태 점검** — Gateway 를 시작하고 실행 중인지 확인합니다.
7. **Skills** — 권장 Skills 과 선택적 종속성을 설치합니다.

<Note>
온보딩을 다시 실행해도 명시적으로 **초기화**를 선택하거나 (`--reset` 을 전달하지 않는 한) 아무것도 지워지지 **않습니다**.
CLI `--reset` 은 기본적으로 설정, 자격 증명, 세션을 대상으로 합니다; 워크스페이스를 포함하려면 `--reset-scope full` 을 사용하세요.
설정이 유효하지 않거나 레거시 키를 포함하는 경우, 온보딩은 먼저 `openclaw doctor` 를 실행하도록 요청합니다.
</Note>

**원격 모드**는 다른 곳의 Gateway 에 연결하도록 로컬 클라이언트만 구성합니다.
원격 호스트에는 아무것도 설치하거나 변경하지 **않습니다**.

## 다른 에이전트 추가

`openclaw agents add <name>` 을 사용하여 자체 워크스페이스, 세션, 인증 프로필을 가진 별도의 에이전트를 만듭니다. `--workspace` 없이 실행하면 온보딩이 시작됩니다.

설정되는 것:

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

참고:

- 기본 워크스페이스는 `~/.openclaw/workspace-<agentId>` 를 따릅니다.
- `bindings` 를 추가하여 인바운드 메시지를 라우팅합니다(온보딩이 이를 수행할 수 있음).
- 비대화형 플래그: `--model`, `--agent-dir`, `--bind`, `--non-interactive`.

## 전체 참조

단계별 상세 분석 및 설정 출력에 대해서는 [CLI 설정 참조](/start/wizard-cli-reference)를 참조하세요.
비대화형 예제는 [CLI 자동화](/start/wizard-cli-automation)를 참조하세요.
RPC 세부 사항을 포함한 더 깊은 기술 참조는 [온보딩 참조](/reference/wizard)를 참조하세요.

## 관련 문서

- CLI 명령 참조: [`openclaw onboard`](/cli/onboard)
- 온보딩 개요: [온보딩 개요](/start/onboarding-overview)
- macOS 앱 온보딩: [온보딩](/start/onboarding)
- 에이전트 최초 실행 의식: [에이전트 부트스트래핑](/start/bootstrapping)
