---
summary: "Nix ဖြင့် OpenClaw ကို ကြေညာပုံစံ (declarative) အတိုင်း ထည့်သွင်းတပ်ဆင်ခြင်း"
read_when:
  - ပြန်လည်ထုတ်ပြန်နိုင်ပြီး rollback လုပ်နိုင်သော ထည့်သွင်းတပ်ဆင်မှုများ လိုအပ်သောအခါ
  - Nix/NixOS/Home Manager ကို အစရှိနေပြီး အသုံးပြုနေသူများအတွက်
  - အရာအားလုံးကို pin လုပ်ပြီး declarative အနေဖြင့် စီမံခန့်ခွဲလိုသောအခါ
title: "Nix"
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
> The nix-openclaw repo is the source of truth for Nix installation. This page is just a quick overview.

## သင်ရရှိမည့်အရာများ

- Gateway + macOS app + tools (whisper, spotify, cameras) — အားလုံးကို pin လုပ်ထားသည်
- reboot လုပ်ပြီးနောက်တောင် ဆက်လက်လည်ပတ်နေမည့် Launchd service
- declarative config ဖြင့် plugin စနစ်
- ချက်ချင်း rollback လုပ်နိုင်ခြင်း: `home-manager switch --rollback`

---

## Nix Mode Runtime အပြုအမူ

`OPENCLAW_NIX_MODE=1` ကို သတ်မှတ်ထားသောအခါ (nix-openclaw ဖြင့် အလိုအလျောက် သတ်မှတ်သည်):

OpenClaw supports a **Nix mode** that makes configuration deterministic and disables auto-install flows.
Enable it by exporting:

```bash
OPENCLAW_NIX_MODE=1
```

On macOS, the GUI app does not automatically inherit shell env vars. You can
also enable Nix mode via defaults:

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

[`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) က ဒီ template ကို app bundle ထဲ ကူးထည့်ပြီး dynamic fields တွေ (bundle ID, version/build, Git SHA, Sparkle keys) ကို patch လုပ်ပါတယ်။ This keeps the plist deterministic for SwiftPM
packaging and Nix builds (which do not rely on a full Xcode toolchain).

## ဆက်စပ်အရာများ

- [nix-openclaw](https://github.com/openclaw/nix-openclaw) — setup လမ်းညွှန်အပြည့်အစုံ
- [Wizard](/start/wizard) — Nix မဟုတ်သော CLI setup
- [Docker](/install/docker) — containerized setup
