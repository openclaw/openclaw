---
title: "CLI 설정 참조"
summary: "CLI 설정 흐름, 인증/모델 설정, 출력, 내부 구조의 완전한 참조"
sidebarTitle: "CLI 참조"
read_when:
  - openclaw onboard 의 상세 동작이 필요할 때
  - 온보딩 결과를 디버깅하거나 온보딩 클라이언트를 통합할 때
x-i18n:
  source_path: docs/start/wizard-cli-reference.md
---

# CLI 설정 참조

이 페이지는 `openclaw onboard` 의 전체 참조입니다.
간단한 가이드는 [온보딩 (CLI)](/start/wizard)를 참조하세요.

## 마법사가 하는 일

로컬 모드(기본값)는 다음을 안내합니다:

- 모델 및 인증 설정 (OpenAI Code 구독 OAuth, Anthropic API 키 또는 setup 토큰, MiniMax, GLM, Ollama, Moonshot, AI Gateway 옵션 포함)
- 워크스페이스 위치 및 부트스트랩 파일
- Gateway 설정 (포트, 바인드, 인증, Tailscale)
- 채널 및 프로바이더 (Telegram, WhatsApp, Discord, Google Chat, Mattermost 플러그인, Signal)
- 데몬 설치 (LaunchAgent 또는 systemd 사용자 유닛)
- 상태 점검
- Skills 설정

원격 모드는 이 머신을 다른 곳의 Gateway 에 연결하도록 구성합니다.
원격 호스트에는 아무것도 설치하거나 수정하지 않습니다.

## 로컬 흐름 상세

<Steps>
  <Step title="기존 설정 감지">
    - `~/.openclaw/openclaw.json` 이 존재하면, 유지, 수정 또는 초기화를 선택합니다.
    - 마법사를 다시 실행해도 명시적으로 초기화를 선택하거나 (`--reset` 을 전달하지 않는 한) 아무것도 지워지지 않습니다.
    - CLI `--reset` 은 기본적으로 `config+creds+sessions` 를 대상으로 합니다; 워크스페이스를 포함하려면 `--reset-scope full` 을 사용하세요.
    - 설정이 유효하지 않거나 레거시 키를 포함하는 경우, 마법사가 중단되고 계속하기 전에 `openclaw doctor` 를 실행하도록 요청합니다.
    - 초기화는 `trash` 를 사용하며 범위를 제공합니다:
      - 설정만
      - 설정 + 자격 증명 + 세션
      - 전체 초기화 (워크스페이스도 제거)
  </Step>
  <Step title="모델 및 인증">
    - 전체 옵션 매트릭스는 [인증 및 모델 옵션](#auth-and-model-options)에 있습니다.
  </Step>
  <Step title="워크스페이스">
    - 기본값 `~/.openclaw/workspace` (구성 가능).
    - 최초 실행 부트스트랩 의식에 필요한 워크스페이스 파일을 시드합니다.
    - 워크스페이스 레이아웃: [에이전트 워크스페이스](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - 포트, 바인드, 인증 모드, Tailscale 노출을 입력하도록 안내합니다.
    - 권장: 로컬 WS 클라이언트가 인증해야 하도록 루프백에서도 토큰 인증을 활성화된 상태로 유지하세요.
    - 토큰 모드에서 대화형 설정은 다음을 제공합니다:
      - **평문 토큰 생성/저장** (기본값)
      - **SecretRef 사용** (옵트인)
    - 비밀번호 모드에서 대화형 설정도 평문 또는 SecretRef 저장을 지원합니다.
    - 비대화형 토큰 SecretRef 경로: `--gateway-token-ref-env <ENV_VAR>`.
      - 온보딩 프로세스 환경에 비어 있지 않은 환경 변수가 필요합니다.
      - `--gateway-token` 과 결합할 수 없습니다.
    - 모든 로컬 프로세스를 완전히 신뢰하는 경우에만 인증을 비활성화하세요.
    - 비루프백 바인드에는 여전히 인증이 필요합니다.
  </Step>
  <Step title="채널">
    - [WhatsApp](/channels/whatsapp): 선택적 QR 로그인
    - [Telegram](/channels/telegram): 봇 토큰
    - [Discord](/channels/discord): 봇 토큰
    - [Google Chat](/channels/googlechat): 서비스 계정 JSON + 웹훅 대상
    - [Mattermost](/channels/mattermost) 플러그인: 봇 토큰 + 기본 URL
    - [Signal](/channels/signal): 선택적 `signal-cli` 설치 + 계정 설정
    - [BlueBubbles](/channels/bluebubbles): iMessage 에 권장; 서버 URL + 비밀번호 + 웹훅
    - [iMessage](/channels/imessage): 레거시 `imsg` CLI 경로 + DB 접근
    - DM 보안: 기본값은 페어링입니다. 첫 DM 이 코드를 전송합니다;
      `openclaw pairing approve <channel> <code>` 로 승인하거나 허용 목록을 사용하세요.
  </Step>
  <Step title="데몬 설치">
    - macOS: LaunchAgent
      - 로그인한 사용자 세션이 필요합니다; 헤드리스의 경우 사용자 정의 LaunchDaemon 을 사용하세요(제공되지 않음).
    - Linux 및 WSL2 를 통한 Windows: systemd 사용자 유닛
      - 마법사가 `loginctl enable-linger <user>` 를 시도하여 로그아웃 후에도 Gateway 가 유지됩니다.
      - sudo 를 요청할 수 있습니다(`/var/lib/systemd/linger` 기록); sudo 없이 먼저 시도합니다.
    - 런타임 선택: Node (권장; WhatsApp 및 Telegram 에 필수). Bun 은 권장되지 않습니다.
  </Step>
  <Step title="상태 점검">
    - Gateway 를 시작하고(필요한 경우) `openclaw health` 를 실행합니다.
    - `openclaw status --deep` 은 상태 출력에 Gateway 상태 프로브를 추가합니다.
  </Step>
  <Step title="Skills">
    - 사용 가능한 Skills 를 읽고 요구 사항을 확인합니다.
    - 노드 매니저를 선택합니다: npm 또는 pnpm (bun 은 권장되지 않음).
    - 선택적 종속성을 설치합니다(일부는 macOS 에서 Homebrew 사용).
  </Step>
  <Step title="완료">
    - 요약 및 다음 단계, iOS, Android, macOS 앱 옵션 포함.
  </Step>
</Steps>

<Note>
GUI 가 감지되지 않으면, 마법사는 브라우저를 여는 대신 Control UI 를 위한 SSH 포트 포워드 안내를 출력합니다.
Control UI 에셋이 없으면 마법사가 빌드를 시도합니다; 폴백은 `pnpm ui:build` 입니다(UI 종속성 자동 설치).
</Note>

## 원격 모드 상세

원격 모드는 이 머신을 다른 곳의 Gateway 에 연결하도록 구성합니다.

<Info>
원격 모드는 원격 호스트에 아무것도 설치하거나 수정하지 않습니다.
</Info>

설정하는 것:

- 원격 Gateway URL (`ws://...`)
- 원격 Gateway 인증이 필요한 경우 토큰 (권장)

<Note>
- Gateway 가 루프백 전용인 경우 SSH 터널링 또는 tailnet 을 사용하세요.
- 디스커버리 힌트:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## 인증 및 모델 옵션

<AccordionGroup>
  <Accordion title="Anthropic API 키">
    `ANTHROPIC_API_KEY` 가 있으면 사용하거나 키를 입력하도록 안내한 후, 데몬 사용을 위해 저장합니다.
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: Keychain 항목 "Claude Code-credentials" 확인
    - Linux 및 Windows: `~/.claude/.credentials.json` 이 있으면 재사용

    macOS 에서는 launchd 시작이 차단되지 않도록 "Always Allow" 를 선택하세요.

  </Accordion>
  <Accordion title="Anthropic 토큰 (setup-token 붙여넣기)">
    아무 머신에서 `claude setup-token` 을 실행한 후, 토큰을 붙여넣습니다.
    이름을 지정할 수 있습니다; 비어 있으면 기본값을 사용합니다.
  </Accordion>
  <Accordion title="OpenAI Code 구독 (Codex CLI 재사용)">
    `~/.codex/auth.json` 이 존재하면 마법사가 재사용할 수 있습니다.
  </Accordion>
  <Accordion title="OpenAI Code 구독 (OAuth)">
    브라우저 흐름; `code#state` 를 붙여넣습니다.

    모델이 미설정이거나 `openai/*` 인 경우 `agents.defaults.model` 을 `openai-codex/gpt-5.4` 로 설정합니다.

  </Accordion>
  <Accordion title="OpenAI API 키">
    `OPENAI_API_KEY` 가 있으면 사용하거나 키를 입력하도록 안내한 후, 인증 프로필에 자격 증명을 저장합니다.

    모델이 미설정, `openai/*` 또는 `openai-codex/*` 인 경우 `agents.defaults.model` 을 `openai/gpt-5.4` 로 설정합니다.

  </Accordion>
  <Accordion title="xAI (Grok) API 키">
    `XAI_API_KEY` 를 입력하도록 안내하고 xAI 를 모델 프로바이더로 구성합니다.
  </Accordion>
  <Accordion title="OpenCode">
    `OPENCODE_API_KEY` (또는 `OPENCODE_ZEN_API_KEY`)를 입력하도록 안내하고 Zen 또는 Go 카탈로그를 선택합니다.
    설정 URL: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="API 키 (일반)">
    키를 저장합니다.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    `AI_GATEWAY_API_KEY` 를 입력하도록 안내합니다.
    자세한 내용: [Vercel AI Gateway](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    계정 ID, Gateway ID, `CLOUDFLARE_AI_GATEWAY_API_KEY` 를 입력하도록 안내합니다.
    자세한 내용: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax">
    설정이 자동으로 기록됩니다. 호스팅 기본값은 `MiniMax-M2.7` 이며; `MiniMax-M2.5` 도 사용 가능합니다.
    자세한 내용: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic 호환)">
    `SYNTHETIC_API_KEY` 를 입력하도록 안내합니다.
    자세한 내용: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Ollama (클라우드 및 로컬 오픈 모델)">
    기본 URL(기본값 `http://127.0.0.1:11434`)을 입력하도록 안내한 후, Cloud + Local 또는 Local 모드를 제공합니다.
    사용 가능한 모델을 검색하고 기본값을 제안합니다.
    자세한 내용: [Ollama](/providers/ollama).
  </Accordion>
  <Accordion title="Moonshot 및 Kimi Coding">
    Moonshot (Kimi K2) 및 Kimi Coding 설정이 자동으로 기록됩니다.
    자세한 내용: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
  </Accordion>
  <Accordion title="사용자 정의 프로바이더">
    OpenAI 호환 및 Anthropic 호환 엔드포인트에서 작동합니다.

    대화형 온보딩은 다른 프로바이더 API 키 흐름과 동일한 API 키 저장 선택을 지원합니다:
    - **API 키 지금 붙여넣기** (평문)
    - **시크릿 참조 사용** (환경 변수 참조 또는 구성된 프로바이더 참조, 사전 검증 포함)

    비대화형 플래그:
    - `--auth-choice custom-api-key`
    - `--custom-base-url`
    - `--custom-model-id`
    - `--custom-api-key` (선택 사항; `CUSTOM_API_KEY` 로 폴백)
    - `--custom-provider-id` (선택 사항)
    - `--custom-compatibility <openai|anthropic>` (선택 사항; 기본값 `openai`)

  </Accordion>
  <Accordion title="건너뛰기">
    인증을 미구성 상태로 둡니다.
  </Accordion>
</AccordionGroup>

모델 동작:

- 감지된 옵션에서 기본 모델을 선택하거나, 프로바이더와 모델을 수동으로 입력합니다.
- 마법사가 모델 점검을 실행하고 구성된 모델이 알 수 없거나 인증이 누락된 경우 경고합니다.

자격 증명 및 프로필 경로:

- OAuth 자격 증명: `~/.openclaw/credentials/oauth.json`
- 인증 프로필 (API 키 + OAuth): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

자격 증명 저장 모드:

- 기본 온보딩 동작은 API 키를 인증 프로필에 평문 값으로 유지합니다.
- `--secret-input-mode ref` 는 평문 키 저장 대신 참조 모드를 활성화합니다.
  대화형 설정에서는 다음 중 하나를 선택할 수 있습니다:
  - 환경 변수 참조 (예: `keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" }`)
  - 구성된 프로바이더 참조 (`file` 또는 `exec`) - 프로바이더 별칭 + id
- 대화형 참조 모드는 저장 전에 빠른 사전 검증을 실행합니다.
  - 환경 변수 참조: 현재 온보딩 환경에서 변수 이름 + 비어 있지 않은 값을 검증합니다.
  - 프로바이더 참조: 프로바이더 구성을 검증하고 요청된 id 를 해석합니다.
  - 사전 검증이 실패하면, 온보딩이 오류를 표시하고 재시도를 허용합니다.
- 비대화형 모드에서 `--secret-input-mode ref` 는 환경 변수 기반만 지원합니다.
  - 온보딩 프로세스 환경에 프로바이더 환경 변수를 설정하세요.
  - 인라인 키 플래그(예: `--openai-api-key`)는 해당 환경 변수가 설정되어 있어야 합니다; 그렇지 않으면 온보딩이 즉시 실패합니다.
  - 사용자 정의 프로바이더의 경우, 비대화형 `ref` 모드는 `models.providers.<id>.apiKey` 를 `{ source: "env", provider: "default", id: "CUSTOM_API_KEY" }` 로 저장합니다.
  - 해당 사용자 정의 프로바이더 케이스에서 `--custom-api-key` 는 `CUSTOM_API_KEY` 가 설정되어 있어야 합니다; 그렇지 않으면 온보딩이 즉시 실패합니다.
- Gateway 인증 자격 증명은 대화형 설정에서 평문 및 SecretRef 선택을 지원합니다:
  - 토큰 모드: **평문 토큰 생성/저장** (기본값) 또는 **SecretRef 사용**.
  - 비밀번호 모드: 평문 또는 SecretRef.
- 비대화형 토큰 SecretRef 경로: `--gateway-token-ref-env <ENV_VAR>`.
- 기존 평문 설정은 변경 없이 계속 작동합니다.

<Note>
헤드리스 및 서버 팁: 브라우저가 있는 머신에서 OAuth 를 완료한 후,
`~/.openclaw/credentials/oauth.json` (또는 `$OPENCLAW_STATE_DIR/credentials/oauth.json`)을
Gateway 호스트로 복사하세요.
</Note>

## 출력 및 내부 구조

`~/.openclaw/openclaw.json` 의 일반적인 필드:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (Minimax 선택 시)
- `tools.profile` (로컬 온보딩은 미설정 시 `"coding"` 으로 기본 설정; 기존 명시적 값은 유지)
- `gateway.*` (모드, 바인드, 인증, Tailscale)
- `session.dmScope` (로컬 온보딩은 미설정 시 `per-channel-peer` 로 기본 설정; 기존 명시적 값은 유지)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- 프롬프트 중 옵트인 시 채널 허용 목록 (Slack, Discord, Matrix, Microsoft Teams) (가능한 경우 이름이 ID 로 해석됨)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` 는 `agents.list[]` 와 선택적 `bindings` 를 기록합니다.

WhatsApp 자격 증명은 `~/.openclaw/credentials/whatsapp/<accountId>/` 에 저장됩니다.
세션은 `~/.openclaw/agents/<agentId>/sessions/` 에 저장됩니다.

<Note>
일부 채널은 플러그인으로 제공됩니다. 설정 중 선택하면, 마법사가 채널 구성 전에 플러그인 설치(npm 또는 로컬 경로)를 안내합니다.
</Note>

Gateway 마법사 RPC:

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

클라이언트(macOS 앱 및 Control UI)는 온보딩 로직을 재구현하지 않고 단계를 렌더링할 수 있습니다.

Signal 설정 동작:

- 적절한 릴리스 에셋을 다운로드합니다
- `~/.openclaw/tools/signal-cli/<version>/` 에 저장합니다
- 설정에 `channels.signal.cliPath` 를 기록합니다
- JVM 빌드에는 Java 21 이 필요합니다
- 네이티브 빌드는 가능한 경우 사용됩니다
- Windows 는 WSL2 를 사용하며 WSL 내에서 Linux signal-cli 흐름을 따릅니다

## 관련 문서

- 온보딩 허브: [온보딩 (CLI)](/start/wizard)
- 자동화 및 스크립트: [CLI 자동화](/start/wizard-cli-automation)
- 명령 참조: [`openclaw onboard`](/cli/onboard)
