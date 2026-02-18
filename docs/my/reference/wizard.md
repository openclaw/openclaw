---
summary: "CLI onboarding wizard အတွက် အပြည့်အစုံ ကိုးကားချက် — အဆင့်တိုင်း၊ flag တိုင်းနှင့် config field တိုင်း"
read_when:
  - Wizard အဆင့်တစ်ခု သို့မဟုတ် flag တစ်ခုကို အထူးရှာဖွေကြည့်လိုသောအခါ
  - Non-interactive mode ဖြင့် onboarding ကို အလိုအလျောက်လုပ်ဆောင်လိုသောအခါ
  - Wizard အပြုအမူကို debug လုပ်နေသောအခါ
title: "Onboarding Wizard Reference"
sidebarTitle: "Wizard Reference"
---

# Onboarding Wizard Reference

ဤစာတမ်းသည် `openclaw onboard` CLI wizard အတွက် ပြည့်စုံသော reference ဖြစ်သည်။
အထွေထွေမြင်ကွင်းအတွက် [Onboarding Wizard](/start/wizard) ကို ကြည့်ပါ။

## Flow details (local mode)

<Steps>
  <Step title="Existing config detection">
    - If `~/.openclaw/openclaw.json` exists, choose **Keep / Modify / Reset**.
    - Wizard ကို ပြန်လည် run လုပ်ခြင်းသည် **Reset** ကို သင်ကိုယ်တိုင် ရွေးချယ်ခြင်း (သို့မဟုတ် `--reset` ပေးခြင်း) မရှိပါက မည်သည့်အရာကိုမျှ မဖျက်ပါ။
    - Config မမှန်ကန်ပါက သို့မဟုတ် legacy keys ပါဝင်ပါက wizard သည် ရပ်ပြီး ဆက်လက်လုပ်ဆောင်ရန် မတိုင်မီ `openclaw doctor` ကို run လုပ်ရန် မေးမြန်းပါမည်။
    - Reset သည် `trash` ကို အသုံးပြုသည် (`rm` ကို ဘယ်တော့မှ မသုံးပါ) နှင့် scope များကို ပေးထားသည်:
      - Config only
      - Config + credentials + sessions
      - Full reset (workspace ကိုပါ ဖယ်ရှားသည်)  
</Step>
  <Step title="Model/Auth">
    - **Anthropic API key (recommended)**: uses `ANTHROPIC_API_KEY` if present or prompts for a key, then saves it for daemon use.
    - **Anthropic OAuth (Claude Code CLI)**: on macOS the wizard checks Keychain item "Claude Code-credentials" (choose "Always Allow" so launchd starts don't block); on Linux/Windows it reuses `~/.claude/.credentials.json` if present.
    - **Anthropic token (paste setup-token)**: မည်သည့်စက်တွင်မဆို `claude setup-token` ကို run လုပ်ပြီး token ကို paste လုပ်ပါ (အမည်ပေးနိုင်သည်; အလွတ် = default)။
    - **OpenAI Code (Codex) subscription (Codex CLI)**: `~/.codex/auth.json` ရှိပါက wizard သည် ပြန်လည်အသုံးပြုနိုင်ပါသည်။
    - **OpenAI Code (Codex) subscription (OAuth)**: browser flow; `code#state` ကို paste လုပ်ပါ။
      - Model ကို မသတ်မှတ်ထားပါက သို့မဟုတ် `openai/*` ဖြစ်ပါက `agents.defaults.model` ကို `openai-codex/gpt-5.2` အဖြစ် သတ်မှတ်ပါသည်။
    - **OpenAI API key**: uses `OPENAI_API_KEY` if present or prompts for a key, then saves it to `~/.openclaw/.env` so launchd can read it.
    - **xAI (Grok) API key**: prompts for `XAI_API_KEY` and configures xAI as a model provider.
    - **OpenCode Zen (multi-model proxy)**: prompts for `OPENCODE_API_KEY` (or `OPENCODE_ZEN_API_KEY`, get it at https://opencode.ai/auth).
    - **API key**: key ကို သင့်အတွက် သိမ်းဆည်းပေးပါသည်။
    - **Vercel AI Gateway (multi-model proxy)**: prompts for `AI_GATEWAY_API_KEY`.
    - More detail: [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**: prompts for Account ID, Gateway ID, and `CLOUDFLARE_AI_GATEWAY_API_KEY`.
    - အသေးစိတ်: [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.1**: config ကို အလိုအလျောက် ရေးသားပါသည်။
    - More detail: [MiniMax](/providers/minimax)
    - **Synthetic (Anthropic-compatible)**: prompts for `SYNTHETIC_API_KEY`.
    - More detail: [Synthetic](/providers/synthetic)
    - **Moonshot (Kimi K2)**: config is auto-written.
    - **Kimi Coding**: config ကို အလိုအလျောက် ရေးသားပါသည်။
    - အသေးစိတ်: [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Skip**: auth ကို ယခုအချိန်တွင် မ configure လုပ်ပါ။
    - တွေ့ရှိထားသော option များထဲမှ default model ကို ရွေးချယ်ပါ (သို့မဟုတ် provider/model ကို ကိုယ်တိုင် ထည့်သွင်းပါ)။
    - Wizard သည် model စစ်ဆေးမှုကို run လုပ်ပြီး configured model မသိရှိပါက သို့မဟုတ် auth မရှိပါက သတိပေးပါသည်။
    - OAuth credentials များကို `~/.openclaw/credentials/oauth.json` တွင် သိမ်းထားပြီး auth profiles များကို `~/.openclaw/agents/
29. /agent/auth-profiles.json` (API keys + OAuth) တွင် သိမ်းထားပါသည်။<agentId>- Default `~/.openclaw/workspace` (configure လုပ်နိုင်သည်)။
    - အသေးစိတ်— [/concepts/oauth](/concepts/oauth)    
<Note>
    Headless/server အကြံပြုချက်: browser ပါသော စက်တစ်လုံးတွင် OAuth ကို ပြီးစီးစေပြီးနောက်
    `~/.openclaw/credentials/oauth.json` (သို့မဟုတ် `$OPENCLAW_STATE_DIR/credentials/oauth.json`) ကို
    Gateway ဟို့စ် သို့ ကူးယူပါ။
    </Note>
  </Step>
  <Step title="Workspace">
    - Agent bootstrap ritual အတွက် လိုအပ်သော workspace ဖိုင်များကို seed လုပ်ပါသည်။
    - Port, bind, auth mode, tailscale exposure။
    - Workspace အပြည့်အစုံ ဖွဲ့စည်းပုံနှင့် backup လမ်းညွှန် — [Agent workspace](/concepts/agent-workspace)  
</Step>
  <Step title="Gateway">
    - Auth အကြံပြုချက်: loopback အတွက်တောင် **Token** ကို ထိန်းထားပါ၊ ဒါမှ local WS clients များသည် authenticate လုပ်ရပါမည်။
    - Auth recommendation: keep **Token** even for loopback so local WS clients must authenticate.
    - Non‑loopback bind များသည် auth လိုအပ်နေဆဲ ဖြစ်သည်။
    - [WhatsApp](/channels/whatsapp): optional QR login။
  </Step>
  <Step title="Channels">
    - [Telegram](/channels/telegram): bot token။
    - [Discord](/channels/discord): bot token။
    - [Google Chat](/channels/googlechat): service account JSON + webhook audience။
    - [Google Chat](/channels/googlechat): service account JSON + webhook audience.
    - [Signal](/channels/signal): optional `signal-cli` install + account config။
    - [BlueBubbles](/channels/bluebubbles): **iMessage အတွက် အကြံပြုထားသည်**; server URL + password + webhook။
    - [iMessage](/channels/imessage): legacy `imsg` CLI path + DB access။
    - DM security: default သည် pairing ဖြစ်သည်။
    - DM security: default is pairing. </Step>
  <Step title="Daemon install">
    - macOS: LaunchAgent
      - Logged-in user session လိုအပ်သည်; headless အတွက် custom LaunchDaemon ကို အသုံးပြုပါ (မပို့ပေးထားပါ)။ <channel><code>` မှတစ်ဆင့် အတည်ပြုပါ သို့မဟုတ် allowlists ကို အသုံးပြုပါ။
  </Step>- Linux (နှင့် WSL2 မှတစ်ဆင့် Windows): systemd user unit
      - Logout ပြီးနောက် Gateway ဆက်လက်လုပ်ဆောင်ရန် wizard သည် `loginctl enable-linger <user>` ဖြင့် lingering ကို enable လုပ်ရန် ကြိုးပမ်းပါသည်။
  - sudo ကို မေးမြန်းနိုင်ပါသည် (`/var/lib/systemd/linger` ကို ရေးသားသည်)；ပထမဦးစွာ sudo မလိုဘဲ ကြိုးပမ်းပါသည်။
    - **Runtime ရွေးချယ်မှု:** Node (recommended; WhatsApp/Telegram အတွက် လိုအပ်သည်)။
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
If no GUI is detected, the wizard prints SSH port-forward instructions for the Control UI instead of opening a browser.
If the Control UI assets are missing, the wizard attempts to build them; fallback is `pnpm ui:build` (auto-installs UI deps).
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
`--json` does **not** imply non-interactive mode. Use `--non-interactive` (and `--workspace`) for scripts.
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

The Gateway exposes the wizard flow over RPC (`wizard.start`, `wizard.next`, `wizard.cancel`, `wizard.status`).
Clients (macOS app, Control UI) can render steps without re‑implementing onboarding logic.

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

WhatsApp credentials go under `~/.openclaw/credentials/whatsapp/<accountId>/`.
Sessions are stored under `~/.openclaw/agents/<agentId>/sessions/`.

Some channels are delivered as plugins. When you pick one during onboarding, the wizard
will prompt to install it (npm or a local path) before it can be configured.

## Related docs

- Wizard overview: [Onboarding Wizard](/start/wizard)
- macOS app onboarding: [Onboarding](/start/onboarding)
- Config reference: [Gateway configuration](/gateway/configuration)
- Providers: [WhatsApp](/channels/whatsapp), [Telegram](/channels/telegram), [Discord](/channels/discord), [Google Chat](/channels/googlechat), [Signal](/channels/signal), [BlueBubbles](/channels/bluebubbles) (iMessage), [iMessage](/channels/imessage) (legacy)
- Skills: [Skills](/tools/skills), [Skills config](/tools/skills-config)
