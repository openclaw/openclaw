---
summary: "Full reference for the CLI onboarding wizard: every step, flag, and config field"
read_when:
  - Looking up a specific wizard step or flag
  - Automating onboarding with non-interactive mode
  - Debugging wizard behavior
title: "Onboarding Wizard Reference"
sidebarTitle: "Wizard Reference"
x-i18n:
  source_hash: 05fac3786016d9065547127bcf1047f73fa92dd061b032ac887ddfd6893b1802
---

# 온보딩 마법사 참조

`openclaw onboard` CLI 마법사에 대한 전체 참조입니다.
대략적인 개요는 [온보딩 마법사](/start/wizard)를 참조하세요.

## 흐름 세부정보(로컬 모드)

<Steps>
  <Step title="Existing config detection">
    - If `~/.openclaw/openclaw.json` exists, choose **Keep / Modify / Reset**.
    - Re-running the wizard does **not** wipe anything unless you explicitly choose **Reset**
      (or pass `--reset`).
    - If the config is invalid or contains legacy keys, the wizard stops and asks
      you to run `openclaw doctor` before continuing.
    - Reset uses `trash` (never `rm`) and offers scopes:
      - Config only
      - Config + credentials + sessions
      - Full reset (also removes workspace)
  </Step>
  <Step title="Model/Auth">
    - **Anthropic API key (recommended)**: uses `ANTHROPIC_API_KEY` if present or prompts for a key, then saves it for daemon use.
    - **Anthropic OAuth (Claude Code CLI)**: on macOS the wizard checks Keychain item "Claude Code-credentials" (choose "Always Allow" so launchd starts don't block); on Linux/Windows it reuses `~/.claude/.credentials.json` if present.
    - **Anthropic token (paste setup-token)**: run `claude setup-token` on any machine, then paste the token (you can name it; blank = default).
    - **OpenAI Code (Codex) subscription (Codex CLI)**: if `~/.codex/auth.json` exists, the wizard can reuse it.
    - **OpenAI Code (Codex) subscription (OAuth)**: browser flow; paste the `code#state`.
      - Sets `agents.defaults.model` to `openai-codex/gpt-5.2` when model is unset or `openai/*`.
    - **OpenAI API key**: uses `OPENAI_API_KEY` if present or prompts for a key, then saves it to `~/.openclaw/.env` so launchd can read it.
    - **xAI (Grok) API key**: prompts for `XAI_API_KEY` and configures xAI as a model provider.
    - **OpenCode Zen (multi-model proxy)**: prompts for `OPENCODE_API_KEY` (or `OPENCODE_ZEN_API_KEY`, get it at https://opencode.ai/auth).
    - **API key**: stores the key for you.
    - **Vercel AI Gateway (multi-model proxy)**: prompts for `AI_GATEWAY_API_KEY`.
    - More detail: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: prompts for Account ID, Gateway ID, and `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - More detail: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: config is auto-written.
    - More detail: [MiniMax](/providers/minimax)
    - **Synthetic (Anthropic-compatible)**: prompts for `SYNTHETIC_API_KEY`.
    - More detail: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: config is auto-written.
    - **Kimi Coding**: config is auto-written.
    - More detail: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Skip**: no auth configured yet.
    - Pick a default model from detected options (or enter provider/model manually).
    - Wizard runs a model check and warns if the configured model is unknown or missing auth.
    - OAuth credentials live in `~/.openclaw/credentials/oauth.json`; auth profiles live in `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` (API keys + OAuth).
    - More detail: [/concepts/oauth](/concepts/oauth)
    <Note>
    Headless/server tip: complete OAuth on a machine with a browser, then copy
    `~/.openclaw/credentials/oauth.json` (or `$OPENCLAW_STATE_DIR/credentials/oauth.json`) to the
    gateway host.
    </Note>
  </Step>
  <Step title="Workspace">
    - Default `~/.openclaw/workspace` (configurable).
    - Seeds the workspace files needed for the agent bootstrap ritual.
    - Full workspace layout + backup guide: [Agent workspace](/concepts/agent-workspace)
  </Step>
  <Step title="Gateway">
    - Port, bind, auth mode, tailscale exposure.
    - Auth recommendation: keep **Token** even for loopback so local WS clients must authenticate.
    - Disable auth only if you fully trust every local process.
    - Non‑loopback binds still require auth.
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): optional QR login.
    - [Telegram](/channels/telegram): bot token.
    - [Discord](/channels/discord): bot token.
    - [Google Chat](/channels/googlechat): service account JSON + webhook audience.
    - [Mattermost](/channels/mattermost) (plugin): bot token + base URL.
    - [Signal](/channels/signal): optional `signal-cli` install + account config.
    - [BlueBubbles](/channels/bluebubbles): **recommended for iMessage**; server URL + password + webhook.
    - [iMessage](/channels/imessage): legacy `imsg` CLI path + DB access.
    - DM security: default is pairing. First DM sends a code; approve via `openclaw pairing approve <channel> <code>` or use allowlists.
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
Control UI 자산이 누락된 경우 마법사는 해당 자산을 빌드하려고 시도합니다. 폴백은 `pnpm ui:build`입니다(UI deps 자동 설치).
</Note>

## 비대화형 모드

온보딩을 자동화하거나 스크립트하려면 `--non-interactive`를 사용하세요.

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

기계가 읽을 수 있는 요약을 위해 `--json`를 추가하세요.

<Note>
`--json`는 비대화형 모드를 의미하지 **않습니다**. 스크립트에는 `--non-interactive`(및 `--workspace`)를 사용하세요.
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

### 에이전트 추가(비대화형)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## 게이트웨이 마법사 RPC

게이트웨이는 RPC(`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`)를 통해 마법사 흐름을 노출합니다.
클라이언트(macOS 앱, Control UI)는 온보딩 로직을 다시 구현하지 않고도 단계를 렌더링할 수 있습니다.

## 신호 설정(signal-cli)

마법사는 GitHub 릴리스에서 `signal-cli`를 설치할 수 있습니다.

- 적절한 릴리스 자산을 다운로드합니다.
- `~/.openclaw/tools/signal-cli/<version>/`에 저장됩니다.
- `channels.signal.cliPath`를 구성에 씁니다.

참고:

- JVM 빌드에는 **Java 21**이 필요합니다.
- 가능한 경우 기본 빌드가 사용됩니다.
- Windows는 WSL2를 사용합니다. signal-cli 설치는 WSL 내부의 Linux 흐름을 따릅니다.

## 마법사가 쓰는 것

`~/.openclaw/openclaw.json`의 일반적인 필드:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (Minimax를 선택한 경우)
- `gateway.*` (모드, 바인딩, 인증, tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- 프롬프트 중에 선택하면 채널 허용 목록(Slack/Discord/Matrix/Microsoft Teams)이 표시됩니다(가능한 경우 이름이 ID로 확인됨).
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add`는 `agents.list[]`와 선택적으로 `bindings`를 씁니다.

WhatsApp 자격 증명은 `~/.openclaw/credentials/whatsapp/<accountId>/` 아래에 있습니다.
세션은 `~/.openclaw/agents/<agentId>/sessions/`에 저장됩니다.

일부 채널은 플러그인으로 제공됩니다. 온보딩 중에 하나를 선택하면 마법사가
구성하기 전에 설치하라는 메시지(npm 또는 로컬 경로)가 표시됩니다.

## 관련 문서

- 마법사 개요: [온보딩 마법사](/start/wizard)
- macOS 앱 온보딩: [온보딩](/start/onboarding)
- 구성 참조 : [게이트웨이 구성](/gateway/configuration)
- 제공자: [WhatsApp](/channels/whatsapp), [텔레그램](/channels/telegram), [Discord](/channels/discord), [구글 채팅](/channels/googlechat), [시그널](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (레거시)
- 스킬 : [스킬](/tools/skills), [스킬 구성](/tools/skills-config)
