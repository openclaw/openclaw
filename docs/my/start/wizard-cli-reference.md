---
summary: "CLI စတင်မိတ်ဆက်ခြင်း လုပ်ငန်းစဉ်၊ အတည်ပြုချက်/မော်ဒယ် တပ်ဆင်မှု၊ ထုတ်လွှတ်ချက်များနှင့် အတွင်းရေးဆိုင်ရာများအတွက် ပြည့်စုံသော ရည်ညွှန်းချက်"
read_when:
  - openclaw onboard အတွက် အသေးစိတ် အပြုအမူများ လိုအပ်သည့်အခါ
  - onboarding ရလဒ်များကို အမှားရှာဖွေနေစဉ် သို့မဟုတ် onboarding client များ ပေါင်းစည်းနေစဉ်
title: "CLI စတင်မိတ်ဆက်ခြင်း ရည်ညွှန်းချက်"
sidebarTitle: "CLI reference"
x-i18n:
  source_path: start/wizard-cli-reference.md
  source_hash: 20bb32d6fd952345
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:27Z
---

# CLI စတင်မိတ်ဆက်ခြင်း ရည်ညွှန်းချက်

ဤစာမျက်နှာသည် `openclaw onboard` အတွက် ပြည့်စုံသော ရည်ညွှန်းချက်ဖြစ်သည်။
တိုတောင်းသော လမ်းညွှန်အတွက် [Onboarding Wizard (CLI)](/start/wizard) ကိုကြည့်ပါ။

## wizard က ဘာတွေ လုပ်ပေးသလဲ

Local mode (မူလသတ်မှတ်ချက်) တွင် အောက်ပါအရာများကို အဆင့်လိုက် လမ်းညွှန်ပေးပါသည်–

- မော်ဒယ်နှင့် အတည်ပြုချက် တပ်ဆင်မှု (OpenAI Code subscription OAuth, Anthropic API key သို့မဟုတ် setup token၊ ထို့အပြင် MiniMax, GLM, Moonshot နှင့် AI Gateway ရွေးချယ်မှုများ)
- Workspace တည်နေရာနှင့် bootstrap ဖိုင်များ
- Gateway ဆက်တင်များ (port, bind, auth, tailscale)
- ချန်နယ်များနှင့် ပံ့ပိုးသူများ (Telegram, WhatsApp, Discord, Google Chat, Mattermost plugin, Signal)
- Daemon ထည့်သွင်းတပ်ဆင်ခြင်း (LaunchAgent သို့မဟုတ် systemd user unit)
- Health check
- Skills တပ်ဆင်ခြင်း

Remote mode သည် ဤစက်ကို အခြားနေရာရှိ gateway တစ်ခုနှင့် ချိတ်ဆက်အလုပ်လုပ်နိုင်အောင် ဖွဲ့စည်းပြင်ဆင်ပေးသည်။
Remote host ပေါ်တွင် ဘာမှ ထည့်သွင်းခြင်း သို့မဟုတ် ပြောင်းလဲခြင်း မလုပ်ပါ။

## Local flow အသေးစိတ်

<Steps>
  <Step title="ရှိပြီးသား config ကို ရှာဖွေခြင်း">
    - `~/.openclaw/openclaw.json` ရှိပါက Keep, Modify, သို့မဟုတ် Reset ကို ရွေးချယ်နိုင်သည်။
    - wizard ကို ပြန်လည်လုပ်ဆောင်ခြင်းသည် Reset ကို ထင်ရှားစွာ ရွေးချယ်မထားလျှင် (သို့မဟုတ် `--reset` ကို ပေးပို့ထားလျှင် မဟုတ်လျှင်) မည်သည့်အရာကိုမှ မဖျက်ပါ။
    - config မမှန်ကန်ပါက သို့မဟုတ် legacy key များ ပါဝင်နေပါက wizard သည် ရပ်တန့်ပြီး ဆက်လက်လုပ်ဆောင်ရန် `openclaw doctor` ကို အရင် run လုပ်ရန် တောင်းဆိုပါသည်။
    - Reset သည် `trash` ကို အသုံးပြုပြီး အောက်ပါ scope များကို ရွေးချယ်ခွင့် ပေးပါသည်–
      - Config သာ
      - Config + credentials + sessions
      - Full reset (workspace ကိုပါ ဖယ်ရှားသည်)
  </Step>
  <Step title="မော်ဒယ်နှင့် အတည်ပြုချက်">
    - ရွေးချယ်စရာ အပြည့်အစုံကို [Auth and model options](#auth-and-model-options) တွင် ဖော်ပြထားပါသည်။
  </Step>
  <Step title="Workspace">
    - မူလသတ်မှတ်ချက်မှာ `~/.openclaw/workspace` (ပြောင်းလဲနိုင်သည်)။
    - ပထမဆုံး run အတွက် bootstrap ritual လိုအပ်သည့် workspace ဖိုင်များကို seed လုပ်ပါသည်။
    - Workspace အပြင်အဆင်: [Agent workspace](/concepts/agent-workspace)။
  </Step>
  <Step title="Gateway">
    - port, bind, auth mode နှင့် tailscale exposure ကို မေးမြန်းပါသည်။
    - အကြံပြုချက်– loopback ဖြစ်သော်လည်း token auth ကို ဖွင့်ထားပါ။ ဒါမှ local WS client များသည် အတည်ပြုချက် ပြုလုပ်ရပါမည်။
    - local process အားလုံးကို အပြည့်အဝ ယုံကြည်မှသာ auth ကို ပိတ်ပါ။
    - loopback မဟုတ်သော bind များတွင် auth လိုအပ်ဆဲဖြစ်သည်။
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): optional QR login
    - [Telegram](/channels/telegram): bot token
    - [Discord](/channels/discord): bot token
    - [Google Chat](/channels/googlechat): service account JSON + webhook audience
    - [Mattermost](/channels/mattermost) plugin: bot token + base URL
    - [Signal](/channels/signal): optional `signal-cli` ထည့်သွင်းခြင်း + account config
    - [BlueBubbles](/channels/bluebubbles): iMessage အတွက် အကြံပြုချက်; server URL + password + webhook
    - [iMessage](/channels/imessage): legacy `imsg` CLI လမ်းကြောင်း + DB access
    - DM လုံခြုံရေး– မူလသတ်မှတ်ချက်မှာ pairing ဖြစ်သည်။ ပထမဆုံး DM တွင် ကုဒ်တစ်ခု ပို့ပြီး
      `openclaw pairing approve <channel> <code>` မှတစ်ဆင့် အတည်ပြုပါ သို့မဟုတ် allowlist များကို အသုံးပြုပါ။
  </Step>
  <Step title="Daemon ထည့်သွင်းခြင်း">
    - macOS: LaunchAgent
      - login လုပ်ထားသော user session လိုအပ်သည်; headless အတွက် custom LaunchDaemon ကို အသုံးပြုရပါမည် (မပို့ဆောင်ပါ)။
    - Linux နှင့် Windows (WSL2 ဖြင့်): systemd user unit
      - logout ပြုလုပ်ပြီးနောက် gateway ဆက်လက်အလုပ်လုပ်စေရန် wizard သည် `loginctl enable-linger <user>` ကို ကြိုးစားလုပ်ဆောင်ပါသည်။
      - sudo ကို တောင်းနိုင်သည် (`/var/lib/systemd/linger` ကို ရေးသားသည်); အရင်ဆုံး sudo မသုံးဘဲ ကြိုးစားပါသည်။
    - Runtime ရွေးချယ်မှု– Node (အကြံပြုချက်; WhatsApp နှင့် Telegram အတွက် မဖြစ်မနေလိုအပ်သည်)။ Bun ကို မအကြံပြုပါ။
  </Step>
  <Step title="Health check">
    - လိုအပ်ပါက gateway ကို စတင်ပြီး `openclaw health` ကို run လုပ်ပါသည်။
    - `openclaw status --deep` သည် status output ထဲသို့ gateway health probes များ ထည့်ပေးပါသည်။
  </Step>
  <Step title="Skills">
    - ရရှိနိုင်သော Skills များကို ဖတ်ပြီး လိုအပ်ချက်များကို စစ်ဆေးပါသည်။
    - node manager ကို ရွေးချယ်ခွင့်ပေးသည်– npm သို့မဟုတ် pnpm (bun မအကြံပြု)။
    - optional dependency များကို ထည့်သွင်းပါသည် (အချို့သည် macOS တွင် Homebrew ကို အသုံးပြုသည်)။
  </Step>
  <Step title="ပြီးဆုံးခြင်း">
    - iOS, Android နှင့် macOS app ရွေးချယ်မှုများ အပါအဝင် အကျဉ်းချုပ်နှင့် နောက်တစ်ဆင့်များကို ပြပါသည်။
  </Step>
</Steps>

<Note>
GUI မတွေ့ရှိပါက wizard သည် browser ဖွင့်ခြင်းအစား Control UI အတွက် SSH port-forward ညွှန်ကြားချက်များကို ပုံနှိပ်ပြသပါသည်။
Control UI asset များ မရှိပါက wizard သည် build လုပ်ရန် ကြိုးစားပြီး fallback အနေဖြင့် `pnpm ui:build` ကို အသုံးပြုပါသည် (UI dependency များကို အလိုအလျောက် ထည့်သွင်းသည်)။
</Note>

## Remote mode အသေးစိတ်

Remote mode သည် ဤစက်ကို အခြားနေရာရှိ gateway တစ်ခုနှင့် ချိတ်ဆက်အလုပ်လုပ်နိုင်အောင် ဖွဲ့စည်းပြင်ဆင်ပေးသည်။

<Info>
Remote mode သည် remote host ပေါ်တွင် မည်သည့်အရာကိုမှ ထည့်သွင်းခြင်း သို့မဟုတ် ပြောင်းလဲခြင်း မလုပ်ပါ။
</Info>

သင် သတ်မှတ်ရမည့်အရာများ–

- Remote gateway URL (`ws://...`)
- Remote gateway auth လိုအပ်ပါက token (အကြံပြုချက်)

<Note>
- gateway သည် loopback-only ဖြစ်ပါက SSH tunneling သို့မဟုတ် tailnet ကို အသုံးပြုပါ။
- Discovery အညွှန်းများ–
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## Auth နှင့် မော်ဒယ် ရွေးချယ်မှုများ

<AccordionGroup>
  <Accordion title="Anthropic API key (အကြံပြုချက်)">
    `ANTHROPIC_API_KEY` ရှိပါက အသုံးပြုသည် သို့မဟုတ် key ကို မေးမြန်းပြီး daemon အသုံးပြုရန် သိမ်းဆည်းပါသည်။
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: Keychain item "Claude Code-credentials" ကို စစ်ဆေးပါသည်
    - Linux နှင့် Windows: `~/.claude/.credentials.json` ရှိပါက ပြန်လည်အသုံးပြုပါသည်

    macOS တွင် "Always Allow" ကို ရွေးချယ်ပါ။ သို့မှသာ launchd စတင်ခြင်းများ မပိတ်ဆို့ပါ။

  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    မည်သည့်စက်ပေါ်မဆို `claude setup-token` ကို run လုပ်ပြီး token ကို paste လုပ်ပါ။
    နာမည်ပေးနိုင်သည်; မပေးပါက default ကို အသုံးပြုပါသည်။
  </Accordion>
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">
    `~/.codex/auth.json` ရှိပါက wizard သည် ပြန်လည်အသုံးပြုနိုင်ပါသည်။
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    Browser flow ဖြစ်ပြီး `code#state` ကို paste လုပ်ပါ။

    မော်ဒယ် မသတ်မှတ်ထားပါက သို့မဟုတ် `openai/*` ဖြစ်ပါက `agents.defaults.model` ကို `openai-codex/gpt-5.3-codex` အဖြစ် သတ်မှတ်ပါသည်။

  </Accordion>
  <Accordion title="OpenAI API key">
    `OPENAI_API_KEY` ရှိပါက အသုံးပြုသည် သို့မဟုတ် key ကို မေးမြန်းပြီး
    launchd ဖတ်နိုင်စေရန် `~/.openclaw/.env` ထဲသို့ သိမ်းဆည်းပါသည်။

    မော်ဒယ် မသတ်မှတ်ထားပါက၊ `openai/*` သို့မဟုတ် `openai-codex/*` ဖြစ်ပါက `agents.defaults.model` ကို `openai/gpt-5.1-codex` အဖြစ် သတ်မှတ်ပါသည်။

  </Accordion>
  <Accordion title="xAI (Grok) API key">
    `XAI_API_KEY` ကို မေးမြန်းပြီး xAI ကို မော်ဒယ် ပံ့ပိုးသူအဖြစ် ဖွဲ့စည်းပြင်ဆင်ပါသည်။
  </Accordion>
  <Accordion title="OpenCode Zen">
    `OPENCODE_API_KEY` (သို့မဟုတ် `OPENCODE_ZEN_API_KEY`) ကို မေးမြန်းပါသည်။
    Setup URL: [opencode.ai/auth](https://opencode.ai/auth)။
  </Accordion>
  <Accordion title="API key (generic)">
    key ကို သင့်အတွက် သိမ်းဆည်းပေးပါသည်။
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    `AI_GATEWAY_API_KEY` ကို မေးမြန်းပါသည်။
    အသေးစိတ်– [Vercel AI Gateway](/providers/vercel-ai-gateway)။
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    account ID, gateway ID နှင့် `CLOUDFLARE_AI_GATEWAY_API_KEY` ကို မေးမြန်းပါသည်။
    အသေးစိတ်– [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)။
  </Accordion>
  <Accordion title="MiniMax M2.1">
    Config ကို အလိုအလျောက် ရေးသားပါသည်။
    အသေးစိတ်– [MiniMax](/providers/minimax)။
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    `SYNTHETIC_API_KEY` ကို မေးမြန်းပါသည်။
    အသေးစိတ်– [Synthetic](/providers/synthetic)။
  </Accordion>
  <Accordion title="Moonshot နှင့် Kimi Coding">
    Moonshot (Kimi K2) နှင့် Kimi Coding config များကို အလိုအလျောက် ရေးသားပါသည်။
    အသေးစိတ်– [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)။
  </Accordion>
  <Accordion title="Skip">
    အတည်ပြုချက်ကို မဖွဲ့စည်းထားဘဲ ချန်ထားပါသည်။
  </Accordion>
</AccordionGroup>

မော်ဒယ် အပြုအမူ–

- တွေ့ရှိထားသော ရွေးချယ်စရာများမှ မူလ မော်ဒယ်ကို ရွေးချယ်ပါ သို့မဟုတ် ပံ့ပိုးသူနှင့် မော်ဒယ်ကို လက်ဖြင့် ထည့်သွင်းပါ။
- wizard သည် မော်ဒယ် စစ်ဆေးမှုကို လုပ်ဆောင်ပြီး ဖွဲ့စည်းထားသော မော်ဒယ် မသိရှိပါက သို့မဟုတ် အတည်ပြုချက် မရှိပါက သတိပေးပါသည်။

Credential နှင့် profile လမ်းကြောင်းများ–

- OAuth credentials: `~/.openclaw/credentials/oauth.json`
- Auth profiles (API keys + OAuth): `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
Headless နှင့် server အတွက် အကြံပြုချက်– browser ရှိသော စက်ပေါ်တွင် OAuth ကို ပြီးစီးအောင်လုပ်ပြီး
`~/.openclaw/credentials/oauth.json` (သို့မဟုတ် `$OPENCLAW_STATE_DIR/credentials/oauth.json`)
ကို gateway host သို့ ကူးယူပါ။
</Note>

## Outputs နှင့် အတွင်းရေးဆိုင်ရာများ

`~/.openclaw/openclaw.json` တွင် တွေ့ရသော ပုံမှန် field များ–

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` (Minimax ကို ရွေးချယ်ထားပါက)
- `gateway.*` (mode, bind, auth, tailscale)
- `channels.telegram.botToken`, `channels.discord.token`, `channels.signal.*`, `channels.imessage.*`
- prompt အတွင်း ရွေးချယ်ပါက Channel allowlist များ (Slack, Discord, Matrix, Microsoft Teams) — ဖြစ်နိုင်ပါက အမည်များကို ID များသို့ ဖြေရှင်းပါသည်
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` သည် `agents.list[]` နှင့် optional `bindings` ကို ရေးသားပါသည်။

WhatsApp credential များကို `~/.openclaw/credentials/whatsapp/<accountId>/` အောက်တွင် သိမ်းဆည်းပါသည်။
Session များကို `~/.openclaw/agents/<agentId>/sessions/` အောက်တွင် သိမ်းဆည်းပါသည်။

<Note>
ချန်နယ်အချို့ကို plugin အဖြစ် ပို့ဆောင်ပေးပါသည်။ onboarding အတွင်း ရွေးချယ်ပါက wizard သည်
channel configuration မလုပ်မီ plugin (npm သို့မဟုတ် local path) ကို ထည့်သွင်းရန် မေးမြန်းပါသည်။
</Note>

Gateway wizard RPC–

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

Client များ (macOS app နှင့် Control UI) သည် onboarding logic ကို ပြန်လည် အကောင်အထည်မဖော်ဘဲ အဆင့်များကို render ပြုလုပ်နိုင်ပါသည်။

Signal setup အပြုအမူ–

- သင့်တော်သော release asset ကို download လုပ်ပါသည်
- `~/.openclaw/tools/signal-cli/<version>/` အောက်တွင် သိမ်းဆည်းပါသည်
- config ထဲသို့ `channels.signal.cliPath` ကို ရေးသားပါသည်
- JVM build များအတွက် Java 21 လိုအပ်ပါသည်
- Native build များ ရရှိပါက အသုံးပြုပါသည်
- Windows သည် WSL2 ကို အသုံးပြုပြီး WSL အတွင်း Linux signal-cli flow ကို လိုက်နာပါသည်

## ဆက်စပ်စာတမ်းများ

- Onboarding hub: [Onboarding Wizard (CLI)](/start/wizard)
- Automation နှင့် script များ: [CLI Automation](/start/wizard-cli-automation)
- Command reference: [`openclaw onboard`](/cli/onboard)
