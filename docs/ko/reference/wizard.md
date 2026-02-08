---
read_when:
    - 특정 마법사 단계 또는 플래그 조회
    - 비대화형 모드로 온보딩 자동화
    - 디버깅 마법사 동작
sidebarTitle: Wizard Reference
summary: 'CLI 온보딩 마법사에 대한 전체 참조: 모든 단계, 플래그 및 구성 필드'
title: 온보딩 마법사 참조
x-i18n:
    generated_at: "2026-02-08T16:08:02Z"
    model: gtx
    provider: google-translate
    source_hash: 05fac3786016d9065547127bcf1047f73fa92dd061b032ac887ddfd6893b1802
    source_path: reference/wizard.md
    workflow: 15
---

# 온보딩 마법사 참조

이는 전체 참조 자료입니다. `openclaw onboard` CLI 마법사.
대략적인 개요는 다음을 참조하세요. [온보딩 마법사](/start/wizard).

## 흐름 세부정보(로컬 모드)

<Steps>
  <Step title="Existing config detection">
    - `~/.openclaw/openclaw.json`이 존재하는 경우 **유지 / 수정 / 재설정**을 선택하세요.
    - 명시적으로 **재설정**을 선택하지 않는 한 마법사를 다시 실행해도 아무것도 초기화되지 **않습니다**
      (또는 `--reset`을 전달합니다).
    - 구성이 유효하지 않거나 레거시 키를 포함하는 경우 마법사가 중지되고 묻습니다.
      계속하기 전에 `openclaw doctor`을 실행하세요.
    - 재설정은 `trash`(절대 `rm` 아님)을 사용하고 범위를 제공합니다.
      - 구성만 가능
      - 구성 + 자격 증명 + 세션
      - 전체 재설정(작업 공간도 제거됨)
  </Step>
  <Step title="Model/Auth">
    - **인류 API 키(권장)**: 존재하는 경우 `ANTHROPIC_API_KEY`을 사용하거나 키를 묻는 메시지를 표시한 다음 데몬 사용을 위해 저장합니다.
    - **Anthropic OAuth(Claude Code CLI)**: macOS에서 마법사는 키체인 항목 "Claude Code-credentials"를 확인합니다(실행 시작이 차단되지 않도록 "항상 허용" 선택). Linux/Windows에서는 `~/.claude/.credentials.json`(있는 경우)을 재사용합니다.
    - **인류 토큰(설정 토큰 붙여넣기)**: 아무 머신에서나 `claude setup-token`을 실행한 다음 토큰을 붙여넣습니다(이름을 지정할 수 있습니다. 공백 = 기본값).
    - **OpenAI 코드(Codex) 구독(Codex CLI)**: `~/.codex/auth.json`이 존재하는 경우 마법사는 이를 재사용할 수 있습니다.
    - **OpenAI 코드(Codex) 구독(OAuth)**: 브라우저 흐름; `code#state`을 붙여넣습니다.
      - 모델이 설정 해제되거나 `openai/*`인 경우 `agents.defaults.model`을 `openai-codex/gpt-5.2`로 설정합니다.
    - **OpenAI API 키**: 존재하는 경우 `OPENAI_API_KEY`을 사용하거나 키를 묻는 메시지를 표시한 다음 launchd가 읽을 수 있도록 `~/.openclaw/.env`에 저장합니다.
    - **xAI(Grok) API 키**: `XAI_API_KEY`에 대한 메시지를 표시하고 xAI를 모델 공급자로 구성합니다.
    - **OpenCode Zen(다중 모델 프록시)**: `OPENCODE_API_KEY`(또는 `OPENCODE_ZEN_API_KEY`, https://opencode.ai/auth에서 가져오기)에 대한 프롬프트를 표시합니다.
    - **API 키**: 키를 저장합니다.
    - **Vercel AI Gateway(다중 모델 프록시)**: `AI_GATEWAY_API_KEY`에 대한 프롬프트를 표시합니다.
    - 자세한 내용 : [Vercel AI Gateway](/providers/vercel-ai-gateway)- **Cloudflare AI 게이트웨이**: 계정 ID, 게이트웨이 ID 및 `CLOUDFLARE_AI_GATEWAY_API_KEY`를 묻는 메시지를 표시합니다.
    - 자세한 내용: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: 구성이 자동으로 작성됩니다.
    - 상세정보: [미니맥스](/providers/minimax)
    - **합성(인류 호환)**: `SYNTHETIC_API_KEY`에 대한 프롬프트를 표시합니다.
    - 상세설명 : [합성](/providers/synthetic)
    - **문샷(키미K2)**: 설정이 자동으로 작성됩니다.
    - **키미 코딩**: 구성이 자동으로 작성됩니다.
    - 자세한 내용 : [문샷AI(키미+키미코딩)](/providers/moonshot)
    - **건너뛰기**: 아직 인증이 구성되지 않았습니다.
    - 검색된 옵션에서 기본 모델을 선택합니다(또는 공급자/모델을 수동으로 입력).
    - 마법사는 모델 검사를 실행하고 구성된 모델이 알 수 없거나 인증이 누락된 경우 경고합니다.
    - OAuth 자격 증명은 `~/.openclaw/credentials/oauth.json`에 있습니다. 인증 프로필은 `~/.openclaw/agents/에 있습니다.<agentId>/agent/auth-profiles.json`(API 키 + OAuth).
    - 자세한 내용: [/concepts/oauth](/concepts/oauth)
    <Note>
    헤드리스/서버 팁: 브라우저가 있는 머신에서 OAuth를 완료한 후 복사하세요.
    `~/.openclaw/credentials/oauth.json`(또는 `$OPENCLAW_STATE_DIR/credentials/oauth.json`)을
    게이트웨이 호스트.
    </Note>
  </Step>
  <Step title="Workspace">
    - 기본값 `~/.openclaw/workspace`(구성 가능).
    - 에이전트 부트스트랩 의식에 필요한 작업공간 파일을 시드합니다.
    - 전체 작업공간 레이아웃 + 백업 안내 : [에이전트 작업공간](/concepts/agent-workspace)
  </Step>
  <Step title="Gateway">
    - 포트, 바인드, 인증 모드, 테일스케일 노출.
    - 인증 권장 사항: 루프백에도 **토큰**을 유지하므로 로컬 WS 클라이언트가 인증해야 합니다.
    - 모든 로컬 프로세스를 완전히 신뢰하는 경우에만 인증을 비활성화하세요.
    - 루프백이 아닌 바인딩에는 여전히 인증이 필요합니다.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): QR 로그인은 선택사항입니다.
    - [텔레그램](/channels/telegram): 봇 토큰.
    - [Discord](/channels/discord): 봇 토큰.
    - [Google Chat](/channels/googlechat): 서비스 계정 JSON + 웹훅 대상.
    - [Mattermost](/channels/mattermost) (플러그인): 봇 토큰 + 기본 URL.
    - [시그널](/channels/signal): 선택 사항 `signal-cli` 설치 + 계정 구성.
    - [BlueBubbles](/channels/bluebubbles): **iMessage에 권장됨**; 서버 URL + 비밀번호 + 웹훅.
    - [iMessage](/channels/imessage): 레거시 `imsg` CLI 경로 + DB 액세스.
    - DM 보안: 기본값은 페어링입니다. 첫 번째 DM은 코드를 보냅니다. `openclaw pairing approve <channel> <code>`로 승인하거나 allowlist를 사용하세요.
  </Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - Requires a logged-in user session; for headless, use a custom LaunchDaemon (not shipped).
    - Linux (and Windows via WSL2): systemd user unit
      - Wizard attempts to enable lingering via `loginctl enable-linger <user>` so the Gateway stays up after logout.
      - May prompt for sudo (writes `/var/lib/systemd/linger`); it tries without sudo first.
    - **Runtime selection:** Node (recommended; required for WhatsApp/Telegram). Bun is **not recommended**.
  </Step>
  <Step title="Health check">
    - Starts the Gateway (if needed) and runs `openclaw health`.
    - Tip: `openclaw status --deep` adds gateway health probes to status output (requires a reachable gateway).
  </Step>
  <Step title="Skills (recommended)">
    - Reads the available skills and checks requirements.
    - Lets you choose a node manager: **npm / pnpm** (bun not recommended).
    - Installs optional dependencies (some use Homebrew on macOS).
  </Step>
  <Step title="Finish">
    - Summary + next steps, including iOS/Android/macOS apps for extra features.
  </Step>
</Steps>

<Note>
GUI가 감지되지 않으면 마법사는 브라우저를 여는 대신 제어 UI에 대한 SSH 포트 전달 지침을 인쇄합니다.
Control UI 자산이 누락된 경우 마법사는 해당 자산을 빌드하려고 시도합니다. 대체는 `pnpm ui:build`입니다(UI deps 자동 설치).
</Note>

## 비대화형 모드

사용 `--non-interactive` 온보딩을 자동화하거나 스크립트하려면:

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

추가하다 `--json` 기계가 읽을 수 있는 요약입니다.

<Note>
`--json`은 비대화형 모드를 의미하지 **않습니다**. 스크립트에는 `--non-interactive`(및 `--workspace`)을 사용하세요.
</Note>

<AccordionGroup>
  <Accordion title="Gemini example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice gemini-api-key \
      --gemini-api-key "$GEMINI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Z.AI example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice zai-api-key \
      --zai-api-key "$ZAI_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Vercel AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice ai-gateway-api-key \
      --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Cloudflare AI Gateway example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice cloudflare-ai-gateway-api-key \
      --cloudflare-ai-gateway-account-id "your-account-id" \
      --cloudflare-ai-gateway-gateway-id "your-gateway-id" \
      --cloudflare-ai-gateway-api-key "$CLOUDFLARE_AI_GATEWAY_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Moonshot example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice moonshot-api-key \
      --moonshot-api-key "$MOONSHOT_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="Synthetic example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice synthetic-api-key \
      --synthetic-api-key "$SYNTHETIC_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
  <Accordion title="OpenCode Zen example">
    ```bash
    openclaw onboard --non-interactive \
      --mode local \
      --auth-choice opencode-zen \
      --opencode-zen-api-key "$OPENCODE_API_KEY" \
      --gateway-port 18789 \
      --gateway-bind loopback
    ```
  </Accordion>
</AccordionGroup>

### 상담원 추가(비대화형)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## 게이트웨이 마법사 RPC

게이트웨이는 RPC를 통해 마법사 흐름을 노출합니다(`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
클라이언트(macOS 앱, Control UI)는 온보딩 로직을 다시 구현하지 않고도 단계를 렌더링할 수 있습니다.

## 신호 설정(signal-cli)

마법사가 설치할 수 있습니다. `signal-cli` GitHub 릴리스에서:

- 적절한 릴리스 자산을 다운로드합니다.
- 아래에 저장합니다. `~/.openclaw/tools/signal-cli/<version>/`.
- 쓰기 `channels.signal.cliPath` 귀하의 구성에.

참고:

- JVM 빌드에는 다음이 필요합니다. **자바 21**.
- 가능한 경우 기본 빌드가 사용됩니다.
- Windows는 WSL2를 사용합니다. signal-cli 설치는 WSL 내부의 Linux 흐름을 따릅니다.

## 마법사가 쓰는 것

일반적인 필드 `~/.openclaw/openclaw.json`:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (Minimax를 선택한 경우)
- `gateway.*` (모드, 바인딩, 인증, tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- 프롬프트에서 선택하는 경우 채널 허용 목록(Slack/Discord/Matrix/Microsoft Teams)(가능한 경우 이름이 ID로 확인됨)
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` 쓴다 `agents.list[]` 그리고 선택사항 `bindings`.

WhatsApp 자격 증명은 아래에 있습니다. `~/.openclaw/credentials/whatsapp/<accountId>/`.
세션은 다음 위치에 저장됩니다. `~/.openclaw/agents/<agentId>/sessions/`.

일부 채널은 플러그인으로 제공됩니다. 온보딩 중에 하나를 선택하면 마법사가
구성하기 전에 설치하라는 메시지(npm 또는 로컬 경로)가 표시됩니다.

## 관련 문서

- 마법사 개요: [온보딩 마법사](/start/wizard)
- macOS 앱 온보딩: [온보딩](/start/onboarding)
- 구성 참조: [게이트웨이 구성](/gateway/configuration)
- 제공자: [왓츠앱](/channels/whatsapp), [전보](/channels/telegram), [불화](/channels/discord), [구글 채팅](/channels/googlechat), [신호](/channels/signal), [블루버블스](/channels/bluebubbles) (아이메시지), [아이메시지](/channels/imessage) (유산)
- 기술: [기술](/tools/skills), [스킬 구성](/tools/skills-config)
