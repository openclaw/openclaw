---
summary: "OpenClaw ကို လုံခြုံစွာ အပ်ဒိတ်လုပ်ခြင်း (global install သို့မဟုတ် source) နှင့် rollback မဟာဗျူဟာ"
read_when:
  - OpenClaw ကို အပ်ဒိတ်လုပ်နေစဉ်
  - အပ်ဒိတ်ပြီးနောက် တစ်ခုခု ပျက်သွားသောအခါ
title: "အပ်ဒိတ်လုပ်ခြင်း"
x-i18n:
  source_path: install/updating.md
  source_hash: c95c31766fb7de8c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:48Z
---

# အပ်ဒိတ်လုပ်ခြင်း

OpenClaw သည် မြန်မြန်ဆန်ဆန် ဖွံ့ဖြိုးနေဆဲ (pre “1.0”) ဖြစ်ပါသည်။ အပ်ဒိတ်များကို infra ကို deploy လုပ်သလို စနစ်တကျ ဆောင်ရွက်ပါ—အပ်ဒိတ် → စစ်ဆေးမှုများ လုပ်ဆောင် → ပြန်လည်စတင် (သို့မဟုတ် `openclaw update` ကို အသုံးပြုပါ၊ ၎င်းသည် restart လုပ်ပါသည်) → အတည်ပြုပါ။

## အကြံပြုချက်: ဝဘ်ဆိုက် installer ကို ပြန်လည် chạy လုပ်ပါ (နေရာမပြောင်းဘဲ အပ်ဂရိတ်)

**အကြိုက်ဆုံး** အပ်ဒိတ်လမ်းကြောင်းမှာ ဝဘ်ဆိုက်မှ installer ကို ပြန်လည် chạy လုပ်ခြင်းဖြစ်သည်။ ၎င်းသည် ရှိပြီးသား install များကို ရှာဖွေတွေ့ရှိပြီး နေရာမပြောင်းဘဲ အပ်ဂရိတ်လုပ်ကာ လိုအပ်ပါက `openclaw doctor` ကို chạy လုပ်ပါသည်။

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

မှတ်ချက်များ—

- onboarding wizard ကို ထပ်မံ chạy မလုပ်စေလိုပါက `--no-onboard` ကို ထည့်ပါ။
- **source install** များအတွက်—

  ```bash
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
  ```

  repo သန့်ရှင်းနေပါကသာ installer သည် `git pull --rebase` ကို **သာလျှင်** ဆောင်ရွက်ပါမည်။

- **global install** များအတွက် script သည် အတွင်းပိုင်းတွင် `npm install -g openclaw@latest` ကို အသုံးပြုပါသည်။
- Legacy မှတ်ချက်: `clawdbot` ကို compatibility shim အဖြစ် ဆက်လက် အသုံးပြုနိုင်ပါသည်။

## အပ်ဒိတ်မလုပ်မီ

- သင် ဘယ်လို install လုပ်ထားသည်ကို သိပါ—**global** (npm/pnpm) သို့မဟုတ် **source မှ** (git clone)။
- သင်၏ Gateway ကို ဘယ်လို chạy နေသည်ကို သိပါ—**foreground terminal** သို့မဟုတ် **supervised service** (launchd/systemd)။
- သင်ပြင်ဆင်ထားသည့် အရာများကို snapshot ယူထားပါ—
  - Config: `~/.openclaw/openclaw.json`
  - Credentials: `~/.openclaw/credentials/`
  - Workspace: `~/.openclaw/workspace`

## အပ်ဒိတ် (global install)

Global install (တစ်ခုရွေးပါ)—

```bash
npm i -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

Gateway runtime အတွက် Bun ကို မထောက်ခံပါ (WhatsApp/Telegram bug များကြောင့်)။

update channel များကို ပြောင်းရန် (git + npm installs)—

```bash
openclaw update --channel beta
openclaw update --channel dev
openclaw update --channel stable
```

တစ်ကြိမ်တည်း install tag/version အတွက် `--tag <dist-tag|version>` ကို အသုံးပြုပါ။

channel အဓိပ္ပါယ်နှင့် release notes များအတွက် [Development channels](/install/development-channels) ကို ကြည့်ပါ။

မှတ်ချက်: npm installs တွင် Gateway သည် startup အချိန်တွင် update hint ကို log လုပ်ပါသည် (လက်ရှိ channel tag ကို စစ်ဆေးပါသည်)။ `update.checkOnStart: false` ဖြင့် ပိတ်နိုင်ပါသည်။

ထို့နောက်—

```bash
openclaw doctor
openclaw gateway restart
openclaw health
```

မှတ်ချက်များ—

- Gateway ကို service အဖြစ် chạy နေပါက PID များကို kill လုပ်ခြင်းထက် `openclaw gateway restart` ကို အကြံပြုပါသည်။
- တိကျသော version တစ်ခုကို pin လုပ်ထားပါက အောက်ပါ “Rollback / pinning” ကို ကြည့်ပါ။

## အပ်ဒိတ် (`openclaw update`)

**source install** (git checkout) များအတွက် အောက်ပါကို အားပေးပါသည်—

```bash
openclaw update
```

၎င်းသည် အနည်းငယ်လုံခြုံသော update flow ကို chạy လုပ်ပါသည်—

- worktree သန့်ရှင်းရမည်။
- ရွေးချယ်ထားသော channel (tag သို့မဟုတ် branch) သို့ ပြောင်းပါသည်။
- upstream (dev channel) ကို fetch + rebase လုပ်ပါသည်။
- deps install လုပ်ပြီး build လုပ်ကာ Control UI ကို build လုပ်ပြီး `openclaw doctor` ကို chạy လုပ်ပါသည်။
- default အနေဖြင့် Gateway ကို restart လုပ်ပါသည် (`--no-restart` ကို သုံးပါက skip လုပ်နိုင်ပါသည်)။

**npm/pnpm** ဖြင့် install လုပ်ထားပါက (git metadata မရှိပါ) `openclaw update` သည် သင်၏ package manager မှတစ်ဆင့် update လုပ်ရန် ကြိုးစားပါမည်။ install ကို မဖော်ထုတ်နိုင်ပါက “Update (global install)” ကို အသုံးပြုပါ။

## အပ်ဒိတ် (Control UI / RPC)

Control UI တွင် **Update & Restart** (RPC: `update.run`) ရှိပါသည်။ ၎င်းသည်—

1. `openclaw update` နှင့်တူသော source-update flow ကို chạy လုပ်ပါသည် (git checkout အတွက်သာ)။
2. stdout/stderr tail ပါဝင်သည့် structured report ဖြင့် restart sentinel ကို ရေးသားပါသည်။
3. Gateway ကို restart လုပ်ပြီး နောက်ဆုံး active session သို့ report ကို ping လုပ်ပါသည်။

rebase မအောင်မြင်ပါက Gateway သည် အပ်ဒိတ်ကို မအသုံးချဘဲ abort လုပ်ကာ restart လုပ်ပါမည်။

## အပ်ဒိတ် (source မှ)

repo checkout မှ—

အကြံပြု—

```bash
openclaw update
```

Manual (အနည်းငယ်တူညီ)—

```bash
git pull
pnpm install
pnpm build
pnpm ui:build # auto-installs UI deps on first run
openclaw doctor
openclaw health
```

မှတ်ချက်များ—

- packaged `openclaw` binary ([`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs)) ကို chạy လုပ်နေပါက သို့မဟုတ် Node ဖြင့် `dist/` ကို chạy လုပ်ပါက `pnpm build` သည် အရေးကြီးပါသည်။
- global install မရှိဘဲ repo checkout မှ chạy နေပါက CLI command များအတွက် `pnpm openclaw ...` ကို အသုံးပြုပါ။
- TypeScript မှ တိုက်ရိုက် chạy နေပါက (`pnpm openclaw ...`) rebuild မလိုအပ်သည့်အခါများရှိသော်လည်း **config migration များသည် မဖြစ်မနေ သက်ရောက်ပါသည်** → doctor ကို chạy လုပ်ပါ။
- global နှင့် git installs အကြား ပြောင်းရန် လွယ်ကူပါသည်—အခြား flavor ကို install လုပ်ပြီးနောက် gateway service entrypoint ကို လက်ရှိ install သို့ ပြန်ရေးရန် `openclaw doctor` ကို chạy လုပ်ပါ။

## အမြဲ chạy လုပ်ပါ: `openclaw doctor`

Doctor သည် “လုံခြုံသော အပ်ဒိတ်” command ဖြစ်ပါသည်။ ရည်ရွယ်ချက်မှာ ပျင်းစရာကောင်းအောင်—repair + migrate + warn—သာ ဖြစ်ပါသည်။

မှတ်ချက်: **source install** (git checkout) ပေါ်တွင် ရှိပါက `openclaw doctor` သည် ပထမဦးစွာ `openclaw update` ကို chạy လုပ်ရန် အကြံပြုပါမည်။

ပုံမှန် ဆောင်ရွက်သည့် အရာများ—

- deprecated config keys များ / legacy config ဖိုင်တည်နေရာများကို migrate လုပ်ပါသည်။
- DM policy များကို audit လုပ်ပြီး အန္တရာယ်ရှိသော “open” settings များအတွက် သတိပေးပါသည်။
- Gateway health ကို စစ်ဆေးပြီး restart လုပ်ရန် အကြံပြုနိုင်ပါသည်။
- အဟောင်း gateway services များ (launchd/systemd; legacy schtasks) ကို လက်ရှိ OpenClaw services သို့ ရှာဖွေတွေ့ရှိ၍ migrate လုပ်ပါသည်။
- Linux တွင် systemd user lingering ကို သေချာစေပါသည် (logout ပြုလုပ်ပြီးနောက် Gateway ဆက်လက် chạy နိုင်ရန်)။

အသေးစိတ်: [Doctor](/gateway/doctor)

## Gateway ကို စတင် / ရပ်တန့် / ပြန်လည်စတင်

CLI (OS မရွေး အသုံးပြုနိုင်သည်)—

```bash
openclaw gateway status
openclaw gateway stop
openclaw gateway restart
openclaw gateway --port 18789
openclaw logs --follow
```

supervised ဖြစ်ပါက—

- macOS launchd (app-bundled LaunchAgent): `launchctl kickstart -k gui/$UID/bot.molt.gateway` (`bot.molt.<profile>` ကို အသုံးပြုပါ; legacy `com.openclaw.*` သည် ဆက်လက် အသုံးပြုနိုင်ပါသည်)
- Linux systemd user service: `systemctl --user restart openclaw-gateway[-<profile>].service`
- Windows (WSL2): `systemctl --user restart openclaw-gateway[-<profile>].service`
  - `launchctl`/`systemctl` သည် service install လုပ်ထားပါကသာ အလုပ်လုပ်ပါသည်; မရှိပါက `openclaw gateway install` ကို chạy လုပ်ပါ။

Runbook နှင့် တိကျသော service labels များ: [Gateway runbook](/gateway)

## Rollback / pinning (တစ်ခုခု ပျက်သွားသောအခါ)

### Pin (global install)

အလုပ်လုပ်နေခဲ့သော version ကို install လုပ်ပါ (`<version>` ကို နောက်ဆုံး အလုပ်လုပ်ခဲ့သည့် version ဖြင့် အစားထိုးပါ)—

```bash
npm i -g openclaw@<version>
```

```bash
pnpm add -g openclaw@<version>
```

အကြံပြုချက်: လက်ရှိ publish လုပ်ထားသော version ကို ကြည့်ရန် `npm view openclaw version` ကို chạy လုပ်ပါ။

ထို့နောက် restart လုပ်ပြီး doctor ကို ပြန် chạy လုပ်ပါ—

```bash
openclaw doctor
openclaw gateway restart
```

### Pin (source) ကို ရက်စွဲအလိုက်

ရက်စွဲတစ်ခုမှ commit ကို ရွေးပါ (ဥပမာ—“2026-01-01 အချိန်အထိ main ၏ အခြေအနေ”)—

```bash
git fetch origin
git checkout "$(git rev-list -n 1 --before=\"2026-01-01\" origin/main)"
```

ထို့နောက် deps ကို ပြန် install လုပ်ပြီး restart—

```bash
pnpm install
pnpm build
openclaw gateway restart
```

နောက်ပိုင်း latest သို့ ပြန်လိုပါက—

```bash
git checkout main
git pull
```

## အကူအညီလိုအပ်နေပါက

- `openclaw doctor` ကို ထပ်မံ chạy လုပ်ပြီး output ကို သေချာဖတ်ပါ (အများအားဖြင့် ပြုပြင်နည်းကို ပြောပြထားတတ်ပါသည်)။
- စစ်ဆေးရန်: [Troubleshooting](/gateway/troubleshooting)
- Discord တွင် မေးမြန်းပါ: [https://discord.gg/clawd](https://discord.gg/clawd)
