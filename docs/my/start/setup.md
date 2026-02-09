---
summary: "OpenClaw အတွက် အဆင့်မြင့် တပ်ဆင်ခြင်းနှင့် ဖွံ့ဖြိုးရေး လုပ်ငန်းစဉ်များ"
read_when:
  - ကွန်ပျူတာအသစ်တစ်လုံးကို တပ်ဆင်နေစဉ်
  - ကိုယ်ပိုင် setup ကို မပျက်စီးစေဘဲ “နောက်ဆုံးဗားရှင်းများ” ကို အသုံးပြုလိုသောအခါ
title: "တပ်ဆင်ခြင်း"
---

# တပ်ဆင်ခြင်း

<Note>
18. ပထမဆုံး setup လုပ်နေတယ်ဆိုရင် [Getting Started](/start/getting-started) နဲ့ စတင်ပါ။
19. wizard အသေးစိတ်အတွက် [Onboarding Wizard](/start/wizard) ကို ကြည့်ပါ။
</Note>

နောက်ဆုံးအပ်ဒိတ်လုပ်ထားသည့်နေ့: 2026-01-01

## TL;DR

- **ပြင်ဆင်ထိန်းညှိမှုများကို repo အပြင်ဘက်တွင်ထားပါ:** `~/.openclaw/workspace` (workspace) + `~/.openclaw/openclaw.json` (config)။
- **တည်ငြိမ်သော workflow:** macOS app ကို ထည့်သွင်းပြီး bundled Gateway ကို အလိုအလျောက် လည်ပတ်စေပါ။
- **Bleeding edge workflow:** `pnpm gateway:watch` ဖြင့် Gateway ကို ကိုယ်တိုင် လည်ပတ်စေပြီး macOS app ကို Local mode ဖြင့် ချိတ်ဆက်ပါ။

## Prereqs (source မှ)

- Node `>=22`
- `pnpm`
- Docker (မဖြစ်မနေ မလိုအပ်ပါ; containerized setup/e2e အတွက်သာ — [Docker](/install/docker) ကိုကြည့်ပါ)

## Tailoring strategy (update လုပ်တဲ့အခါ မထိခိုက်စေရန်)

“ကိုယ်တိုင်အတွက် 100% ပြင်ဆင်ထားခြင်း” _နှင့်_ update လွယ်ကူစေရန်အတွက် သင့် customization များကို အောက်ပါနေရာများတွင်သာ ထားပါ—

- **Config:** `~/.openclaw/openclaw.json` (JSON/JSON5 ပုံစံ)
- **Workspace:** `~/.openclaw/workspace` (skills, prompts, memories; private git repo အဖြစ် ထားပါ)

တစ်ကြိမ်သာ bootstrap လုပ်ပါ—

```bash
openclaw setup
```

ဒီ repo အတွင်းမှ local CLI entry ကို အသုံးပြုပါ—

```bash
openclaw setup
```

global install မရှိသေးပါက `pnpm openclaw setup` ဖြင့် လည်ပတ်နိုင်ပါသည်။

## ဒီ repo မှ Gateway ကို လည်ပတ်ခြင်း

`pnpm build` ပြီးနောက် packaged CLI ကို တိုက်ရိုက် လည်ပတ်နိုင်ပါသည်—

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## Stable workflow (macOS app ကို ဦးစားပေး)

1. **OpenClaw.app** ကို ထည့်သွင်းပြီး စတင်လည်ပတ်ပါ (menu bar)။
2. onboarding/permissions checklist (TCC prompts) ကို ပြီးစီးအောင် လုပ်ပါ။
3. Gateway သည် **Local** ဖြစ်ပြီး လည်ပတ်နေကြောင်း သေချာပါ (app က စီမံခန့်ခွဲပေးသည်)။
4. surfaces များကို ချိတ်ဆက်ပါ (ဥပမာ: WhatsApp)—

```bash
openclaw channels login
```

5. အခြေခံ စစ်ဆေးမှု—

```bash
openclaw health
```

သင့် build တွင် onboarding မရရှိပါက—

- `openclaw setup` ကို လည်ပတ်ပြီး၊ ထို့နောက် `openclaw channels login` ကို လုပ်ပါ၊ ပြီးရင် Gateway ကို ကိုယ်တိုင် စတင်ပါ (`openclaw gateway`)။

## Bleeding edge workflow (terminal မှ Gateway)

ရည်ရွယ်ချက်: TypeScript Gateway ကို အလုပ်လုပ်ရန်၊ hot reload ရရှိစေရန်၊ macOS app UI ကို ဆက်လက် ချိတ်ဆက်ထားရန်။

### 0. (ရွေးချယ်စရာ) macOS app ကိုလည်း source မှ လည်ပတ်ခြင်း

macOS app ကိုပါ bleeding edge သုံးလိုပါက—

```bash
./scripts/restart-mac.sh
```

### 1. dev Gateway ကို စတင်ပါ

```bash
pnpm install
pnpm gateway:watch
```

`gateway:watch` သည် gateway ကို watch mode ဖြင့် လည်ပတ်စေပြီး TypeScript ပြောင်းလဲမှုများအပေါ် အလိုအလျောက် reload လုပ်ပါသည်။

### 2. macOS app ကို သင် လည်ပတ်နေသော Gateway သို့ ညွှန်ပြပါ

**OpenClaw.app** အတွင်း—

- Connection Mode: **Local**
  app သည် သတ်မှတ်ထားသော port ပေါ်ရှိ လည်ပတ်နေသော gateway ကို ချိတ်ဆက်ပါလိမ့်မည်။

### 3. အတည်ပြုစစ်ဆေးခြင်း

- app အတွင်း Gateway status တွင် **“Using existing gateway …”** ဟု ပြသရပါမည်
- သို့မဟုတ် CLI ဖြင့်—

```bash
openclaw health
```

### Common footguns

- **Port မမှန်ခြင်း:** Gateway WS ၏ default သည် `ws://127.0.0.1:18789` ဖြစ်သည်; app နှင့် CLI ကို port တူအောင် ထားပါ။
- **State တွေ ဘယ်မှာရှိသလဲ:**
  - Credentials: `~/.openclaw/credentials/`
  - Sessions: `~/.openclaw/agents/<agentId>/sessions/`
  - Logs: `/tmp/openclaw/`

## Credential storage map

auth ကို debug လုပ်ရာတွင် သို့မဟုတ် backup ဘာတွေ လုပ်မလဲ ဆုံးဖြတ်ရာတွင် အသုံးပြုပါ—

- **WhatsApp**: `~/.openclaw/credentials/whatsapp/<accountId>/creds.json`
- **Telegram bot token**: config/env သို့မဟုတ် `channels.telegram.tokenFile`
- **Discord bot token**: config/env (token file ကို မထောက်ပံ့သေးပါ)
- **Slack tokens**: config/env (`channels.slack.*`)
- **Pairing allowlists**: `~/.openclaw/credentials/<channel>-allowFrom.json`
- **Model auth profiles**: `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- **Legacy OAuth import**: `~/.openclaw/credentials/oauth.json`
  အသေးစိတ်: [Security](/gateway/security#credential-storage-map) ကို ကြည့်ပါ။

## Updating (သင့် setup ကို မပျက်စီးစေဘဲ)

- `~/.openclaw/workspace` နှင့် `~/.openclaw/` ကို “သင့်ပိုင်အရာများ” အဖြစ် ထားပါ; ကိုယ်ပိုင် prompts/config များကို `openclaw` repo ထဲ မထည့်ပါနှင့်။
- source ကို update လုပ်ရန်: `git pull` + `pnpm install` (lockfile ပြောင်းလဲသည့်အခါ) + ဆက်လက် `pnpm gateway:watch` ကို အသုံးပြုပါ။

## Linux (systemd user service)

20. Linux install တွေမှာ systemd **user** service ကို အသုံးပြုပါတယ်။ 21. ပုံမှန်အားဖြင့် systemd က logout/idle ဖြစ်တဲ့အခါ user services တွေကို ရပ်တန့်စေပြီး Gateway ကို သတ်ပစ်ပါတယ်။ 22. Onboarding က lingering ကို သင့်အတွက် enable လုပ်ဖို့ ကြိုးစားပါမယ် (sudo ကို မေးနိုင်ပါတယ်)။ 23. မသေးမကြီး ပိတ်နေသေးရင် အောက်ပါ command ကို run လုပ်ပါ:

```bash
sudo loginctl enable-linger $USER
```

24. အမြဲတမ်း on ဖြစ်နေစေချင်တဲ့ သို့မဟုတ် multi-user server တွေအတွက် user service အစား **system** service ကို စဉ်းစားပါ (lingering မလိုပါ)။ 25. systemd ဆိုင်ရာ မှတ်စုများအတွက် [Gateway runbook](/gateway) ကို ကြည့်ပါ။

## Related docs

- [Gateway runbook](/gateway) (flags, supervision, ports)
- [Gateway configuration](/gateway/configuration) (config schema + ဥပမာများ)
- [Discord](/channels/discord) နှင့် [Telegram](/channels/telegram) (reply tags + replyToMode settings)
- [OpenClaw assistant setup](/start/openclaw)
- [macOS app](/platforms/macos) (gateway lifecycle)
