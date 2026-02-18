---
summary: "အေးဂျင့်အသုံးပြုရန်အတွက် ကင်မရာဖမ်းယူမှု (iOS နိုဒ် + macOS အက်ပ်): ဓာတ်ပုံများ (jpg) နှင့် အတိုချုပ် ဗီဒီယိုကလစ်များ (mp4)"
read_when:
  - iOS နိုဒ်များ သို့မဟုတ် macOS တွင် ကင်မရာဖမ်းယူမှုကို ထည့်သွင်းခြင်း သို့မဟုတ် ပြင်ဆင်ခြင်း ပြုလုပ်နေစဉ်
  - အေးဂျင့်မှ ဝင်ရောက်အသုံးပြုနိုင်သော MEDIA ယာယီဖိုင် လုပ်ငန်းစဉ်များကို တိုးချဲ့နေစဉ်
title: "ကင်မရာ ဖမ်းယူမှု"
---

# ကင်မရာ ဖမ်းယူမှု (အေးဂျင့်)

OpenClaw သည် အေးဂျင့်လုပ်ငန်းစဉ်များအတွက် **ကင်မရာဖမ်းယူမှု** ကို ပံ့ပိုးပေးသည် —

- **iOS နိုဒ်** (Gateway ဖြင့် တွဲဖက်ချိတ်ဆက်ထားသည်): `node.invoke` မှတဆင့် **ဓာတ်ပုံ** (`jpg`) သို့မဟုတ် **အတိုချုပ် ဗီဒီယိုကလစ်** (`mp4`, အသံထည့်သွင်းရန် ရွေးချယ်နိုင်သည်) ကို ဖမ်းယူနိုင်သည်။
- **Android နိုဒ်** (Gateway ဖြင့် တွဲဖက်ချိတ်ဆက်ထားသည်): `node.invoke` မှတဆင့် **ဓာတ်ပုံ** (`jpg`) သို့မဟုတ် **အတိုချုပ် ဗီဒီယိုကလစ်** (`mp4`, အသံထည့်သွင်းရန် ရွေးချယ်နိုင်သည်) ကို ဖမ်းယူနိုင်သည်။
- **macOS အက်ပ်** (Gateway မှတဆင့် နိုဒ်): `node.invoke` မှတဆင့် **ဓာတ်ပုံ** (`jpg`) သို့မဟုတ် **အတိုချုပ် ဗီဒီယိုကလစ်** (`mp4`, အသံထည့်သွင်းရန် ရွေးချယ်နိုင်သည်) ကို ဖမ်းယူနိုင်သည်။

ကင်မရာသုံးစွဲမှုအားလုံးကို **အသုံးပြုသူက ထိန်းချုပ်နိုင်သော ဆက်တင်များ** နောက်ကွယ်တွင်သာ ခွင့်ပြုထားသည်။

## iOS နိုဒ်

### အသုံးပြုသူ ဆက်တင် (ပုံမှန် အဖွင့်)

- iOS Settings တැබ် → **Camera** → **Allow Camera** (`camera.enabled`)
  - ပုံမှန်: **အဖွင့်** (ကီး မရှိပါက ခွင့်ပြုထားသည်ဟု သတ်မှတ်မည်)။
  - ပိတ်ထားပါက: `camera.*` အမိန့်များသည် `CAMERA_DISABLED` ကို ပြန်ပို့မည်။

### အမိန့်များ (Gateway `node.invoke` မှတဆင့်)

- `camera.list`
  - တုံ့ပြန် payload:
    - `devices`: `{ id, name, position, deviceType }` များ၏ array

- `camera.snap`
  - Params:
    - `facing`: `front|back` (ပုံမှန်: `front`)
    - `maxWidth`: number (ရွေးချယ်နိုင်သည်; iOS နိုဒ်တွင် ပုံမှန် `1600`)
    - `quality`: `0..1` (ရွေးချယ်နိုင်သည်; ပုံမှန် `0.9`)
    - `format`: လက်ရှိ `jpg`
    - `delayMs`: number (ရွေးချယ်နိုင်သည်; ပုံမှန် `0`)
    - `deviceId`: string (ရွေးချယ်နိုင်သည်; `camera.list` မှ)
  - တုံ့ပြန် payload:
    - `format: "jpg"`
    - `base64: "<...>"`
    - `width`, `height`
  - Payload ကာကွယ်မှု: base64 payload ကို 5 MB အောက်တွင် ထိန်းသိမ်းရန် ဓာတ်ပုံများကို ပြန်လည်ဖိသိပ်မည်။

- `camera.clip`
  - Params:
    - `facing`: `front|back` (ပုံမှန်: `front`)
    - `durationMs`: number (ပုံမှန် `3000`, အများဆုံး `60000` အထိသာ ချုပ်ထားမည်)
    - `includeAudio`: boolean (ပုံမှန် `true`)
    - `format`: လက်ရှိ `mp4`
    - `deviceId`: string (ရွေးချယ်နိုင်သည်; `camera.list` မှ)
  - တုံ့ပြန် payload:
    - `format: "mp4"`
    - `base64: "<...>"`
    - `durationMs`
    - `hasAudio`

### Foreground လိုအပ်ချက်

`canvas.*` ကဲ့သို့ပင် iOS node သည် **foreground** တွင်သာ `camera.*` command များကို ခွင့်ပြုပါသည်။ background invocation များသည် `NODE_BACKGROUND_UNAVAILABLE` ကို ပြန်လည်ပေးပါသည်။

### CLI အကူအညီ (ယာယီဖိုင်များ + MEDIA)

Attachment များကို ရယူရန် အလွယ်ဆုံးနည်းလမ်းမှာ CLI အကူအညီကို အသုံးပြုခြင်းဖြစ်ပြီး၊ ၎င်းသည် decode ပြုလုပ်ထားသော မီဒီယာကို ယာယီဖိုင်တစ်ခုသို့ ရေးသားပြီး `MEDIA:<path>` ကို ပရင့်ထုတ်ပေးသည်။

ဥပမာများ:

```bash
openclaw nodes camera snap --node <id>               # default: both front + back (2 MEDIA lines)
openclaw nodes camera snap --node <id> --facing front
openclaw nodes camera clip --node <id> --duration 3000
openclaw nodes camera clip --node <id> --no-audio
```

မှတ်ချက်များ:

- `nodes camera snap` သည် အေးဂျင့်အား မြင်ကွင်းနှစ်မျိုးလုံး ပေးနိုင်ရန် **ရှေ့/နောက် နှစ်ဖက်လုံး** ကို ပုံမှန်အဖြစ် သတ်မှတ်ထားသည်။
- ကိုယ်ပိုင် wrapper မတည်ဆောက်ပါက ထွက်လာသော ဖိုင်များသည် (OS temp directory အတွင်းရှိ) ယာယီဖိုင်များ ဖြစ်သည်။

## Android နိုဒ်

### Android အသုံးပြုသူ ဆက်တင် (ပုံမှန် အဖွင့်)

- Android Settings sheet → **Camera** → **Allow Camera** (`camera.enabled`)
  - ပုံမှန်: **အဖွင့်** (ကီး မရှိပါက ခွင့်ပြုထားသည်ဟု သတ်မှတ်မည်)။
  - ပိတ်ထားပါက: `camera.*` အမိန့်များသည် `CAMERA_DISABLED` ကို ပြန်ပို့မည်။

### ခွင့်ပြုချက်များ

- Android သည် runtime ခွင့်ပြုချက်များ လိုအပ်သည် —
  - `CAMERA` သည် `camera.snap` နှင့် `camera.clip` နှစ်ခုလုံးအတွက် လိုအပ်သည်။
  - `RECORD_AUDIO` သည် `camera.clip` အတွက် လိုအပ်ပြီး `includeAudio=true` ဖြစ်သောအခါ အသုံးပြုသည်။

ခွင့်ပြုချက်များ မရှိပါက အက်ပ်သည် ဖြစ်နိုင်သည့်အခါ prompt ပြမည်ဖြစ်ပြီး၊ ငြင်းပယ်ပါက `camera.*` တောင်းဆိုမှုများသည်
`*_PERMISSION_REQUIRED` အမှားဖြင့် မအောင်မြင်ပါ။

### Android Foreground လိုအပ်ချက်

`canvas.*` ကဲ့သို့ပင် Android node သည် **foreground** တွင်သာ `camera.*` command များကို ခွင့်ပြုပါသည်။ Background invocations တွေက `NODE_BACKGROUND_UNAVAILABLE` ကို ပြန်ပေးပါတယ်။

### Payload ကာကွယ်မှု

base64 payload ကို 5 MB အောက်တွင် ထိန်းသိမ်းရန် ဓာတ်ပုံများကို ပြန်လည်ဖိသိပ်မည်။

## macOS အက်ပ်

### အသုံးပြုသူ ဆက်တင် (ပုံမှန် ပိတ်)

macOS companion အက်ပ်တွင် checkbox တစ်ခုကို ပံ့ပိုးထားသည် —

- **Settings → General → Allow Camera** (`openclaw.cameraEnabled`)
  - ပုံမှန်: **ပိတ်**
  - ပိတ်ထားပါက: ကင်မရာတောင်းဆိုမှုများသည် “Camera disabled by user” ကို ပြန်ပို့မည်။

### CLI အကူအညီ (node invoke)

macOS နိုဒ်ပေါ်ရှိ ကင်မရာ အမိန့်များကို ခေါ်ယူရန် အဓိက `openclaw` CLI ကို အသုံးပြုပါ။

ဥပမာများ:

```bash
openclaw nodes camera list --node <id>            # list camera ids
openclaw nodes camera snap --node <id>            # prints MEDIA:<path>
openclaw nodes camera snap --node <id> --max-width 1280
openclaw nodes camera snap --node <id> --delay-ms 2000
openclaw nodes camera snap --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --duration 10s          # prints MEDIA:<path>
openclaw nodes camera clip --node <id> --duration-ms 3000      # prints MEDIA:<path> (legacy flag)
openclaw nodes camera clip --node <id> --device-id <id>
openclaw nodes camera clip --node <id> --no-audio
```

မှတ်ချက်များ:

- `openclaw nodes camera snap` သည် မပြောင်းလဲပါက `maxWidth=1600` ကို ပုံမှန်အဖြစ် သတ်မှတ်ထားသည်။
- macOS တွင် `camera.snap` သည် warm-up/exposure settle ပြီးနောက် ဖမ်းယူမီ `delayMs` (ပုံမှန် 2000ms) စောင့်ဆိုင်းမည်။
- ဓာတ်ပုံ payload များကို base64 ကို 5 MB အောက်တွင် ထိန်းသိမ်းရန် ပြန်လည်ဖိသိပ်မည်။

## လုံခြုံရေး + လက်တွေ့ ကန့်သတ်ချက်များ

- ကင်မရာနှင့် မိုက်ခရိုဖုန်း အသုံးပြုခြင်းသည် OS ၏ ပုံမှန် ခွင့်ပြုချက် prompt များကို ဖြစ်ပေါ်စေပြီး (Info.plist တွင် usage strings လိုအပ်သည်)။
- ဗီဒီယိုကလစ်များကို အရွယ်အစားကြီးမားသွားခြင်းမှ ရှောင်ရှားရန် (base64 overhead + မက်ဆေ့ချ် ကန့်သတ်ချက်များ) `<= 60s` (လက်ရှိ) အထိသာ ကန့်သတ်ထားသည်။

## macOS မျက်နှာပြင် ဗီဒီယို (OS အဆင့်)

_မျက်နှာပြင်_ ဗီဒီယို (ကင်မရာ မဟုတ်) အတွက် macOS companion ကို အသုံးပြုပါ —

```bash
openclaw nodes screen record --node <id> --duration 10s --fps 15   # prints MEDIA:<path>
```

မှတ်ချက်များ:

- macOS **Screen Recording** ခွင့်ပြုချက် (TCC) လိုအပ်သည်။
