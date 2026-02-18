---
summary: "packaging scripts ဖြင့် ထုတ်လုပ်သော macOS debug builds များအတွက် signing အဆင့်များ"
read_when:
  - mac debug builds များကို တည်ဆောက်ခြင်း သို့မဟုတ် signing ပြုလုပ်သောအခါ
title: "macOS Signing"
---

# mac signing (debug builds)

ဤ app ကို ပုံမှန်အားဖြင့် [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) မှ တည်ဆောက်ကြပြီး၊ ယခုအခါ အောက်ပါအရာများကို လုပ်ဆောင်ပါသည်–

- တည်ငြိမ်သော debug bundle identifier ကို သတ်မှတ်သည်: `ai.openclaw.mac.debug`
- ထို bundle id ဖြင့် Info.plist ကို ရေးသားသည် (`BUNDLE_ID=...` ဖြင့် override လုပ်နိုင်သည်)
- `scripts/codesign-mac-app.sh` ကို ခေါ်၍ main binary နှင့် app bundle ကို sign လုပ်ပြီး macOS က rebuild တစ်ကြိမ်ချင်းကို တူညီသော signed bundle အဖြစ် သတ်မှတ်စေကာ TCC permission များ (notifications, accessibility, screen recording, mic, speech) ကို ထိန်းသိမ်းထားနိုင်စေပါသည်။ Permission များ တည်ငြိမ်စေရန် အမှန်တကယ် signing identity ကို အသုံးပြုပါ; ad-hoc သည် opt-in လုပ်ရပြီး မတည်ငြိမ်ပါ ( [macOS permissions](/platforms/mac/permissions) ကို ကြည့်ပါ)။
- မူလအားဖြင့် `CODESIGN_TIMESTAMP=auto` ကို အသုံးပြုပါသည်; Developer ID signature များအတွက် trusted timestamp များကို ဖွင့်ပေးပါသည်။ Set `CODESIGN_TIMESTAMP=off` to skip timestamping (offline debug builds).
- build metadata ကို Info.plist ထဲသို့ ထည့်သွင်းသည်: `OpenClawBuildTimestamp` (UTC) နှင့် `OpenClawGitCommit` (short hash) — ထိုကြောင့် About pane တွင် build, git နှင့် debug/release channel ကို ပြသနိုင်သည်
- **Packaging အတွက် Node 22+ လိုအပ်သည်**: script သည် TS builds နှင့် Control UI build ကို လည်ပတ်စေသည်
- Environment မှ `SIGN_IDENTITY` ကို ဖတ်ပါသည်။ သင့် shell rc ထဲသို့ `export SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"` (သို့မဟုတ် Developer ID Application cert) ကို ထည့်၍ အမြဲတမ်း သင့် cert ဖြင့် sign လုပ်နိုင်ပါသည်။ Ad-hoc signing သည် `ALLOW_ADHOC_SIGNING=1` သို့မဟုတ် `SIGN_IDENTITY="-"` ဖြင့် အထူး opt-in လုပ်ရန် လိုအပ်ပါသည် (permission testing အတွက် မအကြံပြုပါ)။
- Signing ပြီးနောက် Team ID audit ကို chạy လုပ်ပြီး app bundle အတွင်းရှိ Mach-O မည်သည့်အရာမဆို Team ID မတူပါက fail ဖြစ်ပါသည်။ Bypass လုပ်လိုပါက `SKIP_TEAM_ID_CHECK=1` ကို သတ်မှတ်ပါ။

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

`SIGN_IDENTITY="-"` (ad-hoc) ဖြင့် sign လုပ်သောအခါ script သည် **Hardened Runtime** (`--options runtime`) ကို အလိုအလျောက် ပိတ်ပါသည်။ Team ID မတူညီသော embedded framework များ (ဥပမာ Sparkle) ကို app က load လုပ်ရာတွင် crash မဖြစ်စေရန် ဤအရာ လိုအပ်ပါသည်။ Ad-hoc signature များသည် TCC permission များ ဆက်လက်တည်ရှိမှုကိုလည်း ဖျက်စီးပါသည်; ပြန်လည်ပြုပြင်ရန် အဆင့်များအတွက် [macOS permissions](/platforms/mac/permissions) ကို ကြည့်ပါ။

## About အတွက် Build metadata

`package-mac-app.sh` သည် bundle ကို အောက်ပါအချက်များဖြင့် stamp လုပ်ပါသည်–

- `OpenClawBuildTimestamp`: package လုပ်ချိန်တွင် ISO8601 UTC
- `OpenClawGitCommit`: short git hash (မရရှိပါက `unknown`)

About tab သည် version, build date, git commit နှင့် debug build ဟုတ်မဟုတ် (`#if DEBUG` မှတစ်ဆင့်) ကို ပြရန် ဤ key များကို ဖတ်ပါသည်။ Code ပြောင်းလဲပြီးနောက် ဤတန်ဖိုးများကို ပြန်လည်အသစ်လုပ်ရန် packager ကို chạy ပါ။

## Why

TCC permission များသည် bundle identifier **နှင့်** code signature နှစ်ခုစလုံးနှင့် ချိတ်ဆက်ထားပါသည်။ UUID မပြောင်းလဲဘဲ မထိုးထားသော debug build များကြောင့် macOS သည် rebuild တစ်ကြိမ်စီတိုင်း permissions (grants) များကို မေ့လျော့နေခဲ့သည်။ Binary များကို sign လုပ်ခြင်း (ပုံမှန်အားဖြင့် ad‑hoc) နှင့် bundle id/path (`dist/OpenClaw.app`) ကို တည်ငြိမ်စွာ ထားရှိခြင်းက build များအကြား grants များကို ထိန်းသိမ်းပေးပြီး VibeTunnel နည်းလမ်းနှင့် ကိုက်ညီစေသည်။
