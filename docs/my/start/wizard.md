---
summary: "CLI စတင်မိတ်ဆက်ခြင်း wizard — Gateway၊ workspace၊ ချန်နယ်များနှင့် Skills များအတွက် လမ်းညွှန်ထားသော တပ်ဆင်မှု"
read_when:
  - onboarding wizard ကို လုပ်ဆောင်နေစဉ် သို့မဟုတ် ဖွဲ့စည်းပြင်ဆင်နေစဉ်
  - ကွန်ပျူတာအသစ်တစ်လုံးကို တပ်ဆင်နေစဉ်
title: "Onboarding Wizard (CLI)"
sidebarTitle: "Onboarding: CLI"
x-i18n:
  source_path: start/wizard.md
  source_hash: 5495d951a2d78ffb
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:55:04Z
---

# Onboarding Wizard (CLI)

Onboarding wizard သည် macOS၊ Linux သို့မဟုတ် Windows (WSL2 မှတဆင့်; အလွန်အကြံပြုသည်) ပေါ်တွင် OpenClaw ကို တပ်ဆင်ရန် **အကြံပြုထားသော** နည်းလမ်းဖြစ်သည်။
၎င်းသည် local Gateway သို့မဟုတ် remote Gateway ချိတ်ဆက်မှုတစ်ခုကို ဖွဲ့စည်းပြင်ဆင်ပေးပြီး၊ ချန်နယ်များ၊ Skills များနှင့် workspace default များကို လမ်းညွှန်ထားသော လုပ်ငန်းစဉ်တစ်ခုအတွင်း တစ်ခါတည်း သတ်မှတ်ပေးသည်။

```bash
openclaw onboard
```

<Info>
အမြန်ဆုံး ပထမဆုံး ချတ်လုပ်ရန်: Control UI ကို ဖွင့်ပါ (ချန်နယ် တပ်ဆင်ရန် မလိုအပ်ပါ)။
`openclaw dashboard` ကို chạy လုပ်ပြီး browser ထဲတွင် ချတ်လုပ်ပါ။ စာရွက်စာတမ်းများ: [Dashboard](/web/dashboard)။
</Info>

နောက်မှ ပြန်လည်ဖွဲ့စည်းပြင်ဆင်လိုပါက:

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` သည် non-interactive mode ကို ဆိုလိုခြင်း မဟုတ်ပါ။
script များအတွက် `--non-interactive` ကို အသုံးပြုပါ။
</Note>

<Tip>
အကြံပြုချက်: agent သည် `web_search` ကို အသုံးပြုနိုင်ရန် Brave Search API key တစ်ခုကို သတ်မှတ်ပါ
(`web_fetch` သည် key မရှိဘဲလည်း အလုပ်လုပ်နိုင်သည်)။
အလွယ်ဆုံး နည်းလမ်းမှာ `openclaw configure --section web` ဖြစ်ပြီး
`tools.web.search.apiKey` ကို သိမ်းဆည်းပေးသည်။ စာရွက်စာတမ်းများ: [Web tools](/tools/web)။
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

1. **Model/Auth** — Anthropic API key (အကြံပြု), OAuth, OpenAI သို့မဟုတ် အခြား provider များ။ default model တစ်ခုကို ရွေးချယ်ပါ။
2. **Workspace** — agent ဖိုင်များအတွက် တည်နေရာ (default `~/.openclaw/workspace`)။ bootstrap ဖိုင်များကို seed လုပ်ပေးသည်။
3. **Gateway** — Port၊ bind address၊ auth mode၊ Tailscale exposure။
4. **Channels** — WhatsApp၊ Telegram၊ Discord၊ Google Chat၊ Mattermost၊ Signal၊ BlueBubbles သို့မဟုတ် iMessage။
5. **Daemon** — LaunchAgent (macOS) သို့မဟုတ် systemd user unit (Linux/WSL2) ကို ထည့်သွင်းသည်။
6. **Health check** — Gateway ကို စတင်ပြီး အလုပ်လုပ်နေကြောင်း အတည်ပြုသည်။
7. **Skills** — အကြံပြုထားသော Skills များနှင့် optional dependencies များကို ထည့်သွင်းသည်။

<Note>
wizard ကို ပြန်လည် chạy လုပ်ခြင်းသည် သင်က **Reset** ကို တိတိကျကျ ရွေးချယ်ခြင်း (သို့မဟုတ် `--reset` ကို ပေးပို့ခြင်း) မလုပ်ပါက မည်သည့်အရာကိုမျှ ဖျက်မည် မဟုတ်ပါ။
config သည် မမှန်ကန်ပါက သို့မဟုတ် legacy keys များ ပါဝင်နေပါက wizard သည် `openclaw doctor` ကို အရင် chạy လုပ်ရန် တောင်းဆိုမည်ဖြစ်သည်။
</Note>

**Remote mode** သည် local client ကို အခြားနေရာရှိ Gateway တစ်ခုသို့ ချိတ်ဆက်ရန်သာ ဖွဲ့စည်းပြင်ဆင်ပေးသည်။
remote host ပေါ်တွင် မည်သည့်အရာကိုမျှ ထည့်သွင်းခြင်း သို့မဟုတ် ပြောင်းလဲခြင်း မလုပ်ပါ။

## Agent တစ်ခု ထပ်ထည့်ခြင်း

`openclaw agents add <name>` ကို အသုံးပြု၍ ကိုယ်ပိုင် workspace၊ sessions နှင့် auth profiles ပါရှိသော agent သီးခြားတစ်ခုကို ဖန်တီးနိုင်သည်။
`--workspace` မပါဘဲ chạy လုပ်ပါက wizard ကို စတင်မည်ဖြစ်သည်။

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
