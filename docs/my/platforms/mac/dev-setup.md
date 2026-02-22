---
summary: "OpenClaw macOS အက်ပ်ပေါ်တွင် လုပ်ကိုင်နေသော developer များအတွက် တပ်ဆင်မှု လမ်းညွှန်"
read_when:
  - macOS ဖွံ့ဖြိုးရေး ပတ်ဝန်းကျင်ကို တပ်ဆင်နေစဉ်
title: "macOS Dev Setup"
---

# macOS Developer Setup

ဤလမ်းညွှန်တွင် OpenClaw macOS အက်ပ်ကို source မှ တည်ဆောက်ပြီး လည်ပတ်ရန် လိုအပ်သော အဆင့်များကို ဖော်ပြထားပါသည်။

## Prerequisites

အက်ပ်ကို တည်ဆောက်မည်မတိုင်မီ အောက်ပါအရာများကို ထည့်သွင်းထားကြောင်း သေချာပါစေ။

1. **Xcode 26.2+**: Swift ဖွံ့ဖြိုးရေးအတွက် လိုအပ်သည်။
2. **Node.js 22+ & pnpm**: Gateway၊ CLI နှင့် packaging script များအတွက် လိုအပ်သည်။

## 49) 1) 50) Dependency များ ထည့်သွင်းခြင်း

ပရောဂျက်အနှံ့ အသုံးပြုသော dependency များကို ထည့်သွင်းပါ။

```bash
pnpm install
```

## 1. 2. 2. အက်ပ်ကို Build လုပ်ပြီး Package ပြုလုပ်ပါ

macOS အက်ပ်ကို build လုပ်ပြီး `dist/OpenClaw.app` အဖြစ် package ပြုလုပ်ရန် အောက်ပါအမိန့်ကို 실행ပါ။

```bash
./scripts/package-mac-app.sh
```

Apple Developer ID certificate မရှိပါက script သည် **ad-hoc signing** (`-`) ကို အလိုအလျောက် အသုံးပြုမည်ဖြစ်သည်။

dev run mode များ၊ signing flag များ နှင့် Team ID ဆိုင်ရာ ပြဿနာဖြေရှင်းနည်းများအတွက် macOS app README ကို ကြည့်ပါ။
[https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md](https://github.com/openclaw/openclaw/blob/main/apps/macos/README.md)

> 3. **မှတ်ချက်**: Ad-hoc signed အက်ပ်များသည် လုံခြုံရေး သတိပေးချက်များ ပေါ်လာစေနိုင်ပါသည်။ 4. အက်ပ်သည် "Abort trap 6" ဖြင့် ချက်ချင်း crash ဖြစ်ပါက [Troubleshooting](#troubleshooting) အပိုင်းကို ကြည့်ပါ။

## 5. 3. CLI ကို ထည့်သွင်းခြင်း

macOS အက်ပ်သည် နောက်ခံ လုပ်ငန်းများကို စီမံခန့်ခွဲရန် global `openclaw` CLI ကို ထည့်သွင်းထားရန် မျှော်မှန်းထားပါသည်။

**ထည့်သွင်းရန် (အကြံပြုထားသည်):**

1. OpenClaw အက်ပ်ကို ဖွင့်ပါ။
2. **General** settings tab သို့ သွားပါ။
3. **"Install CLI"** ကို နှိပ်ပါ။

အခြားနည်းလမ်းအနေဖြင့် လက်ဖြင့် ထည့်သွင်းနိုင်ပါသည်။

```bash
npm install -g openclaw@<version>
```

## Troubleshooting

### Build Fails: Toolchain or SDK Mismatch

macOS အက်ပ် build လုပ်ရာတွင် နောက်ဆုံး macOS SDK နှင့် Swift 6.2 toolchain ကို မျှော်မှန်းထားပါသည်။

**System dependencies (လိုအပ်သည်):**

- **Software Update တွင် ရရှိနိုင်သော နောက်ဆုံး macOS ဗားရှင်း** (Xcode 26.2 SDK များအတွက် လိုအပ်သည်)
- **Xcode 26.2** (Swift 6.2 toolchain)

**စစ်ဆေးရန်:**

```bash
xcodebuild -version
xcrun swift --version
```

ဗားရှင်းများ မကိုက်ညီပါက macOS/Xcode ကို update လုပ်ပြီး build ကို ထပ်မံ 실행ပါ။

### App Crashes on Permission Grant

**Speech Recognition** သို့မဟုတ် **Microphone** ဝင်ရောက်ခွင့်ကို ခွင့်ပြုရန် ကြိုးစားစဉ် အက်ပ်ပျက်သွားပါက TCC cache ပျက်စီးနေခြင်း သို့မဟုတ် signature မကိုက်ညီခြင်းကြောင့် ဖြစ်နိုင်ပါသည်။

**ဖြေရှင်းနည်း:**

1. TCC ခွင့်ပြုချက်များကို reset ပြုလုပ်ပါ။

   ```bash
   tccutil reset All bot.molt.mac.debug
   ```

2. အထက်ပါနည်းလမ်း မအောင်မြင်ပါက macOS တွင် "clean slate" ရရှိစေရန် [`scripts/package-mac-app.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/package-mac-app.sh) အတွင်းရှိ `BUNDLE_ID` ကို ယာယီ ပြောင်းလဲပါ။

### Gateway "Starting..." indefinitely

6. Gateway status သည် "Starting..." မှာပဲ ရပ်နေပါက zombie process တစ်ခုက port ကို ထိန်းထားနေခြင်း ရှိ/မရှိ စစ်ဆေးပါ။

```bash
openclaw gateway status
openclaw gateway stop

# If you’re not using a LaunchAgent (dev mode / manual runs), find the listener:
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

7. Manual run တစ်ခုက port ကို ထိန်းထားနေပါက ထို process ကို ရပ်တန့်ပါ (Ctrl+C)။ 8. နောက်ဆုံးနည်းလမ်းအဖြစ် အထက်တွင် တွေ့ထားသော PID ကို kill လုပ်ပါ။
