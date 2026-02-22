---
summary: "macOS အက်ပ်တွင် ဖော်ရွေသော အမည်များအတွက် Apple စက်ပစ္စည်း မော်ဒယ် အိုင်ဒီဖိုင်ယာများကို OpenClaw က မည်သို့ ပံ့ပိုးပေးထားသည်ကို ဖော်ပြထားသည်။"
read_when:
  - စက်ပစ္စည်း မော်ဒယ် အိုင်ဒီဖိုင်ယာ မပ်ပင်များ သို့မဟုတ် NOTICE/လိုင်စင် ဖိုင်များကို အပ်ဒိတ်လုပ်သည့်အခါ
  - Instances UI တွင် စက်ပစ္စည်း အမည်များ ပြသပုံကို ပြောင်းလဲသည့်အခါ
title: "Device Model Database"
---

# Device model database (friendly names)

macOS အတွက် အတူတကွ အသုံးပြုသော အက်ပ်သည် Apple မော်ဒယ် အိုင်ဒီဖိုင်ယာများ (ဥပမာ `iPad16,6`, `Mac16,6`) ကို လူဖတ်ရှုနိုင်သော အမည်များနှင့် မပ်ပင်လုပ်ခြင်းအားဖြင့် **Instances** UI တွင် ဖော်ရွေသော Apple စက်ပစ္စည်း မော်ဒယ် အမည်များကို ပြသပါသည်။

ဤမပ်ပင်ကို အောက်ပါလမ်းကြောင်းအောက်တွင် JSON အဖြစ် vendored လုပ်ထားပါသည်—

- `apps/macos/Sources/OpenClaw/Resources/DeviceModels/`

## Data source

လက်ရှိတွင် MIT လိုင်စင်ဖြင့် ထုတ်ပေးထားသော အောက်ပါ repository မှ မပ်ပင်ကို vendored လုပ်ထားပါသည်—

- `kyle-seongwoo-jun/apple-device-identifiers`

build များကို deterministic ဖြစ်စေရန်အတွက် JSON ဖိုင်များကို အထက်စီး (upstream) commit များသတ်မှတ်၍ pin လုပ်ထားပါသည် ( `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md` တွင် မှတ်တမ်းတင်ထားသည်)။

## Updating the database

1. pin လုပ်လိုသော upstream commit များကို ရွေးချယ်ပါ (iOS အတွက် တစ်ခု၊ macOS အတွက် တစ်ခု)။
2. `apps/macos/Sources/OpenClaw/Resources/DeviceModels/NOTICE.md` တွင် commit hash များကို အပ်ဒိတ်လုပ်ပါ။
3. ထို commit များသို့ pin လုပ်ထားသော JSON ဖိုင်များကို ပြန်လည်ဒေါင်းလုပ်လုပ်ပါ—

```bash
IOS_COMMIT="<commit sha for ios-device-identifiers.json>"
MAC_COMMIT="<commit sha for mac-device-identifiers.json>"

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${IOS_COMMIT}/ios-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/ios-device-identifiers.json

curl -fsSL "https://raw.githubusercontent.com/kyle-seongwoo-jun/apple-device-identifiers/${MAC_COMMIT}/mac-device-identifiers.json" \
  -o apps/macos/Sources/OpenClaw/Resources/DeviceModels/mac-device-identifiers.json
```

4. `apps/macos/Sources/OpenClaw/Resources/DeviceModels/LICENSE.apple-device-identifiers.txt` သည် upstream နှင့် ဆက်လက်ကိုက်ညီနေကြောင်း သေချာစစ်ဆေးပါ (upstream လိုင်စင် ပြောင်းလဲပါက အစားထိုးပါ)။
5. macOS အက်ပ်ကို သန့်ရှင်းစွာ build လုပ်နိုင်ကြောင်း (warning မရှိကြောင်း) စစ်ဆေးပါ—

```bash
swift build --package-path apps/macos
```
