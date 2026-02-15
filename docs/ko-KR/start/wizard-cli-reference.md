---
summary: "Complete reference for CLI onboarding flow, auth/model setup, outputs, and internals"
read_when:
  - You need detailed behavior for openclaw onboard
  - You are debugging onboarding results or integrating onboarding clients
title: "CLI Onboarding Reference"
sidebarTitle: "CLI reference"
x-i18n:
  source_hash: cb0eb05f171a2dbca021830add5f56857f1b89302e3a26fec6ba7982207db7cc
---

# CLI 온보딩 참조

이 페이지는 `openclaw onboard`에 대한 전체 참조입니다.
간단한 가이드는 [온보딩 마법사(CLI)](/start/wizard)를 참조하세요.

## 마법사가 하는 일

로컬 모드(기본값)는 다음 과정을 안내합니다.

- 모델 및 인증 설정(OpenAI 코드 구독 OAuth, Anthropic API 키 또는 설정 토큰, MiniMax, GLM, Moonshot 및 AI Gateway 옵션)
- 작업공간 위치 및 부트스트랩 파일
- 게이트웨이 설정(포트, 바인드, 인증, 테일스케일)
- 채널 및 제공업체(Telegram, WhatsApp, Discord, Google Chat, Mattermost 플러그인, Signal)
- 데몬 설치(LaunchAgent 또는 systemd 사용자 장치)
- 건강검진
- 스킬 설정

원격 모드는 이 시스템이 다른 곳의 게이트웨이에 연결되도록 구성합니다.
원격 호스트에 아무것도 설치하거나 수정하지 않습니다.

## 로컬 흐름 세부정보

<Steps>
  <Step title="Existing config detection">
    - `~/.openclaw/openclaw.json`이 존재하는 경우 유지, 수정, 재설정을 선택하세요.
    - 마법사를 다시 실행하면 명시적으로 재설정을 선택하거나 `--reset`를 전달하지 않는 한 아무것도 지워지지 않습니다.
    - 구성이 유효하지 않거나 레거시 키를 포함하는 경우 마법사가 중지되고 계속하기 전에 `openclaw doctor`를 실행하라는 메시지가 표시됩니다.
    - 재설정은 `trash`를 사용하고 다음 범위를 제공합니다.
      - 구성만 가능
      - 구성 + 자격 증명 + 세션
      - 전체 재설정(작업 공간도 제거됨)
  </Step>
  <Step title="Model and auth">
    - 전체 옵션 매트릭스는 [인증 및 모델 옵션](#auth-and-model-options)에 있습니다.
  </Step>
  <Step title="Workspace">
    - 기본값 `~/.openclaw/workspace` (구성 가능).
    - 첫 번째 실행 부트스트랩 의식에 필요한 작업 공간 파일을 시드합니다.
    - 작업공간 레이아웃: [에이전트 작업공간](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - 포트, 바인드, 인증 모드 및 tailscale 노출에 대한 프롬프트를 표시합니다.
    - 권장 사항: 루프백의 경우에도 토큰 인증을 활성화하여 로컬 WS 클라이언트가 인증해야 합니다.
    - 모든 로컬 프로세스를 완전히 신뢰하는 경우에만 인증을 비활성화하세요.
    - 루프백이 아닌 바인딩에는 여전히 인증이 필요합니다.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): 선택적 QR 로그인
    - [텔레그램](/channels/telegram): 봇 토큰
    - [Discord](/channels/discord): 봇 토큰
    - [Google Chat](/channels/googlechat): 서비스 계정 JSON + 웹훅 대상
    - [Mattermost](/channels/mattermost) 플러그인: 봇 토큰 + 기본 URL
    - [시그널](/channels/signal): 선택사항 `signal-cli` 설치 + 계정 구성
    - [BlueBubbles](/channels/bluebubbles): iMessage에 권장됩니다. 서버 URL + 비밀번호 + 웹훅
    - [iMessage](/channels/imessage): 레거시 `imsg` CLI 경로 + DB 접근
    - DM 보안: 기본값은 페어링입니다. 첫 번째 DM은 코드를 보냅니다. 다음을 통해 승인
      `openclaw pairing approve <channel> <code>` 또는 허용 목록을 사용하세요.
  </Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - 로그인된 사용자 세션이 필요합니다. 헤드리스의 경우 사용자 정의 LaunchDaemon(제공되지 않음)을 사용하십시오.
    - WSL2를 통한 Linux 및 Windows: 시스템 사용자 단위
      - 마법사가 `loginctl enable-linger <user>`를 시도하므로 로그아웃 후에도 게이트웨이가 계속 작동합니다.
      - sudo를 묻는 메시지가 표시될 수 있습니다(`/var/lib/systemd/linger` 작성). 먼저 sudo 없이 시도합니다.
    - 런타임 선택: 노드(권장, WhatsApp 및 Telegram에 필수). 롤빵은 추천하지 않습니다.
  </Step>
  <Step title="Health check">
    - 게이트웨이를 시작하고(필요한 경우) `openclaw health`을 실행합니다.
    - `openclaw status --deep`는 상태 출력에 게이트웨이 상태 프로브를 추가합니다.
  </Step>
  <Step title="Skills">
    - 사용 가능한 스킬을 읽고 요구 사항을 확인합니다.
    - 노드 관리자를 선택할 수 있습니다: npm 또는 pnpm(bun 권장되지 않음).
    - 선택적 종속성을 설치합니다(일부는 macOS에서 Homebrew를 사용함).
  </Step>
  <Step title="Finish">
    - iOS, Android 및 macOS 앱 옵션을 포함한 요약 및 다음 단계.
  </Step>
</Steps>

<Note>
GUI가 감지되지 않으면 마법사는 브라우저를 여는 대신 제어 UI에 대한 SSH 포트 전달 지침을 인쇄합니다.
Control UI 자산이 누락된 경우 마법사는 해당 자산을 빌드하려고 시도합니다. fallback은 `pnpm ui:build`입니다(UI deps 자동 설치).
</Note>

## 원격 모드 세부정보

원격 모드는 이 시스템이 다른 곳의 게이트웨이에 연결되도록 구성합니다.

<Info>
원격 모드는 원격 호스트에 아무것도 설치하거나 수정하지 않습니다.
</Info>

설정한 내용:

- 원격 게이트웨이 URL (`ws://...`)
- 원격 게이트웨이 인증이 필요한 경우 토큰(권장)

<Note>
- 게이트웨이가 루프백 전용인 경우 SSH 터널링 또는 tailnet을 사용하십시오.
- 발견 힌트:
  - macOS: 봉쥬르(`dns-sd`)
  - 리눅스: Avahi (`avahi-browse`)
</Note>

## 인증 및 모델 옵션

<AccordionGroup>
  <Accordion title="Anthropic API key (recommended)">
    존재하는 경우 `ANTHROPIC_API_KEY`를 사용하거나 키를 묻는 메시지를 표시한 다음 데몬 사용을 위해 저장합니다.
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: 키체인 항목 "Claude Code-credentials"를 확인합니다.
    - Linux 및 Windows: 존재하는 경우 `~/.claude/.credentials.json` 재사용

    macOS에서는 "항상 허용"을 선택하여 launchd 시작이 차단되지 않도록 하세요.

  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    아무 머신에서나 `claude setup-token`를 실행한 다음 토큰을 붙여넣습니다.
    이름을 지정할 수 있습니다. 공백은 기본값을 사용합니다.
  </Accordion>
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">
    `~/.codex/auth.json`이 존재하는 경우 마법사는 이를 재사용할 수 있습니다.
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    브라우저 흐름; `code#state`를 붙여넣습니다.

    모델이 설정 해제되거나 `openai/*`인 경우 `agents.defaults.model`를 `openai-codex/gpt-5.3-codex`로 설정합니다.

  </Accordion>
  <Accordion title="OpenAI API key">
    존재하는 경우 `OPENAI_API_KEY`를 사용하거나 키를 묻는 메시지를 표시한 후 다음 위치에 저장합니다.
    `~/.openclaw/.env` launchd가 읽을 수 있도록 합니다.

    모델이 설정 해제된 경우 `agents.defaults.model`를 `openai/gpt-5.1-codex`로 설정하거나, `openai/*` 또는 `openai-codex/*`로 설정합니다.

  </Accordion>
  <Accordion title="xAI (Grok) API key">
    `XAI_API_KEY`에 대한 프롬프트를 표시하고 xAI를 모델 공급자로 구성합니다.
  </Accordion>
  <Accordion title="OpenCode Zen">
    `OPENCODE_API_KEY`(또는 `OPENCODE_ZEN_API_KEY`)에 대한 프롬프트입니다.
    설정 URL: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="API key (generic)">
    당신을 위해 키를 저장합니다.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    `AI_GATEWAY_API_KEY`에 대한 프롬프트입니다.
    자세한 내용: [Vercel AI 게이트웨이](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    계정 ID, 게이트웨이 ID 및 `CLOUDFLARE_AI_GATEWAY_API_KEY`를 묻는 메시지가 나타납니다.
    자세한 내용: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    구성이 자동으로 작성됩니다.
    자세한 내용: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    `SYNTHETIC_API_KEY`에 대한 프롬프트입니다.
    자세한 내용: [합성](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot and Kimi Coding">
    Moonshot(Kimi K2) 및 Kimi Coding 구성은 자동으로 작성됩니다.
    자세한 내용: [Moonshot AI(Kimi + Kimi 코딩)](/providers/moonshot).
  </Accordion>
  <Accordion title="Custom provider">
    OpenAI 호환 및 Anthropic 호환 엔드포인트와 함께 작동합니다.

    비대화형 플래그:
    - `--auth-choice custom-api-key`
    - `--custom-base-url`
    - `--custom-model-id`
    - `--custom-api-key` (선택 사항; `CUSTOM_API_KEY`로 대체)
    - `--custom-provider-id` (선택 사항)
    - `--custom-compatibility <openai|anthropic>` (선택 사항, 기본값 `openai`)

  </Accordion>
  <Accordion title="Skip">
    인증을 구성하지 않은 상태로 둡니다.
  </Accordion>
</AccordionGroup>

모델 행동:

- 검색된 옵션에서 기본 모델을 선택하거나 공급자와 모델을 수동으로 입력합니다.
- 마법사는 모델 검사를 실행하고 구성된 모델이 알 수 없거나 인증이 누락된 경우 경고합니다.

자격 증명 및 프로필 경로:

- OAuth 자격 증명: `~/.openclaw/credentials/oauth.json`
- 인증 프로필(API 키 + OAuth): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
헤드리스 및 서버 팁: 브라우저가 있는 머신에서 OAuth를 완료한 후 복사합니다.
`~/.openclaw/credentials/oauth.json` (또는 `$OPENCLAW_STATE_DIR/credentials/oauth.json`)
게이트웨이 호스트에.
</Note>

## 출력 및 내부

`~/.openclaw/openclaw.json`의 일반적인 필드:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (Minimax를 선택한 경우)
- `gateway.*` (모드, 바인딩, 인증, tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- 메시지가 표시되는 동안 선택할 때 채널 허용 목록(Slack, Discord, Matrix, Microsoft Teams)(가능한 경우 이름이 ID로 확인됨)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add`는 `agents.list[]`와 선택적으로 `bindings`를 씁니다.

WhatsApp 자격 증명은 `~/.openclaw/credentials/whatsapp/<accountId>/` 아래에 있습니다.
세션은 `~/.openclaw/agents/<agentId>/sessions/`에 저장됩니다.

<Note>
일부 채널은 플러그인으로 제공됩니다. 온보딩 중에 선택하면 마법사가
채널을 구성하기 전에 플러그인(npm 또는 로컬 경로)을 설치하라는 메시지가 표시됩니다.
</Note>

게이트웨이 마법사 RPC:

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

클라이언트(macOS 앱 및 Control UI)는 온보딩 논리를 다시 구현하지 않고도 단계를 렌더링할 수 있습니다.

신호 설정 동작:

- 적절한 릴리스 자산을 다운로드합니다.
- `~/.openclaw/tools/signal-cli/<version>/`에 저장합니다.
- 구성에 `channels.signal.cliPath`를 씁니다.
- JVM 빌드에는 Java 21이 필요합니다.
- 가능한 경우 기본 빌드가 사용됩니다.
- Windows는 WSL2를 사용하고 WSL 내부의 Linux signal-cli 흐름을 따릅니다.

## 관련 문서

- 온보딩 허브: [온보딩 마법사(CLI)](/start/wizard)
- 자동화 및 스크립트: [CLI 자동화](/start/wizard-cli-automation)
- 명령 참조: [`openclaw onboard`](/cli/onboard)
