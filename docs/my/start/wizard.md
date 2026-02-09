---
summary: "CLI စတင်မိတ်ဆက်ခြင်း wizard — Gateway၊ workspace၊ ချန်နယ်များနှင့် Skills များအတွက် လမ်းညွှန်ထားသော တပ်ဆင်မှု"
read_when:
  - onboarding wizard ကို လုပ်ဆောင်နေစဉ် သို့မဟုတ် ဖွဲ့စည်းပြင်ဆင်နေစဉ်
  - ကွန်ပျူတာအသစ်တစ်လုံးကို တပ်ဆင်နေစဉ်
title: "Onboarding Wizard (CLI)"
sidebarTitle: "Onboarding: CLI"
---

# Onboarding Wizard (CLI)

Onboarding wizard သည် macOS, Linux သို့မဟုတ် Windows (WSL2 ဖြင့်; အလွန်အမင်း ထောက်ခံသည်) တွင် OpenClaw ကို တပ်ဆင်ရန် **ထောက်ခံအကြံပြုထားသော** နည်းလမ်း ဖြစ်သည်။
Guided flow တစ်ခုအတွင်း local Gateway သို့မဟုတ် remote Gateway ချိတ်ဆက်မှု၊ channels၊ skills နှင့် workspace defaults များကို ပြင်ဆင်ပေးသည်။

```bash
openclaw onboard
```

<Info>
အမြန်ဆုံး ပထမဆုံး chat: Control UI ကို ဖွင့်ပါ (channel setup မလိုအပ်ပါ)။ Run
`openclaw dashboard` ကို လုပ်ဆောင်ပြီး browser ထဲတွင် chat ပြုလုပ်ပါ။ Docs: [Dashboard](/web/dashboard).
</Info>

နောက်မှ ပြန်လည်ဖွဲ့စည်းပြင်ဆင်လိုပါက:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` သည် non-interactive mode ကို မဆိုလိုပါ။ Scripts များအတွက် `--non-interactive` ကို အသုံးပြုပါ။
</Note>

<Tip>
အကြံပြုချက်: agent သည် `web_search` ကို အသုံးပြုနိုင်ရန် Brave Search API key ကို ပြင်ဆင်ပါ (`web_fetch` သည် key မလိုအပ်ပါ)။ အလွယ်ဆုံး လမ်းကြောင်း: `openclaw configure --section web`
which stores `tools.web.search.apiKey`. Docs: [Web tools](/tools/web).
</Tip>

## QuickStart vs Advanced

wizard သည် **QuickStart** (default များ) နှင့် **Advanced** (ထိန်းချုပ်မှု အပြည့်အစုံ) အကြား ရွေးချယ်မှုဖြင့် စတင်သည်။

<Tabs>
  <Tab title="QuickStart (defaults)">
    - Local gateway (loopback)
    - Workspace default (သို့မဟုတ် ရှိပြီးသား workspace)
    - Gateway port **18789**
    - Gateway auth **Token** (loopback ပေါ်တွင်တောင် auto‑generated ဖြစ်သည်)
    - Tailscale exposure **Off**
    - Telegram + WhatsApp DM များကို **allowlist** အဖြစ် default သတ်မှတ်သည် (သင့်ဖုန်းနံပါတ်ကို မေးမြန်းမည်)
  </Tab>
  <Tab title="Advanced (full control)">
    - အဆင့်တိုင်းကို ဖော်ပြပေးသည် (mode, workspace, gateway, channels, daemon, skills)။
  </Tab>
</Tabs>

## Wizard က ဖွဲ့စည်းပြင်ဆင်ပေးသည့် အရာများ

**Local mode (default)** တွင် အောက်ပါ အဆင့်များကို လမ်းညွှန်ပေးသည် —

1. **Model/Auth** — Anthropic API key (ထောက်ခံအကြံပြုထားသည်), OAuth, OpenAI သို့မဟုတ် အခြား providers များ။ Default model ကို ရွေးချယ်ပါ။
2. **Workspace** — agent ဖိုင်များအတွက် တည်နေရာ (default `~/.openclaw/workspace`)။ Bootstrap ဖိုင်များကို seed လုပ်သည်။
3. **Gateway** — Port၊ bind address၊ auth mode၊ Tailscale exposure။
4. **Channels** — WhatsApp၊ Telegram၊ Discord၊ Google Chat၊ Mattermost၊ Signal၊ BlueBubbles သို့မဟုတ် iMessage။
5. **Daemon** — LaunchAgent (macOS) သို့မဟုတ် systemd user unit (Linux/WSL2) ကို ထည့်သွင်းသည်။
6. **Health check** — Gateway ကို စတင်ပြီး အလုပ်လုပ်နေကြောင်း အတည်ပြုသည်။
7. **Skills** — အကြံပြုထားသော Skills များနှင့် optional dependencies များကို ထည့်သွင်းသည်။

<Note>
Wizard ကို ပြန်လည် လုပ်ဆောင်ပါက **Reset** ကို ရွေးချယ်ခြင်း (သို့မဟုတ် `--reset` ပေးခြင်း) မလုပ်ပါက မည်သည့်အရာမှ ဖျက်မည် မဟုတ်ပါ။
Config မမှန်ကန်ပါက သို့မဟုတ် legacy keys များ ပါရှိပါက wizard သည် `openclaw doctor` ကို အရင် လုပ်ဆောင်ရန် မေးမြန်းသည်။
</Note>

**Remote mode** သည် အခြားနေရာရှိ Gateway တစ်ခုသို့ ချိတ်ဆက်ရန် local client ကိုသာ ပြင်ဆင်ပေးသည်။
Remote host ပေါ်တွင် မည်သည့်အရာကိုမျှ တပ်ဆင်ခြင်း သို့မဟုတ် ပြောင်းလဲခြင်း မလုပ်ပါ။

## Agent တစ်ခု ထပ်ထည့်ခြင်း

`openclaw agents add <name>` ကို အသုံးပြုပြီး ကိုယ်ပိုင် workspace, sessions နှင့် auth profiles ပါရှိသော သီးခြား agent တစ်ခုကို ဖန်တီးနိုင်သည်။ `--workspace` မပါဘဲ လုပ်ဆောင်ပါက wizard ကို စတင်သည်။

၎င်းက သတ်မှတ်ပေးသည့် အရာများ —

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

မှတ်ချက်များ —

- default workspace များသည် `~/.openclaw/workspace-<agentId>` ကို လိုက်နာသည်။
- inbound မက်ဆေ့ချ်များကို လမ်းကြောင်းချရန် `bindings` ကို ထည့်ပါ (wizard မှ လုပ်ဆောင်နိုင်သည်)။
- Non-interactive flags များ: `--model`, `--agent-dir`, `--bind`, `--non-interactive`။

## Full reference

အဆင့်လိုက် အသေးစိတ် ဖော်ပြချက်များ၊ non-interactive scripting၊ Signal တပ်ဆင်မှု,
RPC API နှင့် wizard က ရေးသားသည့် config field များ၏ စာရင်းအပြည့်အစုံကို
[Wizard Reference](/reference/wizard) တွင် ကြည့်ပါ။

## Related docs

- CLI command reference: [`openclaw onboard`](/cli/onboard)
- macOS app onboarding: [Onboarding](/start/onboarding)
- Agent ပထမဆုံး chạy လုပ်သည့် အစဉ်အလာ: [Agent Bootstrapping](/start/bootstrapping)
