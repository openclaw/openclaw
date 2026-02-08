---
summary: "Nix ဖြင့် OpenClaw ကို ကြေညာပုံစံ (declarative) အတိုင်း ထည့်သွင်းတပ်ဆင်ခြင်း"
read_when:
  - "ပြန်လည်ထုတ်ပြန်နိုင်ပြီး rollback လုပ်နိုင်သော ထည့်သွင်းတပ်ဆင်မှုများ လိုအပ်သောအခါ"
  - "Nix/NixOS/Home Manager ကို အစရှိနေပြီး အသုံးပြုနေသူများအတွက်"
  - "အရာအားလုံးကို pin လုပ်ပြီး declarative အနေဖြင့် စီမံခန့်ခွဲလိုသောအခါ"
title: "Nix"
x-i18n:
  source_path: install/nix.md
  source_hash: f1452194cfdd7461
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:33Z
---

# Nix ထည့်သွင်းတပ်ဆင်ခြင်း

Nix ဖြင့် OpenClaw ကို လည်ပတ်စေဖို့ အကြံပြုထားသော နည်းလမ်းမှာ **[nix-openclaw](https://github.com/openclaw/nix-openclaw)** — batteries-included Home Manager module ကို အသုံးပြုခြင်းဖြစ်သည်။

## အမြန်စတင်ရန်

ဒီစာကို သင့် AI agent (Claude, Cursor စသည်) ထဲသို့ ကူးထည့်ပါ:

```text
I want to set up nix-openclaw on my Mac.
Repository: github:openclaw/nix-openclaw

What I need you to do:
1. Check if Determinate Nix is installed (if not, install it)
2. Create a local flake at ~/code/openclaw-local using templates/agent-first/flake.nix
3. Help me create a Telegram bot (@BotFather) and get my chat ID (@userinfobot)
4. Set up secrets (bot token, Anthropic key) - plain files at ~/.secrets/ is fine
5. Fill in the template placeholders and run home-manager switch
6. Verify: launchd running, bot responds to messages

Reference the nix-openclaw README for module options.
```

> **📦 လမ်းညွှန်အပြည့်အစုံ: [github.com/openclaw/nix-openclaw](https://github.com/openclaw/nix-openclaw)**
>
> nix-openclaw repo သည် Nix ထည့်သွင်းတပ်ဆင်မှုအတွက် အမှန်တကယ် ယုံကြည်စိတ်ချရသော အရင်းအမြစ်ဖြစ်သည်။ ဤစာမျက်နှာသည် အကျဉ်းချုပ် အမြင်သာပေးရန်သာ ဖြစ်သည်။

## သင်ရရှိမည့်အရာများ

- Gateway + macOS app + tools (whisper, spotify, cameras) — အားလုံးကို pin လုပ်ထားသည်
- reboot လုပ်ပြီးနောက်တောင် ဆက်လက်လည်ပတ်နေမည့် Launchd service
- declarative config ဖြင့် plugin စနစ်
- ချက်ချင်း rollback လုပ်နိုင်ခြင်း: `home-manager switch --rollback`

---

## Nix Mode Runtime အပြုအမူ

`OPENCLAW_NIX_MODE=1` ကို သတ်မှတ်ထားသောအခါ (nix-openclaw ဖြင့် အလိုအလျောက် သတ်မှတ်သည်):

OpenClaw သည် **Nix mode** ကို ပံ့ပိုးပြီး configuration ကို တိကျသေချာစေကာ auto-install flow များကို ပိတ်ထားသည်။
အောက်ပါအတိုင်း export လုပ်၍ ဖွင့်နိုင်သည်—

```bash
OPENCLAW_NIX_MODE=1
```

macOS တွင် GUI app သည် shell env vars များကို အလိုအလျောက် မယူဆောင်ပါ။ ထို့ကြောင့်
defaults ဖြင့် Nix mode ကိုလည်း ဖွင့်နိုင်သည်—

```bash
defaults write bot.molt.mac openclaw.nixMode -bool true
```

### Config + state လမ်းကြောင်းများ

OpenClaw သည် JSON5 config ကို `OPENCLAW_CONFIG_PATH` မှ ဖတ်ပြီး ပြောင်းလဲနိုင်သော ဒေတာများကို `OPENCLAW_STATE_DIR` တွင် သိမ်းဆည်းသည်။

- `OPENCLAW_STATE_DIR` (default: `~/.openclaw`)
- `OPENCLAW_CONFIG_PATH` (default: `$OPENCLAW_STATE_DIR/openclaw.json`)

Nix အောက်တွင် လည်ပတ်စဉ် runtime state နှင့် config များကို immutable store မှ ခွဲထုတ်ထားနိုင်ရန်
ဤတန်ဖိုးများကို Nix စီမံခန့်ခွဲထားသော လမ်းကြောင်းများသို့ သီးသန့် သတ်မှတ်ပါ။

### Nix mode တွင် Runtime အပြုအမူ

- Auto-install နှင့် self-mutation flow များကို ပိတ်ထားသည်
- မရှိသော dependency များအတွက် Nix အထူး remediation မက်ဆေ့ချ်များကို ပြသသည်
- ရှိပါက UI တွင် read-only Nix mode banner ကို ပြသသည်

## Packaging မှတ်ချက် (macOS)

macOS packaging flow သည် တည်ငြိမ်သော Info.plist template ကို အောက်ပါနေရာတွင် မျှော်မှန်းထားသည်—

```
apps/macos/Sources/OpenClaw/Resources/Info.plist
```

[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) သည် ဤ template ကို app bundle ထဲသို့ ကူးထည့်ပြီး dynamic fields များ
(bundle ID, version/build, Git SHA, Sparkle keys) ကို patch လုပ်သည်။ ထို့ကြောင့် SwiftPM
packaging နှင့် Nix builds (Xcode toolchain အပြည့်အစုံကို မမှီခိုသော) အတွက် plist ကို deterministic အနေဖြင့် ထိန်းသိမ်းထားနိုင်သည်။

## ဆက်စပ်အရာများ

- [nix-openclaw](https://github.com/openclaw/nix-openclaw) — setup လမ်းညွှန်အပြည့်အစုံ
- [Wizard](/start/wizard) — Nix မဟုတ်သော CLI setup
- [Docker](/install/docker) — containerized setup
