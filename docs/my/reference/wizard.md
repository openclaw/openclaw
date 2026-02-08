---
summary: "CLI onboarding wizard အတွက် အပြည့်အစုံ ကိုးကားချက် — အဆင့်တိုင်း၊ flag တိုင်းနှင့် config field တိုင်း"
read_when:
  - Wizard အဆင့်တစ်ခု သို့မဟုတ် flag တစ်ခုကို အထူးရှာဖွေကြည့်လိုသောအခါ
  - Non-interactive mode ဖြင့် onboarding ကို အလိုအလျောက်လုပ်ဆောင်လိုသောအခါ
  - Wizard အပြုအမူကို debug လုပ်နေသောအခါ
title: "Onboarding Wizard Reference"
sidebarTitle: "Wizard Reference"
x-i18n:
  source_path: reference/wizard.md
  source_hash: 05fac3786016d906
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:16Z
---

# Onboarding Wizard Reference

ဤစာတမ်းသည် `openclaw onboard` CLI wizard အတွက် အပြည့်အစုံ ကိုးကားချက်ဖြစ်သည်။
အမြင်ကျယ် ပြန်လည်သုံးသပ်ချက်အတွက် [Onboarding Wizard](/start/wizard) ကို ကြည့်ပါ။

## Flow details (local mode)

<Steps>
  <Step title="ရှိပြီးသား config ကို စစ်ဆေးခြင်း">
    - `~/.openclaw/openclaw.json` ရှိပါက **Keep / Modify / Reset** ကို ရွေးချယ်ပါ။
    - Wizard ကို ပြန်လည် chạy လုပ်ခြင်းသည် **Reset** ကို တိတိကျကျ မရွေးချယ်ပါက (သို့မဟုတ် `--reset` ကို မပို့ပါက) မည်သည့်အရာကိုမျှ ဖျက်မည်မဟုတ်ပါ။
    - Config မမှန်ကန်ပါက သို့မဟုတ် legacy keys များ ပါရှိပါက wizard သည် ရပ်တန့်ပြီး ဆက်လက်လုပ်ဆောင်ရန် မတိုင်မီ `openclaw doctor` ကို chạy လုပ်ရန် တောင်းဆိုပါသည်။
    - Reset သည် `trash` ကို အသုံးပြုသည် (`rm` ကို ဘယ်တော့မှ မသုံးပါ) နှင့် scope များကို ရွေးချယ်နိုင်ပါသည်။
      - Config သာလျှင်
      - Config + credentials + sessions
      - Full reset (workspace ကိုပါ ဖယ်ရှားသည်)
  </Step>
  <Step title="Model/Auth">
    - **Anthropic API key (အကြံပြု)**: `ANTHROPIC_API_KEY` ရှိပါက အသုံးပြုသည်၊ မရှိပါက key ကို တောင်းယူပြီး daemon အသုံးပြုရန် သိမ်းဆည်းပါသည်။
    - **Anthropic OAuth (Claude Code CLI)**: macOS တွင် wizard သည် Keychain item “Claude Code-credentials” ကို စစ်ဆေးသည် (“Always Allow” ကို ရွေးချယ်ပါ၊ မဟုတ်လျှင် launchd စတင်မှုများ ပိတ်ဆို့နိုင်သည်)။ Linux/Windows တွင် `~/.claude/.credentials.json` ရှိပါက ပြန်လည်အသုံးပြုပါသည်။
    - **Anthropic token (setup-token ကို ကူးထည့်ခြင်း)**: မည်သည့်စက်တွင်မဆို `claude setup-token` ကို chạy လုပ်ပြီး token ကို ကူးထည့်ပါ (နာမည်ပေးနိုင်သည်၊ အလွတ်ထားပါက default)။
    - **OpenAI Code (Codex) subscription (Codex CLI)**: `~/.codex/auth.json` ရှိပါက wizard သည် ပြန်လည်အသုံးပြုနိုင်ပါသည်။
    - **OpenAI Code (Codex) subscription (OAuth)**: browser flow ဖြစ်ပြီး `code#state` ကို ကူးထည့်ပါ။
      - Model မသတ်မှတ်ထားပါက သို့မဟုတ် `openai/*` ဖြစ်ပါက `agents.defaults.model` ကို `openai-codex/gpt-5.2` အဖြစ် သတ်မှတ်ပါသည်။
    - **OpenAI API key**: `OPENAI_API_KEY` ရှိပါက အသုံးပြုသည်၊ မရှိပါက key ကို တောင်းယူပြီး launchd ဖတ်နိုင်ရန် `~/.openclaw/.env` သို့ သိမ်းဆည်းပါသည်။
    - **xAI (Grok) API key**: `XAI_API_KEY` ကို တောင်းယူပြီး xAI ကို model provider အဖြစ် ဖွဲ့စည်းပါသည်။
    - **OpenCode Zen (multi-model proxy)**: `OPENCODE_API_KEY` (သို့မဟုတ် `OPENCODE_ZEN_API_KEY`, https://opencode.ai/auth တွင် ရယူနိုင်သည်) ကို တောင်းယူပါသည်။
    - **API key**: key ကို သင့်အတွက် သိမ်းဆည်းပါသည်။
    - **Vercel AI Gateway (multi-model proxy)**: `AI_GATEWAY_API_KEY` ကို တောင်းယူပါသည်။
    - အသေးစိတ်: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: Account ID၊ Gateway ID နှင့် `CLOUDFLARE_AI_GATEWAY_API_KEY` ကို တောင်းယူပါသည်။
    - အသေးစိတ်: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: config ကို အလိုအလျောက် ရေးသွင်းပါသည်။
    - အသေးစိတ်: [MiniMax](/providers/minimax)
    - **Synthetic (Anthropic-compatible)**: `SYNTHETIC_API_KEY` ကို တောင်းယူပါသည်။
    - အသေးစိတ်: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: config ကို အလိုအလျောက် ရေးသွင်းပါသည်။
    - **Kimi Coding**: config ကို အလိုအလျောက် ရေးသွင်းပါသည်။
    - အသေးစိတ်: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Skip**: ယခုအချိန်တွင် auth ကို မဖွဲ့စည်းပါ။
    - တွေ့ရှိထားသော ရွေးချယ်စရာများမှ default model ကို ရွေးချယ်ပါ (သို့မဟုတ် provider/model ကို ကိုယ်တိုင် ထည့်သွင်းပါ)။
    - Wizard သည် model စစ်ဆေးမှုကို chạy လုပ်ပြီး config ထဲရှိ model မသိရှိခြင်း သို့မဟုတ် auth မရှိခြင်းကို သတိပေးပါသည်။
    - OAuth credentials များကို `~/.openclaw/credentials/oauth.json` တွင် သိမ်းဆည်းပြီး auth profiles များကို `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` တွင် သိမ်းဆည်းပါသည် (API keys + OAuth)။
    - အသေးစိတ်: [/concepts/oauth](/concepts/oauth)
    <Note>
    Headless/server အကြံပြုချက်: browser ပါသော စက်တစ်လုံးတွင် OAuth ကို ပြီးစီးစေပြီးနောက်
    `~/.openclaw/credentials/oauth.json` (သို့မဟုတ် `$OPENCLAW_STATE_DIR/credentials/oauth.json`) ကို
    Gateway ဟို့စ် သို့ ကူးယူပါ။
    </Note>
  </Step>
  <Step title="Workspace">
    - Default `~/.openclaw/workspace` (ပြင်ဆင်နိုင်သည်)။
    - Agent bootstrap ritual အတွက် လိုအပ်သော workspace ဖိုင်များကို စတင်ထည့်သွင်းပေးပါသည်။
    - Workspace အပြည့်အစုံ layout + backup လမ်းညွှန်: [Agent workspace](/concepts/agent-workspace)
  </Step>
  <Step title="Gateway">
    - Port၊ bind၊ auth mode၊ Tailscale exposure။
    - Auth အကြံပြုချက်: loopback အတွက်တောင် **Token** ကို ထားရှိပါ၊ local WS clients များကို auth လုပ်ရန် လိုအပ်စေရန်။
    - Local process အားလုံးကို အပြည့်အဝ ယုံကြည်ပါကသာ auth ကို ပိတ်ပါ။
    - Loopback မဟုတ်သော bind များတွင် auth လိုအပ်ဆဲ ဖြစ်ပါသည်။
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): optional QR login။
    - [Telegram](/channels/telegram): bot token။
    - [Discord](/channels/discord): bot token။
    - [Google Chat](/channels/googlechat): service account JSON + webhook audience။
    - [Mattermost](/channels/mattermost) (plugin): bot token + base URL။
    - [Signal](/channels/signal): optional `signal-cli` install + account config။
    - [BlueBubbles](/channels/bluebubbles): **iMessage အတွက် အကြံပြုချက်**; server URL + password + webhook။
    - [iMessage](/channels/imessage): legacy `imsg` CLI path + DB access။
    - DM လုံခြုံရေး: default သည် pairing ဖြစ်ပါသည်။ ပထမ DM တွင် code တစ်ခု ပို့ပြီး `openclaw pairing approve <channel> <code>` မှတစ်ဆင့် အတည်ပြုပါ သို့မဟုတ် allowlists ကို အသုံးပြုပါ။
  </Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - Login ဝင်ထားသော user session တစ်ခု လိုအပ်ပါသည်; headless အတွက် custom LaunchDaemon ကို အသုံးပြုရပါမည် (မထည့်သွင်းပေးထားပါ)။
    - Linux (နှင့် Windows via WSL2): systemd user unit
      - Logout ပြုလုပ်ပြီးနောက် Gateway ဆက်လက်လည်ပတ်စေရန် wizard သည် `loginctl enable-linger <user>` ဖြင့် lingering ကို enable လုပ်ရန် ကြိုးစားပါသည်။
      - sudo ကို တောင်းဆိုနိုင်ပါသည် (`/var/lib/systemd/linger` ကို ရေးသားသည်); ပထမဦးစွာ sudo မသုံးဘဲ ကြိုးစားပါသည်။
    - **Runtime ရွေးချယ်မှု:** Node (အကြံပြု; WhatsApp/Telegram အတွက် မဖြစ်မနေလိုအပ်သည်)။ Bun ကို **မအကြံပြုပါ**။
  </Step>
  <Step title="Health check">
    - Gateway ကို (လိုအပ်ပါက) စတင်ပြီး `openclaw health` ကို chạy လုပ်ပါသည်။
    - အကြံပြုချက်: `openclaw status --deep` သည် status output ထဲသို့ gateway health probes များ ထည့်ပေးပါသည် (ချိတ်ဆက်နိုင်သော gateway တစ်ခု လိုအပ်သည်)။
  </Step>
  <Step title="Skills (အကြံပြု)">
    - ရရှိနိုင်သော Skills များကို ဖတ်ရှုပြီး လိုအပ်ချက်များကို စစ်ဆေးပါသည်။
    - Node manager ကို ရွေးချယ်နိုင်ပါသည်: **npm / pnpm** (bun ကို မအကြံပြုပါ)။
    - Optional dependencies များကို ထည့်သွင်းပါသည် (အချို့သည် macOS တွင် Homebrew ကို အသုံးပြုပါသည်)။
  </Step>
  <Step title="Finish">
    - အကျဉ်းချုပ် + နောက်ထပ်အဆင့်များ (အပိုအင်္ဂါရပ်များအတွက် iOS/Android/macOS apps များ အပါအဝင်)။
  </Step>
</Steps>

<Note>
GUI မတွေ့ရှိပါက wizard သည် browser ကို ဖွင့်မည့်အစား Control UI အတွက် SSH port-forward လမ်းညွှန်ချက်များကို ထုတ်ပြပါသည်။
Control UI assets များ မရှိပါက wizard သည် ၎င်းတို့ကို build လုပ်ရန် ကြိုးစားပါသည်; fallback သည် `pnpm ui:build` ဖြစ်ပါသည် (UI deps များကို အလိုအလျောက် ထည့်သွင်းပါသည်)။
</Note>

## Non-interactive mode

Onboarding ကို အလိုအလျောက်လုပ်ဆောင်ရန် သို့မဟုတ် script ဖြင့် လုပ်ရန် `--non-interactive` ကို အသုံးပြုပါ။

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

Machine‑readable summary ရရှိရန် `--json` ကို ထပ်ထည့်ပါ။

<Note>
`--json` သည် non-interactive mode ကို **မဆိုလိုပါ**။ Script များအတွက် `--non-interactive` (နှင့် `--workspace`) ကို အသုံးပြုပါ။
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

### Add agent (non-interactive)

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway wizard RPC

Gateway သည် wizard flow ကို RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`) မှတစ်ဆင့် ပံ့ပိုးပေးပါသည်။
Clients (macOS app, Control UI) များသည် onboarding logic ကို ပြန်လည်အကောင်အထည်မဖော်ဘဲ အဆင့်များကို render လုပ်နိုင်ပါသည်။

## Signal setup (signal-cli)

Wizard သည် GitHub releases မှ `signal-cli` ကို ထည့်သွင်းနိုင်ပါသည်။

- သင့် platform နှင့် ကိုက်ညီသော release asset ကို ဒေါင်းလုဒ်လုပ်ပါသည်။
- `~/.openclaw/tools/signal-cli/<version>/` အောက်တွင် သိမ်းဆည်းပါသည်။
- သင့် config ထဲသို့ `channels.signal.cliPath` ကို ရေးသွင်းပါသည်။

မှတ်ချက်များ:

- JVM build များအတွက် **Java 21** လိုအပ်ပါသည်။
- Native build များကို ရရှိနိုင်ပါက အသုံးပြုပါသည်။
- Windows သည် WSL2 ကို အသုံးပြုပါသည်; signal-cli install သည် WSL အတွင်း Linux flow အတိုင်း ဆက်လက်လုပ်ဆောင်ပါသည်။

## Wizard က ရေးသွင်းသော အရာများ

`~/.openclaw/openclaw.json` ထဲရှိ ပုံမှန် field များ:

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (Minimax ကို ရွေးချယ်ပါက)
- `gateway.*` (mode, bind, auth, tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- Prompt များအတွင်း ရွေးချယ်ပါက Channel allowlists (Slack/Discord/Matrix/Microsoft Teams) ကို ထည့်သွင်းရေးသားပါသည် (အမည်များကို ဖြစ်နိုင်သမျှ ID များသို့ ပြောင်းလဲပါသည်)။
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` သည် `agents.list[]` နှင့် optional `bindings` ကို ရေးသွင်းပါသည်။

WhatsApp credentials များကို `~/.openclaw/credentials/whatsapp/<accountId>/` အောက်တွင် သိမ်းဆည်းပါသည်။
Sessions များကို `~/.openclaw/agents/<agentId>/sessions/` အောက်တွင် သိမ်းဆည်းပါသည်။

အချို့ channel များကို plugin အဖြစ် ပံ့ပိုးပေးထားပါသည်။ Onboarding အတွင်း တစ်ခုကို ရွေးချယ်ပါက wizard သည် configure မလုပ်မီ ၎င်းကို (npm သို့မဟုတ် local path) ထည့်သွင်းရန် မေးမြန်းပါမည်။

## Related docs

- Wizard overview: [Onboarding Wizard](/start/wizard)
- macOS app onboarding: [Onboarding](/start/onboarding)
- Config reference: [Gateway configuration](/gateway/configuration)
- Providers: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (legacy)
- Skills: [Skills](/tools/skills), [Skills config](/tools/skills-config)
