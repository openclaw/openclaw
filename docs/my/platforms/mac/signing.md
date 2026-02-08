---
summary: "packaging scripts ဖြင့် ထုတ်လုပ်သော macOS debug builds များအတွက် signing အဆင့်များ"
read_when:
  - mac debug builds များကို တည်ဆောက်ခြင်း သို့မဟုတ် signing ပြုလုပ်သောအခါ
title: "macOS Signing"
x-i18n:
  source_path: platforms/mac/signing.md
  source_hash: 403b92f9a0ecdb7c
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:54:47Z
---

# mac signing (debug builds)

ဤ app ကို ပုံမှန်အားဖြင့် [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) မှ တည်ဆောက်ကြပြီး၊ ယခုအခါ အောက်ပါအရာများကို လုပ်ဆောင်ပါသည်–

- တည်ငြိမ်သော debug bundle identifier ကို သတ်မှတ်သည်: `ai.openclaw.mac.debug`
- ထို bundle id ဖြင့် Info.plist ကို ရေးသားသည် (`BUNDLE_ID=...` ဖြင့် override လုပ်နိုင်သည်)
- [`scripts/codesign-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/codesign-mac-app.sh) ကို ခေါ်ပြီး main binary နှင့် app bundle ကို sign လုပ်သည်။ ထိုသို့လုပ်ခြင်းဖြင့် macOS သည် rebuild တစ်ကြိမ်စီကို တူညီသော signed bundle အဖြစ် သတ်မှတ်ပြီး TCC ခွင့်ပြုချက်များ (notifications, accessibility, screen recording, mic, speech) ကို ထိန်းသိမ်းထားနိုင်သည်။ ခွင့်ပြုချက်များကို တည်ငြိမ်စေရန် အမှန်တကယ်သော signing identity ကို အသုံးပြုပါ။ ad-hoc signing သည် opt-in ဖြစ်ပြီး မခိုင်မာပါ ( [macOS permissions](/platforms/mac/permissions) ကို ကြည့်ပါ)
- ပုံမှန်အားဖြင့် `CODESIGN_TIMESTAMP=auto` ကို အသုံးပြုသည်။ ၎င်းသည် Developer ID signatures အတွက် trusted timestamps ကို ဖွင့်ပေးသည်။ timestamping ကို ကျော်ရန် (offline debug builds အတွက်) `CODESIGN_TIMESTAMP=off` ကို သတ်မှတ်ပါ
- build metadata ကို Info.plist ထဲသို့ ထည့်သွင်းသည်: `OpenClawBuildTimestamp` (UTC) နှင့် `OpenClawGitCommit` (short hash) — ထိုကြောင့် About pane တွင် build, git နှင့် debug/release channel ကို ပြသနိုင်သည်
- **Packaging အတွက် Node 22+ လိုအပ်သည်**: script သည် TS builds နှင့် Control UI build ကို လည်ပတ်စေသည်
- environment မှ `SIGN_IDENTITY` ကို ဖတ်ယူသည်။ သင့် shell rc ထဲသို့ `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (သို့မဟုတ် သင့် Developer ID Application cert) ကို ထည့်သွင်းပါက သင့် cert ဖြင့် အမြဲ sign လုပ်နိုင်ပါသည်။ ad-hoc signing အတွက် `ALLOW_ADHOC_SIGNING=1` သို့မဟုတ် `SIGN_IDENTITY="-"` ဖြင့် အထူးသဘောတူညီချက် ပေးရပါသည် (permission testing အတွက် မအကြံပြုပါ)
- signing ပြီးနောက် Team ID audit ကို လည်ပတ်ပြီး app bundle အတွင်းရှိ Mach-O တစ်ခုခုကို မတူညီသော Team ID ဖြင့် sign လုပ်ထားပါက မအောင်မြင်အဖြစ် သတ်မှတ်သည်။ ကျော်ရန် `SKIP_TEAM_ID_CHECK=1` ကို သတ်မှတ်ပါ

## Usage

```bash
# from repo root
scripts/package-mac-app.sh               # auto-selects identity; errors if none found
SIGN_IDENTITY="Developer ID Application: Your Name" scripts/package-mac-app.sh   # real cert
ALLOW_ADHOC_SIGNING=1 scripts/package-mac-app.sh    # ad-hoc (permissions will not stick)
SIGN_IDENTITY="-" scripts/package-mac-app.sh        # explicit ad-hoc (same caveat)
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh   # dev-only Sparkle Team ID mismatch workaround
```

### Ad-hoc Signing Note

`SIGN_IDENTITY="-"` (ad-hoc) ဖြင့် sign လုပ်သောအခါ script သည် **Hardened Runtime** (`--options runtime`) ကို အလိုအလျောက် ပိတ်ပေးသည်။ ထိုသို့မလုပ်ပါက Team ID တူညီမှု မရှိသော embedded frameworks (Sparkle ကဲ့သို့) ကို app က load လုပ်ရန် ကြိုးစားသည့်အခါ crash ဖြစ်နိုင်ပါသည်။ ad-hoc signatures များကြောင့် TCC permission များ ဆက်လက်တည်ရှိမှု ပျက်စီးသွားနိုင်ပါသည်။ ပြန်လည်ပြုပြင်ရန် အဆင့်များအတွက် [macOS permissions](/platforms/mac/permissions) ကို ကြည့်ပါ။

## About အတွက် Build metadata

`package-mac-app.sh` သည် bundle ကို အောက်ပါအချက်များဖြင့် stamp လုပ်ပါသည်–

- `OpenClawBuildTimestamp`: package လုပ်ချိန်တွင် ISO8601 UTC
- `OpenClawGitCommit`: short git hash (မရရှိပါက `unknown`)

About tab သည် ဤ keys များကို ဖတ်ယူပြီး version, build date, git commit နှင့် debug build ဟုတ်/မဟုတ် (`#if DEBUG` ဖြင့်) ကို ပြသပါသည်။ code ပြောင်းလဲပြီးနောက် ဤတန်ဖိုးများကို အသစ်ပြန်ဖြစ်စေရန် packager ကို လည်ပတ်ပါ။

## Why

TCC ခွင့်ပြုချက်များသည် bundle identifier _နှင့်_ code signature နှစ်ခုလုံးနှင့် ချိတ်ဆက်ထားပါသည်။ UUID များ ပြောင်းလဲနေသော unsigned debug builds များကြောင့် rebuild တစ်ကြိမ်စီအပြီး macOS က ခွင့်ပြုချက်များကို မေ့လျော့သွားခဲ့ပါသည်။ binaries များကို sign လုပ်ခြင်း (ပုံမှန်အားဖြင့် ad‑hoc) နှင့် တည်ငြိမ်သော bundle id/path (`dist/OpenClaw.app`) ကို ထိန်းသိမ်းထားခြင်းဖြင့် builds များအကြား ခွင့်ပြုချက်များကို ဆက်လက်ထိန်းသိမ်းနိုင်ပြီး VibeTunnel ၏ လမ်းကြောင်းနှင့် ကိုက်ညီပါသည်။
