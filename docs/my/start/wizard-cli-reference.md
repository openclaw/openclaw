---
summary: "CLI စတင်မိတ်ဆက်ခြင်း လုပ်ငန်းစဉ်၊ အတည်ပြုချက်/မော်ဒယ် တပ်ဆင်မှု၊ ထုတ်လွှတ်ချက်များနှင့် အတွင်းရေးဆိုင်ရာများအတွက် ပြည့်စုံသော ရည်ညွှန်းချက်"
read_when:
  - openclaw onboard အတွက် အသေးစိတ် အပြုအမူများ လိုအပ်သည့်အခါ
  - onboarding ရလဒ်များကို အမှားရှာဖွေနေစဉ် သို့မဟုတ် onboarding client များ ပေါင်းစည်းနေစဉ်
title: "CLI စတင်မိတ်ဆက်ခြင်း ရည်ညွှန်းချက်"
sidebarTitle: "CLI reference"
---

# CLI စတင်မိတ်ဆက်ခြင်း ရည်ညွှန်းချက်

ဤစာမျက်နှာသည် `openclaw onboard` အတွက် reference အပြည့်အစုံဖြစ်သည်။
အကျဉ်းချုပ်လမ်းညွှန်အတွက် [Onboarding Wizard (CLI)](/start/wizard) ကို ကြည့်ပါ။

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
Remote host ပေါ်တွင် မည်သည့်အရာကိုမျှ install သို့မဟုတ် ပြုပြင်မည်မဟုတ်ပါ။

## Local flow အသေးစိတ်

<Steps>
  <Step title="Existing config detection">
    - `~/.openclaw/openclaw.json` ရှိပါက Keep၊ Modify သို့မဟုတ် Reset ကို ရွေးချယ်ပါ။
    - Wizard ကို ပြန် run လုပ်ခြင်းသည် သင် Reset ကို တိတိကျကျ ရွေးချယ်ခြင်း (သို့မဟုတ် `--reset` ပေးခြင်း) မရှိပါက မည်သည့်အရာကိုမျှ မဖျက်ပါ။
    - Config မမှန်ကန်ပါက သို့မဟုတ် legacy key များ ပါဝင်ပါက wizard သည် ရပ်ပြီး ဆက်မလုပ်မီ `openclaw doctor` ကို run လုပ်ရန် တောင်းဆိုသည်။
    - Reset သည် `trash` ကို အသုံးပြုပြီး scope များကို ပေးသည်:
      - Config သာလျှင်
      - Config + credential + session
      - Full reset (workspace ကိုပါ ဖယ်ရှားသည်)  
</Step>
  <Step title="Model and auth">
    - ရွေးချယ်စရာ အပြည့်အစုံကို [Auth and model options](#auth-and-model-options) တွင် ဖော်ပြထားပါသည်။
  </Step>
  <Step title="Workspace">
    - Default `~/.openclaw/workspace` (ပြောင်းလဲနိုင်သည်)။
    - First-run bootstrap ritual အတွက် လိုအပ်သော workspace file များကို seed လုပ်ပေးသည်။
    - အလုပ်ခန်း အပြင်အဆင်: [Agent workspace](/concepts/agent-workspace).
  </Step>
  <Step title="Gateway">
    - Port၊ bind၊ auth mode နှင့် tailscale exposure အတွက် မေးမြန်းသည်။
    - အကြံပြုချက်: loopback အတွက်တောင် token auth ကို ဖွင့်ထားပါ၊ ဒါမှ local WS client များက authenticate လုပ်ရပါမည်။
    - Local process အားလုံးကို ယုံကြည်နိုင်မှသာ auth ကို ပိတ်ပါ။
    - Non-loopback bind များတွင်လည်း auth လိုအပ်သည်။
  </Step>
  <Step title="Channels">
    - [WhatsApp](/channels/whatsapp): optional QR login
    - [Telegram](/channels/telegram): bot token
    - [Discord](/channels/discord): bot token
    - [Google Chat](/channels/googlechat): service account JSON + webhook audience
    - [Mattermost](/channels/mattermost) plugin: bot token + base URL
    - [Signal](/channels/signal): optional `signal-cli` install + account config
    - [BlueBubbles](/channels/bluebubbles): iMessage အတွက် အကြံပြုသည်; server URL + password + webhook
    - [iMessage](/channels/imessage): legacy `imsg` CLI path + DB access
    - DM security: default သည် pairing ဖြစ်သည်။ ပထမဆုံး DM တွင် code တစ်ခု ပို့မည်ဖြစ်ပြီး၊ အောက်ပါအတိုင်း approve လုပ်ပါ
      `openclaw pairing approve
46. <code>` သို့မဟုတ် allowlist များကို အသုံးပြုပါ။ <channel><code>` မှတစ်ဆင့် အတည်ပြုပါ သို့မဟုတ် allowlist များကို အသုံးပြုပါ။
  </Step></Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - Logged-in user session လိုအပ်သည်; headless အတွက် custom LaunchDaemon ကို အသုံးပြုပါ (မပို့ပေးထားပါ)။
  - Linux နှင့် Windows (WSL2 မှတဆင့်): systemd user unit
      - Logout ပြီးနောက် gateway ဆက်လက် run နေရန် wizard သည် `loginctl enable-linger <user>` ကို ကြိုးစား run လုပ်သည်။
    - sudo ကို မေးနိုင်သည် (`/var/lib/systemd/linger` ကို ရေးရန်); အရင်ဆုံး sudo မပါဘဲ ကြိုးစားသည်။
      - Runtime ရွေးချယ်မှု: Node (အကြံပြုထားသည်; WhatsApp နှင့် Telegram အတွက် လိုအပ်သည်)။
    - Runtime selection: Node (recommended; required for WhatsApp and Telegram). Bun ကို မထောက်ခံပါ။
  </Step>
  <Step title="Health check">
    - Gateway ကို (လိုအပ်ပါက) စတင်ပြီး `openclaw health` ကို လုပ်ဆောင်သည်။
    - `openclaw status --deep` သည် status output ထဲသို့ gateway health probes များကို ထည့်ပေါင်းသည်။
  </Step>
  <Step title="Skills">
    - ရရှိနိုင်သော skills များကို ဖတ်ပြီး လိုအပ်ချက်များကို စစ်ဆေးသည်။
    - node manager ကို ရွေးချယ်နိုင်သည်: npm သို့မဟုတ် pnpm (bun ကို မထောက်ခံပါ)။
    - optional dependencies များကို တပ်ဆင်သည် (အချို့မှာ macOS တွင် Homebrew ကို အသုံးပြုသည်)။
  </Step>
  <Step title="Finish">
    - အကျဉ်းချုပ်နှင့် နောက်တစ်ဆင့်များ၊ iOS, Android နှင့် macOS app ရွေးချယ်စရာများ အပါအဝင်။
  </Step>
</Steps>

<Note>
GUI ကို မတွေ့ရှိပါက wizard သည် browser ကို ဖွင့်မည့်အစား Control UI အတွက် SSH port-forward လမ်းညွှန်ချက်များကို ပုံနှိပ်ပြသသည်။
Control UI assets များ မရှိပါက wizard သည် build ပြုလုပ်ရန် ကြိုးစားမည်ဖြစ်ပြီး fallback အဖြစ် `pnpm ui:build` ကို အသုံးပြုသည် (UI deps များကို အလိုအလျောက် တပ်ဆင်သည်)။
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
- Gateway သည် loopback-only ဖြစ်ပါက SSH tunneling သို့မဟုတ် tailnet ကို အသုံးပြုပါ။
- Discovery အချက်အလက်များ:
  - macOS: Bonjour (`dns-sd`)
  - Linux: Avahi (`avahi-browse`)
</Note>

## Auth နှင့် မော်ဒယ် ရွေးချယ်မှုများ

<AccordionGroup>
  <Accordion title="Anthropic API key (recommended)">
    `ANTHROPIC_API_KEY` ရှိပါက အသုံးပြုသည် သို့မဟုတ် key ကို မေးမြန်းပြီး daemon အသုံးပြုရန် သိမ်းဆည်းပါသည်။
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS: Keychain item "Claude Code-credentials" ကို စစ်ဆေးပါသည်
    - Linux နှင့် Windows: `~/.claude/.credentials.json` ရှိပါက ပြန်လည်အသုံးပြုပါသည်

    ```
    macOS တွင် "Always Allow" ကို ရွေးချယ်ပါ။ သို့မှသာ launchd စတင်ခြင်းများ မပိတ်ဆို့ပါ။
    ```

  </Accordion>
  <Accordion title="Anthropic token (setup-token paste)">
    `claude setup-token` ကို မည်သည့်စက်တွင်မဆို လုပ်ဆောင်ပြီး token ကို ကူးထည့်ပါ။
    နာမည်ပေးနိုင်ပါသည်၊ အလွတ်ထားပါက default ကို အသုံးပြုသည်။
  </Accordion>
  <Accordion title="OpenAI Code subscription (Codex CLI reuse)">
    `~/.codex/auth.json` ရှိပါက wizard သည် ပြန်လည်အသုံးပြုနိုင်ပါသည်။
  </Accordion>
  <Accordion title="OpenAI Code subscription (OAuth)">
    Browser flow ဖြစ်ပြီး `code#state` ကို paste လုပ်ပါ။

    ```
    မော်ဒယ် မသတ်မှတ်ထားပါက သို့မဟုတ် `openai/*` ဖြစ်ပါက `agents.defaults.model` ကို `openai-codex/gpt-5.3-codex` အဖြစ် သတ်မှတ်ပါသည်။
    ```

  </Accordion>
  <Accordion title="OpenAI API key">
    `OPENAI_API_KEY` ရှိပါက အသုံးပြုသည် သို့မဟုတ် key ကို မေးမြန်းပြီး
    launchd ဖတ်နိုင်စေရန် `~/.openclaw/.env` ထဲသို့ သိမ်းဆည်းပါသည်။

    ```
    မော်ဒယ် မသတ်မှတ်ထားပါက၊ `openai/*` သို့မဟုတ် `openai-codex/*` ဖြစ်ပါက `agents.defaults.model` ကို `openai/gpt-5.1-codex` အဖြစ် သတ်မှတ်ပါသည်။
    ```

  </Accordion>
  <Accordion title="xAI (Grok) API key">
    `XAI_API_KEY` ကို မေးမြန်းပြီး xAI ကို မော်ဒယ် ပံ့ပိုးသူအဖြစ် ဖွဲ့စည်းပြင်ဆင်ပါသည်။
  </Accordion>
  <Accordion title="OpenCode Zen">
    `OPENCODE_API_KEY` (သို့မဟုတ် `OPENCODE_ZEN_API_KEY`) ကို ထည့်သွင်းရန် မေးမြန်းသည်။
    Setup URL: [opencode.ai/auth](https://opencode.ai/auth).
  </Accordion>
  <Accordion title="API key (generic)">
    key ကို သင့်အတွက် သိမ်းဆည်းပေးပါသည်။
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    `AI_GATEWAY_API_KEY` ကို ထည့်သွင်းရန် မေးမြန်းသည်။
    အသေးစိတ်: [Vercel AI Gateway](/providers/vercel-ai-gateway).
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    account ID, gateway ID နှင့် `CLOUDFLARE_AI_GATEWAY_API_KEY` ကို ထည့်သွင်းရန် မေးမြန်းသည်။
    အသေးစိတ်: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway).
  </Accordion>
  <Accordion title="MiniMax M2.1">
    Config ကို အလိုအလျောက် ရေးသားထားသည်။
    အသေးစိတ်: [MiniMax](/providers/minimax).
  </Accordion>
  <Accordion title="Synthetic (Anthropic-compatible)">
    `SYNTHETIC_API_KEY` ကို ထည့်သွင်းရန် မေးမြန်းသည်။
    အသေးစိတ်: [Synthetic](/providers/synthetic).
  </Accordion>
  <Accordion title="Moonshot and Kimi Coding">
    Moonshot (Kimi K2) နှင့် Kimi Coding configs များကို အလိုအလျောက် ရေးသားထားသည်။
    အသေးစိတ်: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot).
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

WhatsApp အချက်အလက်များကို `~/.openclaw/credentials/whatsapp/<accountId>/` အောက်တွင် သိမ်းဆည်းထားသည်။
Sessions များကို `~/.openclaw/agents/<agentId>/sessions/` အောက်တွင် သိမ်းဆည်းထားသည်။

<Note>
Channel အချို့ကို plugins အဖြစ် ပေးပို့ထားသည်။ Onboarding အတွင်း ရွေးချယ်ပါက wizard သည် channel configuration မလုပ်မီ plugin ကို (npm သို့မဟုတ် local path) တပ်ဆင်ရန် မေးမြန်းသည်။
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
