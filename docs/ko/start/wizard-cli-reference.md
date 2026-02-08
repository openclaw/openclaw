---
read_when:
    - 온보드 오픈클로에 대한 자세한 동작이 필요합니다.
    - 온보딩 결과를 디버깅하거나 온보딩 클라이언트를 통합하는 중입니다.
sidebarTitle: CLI reference
summary: CLI 온보딩 흐름, 인증/모델 설정, 출력 및 내부에 대한 전체 참조 자료
title: CLI 온보딩 참조
x-i18n:
    generated_at: "2026-02-08T16:09:21Z"
    model: gtx
    provider: google-translate
    source_hash: 20bb32d6fd95234539f93c5724e737e9eaba3981a8cf5071613c0a98f6d549d2
    source_path: start/wizard-cli-reference.md
    workflow: 15
---

# CLI 온보딩 참조

이 페이지는 다음에 대한 전체 참조입니다. `openclaw onboard`.
짧은 가이드는 다음을 참조하세요. [온보딩 마법사(CLI)](/start/wizard).

## 마법사가 하는 일

로컬 모드(기본값)는 다음 과정을 안내합니다.

- 모델 및 인증 설정(OpenAI 코드 구독 OAuth, Anthropic API 키 또는 설정 토큰, MiniMax, GLM, Moonshot 및 AI Gateway 옵션)
- 작업공간 위치 및 부트스트랩 파일
- 게이트웨이 설정(포트, 바인딩, 인증, tailscale)
- 채널 및 제공업체(Telegram, WhatsApp, Discord, Google Chat, Mattermost 플러그인, Signal)
- 데몬 설치(LaunchAgent 또는 systemd 사용자 장치)
- 건강검진
- 스킬 설정

원격 모드는 이 시스템이 다른 곳의 게이트웨이에 연결되도록 구성합니다.
원격 호스트에 아무것도 설치하거나 수정하지 않습니다.

## 로컬 흐름 세부정보

<Steps>
  <Step title="Existing config detection">
    - `~/.openclaw/openclaw.json`이 존재하는 경우 유지, 수정 또는 재설정을 선택합니다.
    - 명시적으로 재설정을 선택하거나 `--reset`을 전달하지 않는 한 마법사를 다시 실행해도 아무것도 지워지지 않습니다.
    - 구성이 유효하지 않거나 레거시 키를 포함하는 경우 마법사가 중지되고 계속하기 전에 `openclaw doctor`을 실행하라는 메시지가 표시됩니다.
    - 재설정은 `trash`을 사용하고 다음 범위를 제공합니다.
      - 구성만 가능
      - 구성 + 자격 증명 + 세션
      - 전체 재설정(작업 공간도 제거됨)
  </Step>
  <Step title="Model and auth">
    - 전체 옵션 매트릭스는 [인증 및 모델 옵션](#auth-and-model-options)에 있습니다.
  </Step>
  <Step title="Workspace">
    - 기본값 `~/.openclaw/workspace`(구성 가능).
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
    - [텔레그램](/channels/telegram) : 봇 토큰
    - [Discord](/channels/discord): 봇 토큰
    - [Google Chat](/channels/googlechat): 서비스 계정 JSON + 웹훅 대상
    - [Mattermost](/channels/mattermost) 플러그인: 봇 토큰 + 기본 URL
    - [시그널](/channels/signal): 선택사항 `signal-cli` 설치 + 계정 구성
    - [BlueBubbles](/channels/bluebubbles): iMessage에 권장됩니다. 서버 URL + 비밀번호 + 웹훅
    - [iMessage](/channels/imessage): 레거시 `imsg` CLI 경로 + DB 액세스
    - DM 보안: 기본값은 페어링입니다. 첫 번째 DM은 코드를 보냅니다.
      `openclaw pairing approve <channel> <code>`로 승인하거나 allowlist를 사용하세요.
  </Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - Requires logged-in user session; for headless, use a custom LaunchDaemon (not shipped).
    - Linux and Windows via WSL2: systemd user unit
      - Wizard attempts `loginctl enable-linger <user>` so gateway stays up after logout.
      - May prompt for sudo (writes `/var/lib/systemd/linger`); it tries without sudo first.
    - Runtime selection: Node (recommended; required for WhatsApp and Telegram). Bun is not recommended.
  </Step>
  <Step title="Health check">
    - Starts gateway (if needed) and runs `openclaw health`.
    - `openclaw status --deep` adds gateway health probes to status output.
  </Step>
  <Step title="Skills">
    - Reads available skills and checks requirements.
    - Lets you choose node manager: npm or pnpm (bun not recommended).
    - Installs optional dependencies (some use Homebrew on macOS).
  </Step>
  <Step title="Finish">
    - Summary and next steps, including iOS, Android, and macOS app options.
  </Step>
</Steps>

<Note>
GUI가 감지되지 않으면 마법사는 브라우저를 여는 대신 제어 UI에 대한 SSH 포트 전달 지침을 인쇄합니다.
Control UI 자산이 누락된 경우 마법사는 해당 자산을 빌드하려고 시도합니다. 대체는 `pnpm ui:build`입니다(UI deps 자동 설치).
</Note>

## 원격 모드 세부정보

원격 모드는 이 시스템이 다른 곳의 게이트웨이에 연결되도록 구성합니다.

<Info>
원격 모드는 원격 호스트에 아무것도 설치하거나 수정하지 않습니다.
</Info>

설정한 내용:

- 원격 게이트웨이 URL(`ws://...`)
- 원격 게이트웨이 인증이 필요한 경우 토큰(권장)

<Note>
- 게이트웨이가 루프백 전용인 경우 SSH 터널링 또는 tailnet을 사용하십시오.
- 발견 힌트:
  - macOS: 봉쥬르(`dns-sd`)
  - 리눅스: 아바히(`avahi-browse`)
</Note>

## 인증 및 모델 옵션

<AccordionGroup>
  <Accordion title="Anthropic API key (recommended)">
    `ANTHROPIC_API_KEY`(있는 경우)을 사용하거나 키를 묻는 메시지를 표시한 다음 데몬 사용을 위해 저장합니다.
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: 키체인 항목 "Claude Code-credentials"를 확인합니다.
    - Linux 및 Windows: 있는 경우 `~/.claude/.credentials.json` 재사용

    On macOS, choose "Always Allow" so launchd starts do not block.

  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    아무 머신에서나 `claude setup-token`을 실행한 다음 토큰을 붙여넣습니다.
    이름을 지정할 수 있습니다. 공백은 기본값을 사용합니다.
  </Accordion>
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">
    `~/.codex/auth.json`이 있으면 마법사가 이를 재사용할 수 있습니다.
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    브라우저 흐름; `code#state`을 붙여넣습니다.

    Sets `agents.defaults.model` to `openai-codex/gpt-5.3-codex` when model is unset or `openai/*`.

  </Accordion>
  <Accordion title="OpenAI API key">
    `OPENAI_API_KEY`(있는 경우)을 사용하거나 키를 묻는 메시지를 표시한 다음 키를 다음 위치에 저장합니다.
    `~/.openclaw/.env` 그래서 launchd가 그것을 읽을 수 있습니다.

    Sets `agents.defaults.model` to `openai/gpt-5.1-codex` when model is unset, `openai/*`, or `openai-codex/*`.

  </Accordion>
  <Accordion title="xAI (Grok) API key">
    `XAI_API_KEY`에 대한 메시지를 표시하고 xAI를 모델 공급자로 구성합니다.
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
    계정 ID, 게이트웨이 ID 및 `CLOUDFLARE_AI_GATEWAY_API_KEY`을 묻는 메시지가 표시됩니다.
    자세한 내용: [Cloudflare AI 게이트웨이](/providers/cloudflare-ai-gateway).
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
    자세한 내용: [Moonshot AI(키미 + 키미 코딩)](/providers/moonshot).
  </Accordion>
  <Accordion title="Skip">
    인증을 구성하지 않은 상태로 둡니다.
  </Accordion>
</AccordionGroup>

모델 행동:

- 검색된 옵션에서 기본 모델을 선택하거나 공급자와 모델을 수동으로 입력하세요.
- 마법사는 모델 검사를 실행하고 구성된 모델이 알 수 없거나 인증이 누락된 경우 경고합니다.

자격 증명 및 프로필 경로:

- OAuth 자격 증명: `~/.openclaw/credentials/oauth.json`
- 인증 프로필(API 키 + OAuth): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
헤드리스 및 서버 팁: 브라우저가 있는 머신에서 OAuth를 완료한 후 복사합니다.
`~/.openclaw/credentials/oauth.json`(또는 `$OPENCLAW_STATE_DIR/credentials/oauth.json`)
게이트웨이 호스트에.
</Note>

## 출력 및 내부

일반적인 필드 `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (Minimax를 선택한 경우)
- `gateway.*` (모드, 바인딩, 인증, tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- 프롬프트 중에 옵트인할 때 채널 허용 목록(Slack, Discord, Matrix, Microsoft Teams)(가능한 경우 이름이 ID로 확인됨)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` 쓴다 `agents.list[]` 그리고 선택사항 `bindings`.

WhatsApp 자격 증명은 아래에 있습니다. `~/.openclaw/credentials/whatsapp/<accountId>/`.
세션은 다음 위치에 저장됩니다. `~/.openclaw/agents/<agentId>/sessions/`.

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
- 아래에 저장합니다. `~/.openclaw/tools/signal-cli/<version>/`
- 쓰기 `channels.signal.cliPath` 구성에서
- JVM 빌드에는 Java 21이 필요합니다.
- 가능한 경우 기본 빌드가 사용됩니다.
- Windows는 WSL2를 사용하고 WSL 내에서 Linux signal-cli 흐름을 따릅니다.

## 관련 문서

- 온보딩 허브: [온보딩 마법사(CLI)](/start/wizard)
- 자동화 및 스크립트: [CLI 자동화](/start/wizard-cli-automation)
- 명령 참조: [`openclaw onboard`](/cli/onboard)
