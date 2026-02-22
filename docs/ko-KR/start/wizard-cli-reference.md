---
summary: "CLI 온보딩 흐름, 인증/모델 설정, 출력 및 내부 작동에 대한 완전한 참고 자료"
read_when:
  - OpenClaw 온보드에 대한 자세한 동작이 필요할 때
  - 온보딩 결과를 디버깅하거나 온보딩 클라이언트를 통합할 때
title: "CLI 온보딩 참고 자료"
sidebarTitle: "CLI 참고 자료"
---

# CLI 온보딩 참고 자료

이 페이지는 `openclaw onboard`에 대한 전체 참고 자료입니다.
간단한 가이드는 [온보딩 마법사 (CLI)](/ko-KR/start/wizard)를 참조하세요.

## 마법사가 하는 일

로컬 모드 (기본값)는 다음을 안내합니다:

- 모델 및 인증 설정 (OpenAI Code 구독 OAuth, Anthropic API 키 또는 설정 토큰, MiniMax, GLM, Moonshot, AI Gateway 옵션 포함)
- 작업 공간 위치와 부트스트랩 파일
- 게이트웨이 설정 (포트, 바인드, 인증, Tailscale)
- 채널 및 프로바이더 (Telegram, WhatsApp, Discord, Google Chat, Mattermost 플러그인, Signal)
- 데몬 설치 (LaunchAgent 또는 systemd 사용자 유닛)
- 정상 작동 검사
- 스킬 설정

원격 모드는 이 머신을 다른 곳의 게이트웨이에 연결하도록 구성합니다.
원격 호스트에 어떠한 설치나 수정도 하지 않습니다.

## 로컬 흐름 세부 사항

<Steps>
  <Step title="기존 설정 감지">
    - `~/.openclaw/openclaw.json`이 존재하면, 유지, 수정 또는 초기화를 선택합니다.
    - 마법사를 다시 실행해도 초기화를 명시적으로 선택하지 않는 한 아무 것도 삭제되지 않습니다 (또는 `--reset` 옵션 전달).
    - 설정이 잘못되었거나 레거시 키가 포함되어 있으면, 마법사는 중지되고 계속하기 전에 `openclaw doctor`를 실행하도록 요청합니다.
    - 초기화는 `trash`를 사용하며 다음 범위를 제안합니다:
      - 설정만
      - 설정 + 자격 증명 + 세션
      - 전체 초기화 (작업 공간도 제거)
  </Step>
  <Step title="모델 및 인증">
    - 전체 옵션 매트릭스는 [인증 및 모델 옵션](#auth-and-model-options)에 있습니다.
  </Step>
  <Step title="작업 공간">
    - 기본 `~/.openclaw/workspace` (구성 가능).
    - 첫 실행 부트스트랩 의식에 필요한 작업 공간 파일을 시드합니다.
    - 작업 공간 레이아웃: [에이전트 작업 공간](/ko-KR/concepts/agent-workspace).
  </Step>
  <Step title="게이트웨이">
    - 포트, 바인드, 인증 모드 및 Tailscale 노출을 묻습니다.
    - 권장 사항: 로컬 WS 클라이언트가 인증해야 하므로 로컬 루프백에서도 토큰 인증을 활성화 상태로 유지하세요.
    - 모든 로컬 프로세스를 완전히 신뢰하는 경우에만 인증을 비활성화합니다.
    - 비 루프백 바인드는 여전히 인증이 필요합니다.
  </Step>
  <Step title="채널">
    - [WhatsApp](/ko-KR/channels/whatsapp): 선택적 QR 로그인
    - [Telegram](/ko-KR/channels/telegram): 봇 토큰
    - [Discord](/ko-KR/channels/discord): 봇 토큰
    - [Google Chat](/ko-KR/channels/googlechat): 서비스 계정 JSON + 웹훅 대상
    - [Mattermost](/ko-KR/channels/mattermost) 플러그인: 봇 토큰 + 기본 URL
    - [Signal](/ko-KR/channels/signal): 선택적 `signal-cli` 설치 + 계정 설정
    - [BlueBubbles](/ko-KR/channels/bluebubbles): iMessage에 권장; 서버 URL + 비밀번호 + 웹훅
    - [iMessage](/ko-KR/channels/imessage): 레거시 `imsg` CLI 경로 + DB 접근
    - 다이렉트 메시지 보안: 기본 설정은 페어링입니다. 첫 번째 다이렉트 메시지는 코드를 보내고, `openclaw pairing approve <channel> <code>`로 승인하거나 허용 목록을 사용합니다.
  </Step>
  <Step title="데몬 설치">
    - macOS: LaunchAgent
      - 로그인한 사용자 세션 필요; 헤드리스의 경우 사용자 정의 LaunchDaemon 사용 (제공되지 않음).
    - Linux 및 Windows via WSL2: systemd 사용자 유닛
      - 마법사는 게이트웨이가 로그아웃 후에도 유지되도록 `loginctl enable-linger <user>`를 시도합니다.
      - sudo를 요청할 수 있습니다 (writes `/var/lib/systemd/linger`); 먼저 sudo 없이 시도합니다.
    - 런타임 선택: Node (권장; WhatsApp 및 Telegram에 필요). Bun은 권장되지 않습니다.
  </Step>
  <Step title="정상 작동 검사">
    - 게이트웨이를 시작하고 (필요한 경우) `openclaw health`를 실행합니다.
    - `openclaw status --deep`은 상태 출력에 게이트웨이 건강 프로브를 추가합니다.
  </Step>
  <Step title="스킬">
    - 이용 가능한 스킬을 읽고 요구 사항을 확인합니다.
    - 노드 관리자 선택을 허용: npm 또는 pnpm (bun은 권장되지 않음).
    - 선택적 종속성 설치 (macOS에서는 일부 Homebrew 사용).
  </Step>
  <Step title="종료">
    - 요약 및 다음 단계, iOS, Android, macOS 앱 옵션 포함.
  </Step>
</Steps>

<Note>
GUI가 감지되지 않으면, 마법사는 SSH 포트 포워딩 지침을 Control UI에 출력하고 브라우저를 열지 않습니다.
Control UI 자산이 없으면, 마법사는 이를 빌드하려고 시도합니다; 대안은 `pnpm ui:build` (UI deps 자동 설치)입니다.
</Note>

## 원격 모드 세부 사항

원격 모드는 이 머신을 다른 곳의 게이트웨이에 연결하도록 구성합니다.

<Info>
원격 모드는 원격 호스트에 어떠한 설치나 수정도 하지 않습니다.
</Info>

설정 항목:

- 원격 게이트웨이 URL (`ws://...`)
- 원격 게이트웨이 인증이 필요한 경우 토큰 (권장)

<Note>
- 게이트웨이가 루프백 전용인 경우 SSH 터널링 또는 테일넷을 사용하세요.
- 디바이스 검색 힌트:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## 인증 및 모델 옵션

<AccordionGroup>
  <Accordion title="Anthropic API 키 (권장)">
    `ANTHROPIC_API_KEY`가 있으면 사용하거나 키를 요청한 후 데몬 사용을 위해 저장합니다.
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: "Claude Code-credentials" 키체인 항목 확인
    - Linux 및 Windows: `~/.claude/.credentials.json`이 존재하면 재사용

    macOS에서는 launchd 시작이 차단되지 않도록 "Always Allow"를 선택하세요.

  </Accordion>
  <Accordion title="Anthropic 토큰 (setup-token 붙여넣기)">
    `claude setup-token`을 어떤 머신에서든 실행한 다음 토큰을 붙여넣습니다.
    이름을 지정할 수 있습니다; 비어있으면 기본값을 사용합니다.
  </Accordion>
  <Accordion title="OpenAI Code 구독 (Codex CLI 재사용)">
    `~/.codex/auth.json`이 존재하면 마법사는 이를 재사용할 수 있습니다.
  </Accordion>
  <Accordion title="OpenAI Code 구독 (OAuth)">
    브라우저 흐름; `code#state` 붙여넣기.

    모델이 설정되지 않았거나 `openai/*`인 경우, `agents.defaults.model`을 `openai-codex/gpt-5.3-codex`로 설정합니다.

  </Accordion>
  <Accordion title="OpenAI API 키">
    `OPENAI_API_KEY`가 있으면 사용하거나 키를 요청한 후 저장하여 `~/.openclaw/.env`에서 launchd가 읽을 수 있도록 합니다.

    모델이 설정되지 않았거나 `openai/*`, `openai-codex/*`인 경우, `agents.defaults.model`을 `openai/gpt-5.1-codex`로 설정합니다.

  </Accordion>
  <Accordion title="xAI (Grok) API 키">
    `XAI_API_KEY`를 받아 모델 프로바이더로 xAI를 구성합니다.
  </Accordion>
  <Accordion title="OpenCode Zen">
    `OPENCODE_API_KEY` (또는 `OPENCODE_ZEN_API_KEY`)를 요청합니다.
    설정 URL: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="일반 API 키">
    키를 저장합니다.
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    `AI_GATEWAY_API_KEY`를 요청합니다.
    자세한 내용: [Vercel AI Gateway](/ko-KR/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    계정 ID, 게이트웨이 ID, `CLOUDFLARE_AI_GATEWAY_API_KEY`를 요청합니다.
    자세한 내용: [Cloudflare AI Gateway](/ko-KR/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    구성이 자동으로 작성됩니다.
    자세한 내용: [MiniMax](/ko-KR/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    `SYNTHETIC_API_KEY`를 요청합니다.
    자세한 내용: [Synthetic](/ko-KR/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot 및 Kimi Coding">
    Moonshot (Kimi K2) 및 Kimi Coding 구성은 자동으로 작성됩니다.
    자세한 내용: [Moonshot AI (Kimi + Kimi Coding)](/ko-KR/providers/moonshot).
  </Accordion>
  <Accordion title="Custom provider">
    OpenAI 호환 및 Anthropic 호환 엔드포인트와 작동합니다.

    비대화식 플래그:
    - `--auth-choice custom-api-key`
    - `--custom-base-url`
    - `--custom-model-id`
    - `--custom-api-key` (선택 사항; `CUSTOM_API_KEY`로 대체 가능)
    - `--custom-provider-id` (선택 사항)
    - `--custom-compatibility <openai|anthropic>` (선택 사항; 기본값 `openai`)

  </Accordion>
  <Accordion title="건너뛰기">
    인증을 구성하지 않음.
  </Accordion>
</AccordionGroup>

모델 동작:

- 감지된 옵션 중 기본 모델을 선택하거나 프로바이더와 모델을 수동으로 입력합니다.
- 마법사는 모델 검사를 실행하고 구성된 모델이 알려지지 않았거나 인증이 누락된 경우 경고합니다.

자격 증명 및 프로필 경로:

- OAuth 자격 증명: `~/.openclaw/credentials/oauth.json`
- 인증 프로필 (API 키 + OAuth): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
헤드리스 및 서버 팁: 브라우저가 있는 머신에서 OAuth를 완료한 다음
`~/.openclaw/credentials/oauth.json` (또는 `$OPENCLAW_STATE_DIR/credentials/oauth.json`)을
게이트웨이 호스트로 복사하세요.
</Note>

## 출력 및 내부

`~/.openclaw/openclaw.json`의 일반 필드:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (MiniMax 선택 시)
- `gateway.*` (모드, 바인드, 인증, Tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- 채널 허용 목록 (Slack, Discord, Matrix, Microsoft Teams) 시 프롬프트 중에 옵트인하면 (이름이 가능하면 ID로 변환)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add`는 `agents.list[]` 및 선택적 `bindings`를 작성합니다.

WhatsApp 자격 증명은 `~/.openclaw/credentials/whatsapp/<accountId>/`에 저장됩니다.
세션은 `~/.openclaw/agents/<agentId>/sessions/`에 저장됩니다.

<Note>
일부 채널은 플러그인으로 제공됩니다. 온보딩 중에 선택하면, 마법사는 채널 설정 전에 플러그인 설치 (npm 또는 로컬 경로)를 요청합니다.
</Note>

게이트웨이 마법사 RPC:

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

클라이언트 (macOS 앱 및 Control UI)는 온보딩 로직을 재구현하지 않고도 단계를 렌더링할 수 있습니다.

Signal 설정 동작:

- 적절한 release asset 다운로드
- `~/.openclaw/tools/signal-cli/<version>/`에 저장
- 설정에서 `channels.signal.cliPath` 작성
- JVM 빌드는 Java 21 필요
- 사용 가능한 경우 네이티브 빌드 사용
- Windows는 WSL2를 사용하며 WSL 내 Linux signal-cli 흐름을 따릅니다

## 관련 문서

- 온보딩 허브: [온보딩 마법사 (CLI)](/ko-KR/start/wizard)
- 자동화 및 스크립트: [CLI 자동화](/ko-KR/start/wizard-cli-automation)
- 명령어 참고 자료: [`openclaw onboard`](/ko-KR/cli/onboard)
